import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROOFREAD_SCHEMA_VERSION,
  ProofreadError,
  chapterProofreadBatchSchema,
  type ChapterProofreadBatch,
  type ModelEditCandidate,
  type NormalizedCandidate,
  type ProofreadBlockReceipt,
  type ProofreadBlockTarget,
  type CandidateValidationContext,
  type ProofreadOptions,
  type ProofreadPromptSnapshot,
  type StoredEditCandidate,
} from "../../shared/proofreading";
import type { Block, ChapterFile } from "../../shared/book";
import { canonicalJson } from "../../shared/task";
import { sha256Hex, hashBody } from "../text/hash";
import { WriteQueue, writeFileAtomic } from "../workspace/atomic-file";
import { candidateFingerprint } from "./fingerprint";
import { validateCandidateBatch } from "./patch-validator";

const batchQueue = new WriteQueue();

export function proofreadBatchPath(root: string, batchId: string): string {
  return path.join(root, "edits", `${batchId}.json`);
}

export function proofreadInputFingerprint(input: {
  workspaceId: string;
  chapterId: string;
  baseBodyHash: string;
  options: ProofreadOptions;
  profileVersion: string;
  promptHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      schemaVersion: PROOFREAD_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      chapterId: input.chapterId,
      baseBodyHash: input.baseBodyHash,
      options: input.options,
      profileVersion: input.profileVersion,
      promptHash: input.promptHash,
    }),
  );
}

export async function loadBatch(
  root: string,
  batchId: string,
): Promise<ChapterProofreadBatch> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(proofreadBatchPath(root, batchId), "utf8"));
  } catch {
    throw new ProofreadError("BATCH_NOT_FOUND", "精校批次不存在或无法解析", batchId);
  }
  const parsed = chapterProofreadBatchSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProofreadError(
      "STALE_BATCH",
      "精校批次结构非法",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("；"),
    );
  return parsed.data;
}

async function persistBatch(
  root: string,
  batch: ChapterProofreadBatch,
): Promise<void> {
  const parsed = chapterProofreadBatchSchema.safeParse(batch);
  if (!parsed.success)
    throw new ProofreadError("STALE_BATCH", "精校批次写入前校验失败");
  await writeFileAtomic(
    proofreadBatchPath(root, batch.batchId),
    JSON.stringify(parsed.data, null, 2),
  );
}

export interface CreateBatchInput {
  root: string;
  workspaceId: string;
  taskId: string;
  chapter: Pick<ChapterFile, "chapterId" | "body" | "bodyHash" | "bodyRevision" | "blocks">;
  options: ProofreadOptions;
  prompt: ProofreadPromptSnapshot;
  blockManifest: readonly ProofreadBlockTarget[];
}

/**
 * 创建不可变基础快照。候选先写批次文件；章节权威文件只引用 batchId，
 * 真正的正文与决议在审阅提交时一次写入。
 */
