import MarkdownIt from "markdown-it";
import { zipSync, type ZipOptions } from "fflate";
import {
  bookMetadataSchema,
  countCodePoints,
  type BodyFormat,
  type BookMetadata,
  type ChapterFile,
} from "../../../shared/book";
import { formatOptionsSchema, type FormatOptions } from "../../../shared/format-options";
import { deriveBlocks } from "../../text/structure";
import { formatMarkdownBody } from "../markdown-formatter";
import { formatTxtBody } from "../txt-formatter";

export const EPUB_MEDIA_TYPE = "application/epub+zip";
const XHTML_TYPE = "application/xhtml+xml";

export interface EpubBuildInput {
  chapters: readonly ChapterFile[];
  bodyFormat: BodyFormat;
  options: FormatOptions;
  metadata: BookMetadata;
  /** urn:uuid:…；由调用方提供，保证唯一标识符稳定。 */
  identifier: string;
  modifiedAt?: Date;
}

export interface EpubChapterEntry {
  title: string;
  href: string;
  charCount: number;
}

export interface EpubBuildResult {
  bytes: Uint8Array;
  /** 与最终 EPUB 共用同一份章节内容与 CSS 的排版预览。 */
  previewHtml: string;
  chapters: EpubChapterEntry[];
  warnings: string[];
}

export function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function chapterTitle(chapter: ChapterFile, options: FormatOptions): string {
  return options.headingTemplate.replace(/\{(title|number)\}/g, (_match, key: string) =>
    key === "title" ? chapter.title.current : String(chapter.order + 1),
  );
}

function paragraphIndentEm(options: FormatOptions): number {
  if (options.indent === "none") return 0;
  if (options.indent === "fullwidth") return 2;
  let em = 0;
  for (const character of options.customPrefix)
    em += character === "\u3000" ? 1 : 0.5;
  return Math.min(4, Math.max(0, em));
}

function styleSheet(options: FormatOptions): string {
  const indent = paragraphIndentEm(options);
  const paragraphSpacing = [0, 0.5, 0.9, 1.3][
    Math.min(3, Math.max(0, options.paragraphBlankLines))
  ];
  const headingBefore = 0.8 + 0.4 * options.headingBlankLinesBefore;
  const headingAfter = 0.4 + 0.2 * options.headingBlankLinesAfter;
  return `html { color-scheme: light; }
body {
  margin: 0 auto;
  max-width: 42em;
  padding: 1.5em 1.2em 4em;
  font-family: "Noto Serif SC", "Songti SC", SimSun, serif;
  font-size: 1em;
  line-height: 1.8;
  color: #172b4d;
  background: #ffffff;
}
h1, h2, h3, h4, h5, h6 {
  text-indent: 0;
  line-height: 1.45;
  font-weight: 600;
  margin: ${headingBefore.toFixed(2)}em 0 ${headingAfter.toFixed(2)}em;
}
.chapter-title { text-align: center; margin-top: 0.2em; }
p { text-indent: ${indent}em; margin: 0 0 ${paragraphSpacing}em; }
p.separator { text-align: center; text-indent: 0; letter-spacing: 0.3em; color: #596b87; }
blockquote {
  margin: 0.8em 0;
  padding: 0.1em 0 0.1em 1em;
  border-left: 3px solid #c9d7ee;
  color: #3a4a63;
}
blockquote p { text-indent: 0; margin-bottom: 0.4em; }
ul, ol { margin: 0 0 ${paragraphSpacing}em; padding-left: 2em; }
li p { text-indent: 0; margin-bottom: 0.3em; }
pre {
  margin: 0.8em 0;
  padding: 0.7em 0.9em;
  background: #f5f8fd;
  border: 1px solid #e3eaf5;
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
code, kbd, samp { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.92em; }
p code { text-indent: 0; }
hr { border: 0; border-top: 1px solid #c9d7ee; margin: 1.5em 0; }
a { color: #2563eb; text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; }
.preview-meta h1 { text-align: center; }
.preview-meta p { text-indent: 0; text-align: center; color: #596b87; margin-bottom: 2em; }
.preview-toc { margin: 0 0 2em; padding: 1em 1.2em; background: #f8faff; border: 1px solid #e3eaf5; border-radius: 6px; }
.preview-toc h2 { margin-top: 0; font-size: 1.05em; }
.preview-toc ol { margin: 0; padding-left: 1.4em; }
.preview-toc a { color: #172b4d; }
.chapter + .chapter { margin-top: 3em; padding-top: 1em; border-top: 1px solid #e3eaf5; }
`;
}

