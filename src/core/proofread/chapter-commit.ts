import { randomUUID } from "node:crypto";
import { bodyFormatOf, type ChapterFile } from "../../shared/book";
import {
  ProofreadError,
  type ChapterProofreadBatch,
  type StoredEditCandidate,
} from "../../shared/proofreading";
import type {
  ChapterReviewState,
  ReviewOperation,
  ReviewOperationKind,
  ReviewStateValue,
} from "../../shared/review-state";
import { canonicalJson } from "../../shared/task";
import { hashBody, sha256Hex } from "../text/hash";
import { deriveBlocks } from "../text/structure";
import {
  chapterIntegrityProblems,
  readBookFile,
  readChapterFile,
  withChapterWriteLock,
  writeChapterFile,
} from "../workspace/book-store";
import { archiveBatchReview, loadBatch } from "./batch-store";
import { projectBody, type ProjectablePatch } from "./body-projector";
import {
  applyReviewCommands,
  assertAcceptedConsistency,
  deriveAcceptedPatchIds,
  type ReviewCommand,
} from "./review-service";

async function writeChapterSafely(
  root: string,
  chapter: ChapterFile,
): Promise<void> {
  try {
    await writeChapterFile(root, chapter);
  } catch {
    throw new ProofreadError(
      "WRITE_FAILED",
      "审阅提交失败，未写入；旧正文与决议保持不变，请检查文件权限后重试",
      chapter.chapterId,
    );
  }
}

export function reviewRequestHash(
  kind: ReviewOperationKind,
  patchIds: readonly string[],
): string {
  return sha256Hex(canonicalJson({ kind, patchIds: [...patchIds].sort() }));
}

function acceptedPatches(
  candidates: readonly StoredEditCandidate[],
  acceptedPatchIds: readonly string[],
): ProjectablePatch[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.patchId, candidate]),
  );
  return acceptedPatchIds.map((patchId) => {
    const candidate = byId.get(patchId);
    if (!candidate)
      throw new ProofreadError(
        "INVALID_REVIEW_STATE",
        "已采纳集合引用了批次中不存在的意见",
        patchId,
      );
    return {
      patchId: candidate.patchId,
      paragraphId: candidate.paragraphId,
      start: candidate.start,
      end: candidate.end,
      before: candidate.before,
      after: candidate.after,
    };
  });
}

function nextChapterBody(
  chapter: ChapterFile,
  baseBody: string,
  baseBlocks: ChapterFile["blocks"],
  patches: readonly ProjectablePatch[],
  format: "txt" | "markdown",
  paragraphMode: "line" | "blank",
): {
  body: string;
  blocks: ChapterFile["blocks"];
  bodyHash: string;
  bodyRevision: number;
  changed: boolean;
} {
  const projection = projectBody(baseBody, baseBlocks, patches);
  const body = projection.body;
  const changed = body !== chapter.body;
  const blocks = deriveBlocks(format, body, paragraphMode);
  return {
    body,
    blocks,
    bodyHash: hashBody(body),
    bodyRevision: changed ? chapter.bodyRevision + 1 : chapter.bodyRevision,
    changed,
  };
}

/**
 * PF-03／PF-07 创建新批次引用：章节权威文件记录 activeReviewBatchId。
 * 旧批次的最后审阅状态先归档到旧批次文件，保证旧意见仍按真实决议可查看。
 */
export async function attachBatchToChapter(
  root: string,
  batch: ChapterProofreadBatch,
): Promise<ChapterFile> {
  return withChapterWriteLock(root, batch.chapterId, async () => {
    const book = await readBookFile(root);
    const chapter = await readChapterFile(root, book, batch.chapterId);
    if (
      chapter.bodyHash !== batch.baseBodyHash ||
      chapter.bodyRevision !== batch.baseRevision
    )
      throw new ProofreadError(
        "STALE_BATCH",
        "章节正文已变化，不能把旧快照作为新批次基础",
        `${chapter.chapterId}`,
      );
    if (chapter.review && chapter.review.batchId !== batch.batchId) {
      try {
        await archiveBatchReview(root, chapter.review.batchId, chapter.review);
      } catch (error) {
        if (
          !(error instanceof ProofreadError) ||
          error.code !== "BATCH_NOT_FOUND"
        )
          throw error;
      }
    }
    const review: ChapterReviewState = {
      batchId: batch.batchId,
      inputFingerprint: batch.inputFingerprint,
      reviewRevision: 0,
      expectedHeadHash: batch.baseBodyHash,
      decisions: {},
      acceptedPatchIds: [],
      operations: [],
      undos: [],
    };
    const next: ChapterFile = {
      ...chapter,
      review,
      updatedAt: new Date().toISOString(),
    };
    const problems = chapterIntegrityProblems(next);
    if (problems.length)
      throw new ProofreadError(
        "INVALID_REVIEW_STATE",
        "批次引用写入前校验失败",
        problems.join("；"),
      );
    await writeChapterSafely(root, next);
    return next;
  });
}