export async function createBatch(
  input: CreateBatchInput,
): Promise<ChapterProofreadBatch> {
  const batchId = randomUUID();
  const now = new Date().toISOString();
  const inputFingerprint = proofreadInputFingerprint({
    workspaceId: input.workspaceId,
    chapterId: input.chapter.chapterId,
    baseBodyHash: input.chapter.bodyHash,
    options: input.options,
    profileVersion: input.options.profileVersion,
    promptHash: input.prompt.hash,
  });
  const batch: ChapterProofreadBatch = {
    schemaVersion: PROOFREAD_SCHEMA_VERSION,
    batchId,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    chapterId: input.chapter.chapterId,
    baseBodyHash: input.chapter.bodyHash,
    baseRevision: input.chapter.bodyRevision,
    baseBody: input.chapter.body,
    baseBlocks: input.chapter.blocks.map((block) => ({ ...block })),
    inputFingerprint,
    options: structuredClone(input.options),
    prompt: { ...input.prompt },
    blockManifest: input.blockManifest.map((target) => ({
      ...target,
      readOnlyBefore: target.readOnlyBefore.map((item) => ({ ...item })),
      readOnlyAfter: target.readOnlyAfter.map((item) => ({ ...item })),
    })),
    candidates: [],
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
  if (hashBody(batch.baseBody) !== batch.baseBodyHash)
    throw new ProofreadError("STALE_BATCH", "批次基础正文 hash 不一致");
  await persistBatch(input.root, batch);
  return batch;
}

function targetFor(
  batch: ChapterProofreadBatch,
  blockId: string,
): ProofreadBlockTarget {
  const target = batch.blockManifest.find((item) => item.blockId === blockId);
  if (!target)
    throw new ProofreadError(
      "FORBIDDEN_RANGE",
      "目标块不在本批次清单内",
      blockId,
    );
  return target;
}

function contextForCandidate(
  batch: ChapterProofreadBatch,
  target: ProofreadBlockTarget,
  candidate: { paragraphId: string },
): CandidateValidationContext {
  const range = target.targets.find(
    (item) => item.paragraphId === candidate.paragraphId,
  );
  if (!range)
    throw new ProofreadError(
      "FORBIDDEN_RANGE",
      "候选段落不在当前目标块内",
      candidate.paragraphId,
    );
  const block = batch.baseBlocks.find((item) => item.id === range.paragraphId);
  if (!block)
    throw new ProofreadError(
      "STALE_BATCH",
      "目标段落不在批次基础正文内",
      range.paragraphId,
    );
  const paragraphText = batch.baseBody.slice(block.start, block.end);
  if (paragraphText.slice(range.start, range.end) !== range.text)
    throw new ProofreadError(
      "STALE_BATCH",
      "目标块文本与基础段落不一致，拒绝提交",
      target.blockId,
    );
  return {
    baseBodyHash: batch.baseBodyHash,
    chapterId: batch.chapterId,
    block,
    targetStart: range.start,
    targetEnd: range.end,
    paragraphText,
    chapterBlocks: batch.baseBlocks,
    enabledCategories: batch.options.categories,
  };
}

function storedCandidate(
  batch: ChapterProofreadBatch,
  normalized: NormalizedCandidate,
  source: "model" | "rule",
  ruleId?: string,
  now = new Date().toISOString(),
): StoredEditCandidate {
  const identity = candidateFingerprint({
    baseBodyHash: batch.baseBodyHash,
    chapterId: batch.chapterId,
    paragraphId: normalized.paragraphId,
    start: normalized.start,
    end: normalized.end,
    before: normalized.before,
    after: normalized.after,
    category: normalized.category,
  });
  return {
    patchId: identity.patchId,
    batchId: batch.batchId,
    chapterId: batch.chapterId,
    paragraphId: normalized.paragraphId,
    start: normalized.start,
    end: normalized.end,
    before: normalized.before,
    after: normalized.after,
    category: normalized.category,
    reason: normalized.reason,
    source,
    sources: [source],
    fingerprint: identity.fingerprint,
    ...(ruleId ? { ruleId } : {}),
    baseValidity: "valid",
    createdAt: now,
  };
}

/** 合并重复候选：同一修改的不同理由／来源只显示一次。 */
function mergeCandidates(
  batch: ChapterProofreadBatch,
  additions: StoredEditCandidate[],
): string[] {
  const byId = new Map(batch.candidates.map((item) => [item.patchId, item]));
  const patchIds: string[] = [];
  for (const candidate of additions) {
    const existing = byId.get(candidate.patchId);
    if (!existing) {
      byId.set(candidate.patchId, candidate);
      batch.candidates.push(candidate);
      patchIds.push(candidate.patchId);
      continue;
    }
    for (const source of candidate.sources)
      if (!existing.sources.includes(source)) existing.sources.push(source);
    existing.sources.sort();
    if (candidate.ruleId) existing.ruleId = candidate.ruleId;
    patchIds.push(existing.patchId);
  }
  return [...new Set(patchIds)];
}

function dedupeNormalized(
  batch: ChapterProofreadBatch,
  normalized: NormalizedCandidate[],
): NormalizedCandidate[] {
  const seen = new Set<string>();
  return normalized.filter((candidate) => {
    const identity = candidateFingerprint({
      baseBodyHash: batch.baseBodyHash,
      chapterId: batch.chapterId,
      paragraphId: candidate.paragraphId,
      start: candidate.start,
      end: candidate.end,
      before: candidate.before,
      after: candidate.after,
      category: candidate.category,
    });
    if (seen.has(identity.fingerprint)) return false;
    seen.add(identity.fingerprint);
    return true;
  });
}

function submissionContentHash(candidates: readonly StoredEditCandidate[]): string {
  return sha256Hex(
    canonicalJson(
      [...candidates]
        .sort((left, right) => (left.patchId < right.patchId ? -1 : 1))
        .map((candidate) => candidate.fingerprint),
    ),
  );
}

export interface SubmitBlockInput {
  root: string;
  batchId: string;
  chapterId: string;
  blockId: string;
  inputHash: string;
  candidates: readonly unknown[];
}

export interface SubmitBlockResult {
  batch: ChapterProofreadBatch;
  receipt: ProofreadBlockReceipt;
  /** 本次提交新增或合并后的候选。 */
  candidates: StoredEditCandidate[];
  replayed: boolean;
}

/**
 * PF-06 submit_edits 的原子提交：一次提交对应一个目标块的完整候选列表。
 * - 任一项非法：整批拒绝，返回逐项错误，不写任何候选；
 * - 相同内容重放：返回原回执；
 * - 同块不同最终内容：BLOCK_ALREADY_COMMITTED，除非应用开始新 attempt。
 * 空数组是有效的“本块无问题”回执。
 */
export async function submitBlock(
  input: SubmitBlockInput,
): Promise<SubmitBlockResult> {
  return batchQueue.run(`${input.root}:edits:${input.batchId}`, async () => {
    const batch = await loadBatch(input.root, input.batchId);
    if (batch.chapterId !== input.chapterId)
      throw new ProofreadError("FORBIDDEN_RANGE", "提交章节与本批次不一致");
    const target = targetFor(batch, input.blockId);
    if (input.inputHash !== target.inputHash)
      throw new ProofreadError(
        "HASH_MISMATCH",
        "提交的 inputHash 不是本批次基础正文",
        input.inputHash,
      );
    const normalized = dedupeNormalized(
      batch,
      validateCandidateBatch(input.candidates, (candidate) =>
        contextForCandidate(batch, target, candidate),
      ),
    );
    const now = new Date().toISOString();
    const additions = normalized.map((candidate) =>
      storedCandidate(batch, candidate, "model", undefined, now),
    );
    const contentHash = submissionContentHash(additions);
    const existingReceipt = batch.receipts.find(
      (receipt) => receipt.blockId === input.blockId,
    );
    if (existingReceipt) {
      if (
        existingReceipt.inputHash === input.inputHash &&
        existingReceipt.contentHash === contentHash
      )
        return {
          batch,
          receipt: existingReceipt,
          candidates: batch.candidates.filter((candidate) =>
            existingReceipt.patchIds.includes(candidate.patchId),
          ),
          replayed: true,
        };
      throw new ProofreadError(
        "BLOCK_ALREADY_COMMITTED",
        "该目标块已提交不同内容；需要应用层开始新 attempt",
        input.blockId,
      );
    }
    const patchIds = mergeCandidates(batch, additions);
    const receipt: ProofreadBlockReceipt = {
      blockId: input.blockId,
      inputHash: input.inputHash,
      contentHash,
      patchIds,
      candidateCount: normalized.length,
      submittedAt: now,
    };
    batch.receipts.push(receipt);
    batch.updatedAt = now;
    await persistBatch(input.root, batch);
    return {
      batch,
      receipt,
      candidates: batch.candidates.filter((candidate) =>
        patchIds.includes(candidate.patchId),
      ),
      replayed: false,
    };
  });
}

export interface AddRuleCandidatesInput {
  root: string;
  batchId: string;
  blockId: string;
  /** 规则候选与规则标识一一对应；来源写入 stored.ruleId。 */
  items: ReadonlyArray<{ ruleId: string; candidate: ModelEditCandidate }>;
}

/** 规则扫描候选走与模型候选相同的校验、去重和冲突层，不产生写正文效果。 */
export async function addRuleCandidates(
  input: AddRuleCandidatesInput,
): Promise<StoredEditCandidate[]> {
  if (input.items.length === 0) return [];
  return batchQueue.run(`${input.root}:edits:${input.batchId}`, async () => {
    const batch = await loadBatch(input.root, input.batchId);
    const target = targetFor(batch, input.blockId);
    const normalized = dedupeNormalized(
      batch,
      validateCandidateBatch(
        input.items.map((item) => item.candidate),
        (candidate) => contextForCandidate(batch, target, candidate),
      ),
    );
    const now = new Date().toISOString();
    const additions = normalized.map((candidate, index) =>
      storedCandidate(batch, candidate, "rule", input.items[index].ruleId, now),
    );
    const patchIds = mergeCandidates(batch, additions);
    batch.updatedAt = now;
    await persistBatch(input.root, batch);
    return batch.candidates.filter((candidate) =>
      patchIds.includes(candidate.patchId),
    );
  });
}

/** 开始新批次前，把旧批次的审阅状态归档到旧批次文件，旧意见仍可查看。 */
export async function archiveBatchReview(
  root: string,
  batchId: string,
  review: ChapterProofreadBatch["archivedReview"],
): Promise<void> {
  if (!review) return;
  await batchQueue.run(`${root}:edits:${batchId}`, async () => {
    const batch = await loadBatch(root, batchId);
    batch.archivedReview = review;
    batch.updatedAt = new Date().toISOString();
    await persistBatch(root, batch);
  });
}

/** 查找某章／某任务最近的批次；用于恢复和审阅视图。 */
export async function findLatestBatch(
  root: string,
  filter: { chapterId?: string; taskId?: string } = {},
): Promise<ChapterProofreadBatch | null> {
  let names: string[];
  try {
    names = await fsp.readdir(path.join(root, "edits"));
  } catch {
    return null;
  }
  const batches: ChapterProofreadBatch[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    const batchId = name.slice(0, -5);
    try {
      const batch = await loadBatch(root, batchId);
      if (filter.chapterId && batch.chapterId !== filter.chapterId) continue;
      if (filter.taskId && batch.taskId !== filter.taskId) continue;
      batches.push(batch);
    } catch {
      // 坏批次不应让整个工作区无法查看；审阅视图会明确报告缺失。
    }
  }
  batches.sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1));
  return batches[0] ?? null;
}

export async function listBatchesForChapter(
  root: string,
  chapterId: string,
): Promise<ChapterProofreadBatch[]> {
  let names: string[];
  try {
    names = await fsp.readdir(path.join(root, "edits"));
  } catch {
    return [];
  }
  const batches: ChapterProofreadBatch[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.includes(".tmp-")) continue;
    try {
      const batch = await loadBatch(root, name.slice(0, -5));
      if (batch.chapterId === chapterId) batches.push(batch);
    } catch {
      // 单个坏批次不影响其他历史批次。
    }
  }
  return batches.sort((left, right) =>
    left.createdAt < right.createdAt ? 1 : -1,
  );
}
