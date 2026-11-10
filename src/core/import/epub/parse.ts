import type { Element } from "@xmldom/xmldom";
import {
  CONVERSION_NOTICE_CODES,
  DEFAULT_BOOK_LANGUAGE,
  countCodePoints,
  type BookMetadata,
  type ChapterKind,
  type ConversionNotice,
  type ConversionNoticeCode,
  type EpubTocSource,
  type EpubVersion,
} from "../../../shared/book";
import { hashBody, sha256Hex } from "../../text/hash";
import type { EpubImportPreview, ImportChapter } from "../import-pipeline";
import { EpubError } from "./epub-error";
import { dirName, baseName, rawHrefPath, resolveHref } from "./paths";
import type { RawTocEntry } from "./toc";
import { parseNavToc, parseNcxToc } from "./toc";
import type { BlockNotice, ConvertedBlock, ConvertedDocument } from "./xhtml";
import { convertXhtml } from "./xhtml";
import {
  attrOf,
  decodeXmlBytes,
  elementsByLocalName,
  firstByLocalName,
  localNameOf,
  normalizedText,
  parseXml,
} from "./xml";
import { findZipEntry, readZipEntries, type ZipEntries } from "./zip";

const MAX_SEGMENTS = 5000;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

interface ManifestItem {
  id: string;
  path: string;
  rawPath: string | null;
  mediaType: string;
  properties: string[];
}

interface SpineItem {
  item: ManifestItem;
  linear: boolean;
}

interface TocTarget {
  label: string;
  level: number;
  path: string;
  fragment: string | null;
}

export interface EpubSegment {
  index: number;
  title: string;
  sourceTitle: string;
  kind: ChapterKind;
  /** 不含章主标题的 Markdown 正文。 */
  body: string;
  /** 被移入章元数据的原标题 Markdown；合并到上一章时保留。 */
  headingMarkdown: string | null;
  charCount: number;
  excerpt: string;
  notices: BlockNotice[];
  sourcePath: string;
}

export interface ParsedEpub {
  fileName: string;
  byteLength: number;
  sourceSha256: string;
  version: EpubVersion;
  tocSource: EpubTocSource;
  spineCount: number;
  metadata: BookMetadata;
  segments: EpubSegment[];
  /** chapters 使用导入段下标；预览/入库时会映射为最终章序。 */
  notices: ConversionNotice[];
}

export interface EpubGroup {
  chapter: ImportChapter;
  segmentStart: number;
  segmentEnd: number;
  notices: BlockNotice[];
}

