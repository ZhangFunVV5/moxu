import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { Adapter } from "../../agent/model/model-adapter";
import { ModelError } from "../../agent/model/model-adapter";
import {
  PROOFREAD_PROFILE,
} from "../../agent/tools/proofread-tools";
import { runChapterProofread, type ProofreadProgressEvent } from "../../agent/tasks/chapter-runner";
import {
  TaskStore,
  TaskStoreError,
} from "../../agent/tasks/task-store";
import type { TaskSpec } from "../../shared/task";
import { loadTaskSpec } from "../../agent/tasks/task-types";
import type { BookFile, ChapterFile } from "../../shared/book";
import {
  ProofreadError,
  PROOFREAD_CATEGORIES,
  type ChapterProofreadBatch,
  type ProofreadCategory,
  proofreadOptionsFromTaskOptions,
  type ProofreadOptions,
} from "../../shared/proofreading";
import {
  readBookFile,
  readChapterFile,
  type Workspace,
} from "../workspace/book-store";
import {
  addRuleCandidates,
  createBatch,
  findLatestBatch,
  loadBatch,
} from "./batch-store";
import {
  buildChapterChunks,
  chunkCoverageProblems,
} from "./chapter-chunker";
import {
  applyReviewOperation,
  attachBatchToChapter,
} from "./chapter-commit";
import { repeatedParagraphTexts, scanTargetRules } from "./rule-scanner";
import { buildIssueViews } from "./review-service";
import { proofreadPromptSnapshot } from "../../agent/prompts/proofread";

export interface ProofreadChapterResult {
  chapterId: string;
  state:
    | "completed"
    | "waiting-review"
    | "failed"
    | "cancelled"
    | "skipped";
  candidateCount: number;
  batchId?: string;
  errorCode?: string;
  message?: string;
}

export interface ProofreadRunResult {
  taskId: string;
  status: "completed" | "waiting-review" | "failed" | "cancelled";
  chapters: ProofreadChapterResult[];
  autoApplyErrors: string[];
}

export interface RunProofreadTaskInput {
  workspace: Workspace;
  taskStore: TaskStore;
  spec: TaskSpec;
  options: ProofreadOptions;
  adapter: Adapter;
  signal: AbortSignal;
  emit: (event: ProofreadProgressEvent) => void;
  now?: () => Date;
}

function assertTaskMatches(
  spec: TaskSpec,
  workspace: Workspace,
  options: ProofreadOptions,
): void {
  if (spec.type !== "proofread")
    throw new ProofreadError("UNSUPPORTED_REQUEST", "任务类型不是精校");
  if (spec.workspaceId !== workspace.book.workspaceId)
    throw new ProofreadError("STALE_BATCH", "任务不属于当前作品");
  if (spec.profileVersion !== options.profileVersion)
    throw new ProofreadError(
      "TASK_INPUT_CHANGED",
      "任务 Profile 版本与精校选项不一致",
    );
}

async function scanRulesIntoBatch(
  root: string,
  batch: ChapterProofreadBatch,
  chapter: ChapterFile,
  options: ProofreadOptions,
): Promise<void> {
  if (!options.categories.includes("advertisement")) return;
  const paragraphs = chapter.blocks
    .filter((block) => block.kind === "paragraph")
    .map((block) => ({
      paragraphId: block.id,
      text: chapter.body.slice(block.start, block.end),
    }));
  const repeatedTexts = repeatedParagraphTexts(paragraphs);
  for (const target of batch.blockManifest) {
    const items: Array<{
      ruleId: string;
      candidate: import("../../shared/proofreading").ModelEditCandidate;
    }> = [];
    for (const range of target.targets) {
      const block = chapter.blocks.find((item) => item.id === range.paragraphId);
      if (!block) continue;
      const paragraphText = chapter.body.slice(block.start, block.end);
      const hits = scanTargetRules({
        paragraphId: range.paragraphId,
        paragraphText,
        targetStart: range.start,
        targetEnd: range.end,
        glossary: options.glossary,
        repeatedTexts,
      });
      for (const hit of hits)
        items.push({ ruleId: hit.ruleId, candidate: hit.candidate });
    }
    if (items.length)
      await addRuleCandidates({
        root,
        batchId: batch.batchId,
        blockId: target.blockId,
        items,
      });
  }
}

