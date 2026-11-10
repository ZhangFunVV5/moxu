import { z } from "zod";
import { chapterReviewStateSchema } from "./review-state";

/**
 * P1 作品与章节权威数据结构。
 *
 * 事实源：`book.json` 保存作品身份与章序，`chapters/<chapterId>.json` 保存单章正文、
 * 标题元数据和版本。导出的 Markdown / TXT 永远不是第二份可写事实源。
 */
export const SCHEMA_VERSION = 1 as const;

export const BOOK_FORMATS = ["txt", "markdown"] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

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
    encoding: z.string().min(1),
    eol: z.enum(["lf", "crlf"]),
    copy: z.string().min(1),
  })
  .strict();
export type BookSource = z.infer<typeof bookSourceSchema>;

export const bookFileSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    workspaceId: z.string().uuid(),
    bookTitle: z.string().min(1).max(200),
    format: z.enum(BOOK_FORMATS),
    chapterOrder: z.array(z.string().min(1)).min(1),
    source: bookSourceSchema,
    importSettings: importSettingsSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BookFile = z.infer<typeof bookFileSchema>;

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
  format: BookFormat;
  chapterOrder: string[];
  chapters: ChapterSummary[];
  source: BookSource;
  importSettings: ImportSettings;
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
