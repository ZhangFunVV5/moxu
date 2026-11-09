import { z } from "zod";
import {
  titleOptionsSchema,
  summaryOptionsSchema,
  type GenerateArtifactView,
} from "./generate";
import type { TaskState } from "../agent/tasks/task-store";
const chapterId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const generateStartRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("title"),
      chapterIds: z.array(chapterId).min(1).max(2000),
      options: titleOptionsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("summary"),
      chapterIds: z.array(chapterId).min(1).max(2000),
      options: summaryOptionsSchema,
    })
    .strict(),
]);
export type GenerateStartRequest = z.infer<typeof generateStartRequestSchema>;
export const generateChapterRequestSchema = z.object({ chapterId }).strict();
export const generateTaskRequestSchema = z
  .object({ taskId: z.string().uuid() })
  .strict();
export const generateSelectTitleRequestSchema = z
  .object({
    chapterId,
    artifactId: z.string().uuid(),
    candidateIndex: z.number().int().min(-1),
    editedTitle: z.string().max(400).optional(),
    expectedBodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    expectedTitleRevision: z.number().int().positive(),
  })
  .strict();
export type GenerateSelectTitleRequest = z.infer<
  typeof generateSelectTitleRequestSchema
>;
export const generateExportRequestSchema = z
  .object({ chapterIds: z.array(chapterId).min(1).max(2000) })
  .strict();
export interface ChapterGenerateView {
  chapterId: string;
  currentTitle: string;
  titleRevision: number;
  bodyHash: string;
  artifacts: GenerateArtifactView[];
  selectedArtifactId?: string;
  selectedTitle?: string;
}
export interface GenerateEventDto {
  workspaceId: string;
  taskId: string;
  chapterId?: string;
  type:
    | "taskStarted"
    | "taskStateChanged"
    | "chapterUpdated"
    | "toolStarted"
    | "toolFinished"
    | "usage"
    | "text";
  message: string;
  state?: TaskState;
}
export interface GenerateSummaryDto {
  chapters: Array<{
    chapterId: string;
    titleCount: number;
    hasSummary: boolean;
    stale: boolean;
  }>;
  tasks: Array<{
    taskId: string;
    kind: "title" | "summary";
    state: TaskState;
    chapterIds: string[];
  }>;
}
export interface GenerateExportResult {
  cancelled: boolean;
  path?: string;
}
import type { Result } from "./contracts";
export interface DesktopGenerateApi {
  start(request: GenerateStartRequest): Promise<Result<{ taskId: string }>>;
  resume(request: { taskId: string }): Promise<Result<{ taskId: string }>>;
  cancel(request: { taskId: string }): Promise<Result<null>>;
  chapter(request: { chapterId: string }): Promise<Result<ChapterGenerateView>>;
  summary(): Promise<Result<GenerateSummaryDto>>;
  selectTitle(
    request: GenerateSelectTitleRequest,
  ): Promise<Result<ChapterGenerateView>>;
  exportSummaries(request: {
    chapterIds: string[];
  }): Promise<Result<GenerateExportResult>>;
  recover(): Promise<Result<{ interrupted: string[] }>>;
  onEvent(listener: (event: GenerateEventDto) => void): () => void;
}

