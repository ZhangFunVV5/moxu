import type { Block } from "../../shared/book";
import { ProofreadError } from "../../shared/proofreading";
import { assertNoConflicts, type ConflictCandidate } from "./conflicts";

export interface ProjectablePatch extends ConflictCandidate {
  after: string;
}

export interface ProjectionResult {
  body: string;
  /** 按段落分组后的应用顺序，供定位和调试使用；坐标始终基于基础正文。 */
  applied: Array<{ patchId: string; paragraphId: string; start: number; end: number }>;
}

function blockMap(blocks: readonly Block[]): Map<string, Block> {
  return new Map(blocks.map((block) => [block.id, block]));
}

/**
 * PF-02 正文投影：始终从批次基础正文重新应用「已采纳集合」。
 *
 * 不把旧坐标逐次套到已经变化的正文上。各段落内按 start 倒序拼接，因此
 * 前一条修改造成的长度变化不会破坏后面补丁的基础坐标。
 */
export function projectBody(
  baseBody: string,
  baseBlocks: readonly Block[],
  patches: readonly ProjectablePatch[],
): ProjectionResult {
  assertNoConflicts(patches, "已采纳集合");
  const blocks = blockMap(baseBlocks);
  const byParagraph = new Map<string, ProjectablePatch[]>();
  for (const patch of patches) {
    const block = blocks.get(patch.paragraphId);
    if (!block)
      throw new ProofreadError(
        "FORBIDDEN_RANGE",
        "补丁段落不属于批次基础正文",
        patch.paragraphId,
      );
    const paragraphText = baseBody.slice(block.start, block.end);
    if (
      patch.start < 0 ||
      patch.end > paragraphText.length ||
      patch.start > patch.end ||
      paragraphText.slice(patch.start, patch.end) !== patch.before
    )
      throw new ProofreadError(
        "QUOTE_MISMATCH",
        "补丁与基础段落不再一致，不能应用",
        patch.patchId,
      );
    const list = byParagraph.get(patch.paragraphId) ?? [];
    list.push(patch);
    byParagraph.set(patch.paragraphId, list);
  }

  const applied: ProjectionResult["applied"] = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const [paragraphId, list] of byParagraph) {
    const block = blocks.get(paragraphId)!;
    const ordered = [...list].sort(
      (left, right) => right.start - left.start || right.end - left.end,
    );
    for (const patch of ordered) {
      replacements.push({
        start: block.start + patch.start,
        end: block.start + patch.end,
        text: patch.after,
      });
      applied.push({
        patchId: patch.patchId,
        paragraphId,
        start: patch.start,
        end: patch.end,
      });
    }
  }

  // 章内坐标倒序拼接：每段只切一次，后续（更靠前）补丁的坐标仍基于基础正文。
  replacements.sort((left, right) => right.start - left.start);
  let body = baseBody;
  for (const replacement of replacements) {
    body =
      body.slice(0, replacement.start) +
      replacement.text +
      body.slice(replacement.end);
  }
  return { body, applied };
}

/** 仅替换单个段落文本，供单元测试与分块定位复用。 */
export function patchParagraphText(
  text: string,
  patches: readonly Pick<ProjectablePatch, "start" | "end" | "after" | "before" | "patchId">[],
): string {
  const ordered = [...patches].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
  let next = text;
  for (const patch of ordered) {
    if (next.slice(patch.start, patch.end) !== patch.before)
      throw new ProofreadError(
        "QUOTE_MISMATCH",
        "引用文本与段落不一致",
        patch.patchId,
      );
    next = next.slice(0, patch.start) + patch.after + next.slice(patch.end);
  }
  return next;
}