function isSafeExternalLink(href: string): boolean {
  return /^(?:https?:|mailto:|tel:)/i.test(href);
}

function markdownToXhtml(
  markdown: string,
  warnings: { images: number; links: number },
): string {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
  });
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, index, options, _env, self) =>
      self.renderToken(tokens, index, options));
  const defaultLinkClose =
    md.renderer.rules.link_close ??
    ((tokens, index, options, _env, self) =>
      self.renderToken(tokens, index, options));
  md.renderer.rules.image = (tokens, index) => {
    warnings.images += 1;
    return escapeXmlText(tokens[index].content || "");
  };
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const href = tokens[index].attrGet("href") ?? "";
    const stack = ((env as { linkStack?: boolean[] }).linkStack ??= []);
    if (!isSafeExternalLink(href)) {
      warnings.links += 1;
      stack.push(true);
      return "<span>";
    }
    stack.push(false);
    return defaultLinkOpen(tokens, index, options, env, self);
  };
  md.renderer.rules.link_close = (tokens, index, options, env, self) => {
    const stack = ((env as { linkStack?: boolean[] }).linkStack ??= []);
    const degraded = stack.pop() ?? false;
    return degraded ? "</span>" : defaultLinkClose(tokens, index, options, env, self);
  };
  const html = md.render(markdown, {});
  return html
    .replace(/<(br|hr)(\s[^<>]*)?>/g, "<$1$2/>")
    .replace(/<img([^<>]*?)(?<!\/)>/g, "<img$1/>");
}

function txtToXhtml(
  body: string,
  options: FormatOptions,
): string {
  const formatted = formatTxtBody(body, {
    ...options,
    indent: "none",
    paragraphBlankLines: 1,
  });
  const blocks = deriveBlocks("txt", formatted, options.paragraphMode);
  return blocks
    .map((block) => {
      const text = formatted.slice(block.start, block.end);
      if (block.kind === "separator")
        return `<p class="separator">${escapeXmlText(text.trim())}</p>`;
      return `<p>${text
        .split("\n")
        .map((line) => escapeXmlText(line))
        .join("<br/>")}</p>`;
    })
    .join("\n");
}

function chapterBodyXhtml(
  chapter: ChapterFile,
  input: EpubBuildInput,
  warnings: { images: number; links: number },
): string {
  const options = input.options;
  if (input.bodyFormat === "markdown") {
    const formatted = formatMarkdownBody(chapter.body, {
      ...options,
      indent: "none",
      paragraphBlankLines: 1,
    });
    return markdownToXhtml(formatted, warnings);
  }
  return txtToXhtml(chapter.body, options);
}

function chapterSectionId(index: number): string {
  return `chapter-${index + 1}`;
}

function chapterFileName(index: number): string {
  return `text/chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
}

function xhtmlDocument(options: {
  title: string;
  language: string;
  cssHref: string;
  body: string;
}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttribute(options.language)}" lang="${escapeXmlAttribute(options.language)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXmlText(options.title)}</title>
<link rel="stylesheet" type="text/css" href="${escapeXmlAttribute(options.cssHref)}"/>
</head>
<body>
${options.body}
</body>
</html>
`;
}