export interface ApplyReviewOperationInput {
  chapterId: string;
  /** 调用方确认的活动批次；与章节当前批次不一致时拒绝。 */
  batchId?: string;
  operationId: string;
  kind: ReviewOperationKind;
  commands: readonly ReviewCommand[];
  batchCategory?: StoredEditCandidate["category"];
  reviewRevision: number;
  expectedHeadHash: string;
}

export interface ReviewCommitResult {
  chapter: ChapterFile;
  operation?: ReviewOperation;
  replayed: boolean;
}

function assertCurrentReview(
  chapter: ChapterFile,
  input: { reviewRevision: number; expectedHeadHash: string },
): ChapterReviewState {
  const review = chapter.review;
  if (!review)
    throw new ProofreadError("NO_ACTIVE_BATCH", "本章没有活动的精校批次");
  if (review.reviewRevision !== input.reviewRevision)
    throw new ProofreadError(
      "STALE_REVIEW",
      "审阅状态已变化，请刷新后再操作",
      `期望修订 ${input.reviewRevision}，当前 ${review.reviewRevision}`,
    );
  if (
    chapter.bodyHash !== input.expectedHeadHash ||
    chapter.bodyHash !== review.expectedHeadHash
  )
    throw new ProofreadError(
      "STALE_BODY",
      "正文已在批次外被修改，旧意见不能直接套用",
      `期望 hash ${input.expectedHeadHash.slice(0, 10)}…，当前 ${chapter.bodyHash.slice(0, 10)}…`,
    );
  assertAcceptedConsistency(review.decisions, review.acceptedPatchIds);
  return review;
}

/**
 * 一次审阅操作 = 单章权威文件的一次原子提交：正文、决议、操作记录一起替换。
 * 同一 operationId 的相同请求返回原结果；不同请求复用同一 ID 被拒绝。
 */
