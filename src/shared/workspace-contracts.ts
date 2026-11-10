import { z } from "zod";
import type { ChapterSummary } from "./book";
import {
  PARAGRAPH_MODES,
  SOURCE_FORMATS,
  SPLIT_MODES,
} from "./book";
import { TASK_TYPES, taskOptionsSchema } from "./task";
import { SUPPORTED_ENCODINGS } from "./encoding";
import type { ImportPreview } from "../core/import/import-pipeline";
import type { ChapterDetail, WorkspaceInfo } from "./book";

const chapterIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "非法章节 ID");
const boundariesSchema = z.array(z.number().int().nonnegative()).min(1).max(5000);

/** 文本来源需要整文件编码与文本分章参数；EPUB 由书籍结构决定，不接受这些参数。 */
export const textPreviewRequestSchema = z
  .object({
    kind: z.literal("text"),
    token: z.string().uuid(),
    encoding: z.enum(SUPPORTED_ENCODINGS).nullable(),
    splitMode: z.enum(SPLIT_MODES),
    paragraphMode: z.enum(PARAGRAPH_MODES),
    headingLevel: z.number().int().min(0).max(6),
    boundaries: boundariesSchema.optional(),
  })
  .strict();
export const epubPreviewRequestSchema = z
  .object({
    kind: z.literal("epub"),
    token: z.string().uuid(),
    boundaries: boundariesSchema.optional(),
  })
  .strict();
export const previewRequestSchema = z.discriminatedUnion("kind", [
  textPreviewRequestSchema,
  epubPreviewRequestSchema,
]);
export type TextPreviewRequest = z.infer<typeof textPreviewRequestSchema>;
export type EpubPreviewRequest = z.infer<typeof epubPreviewRequestSchema>;
export type PreviewRequest = z.infer<typeof previewRequestSchema>;

export const createWorkspaceRequestSchema = z
  .object({
    previewToken: z.string().uuid(),
    bookTitle: z.string().trim().min(1).max(200),
    boundaries: boundariesSchema,
    titles: z.record(z.string(), z.string().max(200)).optional(),
  })
  .strict();
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const chapterRequestSchema = z
  .object({ chapterId: chapterIdSchema })
  .strict();
export type ChapterRequest = z.infer<typeof chapterRequestSchema>;

export const saveChapterRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    baseRevision: z.number().int().positive(),
    body: z.string().max(4_000_000),
  })
  .strict();
export type SaveChapterRequest = z.infer<typeof saveChapterRequestSchema>;

export const renameChapterRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export type RenameChapterRequest = z.infer<typeof renameChapterRequestSchema>;

export const prepareTaskRequestSchema = z
  .object({
    type: z.enum(TASK_TYPES),
    chapterIds: z.array(chapterIdSchema).min(1).max(2000),
    options: taskOptionsSchema,
    profileVersion: z.string().min(1).max(120),
    modelConfigId: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PrepareTaskRequest = z.infer<typeof prepareTaskRequestSchema>;

export interface PreparedTask {
  taskId: string;
  type: z.infer<typeof prepareTaskRequestSchema>["type"];
  chapterIds: string[];
  inputFingerprint: string;
  specPath: string;
  states: Record<string, string>;
}

export const sourceFormatSchema = z.enum(SOURCE_FORMATS);
export type SourceFormatValue = z.infer<typeof sourceFormatSchema>;

export interface SourceSelection {
  token: string;
  fileName: string;
  format: SourceFormatValue;
  byteLength: number;
}

/** 文本与 EPUB 预览是两种内容；保留 previewToken 统一提交入口。 */
export type ImportPreviewResponse = ImportPreview & {
  previewToken: string;
};

export interface RecentWorkspace {
  root: string;
  title: string;
  openedAt: string;
}

export type WorkspaceState = WorkspaceInfo;
export type { ChapterDetail, ChapterSummary };

export interface DesktopWorkspaceApi {
  state(): Promise<
    { ok: true; data: WorkspaceState | null } | { ok: false; error: { code: string; message: string } }
  >;
  chooseSource(): Promise<
    | { ok: true; data: SourceSelection | null }
    | { ok: false; error: { code: string; message: string } }
  >;
  preview(
    request: PreviewRequest,
  ): Promise<
    | { ok: true; data: ImportPreviewResponse }
    | { ok: false; error: { code: string; message: string } }
  >;
  create(
    request: CreateWorkspaceRequest,
  ): Promise<
    | { ok: true; data: WorkspaceState }
    | { ok: false; error: { code: string; message: string } }
  >;
  open(): Promise<
    | { ok: true; data: WorkspaceState | null }
    | { ok: false; error: { code: string; message: string } }
  >;
  close(): Promise<
    { ok: true; data: null } | { ok: false; error: { code: string; message: string } }
  >;
  recent(): Promise<
    | { ok: true; data: RecentWorkspace[] }
    | { ok: false; error: { code: string; message: string } }
  >;
}

export interface DesktopChapterApi {
  get(
    request: ChapterRequest,
  ): Promise<
    | { ok: true; data: ChapterDetail }
    | { ok: false; error: { code: string; message: string } }
  >;
  save(
    request: SaveChapterRequest,
  ): Promise<
    | { ok: true; data: ChapterDetail }
    | { ok: false; error: { code: string; message: string } }
  >;
  rename(
    request: RenameChapterRequest,
  ): Promise<
    | { ok: true; data: ChapterSummary }
    | { ok: false; error: { code: string; message: string } }
  >;
}

export interface DesktopTaskApi {
  prepare(
    request: PrepareTaskRequest,
  ): Promise<
    | { ok: true; data: PreparedTask }
    | { ok: false; error: { code: string; message: string } }
  >;
}
