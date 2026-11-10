import type {
  BookFormat,
  BookMetadata,
  ChapterKind,
  ConversionNotice,
  EpubTocSource,
  EpubVersion,
  ParagraphMode,
  SourceFormat,
  SplitMode,
} from "../../shared/book";
import { countCodePoints } from "../../shared/book";
import { hashBody, sha256Hex } from "../text/hash";
import {
  decodeBuffer,
  decodeWith,
  type EncodingCandidate,
  type SupportedEncoding,
} from "./encoding";
import { parseTxtChapters } from "./txt-parser";
import { parseMarkdownChapters } from "./markdown-parser";
import { segmentBody, type ParsedSegment } from "./segments";

export interface ImportSource {
  fileName: string;
  format: SourceFormat;
  bytes: Uint8Array;
}

export interface ImportOptions {
  /** null = 自动识别；显式指定时按用户选择解码。 */
  encoding: SupportedEncoding | null;
  splitMode: SplitMode;
  paragraphMode: ParagraphMode;
  /** Markdown 标题层级；0 = 自动。TXT 忽略。 */
  headingLevel: number;
}

/** EPUB 没有整文件编码或文本分章参数；分章来自书籍结构，选项只保留来源标记。 */
export interface EpubImportOptions {
  source: "epub";
}

export interface ImportSegmentPreview {
  index: number;
  title: string;
  kind: ChapterKind;
  charCount: number;
  excerpt: string;
}

export interface ImportGroupPreview {
  startSegment: number;
  endSegment: number;
  title: string;
  kind: ChapterKind;
  charCount: number;
  excerpt: string;
  bodyHash: string;
}

interface ImportPreviewBase {
  fileName: string;
  /** 来源格式；正文表示另由工作区 bodyFormat 记录。 */
  format: SourceFormat;
  byteLength: number;
  sourceSha256: string;
  totalChars: number;
  segments: ImportSegmentPreview[];
  groups: ImportGroupPreview[];
}

export interface TextImportPreview extends ImportPreviewBase {
  kind: "text";
  encoding: SupportedEncoding;
  candidates: EncodingCandidate[];
  requiresChoice: boolean;
  replacements: number;
  eol: "lf" | "crlf";
  headingLevel: number;
  options: ImportOptions;
}

/** EPUB 预览：不含整文件文本编码，明确展示元数据、导航来源与转换提示。 */
export interface EpubImportPreview extends ImportPreviewBase {
  kind: "epub";
  metadata: BookMetadata;
  version: EpubVersion;
  tocSource: EpubTocSource;
  spineCount: number;
  notices: ConversionNotice[];
  options: EpubImportOptions;
}

export type ImportPreview = TextImportPreview | EpubImportPreview;

export interface ImportChapter {
  title: string;
  /** 来源标题；用户可在预览中改名，但保留原始章标题供元数据审计。 */
  sourceTitle?: string;
  kind: ChapterKind;
  body: string;
}