export async function applyReviewOperation(
  root: string,
  input: ApplyReviewOperationInput,
): Promise<ReviewCommitResult> {
  const expectedAction =
    input.kind === "batch-accept" || input.kind === "auto-apply"
      ? "accept"
      : input.kind === "batch-ignore"
        ? "ignore"
        : input.kind;
  if (
    input.commands.some((command) => command.action !== expectedAction) ||
    (input.batchCategory &&
      !["batch-accept", "batch-ignore"].includes(input.kind))
  )
    throw new ProofreadError("SCHEMA_INVALID", "审阅操作类型与命令不一致");
  return withChapterWriteLock(root, input.chapterId, async () => {
    const book = await readBookFile(root);
    const chapter = await readChapterFile(root, book, input.chapterId);
    const review = chapter.review;
    if (!review)
      throw new ProofreadError("NO_ACTIVE_BATCH", "本章没有活动的精校批次");
    if (input.batchId && input.batchId !== review.batchId)
      throw new ProofreadError(
        "STALE_BATCH",
        "所选批次已不是本章活动批次，请刷新后再操作",
        input.batchId,
      );
    const requestHash = input.batchCategory
      ? sha256Hex(
          canonicalJson({ kind: input.kind, category: input.batchCategory }),
        )
      : reviewRequestHash(
          input.kind,
          input.commands.map((command) => command.patchId),
        );
    // 幂等优先：同一 operationId 的重试即使带着旧 revision 也返回原结果。
    const existing = review.operations.find(
      (operation) => operation.operationId === input.operationId,
    );
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw new ProofreadError(
          "OPERATION_CONFLICT",
          "同一 operationId 已用于不同审阅请求",
          input.operationId,
        );
      return { chapter, operation: existing, replayed: true };
    }
    const withdrawn = review.undos.find(
      (undo) => undo.undoneOperationId === input.operationId,
    );
    if (withdrawn) {
      if (withdrawn.undoneOperation?.requestHash !== requestHash)
        throw new ProofreadError(
          "OPERATION_CONFLICT",
          "此 operationId 已被撤回，不能再次执行",
          input.operationId,
        );
      return { chapter, operation: withdrawn.undoneOperation, replayed: true };
    }
    if (review.undos.some((undo) => undo.operationId === input.operationId))
      throw new ProofreadError(
        "OPERATION_CONFLICT",
        "此 operationId 已用于撤回操作",
        input.operationId,
      );
    assertCurrentReview(chapter, input);
    const batch = await loadBatch(root, review.batchId);
    if (
      batch.chapterId !== chapter.chapterId ||
      batch.workspaceId !== book.workspaceId
    )
      throw new ProofreadError(
        "STALE_BATCH",
        "批次不属于当前章节或作品，拒绝写入",
        batch.batchId,
      );
    if (batch.inputFingerprint !== review.inputFingerprint)
      throw new ProofreadError(
        "STALE_BATCH",
        "批次指纹与章节审阅状态不一致，拒绝写入",
      );
    if (batch.receipts.length !== batch.blockManifest.length)
      throw new ProofreadError(
        "INCOMPLETE_BATCH",
        "本章检查尚未完成全部目标块，不能正式采纳",
        `${batch.receipts.length}/${batch.blockManifest.length}`,
      );
    const commands: readonly ReviewCommand[] = input.batchCategory
      ? batch.candidates
          .filter(
            (candidate) =>
              candidate.category === input.batchCategory &&
              !review.decisions[candidate.patchId],
          )
          .map((candidate) => ({
            patchId: candidate.patchId,
            action:
              input.kind === "batch-accept"
                ? ("accept" as const)
                : ("ignore" as const),
          }))
      : input.commands;
    if (input.batchCategory && commands.length === 0)
      throw new ProofreadError("PATCH_NOT_FOUND", "没有待处理的该类意见");
    const outcome = applyReviewCommands(
      batch.candidates,
      {
        decisions: review.decisions,
        acceptedPatchIds: review.acceptedPatchIds,
      },
      commands,
    );
    const nextBody = nextChapterBody(
      chapter,
      batch.baseBody,
      batch.baseBlocks,
      acceptedPatches(batch.candidates, outcome.acceptedPatchIds),
      bodyFormatOf(book),
      book.importSettings.paragraphMode,
    );
    const nextRevision = review.reviewRevision + 1;
    const operation: ReviewOperation = {
      operationId: input.operationId,
      kind: input.kind,
      patchIds: [...commands.map((command) => command.patchId)].sort(),
      requestHash,
      previousStates: outcome.previousStates,
      resultHeadHash: nextBody.bodyHash,
      resultReviewRevision: nextRevision,
      createdAt: new Date().toISOString(),
    };
    const next: ChapterFile = {
      ...chapter,
      body: nextBody.body,
      blocks: nextBody.blocks,
      bodyHash: nextBody.bodyHash,
      bodyRevision: nextBody.bodyRevision,
      updatedAt: new Date().toISOString(),
      review: {
        ...review,
        decisions: outcome.decisions,
        acceptedPatchIds: outcome.acceptedPatchIds,
        reviewRevision: nextRevision,
        expectedHeadHash: nextBody.bodyHash,
        operations: [...review.operations, operation],
        lastOperationId: operation.operationId,
      },
    };
    const problems = chapterIntegrityProblems(next);
    if (problems.length)
      throw new ProofreadError(
        "INVALID_REVIEW_STATE",
        "审阅提交前校验失败，未写入",
        problems.join("；"),
      );
    await writeChapterSafely(root, next);
    return { chapter: next, operation, replayed: false };
  });
}

export interface UndoReviewOperationInput {
  chapterId: string;
  batchId?: string;
  operationId: string;
  /** 调用方看到的“上次操作”ID；幂等重放必须与首次一致。 */
  undoneOperationId?: string;
  reviewRevision: number;
  expectedHeadHash: string;
}

