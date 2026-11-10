import { z } from "zod";
import { chapterReviewStateSchema } from "./review-state";

/**
 * P1 作品与章节权威数据结构。
 *
 * 事实源：`book.json` 保存作品身份与章序，`chapters/<chapterId>.json` 保存单章正文、
 * 标题元数据和版本。导出的 Markdown / TXT 永远不是第二份可写事实源。
 */
export const SCHEMA_VERSION = 1 as const;

/**
 * 来源、正文与导出格式是三个独立职责：
 * - 来源格式记录用户导入的是什么文件；
 * - 正文格式记录工作区章节 JSON 里的 body 如何派生段落（EPUB 一律转为 Markdown）；
 * - 导出格式是本次输出的目标，可独立选择 EPUB。
 * 旧工作区没有 bodyFormat 时按来源格式回退，语义与 v0.1.1 一致。
 */
export const SOURCE_FORMATS = ["txt", "markdown", "epub"] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];
/** 兼容旧引用：BookFormat 现在指来源格式。 */
export type BookFormat = SourceFormat;
export const BOOK_FORMATS = SOURCE_FORMATS;

export const BODY_FORMATS = ["txt", "markdown"] as const;
export type BodyFormat = (typeof BODY_FORMATS)[number];

export const EXPORT_FORMATS = ["txt", "markdown", "epub"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const DEFAULT_BOOK_LANGUAGE = "zh";

/** BCP 47 的宽松校验：zh、zh-CN、en-US；拒绝空白和路径字符。 */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/** 导出与预览使用的完整元数据；title 默认取 bookTitle。 */
export const bookMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    language: z.string().trim().regex(LANGUAGE_PATTERN, "语言需为 BCP 47 标记"),
    authors: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
  })
  .strict();
export type BookMetadata = z.infer<typeof bookMetadataSchema>;

/** 持久化在 book.json 的元数据子集：书名仍是 bookTitle，避免两份标题事实源。 */
export const storedBookMetadataSchema = z
  .object({
    language: z.string().trim().regex(LANGUAGE_PATTERN, "语言需为 BCP 47 标记"),
    authors: z.array(z.string().trim().min(1).max(200)).max(32).optional(),
  })
  .strict();
export type StoredBookMetadata = z.infer<typeof storedBookMetadataSchema>;

export const EPUB_TOC_SOURCES = ["nav", "ncx", "none"] as const;
export type EpubTocSource = (typeof EPUB_TOC_SOURCES)[number];

export const EPUB_VERSIONS = ["2", "3"] as const;
export type EpubVersion = (typeof EPUB_VERSIONS)[number];

/** 导入转换提示：任何不能完整转换的内容都按章节记录，不静默丢弃。 */
export const CONVERSION_NOTICE_CODES = [
  "image-dropped",
  "media-dropped",
  "table-flattened",
  "footnote-flattened",
  "ruby-flattened",
  "inline-style-flattened",
  "unsupported-content-flattened",
  "internal-link-degraded",
  "external-link-degraded",
  "empty-chapter-skipped",
  "nav-invalid-anchor",
  "toc-target-outside-spine",
  "toc-unreadable",
  "non-text-spine-item",
  "fonts-obfuscated-ignored",
] as const;
export type ConversionNoticeCode = (typeof CONVERSION_NOTICE_CODES)[number];

export const conversionNoticeSchema = z
  .object({
    code: z.enum(CONVERSION_NOTICE_CODES),
    count: z.number().int().positive(),
    /** 0 基导入章序；空表示整书级提示。 */
    chapters: z.array(z.number().int().nonnegative()).max(5000),
    message: z.string().trim().min(1).max(500),
  })
  .strict();
export type ConversionNotice = z.infer<typeof conversionNoticeSchema>;

export const epubImportInfoSchema = z
  .object({
    kind: z.literal("epub"),
    version: z.enum(EPUB_VERSIONS),
    tocSource: z.enum(EPUB_TOC_SOURCES),
    spineCount: z.number().int().nonnegative(),
    notices: z.array(conversionNoticeSchema).max(200),
  })
  .strict();
export type EpubImportInfo = z.infer<typeof epubImportInfoSchema>;

export const CHAPTER_KINDS = [
  "chapter",
  "volume",
  "frontmatter",
  "extra",
] as const;
export type ChapterKind = (typeof CHAPTER_KINDS)[number];

export const BLOCK_KINDS = [
  "paragraph",
  "heading",
  "code",
  "list",
  "quote",
  "separator",
  "html",
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const PARAGRAPH_MODES = ["line", "blank"] as const;
export type ParagraphMode = (typeof PARAGRAPH_MODES)[number];

export const SPLIT_MODES = ["auto", "single"] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];

/**
 * 段落／特殊块。start / end 是本章正文（`ChapterFile.body`）内的 UTF-16 code unit
 * 偏移，左闭右开；正文本身由 `body` 保存，块文本等于 `body.slice(start, end)`。
 */
