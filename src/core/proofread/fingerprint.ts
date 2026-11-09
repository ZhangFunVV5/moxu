import { canonicalJson } from "../../shared/task";
import { sha256Hex } from "../text/hash";
import type { ProofreadCategory } from "../../shared/proofreading";

export interface CandidateFingerprintInput {
  baseBodyHash: string;
  chapterId: string;
  paragraphId: string;
  start: number;
  end: number;
  before: string;
  after: string;
  category: ProofreadCategory;
}

/**
 * 候选指纹不包含理由、来源和 patchId，因此：
 * - 同一修改的不同解释不会生成两条意见；
 * - 规则候选与模型候选命中同一修改时按 fingerprint 合并。
 */
export function candidateFingerprint(
  input: CandidateFingerprintInput,
): { fingerprint: string; patchId: string } {
  const fingerprint = sha256Hex(
    canonicalJson({
      schemaVersion: 1,
      baseBodyHash: input.baseBodyHash,
      chapterId: input.chapterId,
      paragraphId: input.paragraphId,
      start: input.start,
      end: input.end,
      before: input.before,
      after: input.after,
      category: input.category,
    }),
  );
  return { fingerprint, patchId: `pt-${fingerprint.slice(0, 16)}` };
}