/** 撤回上次操作：恢复该操作前的决议并重新投影，不产生“半撤回”状态。 */
export async function undoLastReviewOperation(
  root: string,
  input: UndoReviewOperationInput,
): Promise<ReviewCommitResult> {
  return withChapterWriteLock(root, input.chapterId, async () => {
    const book = await readBookFile(root);
    const chapter = await readChapterFile(root, book, input.chapterId);
    const review = chapter.review;
    if (!review)
      throw new ProofreadError("NO_ACTIVE_BATCH", "本章没有活动的精校批次");
    if (input.batchId && input.batchId !== review.batchId)
      throw new ProofreadError(
        "STALE_BATCH",
        "所选批次已不是本章活动批次，请刷新后再操作",
        input.batchId,
      );
    const existingUndo = review.undos.find(
      (undo) => undo.operationId === input.operationId,
    );
    const last = review.operations[review.operations.length - 1];
    const targetId =
      input.undoneOperationId ??
      existingUndo?.undoneOperationId ??
      last?.operationId;
    if (existingUndo) {
      const requestHash = sha256Hex(
        canonicalJson({ kind: "undo", undoneOperationId: targetId }),
      );
      if (existingUndo.requestHash !== requestHash)
        throw new ProofreadError(
          "OPERATION_CONFLICT",
          "同一 operationId 已用于不同撤回请求",
          input.operationId,
        );
      return { chapter, replayed: true };
    }
    if (
      review.operations.some(
        (operation) => operation.operationId === input.operationId,
      ) ||
      review.undos.some((undo) => undo.undoneOperationId === input.operationId)
    )
      throw new ProofreadError(
        "OPERATION_CONFLICT",
        "此 operationId 已用于审阅操作",
        input.operationId,
      );
    if (!last || !targetId)
      throw new ProofreadError("NOTHING_TO_UNDO", "没有可撤回的审阅操作");
    const requestHash = sha256Hex(
      canonicalJson({ kind: "undo", undoneOperationId: targetId }),
    );
    assertCurrentReview(chapter, input);
    if (targetId !== last.operationId)
      throw new ProofreadError(
        "STALE_REVIEW",
        "要撤回的操作不是最近一次审阅操作，请刷新",
        targetId,
      );
    const batch = await loadBatch(root, review.batchId);
    if (
      batch.chapterId !== chapter.chapterId ||
      batch.workspaceId !== book.workspaceId
    )
      throw new ProofreadError(
        "STALE_BATCH",
        "批次不属于当前章节或作品，拒绝写入",
        batch.batchId,
      );
    if (batch.receipts.length !== batch.blockManifest.length)
      throw new ProofreadError(
        "INCOMPLETE_BATCH",
        "本章检查尚未完成全部目标块，不能撤回审阅",
      );
    const decisions = { ...review.decisions };
    for (const [patchId, state] of Object.entries(last.previousStates)) {
      if (state === "pending") delete decisions[patchId];
      else decisions[patchId] = state;
    }
    const acceptedPatchIds = deriveAcceptedPatchIds(decisions);
    const nextBody = nextChapterBody(
      chapter,
      batch.baseBody,
      batch.baseBlocks,
      acceptedPatches(batch.candidates, acceptedPatchIds),
      bodyFormatOf(book),
      book.importSettings.paragraphMode,
    );
    const nextRevision = review.reviewRevision + 1;
    const next: ChapterFile = {
      ...chapter,
      body: nextBody.body,
      blocks: nextBody.blocks,
      bodyHash: nextBody.bodyHash,
      bodyRevision: nextBody.bodyRevision,
      updatedAt: new Date().toISOString(),
      review: {
        ...review,
        decisions,
        acceptedPatchIds,
        reviewRevision: nextRevision,
        expectedHeadHash: nextBody.bodyHash,
        operations: review.operations.slice(0, -1),
        undos: [
          ...review.undos,
          {
            operationId: input.operationId,
            undoneOperationId: last.operationId,
            undoneOperation: last,
            requestHash,
            restoredHeadHash: nextBody.bodyHash,
            restoredReviewRevision: nextRevision,
            createdAt: new Date().toISOString(),
          },
        ],
        lastOperationId:
          review.operations[review.operations.length - 2]?.operationId,
      },
    };
    const problems = chapterIntegrityProblems(next);
    if (problems.length)
      throw new ProofreadError(
        "INVALID_REVIEW_STATE",
        "撤回提交前校验失败，未写入",
        problems.join("；"),
      );
    await writeChapterSafely(root, next);
    return { chapter: next, replayed: false };
  });
}

export function newOperationId(): string {
  return randomUUID();
}

export type { ReviewStateValue };