export const blockSchema = z
  .object({
    id: z.string().regex(/^p[1-9][0-9]*$/, "段落 ID 必须形如 p1"),
    kind: z.enum(BLOCK_KINDS),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict();
export type Block = z.infer<typeof blockSchema>;

export const titleMetaSchema = z
  .object({
    current: z.string().min(1).max(200),
    source: z.string().min(1).max(200),
  })
  .strict();
export type TitleMeta = z.infer<typeof titleMetaSchema>;

export const chapterFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    workspaceId: z.string().uuid(),
    chapterId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "非法章节 ID"),
    order: z.number().int().nonnegative(),
    kind: z.enum(CHAPTER_KINDS),
    title: titleMetaSchema,
    body: z.string(),
    blocks: z.array(blockSchema),
    bodyRevision: z.number().int().positive(),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    titleApplication: z
      .object({
        taskId: z.string().uuid(),
        artifactId: z.string().uuid(),
        candidateIndex: z.number().int().nonnegative(),
        title: z.string(),
        titleRevision: z.number().int().positive(),
        bodyHash: z.string(),
      })
      .strict()
      .optional(),
    titleRevision: z.number().int().positive(),
    /**
     * P3 审阅状态：正文、已采纳集合、决议和操作记录与本章同一次原子提交。
     * 可选，保证 P1/P2 已创建的章节文件仍可打开。
     */
    review: chapterReviewStateSchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type ChapterFile = z.infer<typeof chapterFileSchema>;

export const importSettingsSchema = z
  .object({
    splitMode: z.enum(SPLIT_MODES),
    paragraphMode: z.enum(PARAGRAPH_MODES),
    headingLevel: z.number().int().min(0).max(6),
    boundaries: z.array(z.number().int().nonnegative()),
  })
  .strict();
export type ImportSettings = z.infer<typeof importSettingsSchema>;

export const bookSourceSchema = z
  .object({
    fileName: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** 文本来源的整文件编码；EPUB 是 ZIP 容器，不记作文本编码。 */
    encoding: z.string().min(1).optional(),
    /** 文本来源的换行符；EPUB 不适用。 */
    eol: z.enum(["lf", "crlf"]).optional(),
    copy: z.string().min(1),
  })
  .strict();
export type BookSource = z.infer<typeof bookSourceSchema>;

export const bookFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    workspaceId: z.string().uuid(),
    bookTitle: z.string().min(1).max(200),
    /** 来源格式；旧工作区只有 txt / markdown。 */
    format: z.enum(SOURCE_FORMATS),
    /** 正文表示；缺省时按来源格式回退，EPUB 导入必须显式写 markdown。 */
    bodyFormat: z.enum(BODY_FORMATS).optional(),
    chapterOrder: z.array(z.string().min(1)).min(1),
    source: bookSourceSchema,
    metadata: storedBookMetadataSchema.optional(),
    importSettings: importSettingsSchema,
    importInfo: epubImportInfoSchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BookFile = z.infer<typeof bookFileSchema>;

/** 旧工作区缺少 bodyFormat：按原来源格式派生，保证既有编辑/精校语义不变。 */
export function bodyFormatOf(
  book: Pick<BookFile, "format" | "bodyFormat">,
): BodyFormat {
  if (book.bodyFormat) return book.bodyFormat;
  return book.format === "markdown" ? "markdown" : "txt";
}

/** 组成完整导出元数据；title 始终取当前 bookTitle。 */
export function bookMetadataOf(
  book: Pick<BookFile, "bookTitle" | "metadata">,
): BookMetadata {
  const authors = book.metadata?.authors?.filter((author) => author.trim());
  return {
    title: book.bookTitle,
    language: book.metadata?.language ?? DEFAULT_BOOK_LANGUAGE,
    ...(authors && authors.length ? { authors: [...authors] } : {}),
  };
}

export interface ChapterSummary {
  chapterId: string;
  order: number;
  kind: ChapterKind;
  title: string;
  sourceTitle: string;
  charCount: number;
  bodyRevision: number;
  bodyHash: string;
  titleRevision: number;
  /** 精校待审数量；P1 尚无审阅数据，恒为 0，不伪造。 */
  pendingReview: number;
  taskState:
    | "unchecked"
    | "running"
    | "waiting-review"
    | "completed"
    | "failed";
}

export interface ChapterDetail extends ChapterSummary {
  body: string;
  blocks: Block[];
}

export interface WorkspaceInfo {
  workspaceId: string;
  root: string;
  bookTitle: string;
  format: SourceFormat;
  bodyFormat: BodyFormat;
  metadata: BookMetadata;
  chapterOrder: string[];
  chapters: ChapterSummary[];
  source: BookSource;
  importSettings: ImportSettings;
  importInfo?: EpubImportInfo;
  createdAt: string;
  updatedAt: string;
}

export function countCodePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function toChapterSummary(
  chapter: ChapterFile,
  pendingReview = 0,
  taskState: ChapterSummary["taskState"] = "unchecked",
): ChapterSummary {
  return {
    chapterId: chapter.chapterId,
    order: chapter.order,
    kind: chapter.kind,
    title: chapter.title.current,
    sourceTitle: chapter.title.source,
    charCount: countCodePoints(chapter.body),
    bodyRevision: chapter.bodyRevision,
    bodyHash: chapter.bodyHash,
    titleRevision: chapter.titleRevision,
    pendingReview,
    taskState,
  };
}

export function toChapterDetail(
  chapter: ChapterFile,
  pendingReview = 0,
): ChapterDetail {
  return {
    ...toChapterSummary(chapter, pendingReview),
    body: chapter.body,
    blocks: chapter.blocks,
  };
}