function isCategory(value: string): value is ProofreadCategory {
  return (PROOFREAD_CATEGORIES as readonly string[]).includes(value);
}

async function autoApplyCategories(input: {
  root: string;
  chapterId: string;
  categories: readonly string[];
  emit: RunProofreadTaskInput["emit"];
}): Promise<string[]> {
  const errors: string[] = [];
  for (const category of input.categories) {
    if (!isCategory(category)) continue;
    const book = await readBookFile(input.root);
    let chapter = await readChapterFile(input.root, book, input.chapterId);
    if (!chapter.review) continue;
    const batch = await loadBatch(input.root, chapter.review.batchId);
    const pending = batch.candidates.filter(
      (candidate) =>
        candidate.category === category &&
        !chapter.review!.decisions[candidate.patchId],
    );
    if (pending.length === 0) continue;
    try {
      chapter = (
        await applyReviewOperation(input.root, {
          chapterId: input.chapterId,
          operationId: randomUUID(),
          kind: "auto-apply",
          commands: pending.map((candidate) => ({
            patchId: candidate.patchId,
            action: "accept" as const,
          })),
          reviewRevision: chapter.review.reviewRevision,
          expectedHeadHash: chapter.bodyHash,
        })
      ).chapter;
      input.emit({
        type: "chapterStateChanged",
        chapterId: input.chapterId,
        message: `已按授权类别自动采纳 ${pending.length} 条${category}意见`,
      });
    } catch (error) {
      const message =
        error instanceof ProofreadError
          ? `${category}：${error.message}${error.detail ? `（${error.detail}）` : ""}`
          : `${category}：自动应用失败`;
      errors.push(message);
      input.emit({
        type: "chapterStateChanged",
        chapterId: input.chapterId,
        message: `自动应用未执行：${message}`,
      });
    }
  }
  return errors;
}

async function finalizeChapter(
  root: string,
  chapterId: string,
  taskStore: TaskStore,
  options: ProofreadOptions,
  emit: RunProofreadTaskInput["emit"],
): Promise<ProofreadChapterResult> {
  const chapter = await readChapterFile(
    root,
    await readBookFile(root),
    chapterId,
  );
  if (!chapter.review)
    return {
      chapterId,
      state: "failed",
      candidateCount: 0,
      errorCode: "NO_ACTIVE_BATCH",
    };
  const batch = await loadBatch(root, chapter.review.batchId);
  if (batch.taskId !== taskStore.taskId)
    throw new ProofreadError(
      "STALE_BATCH",
      "本章已开始新的精校批次，不能用旧任务继续审阅或自动应用",
      batch.batchId,
    );
  const errors = await autoApplyCategories({
    root,
    chapterId,
    categories: options.autoApplyCategories,
    emit,
  });
  const latest = await readChapterFile(root, await readBookFile(root), chapterId);
  const pending = buildIssueViews(
    batch.candidates,
    latest.review?.decisions ?? {},
    latest.review?.acceptedPatchIds ?? [],
    latest.bodyHash !== latest.review?.expectedHeadHash,
  ).filter((issue) => issue.decision === "pending");
  if (pending.length === 0 && latest.review) {
    try {
      await taskStore.completeChapter(chapterId);
    } catch (error) {
      if (
        !(error instanceof TaskStoreError) ||
        error.code !== "INVALID_TRANSITION"
      )
        throw error;
    }
  }
  return {
    chapterId,
    state: pending.length === 0 ? "completed" : "waiting-review",
    candidateCount: batch.candidates.length,
    batchId: batch.batchId,
    message: errors.length ? `自动应用部分失败：${errors.join("；")}` : undefined,
  };
}