function excerptOf(body: string, limit = 120): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join("")}…`;
}

function decodeEntry(
  zip: ZipEntries,
  path: string,
  file: string,
): ReturnType<typeof parseXml> {
  const bytes = findZipEntry(zip, path);
  if (!bytes)
    throw new EpubError(
      "MISSING_SPINE_RESOURCE",
      "EPUB 缺少阅读顺序引用的文档",
      file,
    );
  const decoded = decodeXmlBytes(bytes);
  return parseXml(decoded.text, file, "application/xhtml+xml");
}

function normalizedLanguage(value: string): string {
  const trimmed = value.trim();
  return LANGUAGE_PATTERN.test(trimmed) ? trimmed : DEFAULT_BOOK_LANGUAGE;
}

function metadataOf(
  packageElement: Element,
  fileName: string,
): { metadata: BookMetadata; fixedLayout: boolean } {
  const metadataElement =
    elementsByLocalName(packageElement, "metadata")[0] ?? packageElement;
  const title =
    normalizedText(elementsByLocalName(metadataElement, "title")[0]) ||
    baseName(fileName).replace(/\.epub$/i, "").trim() ||
    "未命名作品";
  const language =
    normalizedText(elementsByLocalName(metadataElement, "language")[0]) ||
    DEFAULT_BOOK_LANGUAGE;
  const authors: string[] = [];
  for (const creator of elementsByLocalName(metadataElement, "creator")) {
    const name = normalizedText(creator).slice(0, 200);
    if (name && !authors.includes(name)) authors.push(name);
    if (authors.length >= 32) break;
  }
  let fixedLayout = false;
  for (const meta of elementsByLocalName(metadataElement, "meta")) {
    const property = (
      attrOf(meta, "property") ??
      attrOf(meta, "name") ??
      ""
    ).toLowerCase();
    const value = (
      (meta.textContent ?? "").trim() || attrOf(meta, "content") || ""
    ).toLowerCase();
    if (
      (property === "rendition:layout" && value === "pre-paginated") ||
      (property === "fixed-layout" && value === "true")
    )
      fixedLayout = true;
  }
  return {
    metadata: {
      title: title.slice(0, 200),
      language: normalizedLanguage(language),
      ...(authors.length ? { authors } : {}),
    },
    fixedLayout,
  };
}

function isXhtmlItem(item: ManifestItem): boolean {
  return (
    /^(?:application\/xhtml\+xml|text\/html)$/i.test(item.mediaType) ||
    /\.x?html?$/i.test(item.path)
  );
}

function appleFixedLayout(zip: ZipEntries): boolean {
  const bytes = findZipEntry(
    zip,
    "META-INF/com.apple.ibooks.display-options.xml",
  );
  if (!bytes) return false;
  try {
    const { text } = decodeXmlBytes(bytes, 512 * 1024);
    return /name\s*=\s*["']fixed-layout["'][^>]*>\s*true\s*</i.test(text);
  } catch {
    return false;
  }
}

/**
 * 加密检测：只放行字体混淆；任何指向正文/OPF/导航的加密都判定为 DRM。
 * 无法确认时拒绝，而不是把密文当正文导入。
 */
function assertNotDrm(zip: ZipEntries): number {
  const bytes = findZipEntry(zip, "META-INF/encryption.xml");
  if (!bytes) return 0;
  let document: ReturnType<typeof parseXml>;
  try {
    document = parseXml(decodeXmlBytes(bytes).text, "META-INF/encryption.xml");
  } catch (error) {
    throw new EpubError(
      "DRM_PROTECTED",
      "EPUB 含加密信息且无法确认内容是否可读，暂不支持",
      error instanceof Error ? error.message : "",
    );
  }
  const encrypted = elementsByLocalName(document, "EncryptedData");
  if (!encrypted.length) return 0;
  let fonts = 0;
  for (const data of encrypted) {
    const method = firstByLocalName(data, "EncryptionMethod");
    const algorithm = method ? (attrOf(method, "Algorithm") ?? "") : "";
    const reference = firstByLocalName(data, "CipherReference");
    const uri = reference ? (attrOf(reference, "URI") ?? "") : "";
    const fontObfuscation =
      /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc/i.test(algorithm);
    const fontTarget = /\.(?:ttf|otf|woff2?|eot)(?:[?#].*)?$/i.test(uri);
    if (!(fontObfuscation && fontTarget))
      throw new EpubError(
        "DRM_PROTECTED",
        "EPUB 受 DRM 加密保护，暂不支持导入",
        uri || "encryption.xml",
      );
    fonts += 1;
  }
  return fonts;
}

function readPackage(
  zip: ZipEntries,
  opfPath: string,
  fileName: string,
): {
  metadata: BookMetadata;
  version: EpubVersion;
  manifest: Map<string, ManifestItem>;
  spine: SpineItem[];
  spineCount: number;
  navPath: string | null;
  ncxPath: string | null;
} {
  const document = (() => {
    const bytes = findZipEntry(zip, opfPath);
    if (!bytes)
      throw new EpubError("MISSING_OPF", "EPUB 缺少 container.xml 指向的 OPF 包", opfPath);
    return parseXml(
      decodeXmlBytes(bytes).text,
      opfPath,
      "application/xhtml+xml",
    );
  })();
  const rootElement = document.documentElement;
  if (!rootElement || localNameOf(rootElement) !== "package")
    throw new EpubError("INVALID_OPF", "OPF 根元素不是 package", opfPath);
  const packageElement = rootElement;
  const versionRaw = (attrOf(packageElement, "version") ?? "2").trim();
  const major = versionRaw.charAt(0);
  if (major !== "2" && major !== "3")
    throw new EpubError(
      "INVALID_OPF",
      "只支持 EPUB 2 / EPUB 3 的 OPF 版本",
      versionRaw,
    );
  const version: EpubVersion = major === "3" ? "3" : "2";
  const { metadata, fixedLayout } = metadataOf(packageElement, fileName);
  if (fixedLayout || appleFixedLayout(zip))
    throw new EpubError(
      "FIXED_LAYOUT",
      "EPUB 为固定版式书籍，暂不支持导入",
    );

  const manifestElement = elementsByLocalName(packageElement, "manifest")[0];
  if (!manifestElement)
    throw new EpubError("INVALID_OPF", "OPF 缺少 manifest");
  const manifest = new Map<string, ManifestItem>();
  for (const item of elementsByLocalName(manifestElement, "item")) {
    const id = (attrOf(item, "id") ?? "").trim();
    const href = (attrOf(item, "href") ?? "").trim();
    if (!id || !href)
      throw new EpubError("INVALID_OPF", "OPF manifest 条目缺少 id 或 href");
    if (manifest.has(id))
      throw new EpubError("INVALID_OPF", "OPF manifest 存在重复 id", id);
    const resolved = resolveHref(opfPath, href);
    manifest.set(id, {
      id,
      path: resolved.path,
      rawPath: rawHrefPath(opfPath, href),
      mediaType: (attrOf(item, "media-type") ?? "").trim().toLowerCase(),
      properties: (attrOf(item, "properties") ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    });
  }

  const spineElement = elementsByLocalName(packageElement, "spine")[0];
  const itemrefs = spineElement
    ? elementsByLocalName(spineElement, "itemref")
    : [];
  if (!spineElement || itemrefs.length === 0)
    throw new EpubError("MISSING_SPINE", "OPF 缺少阅读顺序（spine）");
  const spine: SpineItem[] = [];
  for (const itemref of itemrefs) {
    const idref = (attrOf(itemref, "idref") ?? "").trim();
    const item = manifest.get(idref);
    if (!item)
      throw new EpubError(
        "MISSING_SPINE_RESOURCE",
        "阅读顺序引用了 manifest 中不存在的资源",
        idref,
      );
    spine.push({
      item,
      linear: (attrOf(itemref, "linear") ?? "yes").toLowerCase() !== "no",
    });
  }

  const navItem = [...manifest.values()].find((item) =>
    item.properties.includes("nav"),
  );
  const tocId = spineElement ? (attrOf(spineElement, "toc") ?? "").trim() : "";
  const ncxItem =
    (tocId ? manifest.get(tocId) : undefined) ??
    [...manifest.values()].find(
      (item) => item.mediaType === "application/x-dtbncx+xml",
    );
  return {
    metadata,
    version,
    manifest,
    spine,
    spineCount: itemrefs.length,
    navPath: navItem?.path ?? null,
    ncxPath: ncxItem?.path ?? null,
  };
}

function loadTocEntries(
  zip: ZipEntries,
  path: string,
  kind: "nav" | "ncx",
): RawTocEntry[] {
  const bytes = findZipEntry(zip, path);
  if (!bytes) return [];
  const document = parseXml(
    decodeXmlBytes(bytes).text,
    path,
    "application/xhtml+xml",
  );
  return kind === "nav" ? parseNavToc(document) : parseNcxToc(document);
}

function readToc(
  zip: ZipEntries,
  navPath: string | null,
  ncxPath: string | null,
): {
  tocSource: EpubTocSource;
  entries: TocTarget[];
  unreadable: boolean;
} {
  let tocSource: EpubTocSource = "none";
  let raw: RawTocEntry[] = [];
  let basePath = "";
  let unreadable = false;
  if (navPath) {
    try {
      const navEntries = loadTocEntries(zip, navPath, "nav");
      if (navEntries.length) {
        raw = navEntries;
        basePath = navPath;
        tocSource = "nav";
      }
    } catch {
      unreadable = true;
    }
  }
  if (tocSource === "none" && ncxPath) {
    try {
      const ncxEntries = loadTocEntries(zip, ncxPath, "ncx");
      if (ncxEntries.length) {
        raw = ncxEntries;
        basePath = ncxPath;
        tocSource = "ncx";
      }
    } catch {
      unreadable = true;
    }
  }
  return {
    tocSource,
    entries: raw.map((entry) => {
      const resolved = resolveTocHref(basePath, entry.href);
      return {
        label: entry.label,
        level: entry.level,
        path: resolved.path,
        fragment: resolved.fragment,
      };
    }),
    unreadable,
  };
}

function resolveTocHref(
  basePath: string,
  href: string,
): { path: string; fragment: string | null } {
  try {
    return resolveHref(basePath, href);
  } catch {
    return { path: "", fragment: null };
  }
}

/** 按 spine 顺序把每个正文文档转成段；目录锚点决定一文件多章的切分位置。 */
function splitDocument(
  converted: ConvertedDocument,
  entries: readonly TocTarget[],
  item: ManifestItem,
  startIndex: number,
  fallbackTitle: string,
): { segments: EpubSegment[]; invalidAnchors: number } {
  const positions: Array<{ block: number; label: string }> = [];
  const seenBlocks = new Set<number>();
  let invalidAnchors = 0;
  for (const entry of entries) {
    let block = 0;
    if (entry.fragment) {
      const index = converted.anchors.get(entry.fragment);
      if (index === undefined) {
        invalidAnchors += 1;
        continue;
      }
      block = index;
    }
    if (seenBlocks.has(block)) continue;
    seenBlocks.add(block);
    positions.push({ block, label: entry.label });
  }
  positions.sort((a, b) => a.block - b.block);
  const labelAt = new Map<number, string>();
  for (const position of positions)
    if (!labelAt.has(position.block)) labelAt.set(position.block, position.label);

  const boundaries = [
    0,
    ...positions.map((position) => position.block).filter((block) => block > 0),
  ];
  const segments: EpubSegment[] = [];
  for (const [groupIndex, start] of boundaries.entries()) {
    const end =
      groupIndex + 1 < boundaries.length
        ? boundaries[groupIndex + 1]
        : converted.blocks.length;
    let bodyStart = start;
    while (
      bodyStart < end &&
      !converted.blocks[bodyStart].markdown.trim() &&
      converted.blocks[bodyStart].notices.length === 0
    )
      bodyStart += 1;
    const first = converted.blocks[bodyStart];
    const tocLabel = labelAt.get(start) ?? "";
    let title = tocLabel;
    let headingMarkdown: string | null = null;
    const headingText = first?.headingText.trim() ?? "";
    const headingFitsTitle =
      headingText.length <= 200 &&
      (!tocLabel || tocLabel.trim() === headingText);
    if (
      first &&
      first.headingLevel !== null &&
      first.headingLevel <= 3 &&
      headingFitsTitle
    ) {
      headingMarkdown = first.markdown || null;
      if (!title) title = first.headingText;
      bodyStart += 1;
    } else if (!title && first && first.headingText) {
      title = first.headingText;
    }
    if (!title) title = fallbackTitle;
    const blocks: ConvertedBlock[] = converted.blocks.slice(bodyStart, end);
    const body = blocks
      .map((block) => block.markdown.trim())
      .filter(Boolean)
      .join("\n\n");
    const notices = converted.blocks
      .slice(start, end)
      .flatMap((block) => block.notices);
    segments.push({
      index: startIndex + segments.length,
      title: title.trim().slice(0, 200) || `未命名章节 ${startIndex + segments.length + 1}`,
      sourceTitle: (tocLabel || (first?.headingText ?? "") || fallbackTitle)
        .trim()
        .slice(0, 200),
      kind: "chapter",
      body,
      headingMarkdown,
      charCount: countCodePoints(body),
      excerpt: excerptOf(body),
      notices,
      sourcePath: item.path,
    });
    if (segments.length > MAX_SEGMENTS)
      throw new EpubError(
        "TOO_MANY_CHAPTERS",
        `EPUB 章节数超过 ${MAX_SEGMENTS} 上限`,
      );
  }
  return { segments, invalidAnchors };
}

function documentFallbackTitle(path: string): string {
  const name = baseName(path).replace(/\.x?html?$/i, "").trim();
  return name || "未命名章节";
}

function addNotice(
  map: Map<ConversionNoticeCode, { count: number; chapters: Set<number> }>,
  code: ConversionNoticeCode,
  count: number,
  chapters: readonly number[],
): void {
  if (count <= 0) return;
  const entry = map.get(code) ?? { count: 0, chapters: new Set<number>() };
  entry.count += count;
  for (const chapter of chapters) entry.chapters.add(chapter);
  map.set(code, entry);
}

export function noticeMessage(
  code: ConversionNoticeCode,
  count: number,
  chapters: readonly number[],
): string {
  const prefix = chapters.length
    ? `第 ${chapters.map((chapter) => chapter + 1).join("、")} 章：`
    : "";
  const messages: Record<ConversionNoticeCode, string> = {
    "image-dropped": `${prefix}${count} 张图片未转换（EPUB 导出不包含图片）`,
    "media-dropped": `${prefix}${count} 个音视频或嵌入内容未转换`,
    "table-flattened": `${prefix}${count} 个表格已展开为段落文本`,
    "footnote-flattened": `${prefix}${count} 个脚注／附注已转为引用块`,
    "ruby-flattened": `${prefix}${count} 处注音已保留基文、去除注音`,
    "inline-style-flattened": `${prefix}${count} 处行内样式已保留纯文本`,
    "unsupported-content-flattened": `${prefix}${count} 个不支持的元素已保留文本`,
    "internal-link-degraded": `${prefix}${count} 个内部链接无法保留，已保留链接文字`,
    "external-link-degraded": `${prefix}${count} 个不安全链接已保留文字`,
    "empty-chapter-skipped": `${prefix}${count} 个空章节未导入`,
    "nav-invalid-anchor": `目录中有 ${count} 个锚点找不到正文位置，已按正文位置回退分章`,
    "toc-target-outside-spine": `目录中有 ${count} 项指向阅读顺序之外，未导入正文`,
    "toc-unreadable": "EPUB 目录无法解析，已按正文文件与标题回退分章",
    "non-text-spine-item": `阅读顺序中有 ${count} 个非文本项目未导入`,
    "fonts-obfuscated-ignored": `${count} 个字体文件使用混淆保护，未使用（不影响正文）`,
  };
  return messages[code].slice(0, 500);
}

function buildNotices(
  segments: readonly EpubSegment[],
  docInvalid: ReadonlyMap<string, number>,
  outside: number,
  unreadable: boolean,
  nonTextSpine: number,
  fonts: number,
): ConversionNotice[] {
  const map = new Map<
    ConversionNoticeCode,
    { count: number; chapters: Set<number> }
  >();
  for (const segment of segments)
    for (const notice of segment.notices)
      addNotice(map, notice.code, notice.count, [segment.index]);
  for (const [path, count] of docInvalid) {
    const chapters = segments
      .filter((segment) => segment.sourcePath === path)
      .map((segment) => segment.index);
    addNotice(map, "nav-invalid-anchor", count, chapters);
  }
  if (outside) addNotice(map, "toc-target-outside-spine", outside, []);
  if (unreadable) addNotice(map, "toc-unreadable", 1, []);
  if (nonTextSpine) addNotice(map, "non-text-spine-item", nonTextSpine, []);
  if (fonts) addNotice(map, "fonts-obfuscated-ignored", fonts, []);
  return CONVERSION_NOTICE_CODES.flatMap((code) => {
    const entry = map.get(code);
    if (!entry) return [];
    const chapters = [...entry.chapters].sort((a, b) => a - b);
    return [
      {
        code,
        count: entry.count,
        chapters,
        message: noticeMessage(code, entry.count, chapters),
      },
    ];
  });
}

/**
 * 解析 EPUB 2/3 的流式排版书籍。阅读顺序以 OPF spine 为准，
 * 导航只用于章名与切分；纯图片/固定版式/DRM 明确拒绝。
 */
export function parseEpub(source: {
  fileName: string;
  bytes: Uint8Array;
}): ParsedEpub {
  const zip = readZipEntries(source.bytes);
  const fonts = assertNotDrm(zip);
  const containerBytes = findZipEntry(zip, "META-INF/container.xml");
  if (!containerBytes)
    throw new EpubError(
      "MISSING_CONTAINER",
      "EPUB 缺少 META-INF/container.xml",
    );
  const container = parseXml(
    decodeXmlBytes(containerBytes).text,
    "META-INF/container.xml",
  );
  const rootfiles = elementsByLocalName(container, "rootfile");
  const rootfile =
    rootfiles.find((element) =>
      /oebps-package/i.test(attrOf(element, "media-type") ?? ""),
    ) ?? rootfiles[0];
  const fullPath = rootfile ? (attrOf(rootfile, "full-path") ?? "").trim() : "";
  if (!fullPath)
    throw new EpubError(
      "INVALID_CONTAINER",
      "container.xml 未声明有效的 OPF 包路径",
    );
  const opfPath = resolveHref("", fullPath).path;

  const pkg = readPackage(zip, opfPath, source.fileName);
  const toc = readToc(zip, pkg.navPath, pkg.ncxPath);

  const contentItems = pkg.spine.filter(
    (entry) =>
      entry.linear &&
      isXhtmlItem(entry.item) &&
      !entry.item.properties.includes("nav"),
  );
  const nonTextSpine = pkg.spine.filter(
    (entry) => entry.linear && !isXhtmlItem(entry.item),
  ).length;

  const spinePathMap = new Map<string, string>();
  for (const entry of contentItems) {
    spinePathMap.set(entry.item.path.normalize("NFC"), entry.item.path);
    if (entry.item.rawPath)
      spinePathMap.set(entry.item.rawPath.normalize("NFC"), entry.item.path);
  }
  const tocByPath = new Map<string, TocTarget[]>();
  let outside = 0;
  const seenTargets = new Set<string>();
  for (const entry of toc.entries) {
    const canonical =
      spinePathMap.get(entry.path.normalize("NFC")) ??
      (entry.path ? null : null);
    if (!canonical) {
      outside += 1;
      continue;
    }
    const key = `${canonical}#${entry.fragment ?? ""}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    const list = tocByPath.get(canonical) ?? [];
    list.push({ ...entry, path: canonical });
    tocByPath.set(canonical, list);
  }

  const segments: EpubSegment[] = [];
  const docInvalid = new Map<string, number>();
  for (const entry of contentItems) {
    const document = decodeEntry(zip, entry.item.path, entry.item.path);
    const converted = convertXhtml(document, entry.item.path);
    const { segments: produced, invalidAnchors } = splitDocument(
      converted,
      tocByPath.get(entry.item.path) ?? [],
      entry.item,
      segments.length,
      documentFallbackTitle(entry.item.path),
    );
    if (invalidAnchors) docInvalid.set(entry.item.path, invalidAnchors);
    segments.push(...produced);
  }

  if (segments.length === 0 || !segments.some((segment) => segment.body.trim()))
    throw new EpubError(
      "NO_TEXT_CONTENT",
      "EPUB 没有可导入的文字正文（可能为纯图片或固定版式书籍）",
    );

  return {
    fileName: source.fileName,
    byteLength: source.bytes.byteLength,
    sourceSha256: sha256Hex(source.bytes),
    version: pkg.version,
    tocSource: toc.tocSource,
    spineCount: pkg.spineCount,
    metadata: pkg.metadata,
    segments,
    notices: buildNotices(
      segments,
      docInvalid,
      outside,
      toc.unreadable,
      nonTextSpine,
      fonts,
    ),
  };
}

