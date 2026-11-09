import type { Adapter } from "../model/model-adapter";
import { ModelError } from "../model/model-adapter";
import { run } from "../runtime/loop";
import { PROOFREAD_PROFILE, ruleCandidatesForPrompt } from "../tools/proofread-tools";
import { type Context, type Profile } from "../tools/dispatcher";
import type { Result } from "../../shared/contracts";
import type { Block } from "../../shared/book";
import {
  ProofreadError,
  type ChapterProofreadBatch,
  type ProofreadBlockTarget,
  type ProofreadOptions,
} from "../../shared/proofreading";
import { loadBatch, submitBlock } from "../../core/proofread/batch-store";
import { buildProofreadPrompt, proofreadPromptSnapshot } from "../prompts/proofread";
import { TaskStore } from "./task-store";

export interface ProofreadProgressEvent {
  type:
    | "chapterStarted"
    | "blockStarted"
    | "toolStarted"
    | "toolFinished"
    | "usage"
    | "text"
    | "chapterStateChanged";
  chapterId: string;
  blockId?: string;
  /** 1 基块序号，用于进度显示。 */
  blockIndex?: number;
  blockTotal?: number;
  message: string;
}

export interface ChapterRunnerInput {
  root: string;
  workspaceId: string;
  chapterTitle: string;
  chapterOrder: number;
  taskId: string;
  batch: ChapterProofreadBatch;
  options: ProofreadOptions;
  adapter: Adapter;
  signal: AbortSignal;
  taskStore: TaskStore;
  emit: (event: ProofreadProgressEvent) => void;
}

export interface ChapterRunnerResult {
  batch: ChapterProofreadBatch;
  candidateCount: number;
  completedBlockIds: string[];
  state: "waiting-review" | "completed";
}

function chapterTextOf(blocks: readonly Block[], body: string) {
  return blocks.map((block) => ({
    paragraphId: block.id,
    kind: block.kind,
    text: body.slice(block.start, block.end),
  }));
}

/**
 * 每个目标块用同一 Runtime 运行一次，完整提交后才算该块完成。
 * 工具只能看到本批次冻结正文与当前目标块；写正式正文仍由审阅服务执行。
 */
export async function runChapterProofread(
  input: ChapterRunnerInput,
): Promise<ChapterRunnerResult> {
  let batch = input.batch;
  const total = batch.blockManifest.length;
  const emit = input.emit;
  emit({
    type: "chapterStarted",
    chapterId: batch.chapterId,
    message: `开始检查《${input.chapterTitle}》，共 ${total} 个目标块`,
  });

  for (const [index, target] of batch.blockManifest.entries()) {
    if (input.signal.aborted)
      throw new ModelError("CANCELLED", "精校任务已取消");
    const completed = new Set(batch.receipts.map((receipt) => receipt.blockId));
    if (completed.has(target.blockId)) continue;
    emit({
      type: "blockStarted",
      chapterId: batch.chapterId,
      blockId: target.blockId,
      blockIndex: index + 1,
      blockTotal: total,
      message: `检查目标块 ${index + 1}/${total}`,
    });
    const ruleCandidates = ruleCandidatesForPrompt(
      target,
      batch.candidates
        .filter((candidate) => candidate.sources.includes("rule"))
        .map((candidate) => ({ candidate })),
    );
    const prompt = buildProofreadPrompt({
      chapterId: batch.chapterId,
      baseBodyHash: batch.baseBodyHash,
      chapterTitle: input.chapterTitle,
      options: input.options,
      target,
      ruleCandidates,
    });
    const context = runnerContext(input, batch, target);
    await run(
      input.adapter,
      PROOFREAD_PROFILE,
      context,
      prompt,
      input.signal,
      (type, message) =>
        emit({
          type,
          chapterId: batch.chapterId,
          blockId: target.blockId,
          blockIndex: index + 1,
          blockTotal: total,
          message,
        }),
    );
    batch = await loadBatch(input.root, batch.batchId);
    if (!batch.receipts.some((receipt) => receipt.blockId === target.blockId))
      throw new ModelError(
        "NO_ARTIFACT",
        `目标块 ${target.blockId} 没有有效提交，不能把本章标为完成`,
      );
  }

  batch = await loadBatch(input.root, batch.batchId);
  const missing = batch.blockManifest.filter(
    (target) => !batch.receipts.some((receipt) => receipt.blockId === target.blockId),
  );
  if (missing.length)
    throw new ModelError(
      "MISSING_ARTIFACT",
      `仍有目标块未提交：${missing.map((target) => target.blockId).join(",")}`,
    );
  const completedBlockIds = batch.blockManifest.map((target) => target.blockId);
  await input.taskStore.writeArtifact(batch.chapterId, {
    kind: "proofread-batch",
    completedBlockIds,
    payload: {
      batchId: batch.batchId,
      candidateCount: batch.candidates.length,
      baseBodyHash: batch.baseBodyHash,
    },
  });
  if (batch.candidates.length === 0) {
    await input.taskStore.completeChapter(batch.chapterId);
    emit({
      type: "chapterStateChanged",
      chapterId: batch.chapterId,
      message: "检查完成，未发现需修改项",
    });
    return { batch, candidateCount: 0, completedBlockIds, state: "completed" };
  }
  await input.taskStore.markReviewReady(batch.chapterId);
  emit({
    type: "chapterStateChanged",
    chapterId: batch.chapterId,
    message: `检查完成，${batch.candidates.length} 条意见等待审阅`,
  });
  return {
    batch,
    candidateCount: batch.candidates.length,
    completedBlockIds,
    state: "waiting-review",
  };
}