async function createAndAttachBatch(
  input: RunProofreadTaskInput,
  chapter: ChapterFile,
): Promise<ChapterProofreadBatch> {
  const chunks = buildChapterChunks({
    chapterId: chapter.chapterId,
    baseBodyHash: chapter.bodyHash,
    body: chapter.body,
    blocks: chapter.blocks,
    budget: input.options.blockBudget,
  });
  const problems = chunkCoverageProblems(chapter.blocks, chunks);
  if (problems.length)
    throw new ProofreadError(
      "INVALID_CHUNKS",
      "目标分块未完整覆盖本章，已停止而不是漏检",
      problems.join("；"),
    );
  const batch = await createBatch({
    root: input.workspace.root,
    workspaceId: input.workspace.book.workspaceId,
    taskId: input.spec.taskId,
    chapter,
    options: input.options,
    prompt: proofreadPromptSnapshot(),
    blockManifest: chunks,
  });
  await scanRulesIntoBatch(
    input.workspace.root,
    batch,
    chapter,
    input.options,
  );
  const attached = await attachBatchToChapter(input.workspace.root, batch);
  if (!attached.review)
    throw new ProofreadError("NO_ACTIVE_BATCH", "批次引用写入失败");
  input.emit({
    type: "chapterStateChanged",
    chapterId: chapter.chapterId,
    message: `已创建精校批次 · ${chunks.length} 个目标块`,
  });
  return loadBatch(input.workspace.root, batch.batchId);
}

async function runOneChapter(
  input: RunProofreadTaskInput,
  chapterId: string,
  existingBatch?: ChapterProofreadBatch | null,
): Promise<ProofreadChapterResult> {
  const { workspace, spec, options, taskStore, signal, emit } = input;
  const root = workspace.root;
  if (signal.aborted)
    return { chapterId, state: "cancelled", candidateCount: 0 };
  await taskStore.setState(chapterId, "running");
  const chapter = await readChapterFile(root, workspace.book, chapterId);
  const expectedHash = spec.inputHashes[chapterId];
  if (expectedHash && chapter.bodyHash !== expectedHash)
    throw new ProofreadError(
      "TASK_INPUT_CHANGED",
      "章节正文已变化，请基于当前正文新建精校任务",
      chapterId,
    );
  let batch: ChapterProofreadBatch;
  if (existingBatch) {
    if (
      existingBatch.chapterId !== chapterId ||
      existingBatch.workspaceId !== workspace.book.workspaceId
    )
      throw new ProofreadError("STALE_BATCH", "恢复批次不属于当前章节或作品");
    if (chapter.bodyHash !== existingBatch.baseBodyHash)
      throw new ProofreadError(
        "TASK_INPUT_CHANGED",
        "章节正文已偏离批次基础，不能继续套用旧意见",
        chapterId,
      );
    if (chapter.review?.batchId !== existingBatch.batchId) {
      if (chapter.review)
        throw new ProofreadError(
          "STALE_BATCH",
          "本章已有另一个活动批次，不能同时写入",
          chapter.review.batchId,
        );
      const attached = await attachBatchToChapter(root, existingBatch);
      if (!attached.review)
        throw new ProofreadError("NO_ACTIVE_BATCH", "恢复批次引用写入失败");
    }
    emit({
      type: "chapterStateChanged",
      chapterId,
      message: `从已保存批次恢复 · ${existingBatch.receipts.length}/${existingBatch.blockManifest.length} 块已完成`,
    });
    batch = await loadBatch(root, existingBatch.batchId);
  } else {
    batch = await createAndAttachBatch(input, chapter);
  }
  const result = await runChapterProofread({
    root,
    workspaceId: workspace.book.workspaceId,
    chapterTitle: chapter.title.current,
    chapterOrder: chapter.order,
    taskId: spec.taskId,
    batch,
    options,
    adapter: input.adapter,
    signal,
    taskStore,
    emit,
  });
  if (result.candidateCount === 0)
    return { chapterId, state: "completed", candidateCount: 0, batchId: batch.batchId };
  return finalizeChapter(root, chapterId, taskStore, options, emit);
}