function navDocument(
  metadata: BookMetadata,
  chapters: readonly EpubChapterEntry[],
): string {
  const items = chapters
    .map(
      (_chapter, index) =>
        `<li><a href="${escapeXmlAttribute(chapterFileName(index))}#${chapterSectionId(index)}">${escapeXmlText(_chapter.title)}</a></li>`,
    )
    .join("\n");
  return xhtmlDocument({
    title: "目录",
    language: metadata.language,
    cssHref: "style.css",
    body: `<nav epub:type="toc" id="toc">
<h1 class="chapter-title">目录</h1>
<ol>
${items}
</ol>
</nav>`,
  });
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles>
</container>
`;
}

function packageOpf(
  metadata: BookMetadata,
  identifier: string,
  modifiedAt: Date,
  chapterCount: number,
): string {
  const creators = (metadata.authors ?? [])
    .map((author) => `<dc:creator>${escapeXmlText(author)}</dc:creator>`)
    .join("\n");
  const items: string[] = [
    `<item id="nav" href="nav.xhtml" media-type="${XHTML_TYPE}" properties="nav"/>`,
    `<item id="style" href="style.css" media-type="text/css"/>`,
  ];
  const itemrefs: string[] = [];
  for (let index = 0; index < chapterCount; index += 1) {
    items.push(
      `<item id="${chapterSectionId(index)}" href="${chapterFileName(index)}" media-type="${XHTML_TYPE}"/>`,
    );
    itemrefs.push(`<itemref idref="${chapterSectionId(index)}"/>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXmlAttribute(metadata.language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">${escapeXmlText(identifier)}</dc:identifier>
<dc:title>${escapeXmlText(metadata.title)}</dc:title>
<dc:language>${escapeXmlText(metadata.language)}</dc:language>
${creators}
<meta property="dcterms:modified">${modifiedAt.toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
</metadata>
<manifest>
${items.join("\n")}
</manifest>
<spine>
${itemrefs.join("\n")}
</spine>
</package>
`;
}

function previewDocument(
  metadata: BookMetadata,
  chapters: readonly EpubChapterEntry[],
  sections: readonly string[],
  css: string,
): string {
  const toc = chapters
    .map(
      (chapter, index) =>
        `<li><a href="#${chapterSectionId(index)}">${escapeXmlText(chapter.title)}</a></li>`,
    )
    .join("\n");
  const authors = metadata.authors?.length
    ? `<p>${escapeXmlText(metadata.authors.join("、"))}</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="${escapeXmlAttribute(metadata.language)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXmlText(metadata.title)} · EPUB 预览</title>
<style>${css}</style>
</head>
<body>
<header class="preview-meta"><h1>${escapeXmlText(metadata.title)}</h1>${authors}<p>${escapeXmlText(metadata.language)} · EPUB 3</p></header>
<nav class="preview-toc"><h2>目录 · ${chapters.length} 章</h2><ol>
${toc}
</ol></nav>
${sections.join("\n")}
</body>
</html>`;
}

/**
 * 从选定章节和当前标题构建 EPUB 3：mimetype 首项且不压缩，
 * OPF/nav/逐章 XHTML 与 CSS 共用同一份已格式化正文。
 */
export function buildEpub(input: EpubBuildInput): EpubBuildResult {
  const options = formatOptionsSchema.parse(input.options);
  const metadata = bookMetadataSchema.parse(input.metadata);
  if (!input.identifier.trim())
    throw new Error("EPUB 唯一标识符不能为空");
  const modifiedAt = input.modifiedAt ?? new Date();
  const css = styleSheet(options);
  const warnings: string[] = [];
  const chapters: EpubChapterEntry[] = [];
  const sections: string[] = [];
  const chapterFiles: Array<{ path: string; xhtml: string }> = [];
  const encoder = new TextEncoder();

  for (const [index, chapter] of input.chapters.entries()) {
    const title = chapterTitle(chapter, options);
    const counters = { images: 0, links: 0 };
    const content = chapterBodyXhtml(chapter, input, counters);
    const heading =
      chapter.kind === "frontmatter"
        ? ""
        : `<h1 class="chapter-title">${escapeXmlText(title)}</h1>`;
    const section = `<section class="chapter" id="${chapterSectionId(index)}">
${heading}
${content}
</section>`;
    sections.push(section);
    chapterFiles.push({
      path: `OEBPS/${chapterFileName(index)}`,
      xhtml: xhtmlDocument({
        title,
        language: metadata.language,
        cssHref: "../style.css",
        body: section,
      }),
    });
    chapters.push({
      title,
      href: chapterFileName(index),
      charCount: countCodePoints(chapter.body),
    });
    const chapterWarnings: string[] = [];
    if (counters.images)
      chapterWarnings.push(`${counters.images} 张图片未包含在 EPUB 中`);
    if (counters.links)
      chapterWarnings.push(`${counters.links} 个内部／相对链接已保留文字`);
    if (chapterWarnings.length)
      warnings.push(`第 ${index + 1} 章：${chapterWarnings.join("；")}`);
  }

  const opf = packageOpf(metadata, input.identifier, modifiedAt, input.chapters.length);
  const entries: Record<string, [Uint8Array, ZipOptions]> = {
    mimetype: [encoder.encode(EPUB_MEDIA_TYPE), { level: 0, mtime: modifiedAt }],
    "META-INF/container.xml": [encoder.encode(containerXml()), { mtime: modifiedAt }],
    "OEBPS/content.opf": [encoder.encode(opf), { mtime: modifiedAt }],
    "OEBPS/style.css": [encoder.encode(css), { mtime: modifiedAt }],
    "OEBPS/nav.xhtml": [
      encoder.encode(navDocument(metadata, chapters)),
      { mtime: modifiedAt },
    ],
  };
  for (const file of chapterFiles)
    entries[file.path] = [encoder.encode(file.xhtml), { mtime: modifiedAt }];

  return {
    bytes: zipSync(entries),
    previewHtml: previewDocument(metadata, chapters, sections, css),
    chapters,
    warnings,
  };
}
