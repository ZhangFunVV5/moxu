import { ProofreadError } from "../../shared/proofreading";

export interface ConflictCandidate {
  patchId: string;
  paragraphId: string;
  start: number;
  end: number;
  before: string;
}

function isInsertion(candidate: ConflictCandidate): boolean {
  return candidate.start === candidate.end;
}

/**
 * PF-02 冲突约定（首版保守）：
 * - 同段两个非空区间相交 → 冲突；
 * - 同点插入 → 冲突；
 * - 插入恰好落在替换／删除的起点或终点 → 冲突（不猜测执行先后）；
 * - 相邻且不相交的替换 → 可共存。
 */
export function candidatesConflict(
  left: ConflictCandidate,
  right: ConflictCandidate,
): boolean {
  if (left.patchId === right.patchId) return false;
  if (left.paragraphId !== right.paragraphId) return false;
  const leftInsert = isInsertion(left);
  const rightInsert = isInsertion(right);
  if (leftInsert && rightInsert) return left.start === right.start;
  if (leftInsert) {
    const point = left.start;
    return point >= right.start && point <= right.end;
  }
  if (rightInsert) {
    const point = right.start;
    return point >= left.start && point <= left.end;
  }
  return left.start < right.end && right.start < left.end;
}

export interface ConflictIndex {
  pairs: Array<[string, string]>;
  byPatch: Map<string, Set<string>>;
}

export function buildConflictIndex(
  candidates: readonly ConflictCandidate[],
): ConflictIndex {
  const pairs: Array<[string, string]> = [];
  const byPatch = new Map<string, Set<string>>();
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i];
      const right = candidates[j];
      if (!candidatesConflict(left, right)) continue;
      pairs.push([left.patchId, right.patchId]);
      if (!byPatch.has(left.patchId)) byPatch.set(left.patchId, new Set());
      if (!byPatch.has(right.patchId)) byPatch.set(right.patchId, new Set());
      byPatch.get(left.patchId)!.add(right.patchId);
      byPatch.get(right.patchId)!.add(left.patchId);
    }
  }
  return { pairs, byPatch };
}

/** 已选集合内部是否冲突；用于整次提交前一次性校验，冲突时整体不应用。 */
export function assertNoConflicts(
  candidates: readonly ConflictCandidate[],
  context = "已选候选",
): void {
  const index = buildConflictIndex(candidates);
  if (index.pairs.length === 0) return;
  const detail = index.pairs
    .slice(0, 8)
    .map(([left, right]) => `${left} ↔ ${right}`)
    .join("；");
  throw new ProofreadError(
    "PATCH_CONFLICT",
    `${context}包含互斥修改，整次操作未应用`,
    detail,
    { pairs: index.pairs },
  );
}