/**
 * P3 整书串行入口：代码遍历固定章序，一章检查完成即可审阅，再继续下一章。
 * 模型不持有全书进度；正式正文写入仍通过章节写队列。
 */
export async function runProofreadTask(
  rawInput: RunProofreadTaskInput,
): Promise<ProofreadRunResult> {
  assertTaskMatches(rawInput.spec, rawInput.workspace, rawInput.options);
  // 自动应用只使用应用层写入 TaskSpec 的授权类别，模型／请求参数不能扩大。
  const input: RunProofreadTaskInput = {
    ...rawInput,
    options: {
      ...rawInput.options,
      autoApplyCategories: rawInput.options.autoApplyCategories.filter((category) =>
        rawInput.spec.permissions.autoApplyCategories.includes(category),
      ),
    },
  };
  const results: ProofreadChapterResult[] = [];
  const autoApplyErrors: string[] = [];
  let cancelled = false;
  for (const chapterId of input.spec.chapterIds) {
    if (input.signal.aborted) {
      cancelled = true;
      break;
    }
    try {
      const result = await runOneChapter(input, chapterId);
      results.push(result);
      if (result.state === "cancelled") cancelled = true;
      if (result.message) autoApplyErrors.push(result.message);
    } catch (error) {
      const isCancel =
        input.signal.aborted ||
        (error instanceof ModelError && error.code === "CANCELLED");
      if (isCancel) {
        cancelled = true;
        await input.taskStore
          .cancelChapter(chapterId)
          .catch(() => undefined);
        results.push({ chapterId, state: "cancelled", candidateCount: 0 });
        break;
      }
      const code =
        error instanceof ProofreadError ||
        error instanceof ModelError ||
        error instanceof TaskStoreError
          ? error.code
          : "PROOFREAD_FAILED";
      await input.taskStore.failChapter(chapterId, code).catch(() => undefined);
      results.push({
        chapterId,
        state: "failed",
        candidateCount: 0,
        errorCode: code,
        message: error instanceof Error ? error.message : String(error),
      });
      // 已完成的章节保留；失败后停止，未开始的章节仍为 queued，可由恢复流程继续。
      break;
    }
  }
  const status: ProofreadRunResult["status"] = cancelled
    ? "cancelled"
    : results.some((result) => result.state === "failed")
      ? "failed"
      : results.some((result) => result.state === "waiting-review")
        ? "waiting-review"
        : "completed";
  return { taskId: input.spec.taskId, status, chapters: results, autoApplyErrors };
}

export interface ProofreadSummaryChapter {
  chapterId: string;
  state:
    | "unchecked"
    | "running"
    | "waiting-review"
    | "completed"
    | "failed"
    | "interrupted"
    | "queued"
    | "cancelled";
  batchId: string | null;
  stale: boolean;
  pending: number;
  accepted: number;
  ignored: number;
  total: number;
  errorCode?: string;
}