export class ImportError extends Error {
  readonly code:
    | "UNSUPPORTED_FORMAT"
    | "INVALID_BOUNDARIES"
    | "EMPTY_RESULT"
    | "SETTINGS_MISMATCH";
  constructor(code: ImportError["code"], message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

function excerptOf(body: string, limit = 120): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= limit ? flat : `${chars.slice(0, limit).join("")}…`;
}

function parseSegments(
  source: ImportSource,
  text: string,
  options: ImportOptions,
): { lines: string[]; segments: ParsedSegment[]; headingLevel: number } {
  if (source.format === "epub")
    throw new ImportError(
      "UNSUPPORTED_FORMAT",
      "EPUB 来源必须使用 EPUB 解析与分章流程",
    );
  if (source.format === "txt") {
    const parsed = parseTxtChapters(text, options.splitMode);
    return { ...parsed, headingLevel: 0 };
  }
  const parsed = parseMarkdownChapters(text, {
    splitMode: options.splitMode,
    headingLevel: options.headingLevel,
  });
  return parsed;
}

/**
 * 导入预览：解码 → 分章 → 输出章节边界和每段摘要。绝不写入工作区。
 * 用户可在 GUI 中合并相邻段、改标题，再按同一解析结果正式创建作品。
 */
export function buildImportPreview(
  source: ImportSource,
  options: ImportOptions,
  boundaries?: readonly number[],
): TextImportPreview {
  if (source.format === "epub")
    throw new ImportError(
      "UNSUPPORTED_FORMAT",
      "EPUB 来源必须使用 EPUB 解析与分章流程",
    );
  let decoded: {
    encoding: SupportedEncoding;
    text: string;
    eol: "lf" | "crlf";
    candidates: EncodingCandidate[];
    requiresChoice: boolean;
    replacements: number;
  };
  if (options.encoding) {
    const selected = decodeWith(source.bytes, options.encoding);
    decoded = {
      encoding: options.encoding,
      text: selected.text,
      eol: selected.eol,
      candidates: [],
      requiresChoice: selected.replacements > 0,
      replacements: selected.replacements,
    };
  } else {
    decoded = decodeBuffer(source.bytes);
  }
  const encoding = decoded.encoding;
  const parsed = parseSegments(source, decoded.text, options);
  const totalChars = countCodePoints(decoded.text);

  const bodies = parsed.segments.map((segment) =>
    segmentBody(parsed.lines, segment, { dropHeading: true }),
  );
  const segments: ImportSegmentPreview[] = parsed.segments.map((segment, index) => ({
    index: segment.index,
    title: segment.title,
    kind: segment.kind,
    charCount: countCodePoints(bodies[index]),
    excerpt: excerptOf(bodies[index]),
  }));
  const starts = boundaries ?? parsed.segments.map((segment) => segment.index);
  const chapters = assembleParsedChapters(parsed, starts);
  const groups: ImportGroupPreview[] = chapters.map((chapter, index) => ({
    startSegment: starts[index],
    endSegment: (starts[index + 1] ?? parsed.segments.length) - 1,
    title: chapter.title,
    kind: chapter.kind,
    charCount: countCodePoints(chapter.body),
    excerpt: excerptOf(chapter.body),
    bodyHash: hashBody(chapter.body),
  }));

  return {
    kind: "text",
    fileName: source.fileName,
    format: source.format,
    byteLength: source.bytes.byteLength,
    sourceSha256: sha256Hex(source.bytes),
    encoding,
    candidates: decoded.candidates,
    requiresChoice: options.encoding ? decoded.replacements > 0 : decoded.requiresChoice,
    replacements: decoded.replacements,
    eol: decoded.eol,
    totalChars,
    headingLevel: parsed.headingLevel,
    options,
    segments,
    groups,
  };
}

export interface AssembleResult {
  chapters: ImportChapter[];
  preview: TextImportPreview;
}

function validateBoundaries(boundaries: readonly number[], segmentCount: number): void {
  if (boundaries.length === 0) throw new ImportError("INVALID_BOUNDARIES", "缺少分章边界");
  if (boundaries[0] !== 0) throw new ImportError("INVALID_BOUNDARIES", "首个分章边界必须为 0");
  for (let i = 0; i < boundaries.length; i += 1) {
    const value = boundaries[i];
    if (!Number.isInteger(value) || value < 0 || value >= segmentCount)
      throw new ImportError("INVALID_BOUNDARIES", "分章边界超出范围");
    if (i > 0 && value <= boundaries[i - 1])
      throw new ImportError("INVALID_BOUNDARIES", "分章边界必须严格递增");
  }
}

/**
 * 按预览的同一份字节、同一组选项和用户确认的边界生成章节正文。
 * 合并章节时把相邻段的原文用换行连接，正文不丢字；标题取该组第一个可编辑标题。
 */
export function assembleImportChapters(
  source: ImportSource,
  options: ImportOptions,
  boundaries: readonly number[],
  titles: Readonly<Record<number, string>> = {},
): AssembleResult {
  const preview = buildImportPreview(source, options, boundaries);
  const decoded = options.encoding
    ? decodeWith(source.bytes, options.encoding).text
    : decodeBuffer(source.bytes).text;
  const parsed = parseSegments(source, decoded, options);
  return { chapters: assembleParsedChapters(parsed, boundaries, titles), preview };
}

/** 预览与正式创建共用正文组装，保留合并后续段的原始标题和连接换行。 */
function assembleParsedChapters(
  parsed: { lines: string[]; segments: ParsedSegment[] },
  boundaries: readonly number[],
  titles: Readonly<Record<number, string>> = {},
): ImportChapter[] {
  validateBoundaries(boundaries, parsed.segments.length);

  const bodies = parsed.segments.map((segment) =>
    segmentBody(parsed.lines, segment, { dropHeading: true }),
  );
  const chapters: ImportChapter[] = [];
  for (const [index, start] of boundaries.entries()) {
    const endExclusive =
      index + 1 < boundaries.length ? boundaries[index + 1] : parsed.segments.length;
    const groupBodies: string[] = [];
    for (let segmentIndex = start; segmentIndex < endExclusive; segmentIndex += 1) {
      // 组内首段的标题行进入 title 元数据，正文不再重复；被合并的后续段保留自己的标题行。
      groupBodies.push(
        segmentIndex === start
          ? bodies[segmentIndex]
          : segmentBody(parsed.lines, parsed.segments[segmentIndex]),
      );
    }
    const body = groupBodies.join("\n\n").replace(/\n+$/, "");
    const title = (titles[start] ?? parsed.segments[start].title).trim();
    chapters.push({
      title: title || `未命名章节 ${index + 1}`,
      sourceTitle: parsed.segments[start].title,
      kind: parsed.segments[start].kind,
      body,
    });
  }
  if (chapters.length === 0) throw new ImportError("EMPTY_RESULT", "导入结果没有章节");
  return chapters;
}
