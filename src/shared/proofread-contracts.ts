import { z } from "zod";
import type { Block } from "./book";
import type { Result } from "./contracts";
import { PROOFREAD_CATEGORIES, proofreadOptionsSchema } from "./proofreading";
import type { ProofreadCategory, ProofreadOptions } from "./proofreading";

const chapterIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/, "非法章节 ID");
const hexHash = z.string().regex(/^[0-9a-f]{64}$/);
const patchIdSchema = z.string().regex(/^pt-[0-9a-f]{16}$/);

export const proofreadStartRequestSchema = z
  .object({
    chapterIds: z.array(chapterIdSchema).min(1).max(2000),
    options: proofreadOptionsSchema,
    naturalLanguage: z.string().max(2000).optional(),
  })
  .strict();
export type ProofreadStartRequest = z.infer<typeof proofreadStartRequestSchema>;

export const proofreadChapterRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    batchId: z.string().uuid().optional(),
  })
  .strict();

export const proofreadApplyRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    batchId: z.string().uuid(),
    operationId: z.string().uuid(),
    kind: z.enum(["accept", "ignore", "restore", "withdraw"]),
    commands: z
      .array(
        z
          .object({
            patchId: patchIdSchema,
            action: z.enum(["accept", "ignore", "restore", "withdraw"]),
          })
          .strict(),
      )
      .min(1)
      .max(500),
    reviewRevision: z.number().int().nonnegative(),
    expectedHeadHash: hexHash,
  })
  .strict();
export type ProofreadApplyRequest = z.infer<typeof proofreadApplyRequestSchema>;

export const proofreadBatchRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    batchId: z.string().uuid(),
    operationId: z.string().uuid(),
    category: z.enum(PROOFREAD_CATEGORIES),
    action: z.enum(["accept", "ignore"]),
    reviewRevision: z.number().int().nonnegative(),
    expectedHeadHash: hexHash,
  })
  .strict();
export type ProofreadBatchRequest = z.infer<typeof proofreadBatchRequestSchema>;

export const proofreadUndoRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    batchId: z.string().uuid(),
    operationId: z.string().uuid(),
    undoneOperationId: z.string().uuid().optional(),
    reviewRevision: z.number().int().nonnegative(),
    expectedHeadHash: hexHash,
  })
  .strict();
export type ProofreadUndoRequest = z.infer<typeof proofreadUndoRequestSchema>;

export const proofreadLocateRequestSchema = z
  .object({
    chapterId: chapterIdSchema,
    batchId: z.string().uuid(),
    patchId: patchIdSchema,
    reviewRevision: z.number().int().nonnegative(),
    expectedHeadHash: hexHash,
  })
  .strict();

export const proofreadBatchesRequestSchema = z
  .object({ chapterId: chapterIdSchema })
  .strict();

export const proofreadTaskRequestSchema = z
  .object({ taskId: z.string().uuid() })
  .strict();

export const proofreadReportRequestSchema = z
  .object({
    chapterIds: z.array(chapterIdSchema).min(1).max(2000),
  })
  .strict();

export interface ProofreadLocationDto {
  from: number;
  to: number;
  anchor: boolean;
  kind: "replacement" | "insertion" | "deletion" | "pending";
}

export interface ProofreadIssueDto {
  patchId: string;
  paragraphId: string;
  start: number;
  end: number;
  before: string;
  after: string;
  category: ProofreadCategory;
  reason: string;
  source: "model" | "rule";
  sources: Array<"model" | "rule">;
  decision: "pending" | "accepted" | "ignored";
  validity: "valid" | "conflict" | "stale" | "invalid";
  conflictWith: string[];
  locate: ProofreadLocationDto | null;
}

export interface ProofreadCountsDto {
  pending: number;
  accepted: number;
  ignored: number;
  total: number;
  conflict: number;
  stale: number;
}

export interface ChapterProofreadView {
  chapterId: string;
  title: string;
  state:
    | "unchecked"
    | "queued"
    | "running"
    | "waiting-review"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  stale: boolean;
  /** 所有目标块都已提交后才允许正式采纳。 */
  reviewReady: boolean;
  /** 历史批次只读查看，不允许动作。 */
  readOnly: boolean;
  batchId: string | null;
  batchCreatedAt?: string;
  taskId?: string;
  reviewRevision: number;
  expectedHeadHash: string;
  chapterBodyHash: string;
  bodyRevision: number;
  body: string;
  blocks: Block[];
  baseBody: string;
  baseBlocks: Block[];
  /** 当前批次使用的精校选项快照，用于“重新检查”预填。 */
  options: ProofreadOptions;
  counts: ProofreadCountsDto;
  issues: ProofreadIssueDto[];
  lastOperationId?: string;
  canUndo: boolean;
  errorCode?: string;
}

export interface ProofreadBatchSummary {
  batchId: string;
  taskId: string;
  createdAt: string;
  active: boolean;
  candidateCount: number;
}

export interface ProofreadBatchesDto {
  batches: ProofreadBatchSummary[];
}

export interface ProofreadSummaryChapter {
  chapterId: string;
  state: string;
  batchId: string | null;
  stale: boolean;
  pending: number;
  accepted: number;
  ignored: number;
  total: number;
  errorCode?: string;
}

export interface ProofreadTaskSummary {
  taskId: string;
  status: string;
  chapters: Array<{ chapterId: string; status: string; errorCode?: string }>;
}

export interface ProofreadSummaryDto {
  chapters: ProofreadSummaryChapter[];
  tasks: ProofreadTaskSummary[];
}

export interface ProofreadStartResult {
  taskId: string;
  options: ProofreadOptions;
  notes: string[];
}

export interface ProofreadEventDto {
  taskId: string;
  workspaceId: string;
  chapterId?: string;
  type:
    | "taskStarted"
    | "chapterStarted"
    | "blockStarted"
    | "toolStarted"
    | "toolFinished"
    | "usage"
    | "text"
    | "chapterStateChanged"
    | "taskStateChanged";
  blockId?: string;
  blockIndex?: number;
  blockTotal?: number;
  message: string;
  state?: "running" | "completed" | "failed" | "cancelled" | "waiting-review";
}

export interface ProofreadReportResult {
  cancelled: boolean;
  path?: string;
}

export interface DesktopProofreadApi {
  start(request: ProofreadStartRequest): Promise<Result<ProofreadStartResult>>;
  cancel(request: { taskId: string }): Promise<Result<null>>;
  resume(request: { taskId: string }): Promise<Result<{ taskId: string }>>;
  chapter(
    request: z.infer<typeof proofreadChapterRequestSchema>,
  ): Promise<Result<ChapterProofreadView>>;
  batches(
    request: z.infer<typeof proofreadBatchesRequestSchema>,
  ): Promise<Result<ProofreadBatchesDto>>;
  summary(): Promise<Result<ProofreadSummaryDto>>;
  apply(request: ProofreadApplyRequest): Promise<Result<ChapterProofreadView>>;
  batch(request: ProofreadBatchRequest): Promise<Result<ChapterProofreadView>>;
  undo(request: ProofreadUndoRequest): Promise<Result<ChapterProofreadView>>;
  locate(
    request: z.infer<typeof proofreadLocateRequestSchema>,
  ): Promise<Result<{ locate: ProofreadLocationDto | null; stale: boolean }>>;
  exportReport(
    request: z.infer<typeof proofreadReportRequestSchema>,
  ): Promise<Result<ProofreadReportResult>>;
  recover(): Promise<Result<{ interrupted: string[] }>>;
  onEvent(callback: (event: ProofreadEventDto) => void): () => void;
}