/** 侧栏／审阅面板共用的派生计数：只从章节权威文件和批次候选计算。 */
export async function chapterProofreadSummary(
  root: string,
  book: BookFile,
  chapter: ChapterFile,
  taskStore?: TaskStore | null,
): Promise<ProofreadSummaryChapter> {
  const review = chapter.review;
  if (!review)
    return {
      chapterId: chapter.chapterId,
      state: taskStore?.getCheckpoint(chapter.chapterId).status ?? "unchecked",
      batchId: null,
      stale: false,
      pending: 0,
      accepted: 0,
      ignored: 0,
      total: 0,
    };
  let batch: ChapterProofreadBatch | null = null;
  try {
    batch = await loadBatch(root, review.batchId);
  } catch {
    batch = null;
  }
  const stale = chapter.bodyHash !== review.expectedHeadHash;
  const candidates = batch?.candidates ?? [];
  const views = buildIssueViews(
    candidates,
    review.decisions,
    review.acceptedPatchIds,
    stale,
  );
  const pending = views.filter((issue) => issue.decision === "pending").length;
  const checkpointState = taskStore?.getCheckpoint(chapter.chapterId).status ?? (stale ? "failed" : "waiting-review");
  return {
    chapterId: chapter.chapterId,
    state: checkpointState === "waiting-review" && pending === 0 ? "completed" : checkpointState,
    batchId: review.batchId,
    stale,
    pending,
    accepted: views.filter((issue) => issue.decision === "accepted").length,
    ignored: views.filter((issue) => issue.decision === "ignored").length,
    total: views.length,
    errorCode: taskStore?.getCheckpoint(chapter.chapterId).errorCode,
  };
}


// ---------------------------------------------------------------- T055 恢复

export interface ProofreadRecovery {
  interrupted: string[];
  repaired: string[];
}

/** 关闭重开：running 且候选/回执完整则补齐检查点；否则标 interrupted，等待显式继续。 */
export async function recoverProofreadTasks(
  root: string,
  book: BookFile,
): Promise<ProofreadRecovery> {
  const report: ProofreadRecovery = { interrupted: [], repaired: [] };
  let taskIds: string[];
  try {
    taskIds = (await fsp.readdir(path.join(root, "tasks"))).filter((name) =>
      /^[0-9a-f-]{36}$/.test(name),
    );
  } catch {
    return report;
  }
  for (const taskId of taskIds) {
    let spec: TaskSpec;
    try {
      spec = await loadTaskSpec(root, taskId);
    } catch {
      continue;
    }
    if (spec.type !== "proofread" || spec.workspaceId !== book.workspaceId)
      continue;
    const store = await TaskStore.open(root, taskId).catch(() => null);
    if (!store) continue;
    for (const chapterId of spec.chapterIds) {
      const checkpoint = store.getCheckpoint(chapterId);
      if (checkpoint.status !== "running") continue;
      const batch = await findLatestBatch(root, { chapterId, taskId });
      const complete =
        batch &&
        batch.blockManifest.length > 0 &&
        batch.blockManifest.every((target) =>
          batch.receipts.some((receipt) => receipt.blockId === target.blockId),
        );
      if (batch && complete) {
        await store.writeArtifact(chapterId, {
          kind: "proofread-batch",
          completedBlockIds: batch.blockManifest.map((target) => target.blockId),
          payload: {
            batchId: batch.batchId,
            candidateCount: batch.candidates.length,
            baseBodyHash: batch.baseBodyHash,
          },
        });
        if (batch.candidates.length > 0)
          await store.markReviewReady(chapterId).catch(() => undefined);
        else
          await store.completeChapter(chapterId).catch(() => undefined);
        report.repaired.push(`${taskId}/${chapterId}`);
      } else {
        await store.setState(chapterId, "interrupted").catch(() => undefined);
        report.interrupted.push(`${taskId}/${chapterId}`);
      }
    }
  }
  return report;
}

export interface ResumeProofreadTaskInput {
  workspace: Workspace;
  taskStore: TaskStore;
  spec: TaskSpec;
  adapter: Adapter;
  signal: AbortSignal;
  emit: (event: ProofreadProgressEvent) => void;
}

/**
 * 显式继续任务：输入指纹与选项必须与任务快照一致；只补未完成块，
 * 不在后台把当前正文悄悄换成新输入。
 */
