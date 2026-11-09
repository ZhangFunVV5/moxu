import type { Block, BookFile, ChapterFile } from "../../shared/book";
import type {
  ChapterProofreadView,
  ProofreadIssueDto,
  ProofreadLocationDto,
} from "../../shared/proofread-contracts";
import type { ChapterReviewState } from "../../shared/review-state";
import { ProofreadError, defaultProofreadOptions } from "../../shared/proofreading";
import type { TaskStore } from "../../agent/tasks/task-store";
import { buildIssueViews } from "./review-service";
import { loadBatch } from "./batch-store";
import { buildPositionMap } from "./position-map";
import type { ProjectablePatch } from "./body-projector";

function emptyReview(batchId: string, inputFingerprint: string, head: string): ChapterReviewState {
  return {
    batchId,
    inputFingerprint,
    reviewRevision: 0,
    expectedHeadHash: head,
    decisions: {},
    acceptedPatchIds: [],
    operations: [],
    undos: [],
  };
}

export interface BuildChapterViewInput {
  root: string;
  book: BookFile;
  chapter: ChapterFile;
  /** 不传表示当前活动批次；传入历史 batchId 时只读查看。 */
  batchId?: string;
  taskStore?: TaskStore | null;
}

/**
 * 审阅视图的唯一派生入口：卡片、计数、定位都来自章节权威文件 + 批次候选，
 * 前端不自己维护另一份状态。历史批次使用归档决议，只读查看。
 */
export async function buildChapterView(
  input: BuildChapterViewInput,
): Promise<ChapterProofreadView> {
  const { chapter, book } = input;
  const activeBatchId = chapter.review?.batchId;
  const requestedId = input.batchId ?? activeBatchId;
  const taskState = input.taskStore
    ? input.taskStore.getCheckpoint(chapter.chapterId).status
    : null;
  const errorCode = input.taskStore
    ? input.taskStore.getCheckpoint(chapter.chapterId).errorCode
    : undefined;

  if (!requestedId) {
    return {
      chapterId: chapter.chapterId,
      title: chapter.title.current,
      state: (taskState as ChapterProofreadView["state"]) ?? "unchecked",
      stale: false,
      reviewReady: false,
      readOnly: false,
      batchId: null,
      reviewRevision: 0,
      expectedHeadHash: chapter.bodyHash,
      chapterBodyHash: chapter.bodyHash,
      bodyRevision: chapter.bodyRevision,
      body: chapter.body,
      blocks: chapter.blocks,
      baseBody: chapter.body,
      baseBlocks: chapter.blocks,
      options: defaultProofreadOptions,
      counts: { pending: 0, accepted: 0, ignored: 0, total: 0, conflict: 0, stale: 0 },
      issues: [],
      canUndo: false,
      errorCode,
    };
  }

  const batch = await loadBatch(input.root, requestedId);
  if (batch.chapterId !== chapter.chapterId || batch.workspaceId !== book.workspaceId)
    throw new ProofreadError("STALE_BATCH", "批次不属于当前章节或作品", requestedId);
  const active = activeBatchId === batch.batchId;
  const review =
    (active ? chapter.review : batch.archivedReview) ??
    emptyReview(batch.batchId, batch.inputFingerprint, batch.baseBodyHash);
  const stale = active
    ? chapter.bodyHash !== review.expectedHeadHash
    : true;
  const readOnly = !active;
  const reviewReady =
    batch.blockManifest.length === batch.receipts.length;
  const views = buildIssueViews(
    batch.candidates,
    review.decisions,
    review.acceptedPatchIds,
    stale,
  );
  const acceptedPatches: ProjectablePatch[] = review.acceptedPatchIds
    .map((patchId) => batch.candidates.find((candidate) => candidate.patchId === patchId))
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .map((candidate) => ({
      patchId: candidate.patchId,
      paragraphId: candidate.paragraphId,
      start: candidate.start,
      end: candidate.end,
      before: candidate.before,
      after: candidate.after,
    }));
  const map = buildPositionMap(batch.baseBlocks, acceptedPatches);
  const issues: ProofreadIssueDto[] = views.map((view) => {
    let locate: ProofreadLocationDto | null = null;
    if (active && !stale) {
      try {
        locate = map.locate(
          {
            patchId: view.patchId,
            paragraphId: view.paragraphId,
            start: view.start,
            end: view.end,
            before: view.before,
            after: view.after,
          },
          view.decision === "accepted",
        );
      } catch {
        locate = null;
      }
    }
    return {
      patchId: view.patchId,
      paragraphId: view.paragraphId,
      start: view.start,
      end: view.end,
      before: view.before,
      after: view.after,
      category: view.category,
      reason: view.reason,
      source: view.source,
      sources: view.sources,
      decision: view.decision,
      validity: view.validity,
      conflictWith: view.conflictWith,
      locate,
    };
  });
  const pendingCount = issues.filter((issue) => issue.decision === "pending").length;
  const baseState =
    (taskState as ChapterProofreadView["state"]) ??
    (readOnly ? "completed" : "waiting-review");
  return {
    chapterId: chapter.chapterId,
    title: chapter.title.current,
    state:
      baseState === "waiting-review" && pendingCount === 0
        ? "completed"
        : baseState,
    stale,
    reviewReady,
    readOnly,
    batchId: batch.batchId,
    batchCreatedAt: batch.createdAt,
    taskId: batch.taskId,
    reviewRevision: review.reviewRevision,
    expectedHeadHash: review.expectedHeadHash,
    chapterBodyHash: chapter.bodyHash,
    bodyRevision: chapter.bodyRevision,
    body: chapter.body,
    blocks: chapter.blocks as Block[],
    baseBody: batch.baseBody,
    baseBlocks: batch.baseBlocks,
    options: batch.options,
    counts: {
      pending: pendingCount,
      accepted: issues.filter((issue) => issue.decision === "accepted").length,
      ignored: issues.filter((issue) => issue.decision === "ignored").length,
      total: issues.length,
      conflict: issues.filter((issue) => issue.validity === "conflict").length,
      stale: issues.filter((issue) => issue.validity === "stale").length,
    },
    issues,
    lastOperationId: review.lastOperationId,
    canUndo: active && review.operations.length > 0,
    errorCode,
  };
}