function validateBoundaries(
  boundaries: readonly number[],
  count: number,
): void {
  if (boundaries.length === 0)
    throw new EpubError("INVALID_BOUNDARIES", "缺少分章边界");
  if (boundaries[0] !== 0)
    throw new EpubError("INVALID_BOUNDARIES", "首个分章边界必须为 0");
  for (const [index, value] of boundaries.entries()) {
    if (!Number.isInteger(value) || value < 0 || value >= count)
      throw new EpubError("INVALID_BOUNDARIES", "分章边界超出范围");
    if (index > 0 && value <= boundaries[index - 1])
      throw new EpubError("INVALID_BOUNDARIES", "分章边界必须严格递增");
  }
}

/** 预览与入库共用同一分组：组内首段去掉主标题，后续段保留自己的标题。 */
export function groupEpubSegments(
  parsed: ParsedEpub,
  boundaries: readonly number[],
  titles: Readonly<Record<number, string>> = {},
): EpubGroup[] {
  validateBoundaries(boundaries, parsed.segments.length);
  return boundaries.map((start, index) => {
    const end =
      index + 1 < boundaries.length
        ? boundaries[index + 1]
        : parsed.segments.length;
    const group = parsed.segments.slice(start, end);
    const parts: string[] = [];
    for (const [offset, segment] of group.entries()) {
      const body = segment.body.trim();
      if (offset === 0) {
        if (body) parts.push(body);
      } else if (segment.headingMarkdown) {
        parts.push(
          segment.body.trim()
            ? `${segment.headingMarkdown}\n\n${body}`
            : segment.headingMarkdown,
        );
      } else {
        const heading = segment.title
          .trim()
          .replace(/([\\`*_\[\]])/g, "\\$1");
        if (heading)
          parts.push(body ? `## ${heading}\n\n${body}` : `## ${heading}`);
        else if (body) parts.push(body);
      }
    }
    const chapter: ImportChapter = {
      title: (titles[start] ?? group[0].title).trim(),
      sourceTitle: group[0].sourceTitle,
      kind: group[0].kind,
      body: parts.join("\n\n").replace(/\n+$/, ""),
    };
    return {
      chapter,
      segmentStart: start,
      segmentEnd: end - 1,
      notices: group.flatMap((segment) => segment.notices),
    };
  });
}

function mapNoticeChapters(
  notices: readonly ConversionNotice[],
  boundaries: readonly number[],
): ConversionNotice[] {
  const groupOf = (segment: number): number => {
    let group = 0;
    for (const [index, start] of boundaries.entries())
      if (segment >= start) group = index;
    return group;
  };
  return notices.map((notice) => {
    const chapters = [
      ...new Set(notice.chapters.map((segment) => groupOf(segment))),
    ].sort((a, b) => a - b);
    return {
      ...notice,
      chapters,
      message: noticeMessage(notice.code, notice.count, chapters),
    };
  });
}

export function buildEpubImportPreview(
  parsed: ParsedEpub,
  defaultBoundaries?: readonly number[],
): EpubImportPreview {
  const boundaries =
    defaultBoundaries ?? parsed.segments.map((segment) => segment.index);
  const groups = groupEpubSegments(parsed, boundaries);
  return {
    kind: "epub",
    fileName: parsed.fileName,
    format: "epub",
    byteLength: parsed.byteLength,
    sourceSha256: parsed.sourceSha256,
    totalChars: parsed.segments.reduce(
      (sum, segment) => sum + segment.charCount,
      0,
    ),
    segments: parsed.segments.map((segment) => ({
      index: segment.index,
      title: segment.title,
      kind: segment.kind,
      charCount: segment.charCount,
      excerpt: segment.excerpt,
    })),
    groups: groups.map((group) => ({
      startSegment: group.segmentStart,
      endSegment: group.segmentEnd,
      title: group.chapter.title,
      kind: group.chapter.kind,
      charCount: countCodePoints(group.chapter.body),
      excerpt: excerptOf(group.chapter.body),
      bodyHash: hashBody(group.chapter.body),
    })),
    metadata: { ...parsed.metadata },
    version: parsed.version,
    tocSource: parsed.tocSource,
    spineCount: parsed.spineCount,
    notices: mapNoticeChapters(parsed.notices, boundaries),
    options: { source: "epub" },
  };
}

export interface EpubAssembleResult {
  chapters: ImportChapter[];
  notices: ConversionNotice[];
}

export function assembleEpubChapters(
  parsed: ParsedEpub,
  boundaries: readonly number[],
  titles: Readonly<Record<number, string>> = {},
): EpubAssembleResult {
  const groups = groupEpubSegments(parsed, boundaries, titles);
  return {
    chapters: groups.map((group) => group.chapter),
    notices: mapNoticeChapters(parsed.notices, boundaries),
  };
}
