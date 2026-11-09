import {
  ProofreadError,
  type StoredEditCandidate,
} from "../../shared/proofreading";
import type { ReviewDecision } from "../../shared/review-state";
import { assertNoConflicts, buildConflictIndex } from "./conflicts";

export type ReviewAction = "accept" | "ignore" | "restore" | "withdraw";

export interface ReviewCommand {
  patchId: string;
  action: ReviewAction;
}

export interface ReviewSnapshot {
  decisions: Readonly<Record<string, ReviewDecision>>;
  acceptedPatchIds: readonly string[];
}

export interface ReviewCommandResult {
  decisions: Record<string, ReviewDecision>;
  acceptedPatchIds: string[];
  /** 本次操作影响到的候选在操作前的状态，供“撤回上次操作”精确恢复。 */
  previousStates: Record<string, "pending" | "accepted" | "ignored">;
  changedPatchIds: string[];
}

export function deriveAcceptedPatchIds(
  decisions: Readonly<Record<string, ReviewDecision>>,
): string[] {
  return Object.entries(decisions)
    .filter(([, decision]) => decision === "accepted")
    .map(([patchId]) => patchId)
    .sort();
}

export function assertAcceptedConsistency(
  decisions: Readonly<Record<string, ReviewDecision>>,
  acceptedPatchIds: readonly string[],
): void {
  const derived = deriveAcceptedPatchIds(decisions);
  const stored = [...acceptedPatchIds].sort();
  if (
    derived.length !== stored.length ||
    derived.some((patchId, index) => patchId !== stored[index])
  )
    throw new ProofreadError(
      "INVALID_REVIEW_STATE",
      "已采纳集合与审阅决议不一致，已拒绝继续审阅",
    );
}

function previousStateOf(
  decisions: Readonly<Record<string, ReviewDecision>>,
  patchId: string,
): "pending" | "accepted" | "ignored" {
  return decisions[patchId] ?? "pending";
}

/**
 * PF-03 审阅命令的纯函数部分：采纳、忽略、恢复待审和撤回。
 * 任何一条命令非法则整次不应用；互斥组合在最后统一检查。
 */
export function applyReviewCommands(
  candidates: readonly StoredEditCandidate[],
  snapshot: ReviewSnapshot,
  commands: readonly ReviewCommand[],
): ReviewCommandResult {
  if (commands.length === 0)
    throw new ProofreadError("INVALID_REVIEW_STATE", "审阅操作没有作用对象");
  const byId = new Map(candidates.map((candidate) => [candidate.patchId, candidate]));
  const seen = new Set<string>();
  const decisions: Record<string, ReviewDecision> = { ...snapshot.decisions };
  const previousStates: ReviewCommandResult["previousStates"] = {};
  const changedPatchIds: string[] = [];

  for (const command of commands) {
    if (seen.has(command.patchId))
      throw new ProofreadError(
        "INVALID_REVIEW_STATE",
        "同一候选在一次操作中出现多次",
        command.patchId,
      );
    seen.add(command.patchId);
    const candidate = byId.get(command.patchId);
    if (!candidate)
      throw new ProofreadError(
        "PATCH_NOT_FOUND",
        "意见不存在于当前批次",
        command.patchId,
      );
    if (candidate.baseValidity !== "valid")
      throw new ProofreadError(
        "INVALID_REVIEW_STATE",
        "无效或过期的意见不能改变审阅决议",
        `${command.patchId}（${candidate.baseValidity}）`,
      );
    const before = previousStateOf(decisions, command.patchId);
    previousStates[command.patchId] = before;
    if (command.action === "accept") {
      if (before === "accepted")
        throw new ProofreadError("ALREADY_DECIDED", "该意见已经采纳", command.patchId);
      decisions[command.patchId] = "accepted";
    } else if (command.action === "ignore") {
      if (before !== "pending")
        throw new ProofreadError(
          "ALREADY_DECIDED",
          "只有待处理意见可以忽略",
          command.patchId,
        );
      decisions[command.patchId] = "ignored";
    } else if (command.action === "restore") {
      if (before !== "ignored")
        throw new ProofreadError(
          "ALREADY_DECIDED",
          "只有已忽略意见可以恢复待审",
          command.patchId,
        );
      delete decisions[command.patchId];
    } else {
      if (before !== "accepted")
        throw new ProofreadError(
          "ALREADY_DECIDED",
          "只有已采纳意见可以撤回",
          command.patchId,
        );
      delete decisions[command.patchId];
    }
    changedPatchIds.push(command.patchId);
  }

  const acceptedPatchIds = deriveAcceptedPatchIds(decisions);
  const accepted = acceptedPatchIds
    .map((patchId) => byId.get(patchId))
    .filter((candidate): candidate is StoredEditCandidate => Boolean(candidate));
  if (accepted.length !== acceptedPatchIds.length)
    throw new ProofreadError(
      "INVALID_REVIEW_STATE",
      "已采纳集合包含不属于当前批次的意见",
    );
  assertNoConflicts(accepted, "采纳组合");
  return { decisions, acceptedPatchIds, previousStates, changedPatchIds };
}

export interface CandidateValidity {
  validity: "valid" | "conflict" | "stale" | "invalid";
  conflictWith: string[];
  invalidCode?: string;
}

export interface IssueView extends StoredEditCandidate {
  decision: "pending" | "accepted" | "ignored";
  validity: CandidateValidity["validity"];
  conflictWith: string[];
}

/**
 * 候选有效性与审阅决议分开：过期／无效不是“用户已忽略”，
 * 冲突是动态的——撤回其中一条后，另一条重新变为可用。
 */
export function candidateValidity(
  candidate: StoredEditCandidate,
  candidates: readonly StoredEditCandidate[],
  acceptedPatchIds: readonly string[],
  batchStale: boolean,
  index = buildConflictIndex(candidates),
): CandidateValidity {
  if (candidate.baseValidity !== "valid")
    return {
      validity: candidate.baseValidity,
      conflictWith: [],
      invalidCode: candidate.invalidCode,
    };
  if (batchStale) return { validity: "stale", conflictWith: [] };
  const conflictWith = [...(index.byPatch.get(candidate.patchId) ?? [])].filter(
    (patchId) => acceptedPatchIds.includes(patchId),
  );
  return {
    validity: conflictWith.length ? "conflict" : "valid",
    conflictWith,
  };
}

export function buildIssueViews(
  candidates: readonly StoredEditCandidate[],
  decisions: Readonly<Record<string, ReviewDecision>>,
  acceptedPatchIds: readonly string[],
  batchStale: boolean,
): IssueView[] {
  const index = buildConflictIndex(candidates);
  return candidates.map((candidate) => {
    const validity = candidateValidity(
      candidate,
      candidates,
      acceptedPatchIds,
      batchStale,
      index,
    );
    return {
      ...candidate,
      decision: decisions[candidate.patchId] ?? "pending",
      ...validity,
    };
  });
}