export async function resumeProofreadTask(
  input: ResumeProofreadTaskInput,
): Promise<ProofreadRunResult> {
  const resolved = proofreadOptionsFromTaskOptions(input.spec.options);
  assertTaskMatches(input.spec, input.workspace, resolved);
  const options: ProofreadOptions = {
    ...resolved,
    autoApplyCategories: resolved.autoApplyCategories.filter((category) =>
      input.spec.permissions.autoApplyCategories.includes(category),
    ),
  };
  const runInput: RunProofreadTaskInput = {
    workspace: input.workspace,
    taskStore: input.taskStore,
    spec: input.spec,
    options,
    adapter: input.adapter,
    signal: input.signal,
    emit: input.emit,
  };
  const results: ProofreadChapterResult[] = [];
  let cancelled = false;
  for (const chapterId of input.spec.chapterIds) {
    if (input.signal.aborted) {
      cancelled = true;
      break;
    }
    const checkpoint = runInput.taskStore.getCheckpoint(chapterId);
    if (checkpoint.status === "completed") {
      results.push({ chapterId, state: "completed", candidateCount: 0 });
      continue;
    }
    try {
      if (checkpoint.status === "waiting-review") {
        const finalized = await finalizeChapter(
          input.workspace.root,
          chapterId,
          runInput.taskStore,
          options,
          runInput.emit,
        );
        results.push(finalized);
        continue;
      }
      const existing = await findLatestBatch(input.workspace.root, {
        chapterId,
        taskId: input.spec.taskId,
      });
      const result = await runOneChapter(runInput, chapterId, existing);
      results.push(result);
    } catch (error) {
      const isCancel =
        input.signal.aborted ||
        (error instanceof ModelError && error.code === "CANCELLED");
      if (isCancel) {
        cancelled = true;
        await runInput.taskStore
          .cancelChapter(chapterId)
          .catch(() => undefined);
        results.push({ chapterId, state: "cancelled", candidateCount: 0 });
        break;
      }
      const code =
        error instanceof ProofreadError ||
        error instanceof ModelError ||
        error instanceof TaskStoreError
          ? error.code
          : "PROOFREAD_FAILED";
      await runInput.taskStore
        .failChapter(chapterId, code)
        .catch(() => undefined);
      results.push({
        chapterId,
        state: "failed",
        candidateCount: 0,
        errorCode: code,
        message: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  const status: ProofreadRunResult["status"] = cancelled
    ? "cancelled"
    : results.some((result) => result.state === "failed")
      ? "failed"
      : results.some((result) => result.state === "waiting-review")
        ? "waiting-review"
        : "completed";
  return {
    taskId: input.spec.taskId,
    status,
    chapters: results,
    autoApplyErrors: [],
  };
}

export interface ProofreadTaskSummaryLike {
  taskId: string;
  status: string;
  chapters: Array<{ chapterId: string; status: string; errorCode?: string }>;
}

/** 任务列表只读视图；状态来自检查点，不伪造“已完成”。 */
export async function listProofreadTasks(
  root: string,
): Promise<ProofreadTaskSummaryLike[]> {
  const summaries: ProofreadTaskSummaryLike[] = [];
  let taskIds: string[];
  try {
    taskIds = (await fsp.readdir(path.join(root, "tasks"))).filter((name) =>
      /^[0-9a-f-]{36}$/.test(name),
    );
  } catch {
    return summaries;
  }
  for (const taskId of taskIds) {
    let spec: TaskSpec;
    try {
      spec = await loadTaskSpec(root, taskId);
    } catch {
      continue;
    }
    if (spec.type !== "proofread") continue;
    const store = await TaskStore.open(root, taskId).catch(() => null);
    if (!store) continue;
    const chapters = spec.chapterIds.map((chapterId) => {
      const checkpoint = store.getCheckpoint(chapterId);
      return {
        chapterId,
        status: checkpoint.status,
        errorCode: checkpoint.errorCode,
      };
    });
    const statuses = chapters.map((chapter) => chapter.status);
    const status = ["running", "failed", "interrupted", "cancelled", "queued", "waiting-review"]
      .find((state) => statuses.includes(state as typeof statuses[number])) ?? "completed";
    summaries.push({ taskId, status, chapters });
  }
  return summaries;
}