function runnerContext(
  input: ChapterRunnerInput,
  batch: ChapterProofreadBatch,
  target: ProofreadBlockTarget,
): Context {
  const execute = async (name: string, args: unknown): Promise<Result> => {
    try {
      if (name === "list_chapters")
        return {
          ok: true,
          data: {
            chapters: [
              {
                chapterId: batch.chapterId,
                title: input.chapterTitle,
                order: input.chapterOrder,
                charCount: batch.baseBody.length,
              },
            ],
          },
        };
      if (name === "read_chapter") {
        const request = args as { chapterId: string };
        if (request.chapterId !== batch.chapterId)
          throw new ProofreadError(
            "FORBIDDEN_RANGE",
            "只能读取本批次授权章节的冻结快照",
            request.chapterId,
          );
        return {
          ok: true,
          data: {
            chapterId: batch.chapterId,
            title: input.chapterTitle,
            blocks: chapterTextOf(batch.baseBlocks, batch.baseBody),
            truncated: false,
          },
        };
      }
      if (name === "scan_text_rules") {
        return {
          ok: true,
          data: {
            blockId: target.blockId,
            candidates: ruleCandidatesForPrompt(
              target,
              batch.candidates
                .filter((candidate) => candidate.sources.includes("rule"))
                .map((candidate) => ({ candidate })),
            ),
          },
        };
      }
      if (name === "submit_edits") {
        const request = args as {
          chapterId: string;
          blockId: string;
          inputHash: string;
          candidates: unknown[];
        };
        if (request.chapterId !== batch.chapterId)
          throw new ProofreadError(
            "FORBIDDEN_RANGE",
            "提交章节不在本批次范围",
            request.chapterId,
          );
        const result = await submitBlock({
          root: input.root,
          batchId: batch.batchId,
          chapterId: batch.chapterId,
          blockId: request.blockId,
          inputHash: request.inputHash,
          candidates: request.candidates,
        });
        return {
          ok: true,
          data: {
            blockId: result.receipt.blockId,
            candidateCount: result.receipt.candidateCount,
            patchIds: result.receipt.patchIds,
            replayed: result.replayed,
            status: result.receipt.candidateCount === 0 ? "no-issues" : "candidate-saved",
          },
        };
      }
      return { ok: false, error: { code: "UNKNOWN_TOOL", message: "未知精校工具" } };
    } catch (error) {
      if (error instanceof ProofreadError)
        return { ok: false, error: { code: error.code, message: error.message, detail: error.detail, data: error.data } };
      return {
        ok: false,
        error: {
          code: "TOOL_FAILED",
          message: error instanceof Error ? error.message : "精校工具失败",
        },
      };
    }
  };
  return {
    workspaceId: input.workspaceId,
    chapterIds: [batch.chapterId],
    source: "agent",
    allowWrite: false,
    version: 1,
    proofread: {
      chapterIds: [batch.chapterId],
      blockId: target.blockId,
      inputHash: target.inputHash,
      execute,
    },
  };
}

/** 提示词版本与 hash；由应用服务写入批次前调用。 */
export function currentProofreadPrompt() {
  return proofreadPromptSnapshot();
}

export type { Profile };

