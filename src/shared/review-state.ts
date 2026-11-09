import { z } from "zod";

/**
 * 单章权威文件内的审阅状态。
 *
 * 事实源只有 `chapters/<chapterId>.json`：正文、已采纳集合、审阅决议和操作
 * 记录在同一次原子写入中提交，避免“正文已改、决议未落盘”的两份事实源。
 * `edits/<batchId>.json` 只保存不可变基础正文与候选。
 *
 * 决议只记录 accepted / ignored；没有记录的候选视为 pending（待审）。
 */
export const REVIEW_DECISIONS = ["accepted", "ignored"] as const;
export const reviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const reviewOperationKindSchema = z.enum([
  "accept",
  "ignore",
  "restore",
  "withdraw",
  "batch-accept",
  "batch-ignore",
  "auto-apply",
]);
export type ReviewOperationKind = z.infer<typeof reviewOperationKindSchema>;

const headHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const reviewStateValueSchema = z.enum([
  "pending",
  "accepted",
  "ignored",
]);
export type ReviewStateValue = z.infer<typeof reviewStateValueSchema>;

export const reviewOperationSchema = z
  .object({
    operationId: z.string().uuid(),
    kind: reviewOperationKindSchema,
    /** 本次操作实际作用的候选；批量操作也展开为明确 ID。 */
    patchIds: z.array(z.string().min(1)).min(1).max(5000),
    /** kind + 规范化 patchIds 的指纹，用于同一 operationId 的幂等比对。 */
    requestHash: headHashSchema,
    /** 操作前受影响候选的决议快照，供“撤回上次操作”恢复。 */
    previousStates: z.record(z.string(), reviewStateValueSchema),
    resultHeadHash: headHashSchema,
    resultReviewRevision: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict();
export type ReviewOperation = z.infer<typeof reviewOperationSchema>;

export const reviewUndoSchema = z
  .object({
    operationId: z.string().uuid(),
    undoneOperationId: z.string().uuid(),
    /** 新记录保存被撤回操作，旧记录兼容缺省；用于去重与报告。 */
    undoneOperation: reviewOperationSchema.optional(),
    /** undo 请求指纹；同一 operationId 的不同请求被拒绝。 */
    requestHash: headHashSchema,
    restoredHeadHash: headHashSchema,
    restoredReviewRevision: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict();
export type ReviewUndo = z.infer<typeof reviewUndoSchema>;

export const chapterReviewStateSchema = z
  .object({
    batchId: z.string().uuid(),
    /** 批次输入指纹；与 edits/<batchId>.json 一致，用于识别串批次写入。 */
    inputFingerprint: headHashSchema,
    reviewRevision: z.number().int().nonnegative(),
    /** 本批次最近一次成功提交后的工作正文 hash。 */
    expectedHeadHash: headHashSchema,
    decisions: z.record(z.string(), reviewDecisionSchema),
    acceptedPatchIds: z.array(z.string().min(1)),
    operations: z.array(reviewOperationSchema).max(5000),
    undos: z.array(reviewUndoSchema).max(5000),
    lastOperationId: z.string().uuid().optional(),
  })
  .strict();
export type ChapterReviewState = z.infer<typeof chapterReviewStateSchema>;
