import type { Block } from "../../shared/book";
import {
  type ProofreadBlockTarget,
  type ProofreadChunkBudget,
  type ProofreadTargetRange,
} from "../../shared/proofreading";
import { canonicalJson } from "../../shared/task";
import { sha256Hex } from "../text/hash";
import { snapToCodeUnitBoundary } from "../../shared/text-offsets";

const SENTENCE_END = /[。！？!?；;…\n]/;
const WHITESPACE = /\s/;

function splitLongParagraph(text: string, maxChars: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  const softFloor = Math.max(1, Math.floor(maxChars / 3));
  while (text.length - start > maxChars) {
    const limit = start + maxChars;
    let cut = -1;
    // 优先在句界切分，避免把一句话拆到两个目标块。
    for (let index = limit; index > start + softFloor; index -= 1) {
      if (SENTENCE_END.test(text[index - 1])) {
        cut = index;
        break;
      }
    }
    if (cut < 0) {
      for (let index = limit; index > start + softFloor; index -= 1) {
        if (WHITESPACE.test(text[index - 1])) {
          cut = index;
          break;
        }
      }
    }
    if (cut < 0) cut = limit;
    cut = snapToCodeUnitBoundary(text, cut);
    if (cut <= start) cut = snapToCodeUnitBoundary(text, Math.min(text.length, start + maxChars));
    ranges.push({ start, end: cut });
    start = cut;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

function readOnlyEntries(
  blocks: readonly Block[],
  body: string,
  from: number,
  count: number,
): Array<{ paragraphId: string; text: string }> {
  const result: Array<{ paragraphId: string; text: string }> = [];
  for (let index = from; index >= 0 && result.length < count; index -= 1) {
    const block = blocks[index];
    if (!block) break;
    result.unshift({
      paragraphId: block.id,
      text: body.slice(block.start, block.end),
    });
  }
  return result;
}

function readOnlyEntriesAfter(
  blocks: readonly Block[],
  body: string,
  from: number,
  count: number,
): Array<{ paragraphId: string; text: string }> {
  const result: Array<{ paragraphId: string; text: string }> = [];
  for (let index = from; index < blocks.length && result.length < count; index += 1) {
    const block = blocks[index];
    if (!block) break;
    result.push({ paragraphId: block.id, text: body.slice(block.start, block.end) });
  }
  return result;
}

/** 只读邻接也必须有界；优先保留离目标最近的文字，避免长段在每块重复整段。 */
function boundContext(
  entries: Array<{ paragraphId: string; text: string }>,
  maxChars: number,
  before: boolean,
): Array<{ paragraphId: string; text: string }> {
  const result: typeof entries = [];
  let remaining = maxChars;
  for (const entry of before ? [...entries].reverse() : entries) {
    if (remaining <= 0) break;
    let text = entry.text;
    if (text.length > remaining) {
      if (before) {
        text = text.slice(snapToCodeUnitBoundary(text, text.length - remaining));
      } else {
        const end = snapToCodeUnitBoundary(text, remaining);
        text = text.slice(0, end > remaining ? remaining - 1 : end);
      }
    }
    if (text) result.push({ paragraphId: entry.paragraphId, text });
    remaining -= text.length;
  }
  return before ? result.reverse() : result;
}

export interface ChapterChunkInput {
  chapterId: string;
  baseBodyHash: string;
  body: string;
  blocks: readonly Block[];
  budget: ProofreadChunkBudget;
}

/**
 * PF-05 目标分块：只把普通段落作为目标，按预算切开；邻接段落只读。
 * 超长段落按句界切成同一段落内的多个目标区间，坐标始终是段落内绝对偏移，
 * 模型不能通过越界补丁处理边界之外的句子。
 */
export function buildChapterChunks(input: ChapterChunkInput): ProofreadBlockTarget[] {
  const { body, blocks, budget } = input;
  const editable = blocks
    .map((block, index) => ({ block, index }))
    .filter((item) => item.block.kind === "paragraph");
  const targets: ProofreadBlockTarget[] = [];
  let blockNumber = 0;

  function pushTarget(
    ranges: ProofreadTargetRange[],
    firstIndex: number,
    lastIndex: number,
    before: Array<{ paragraphId: string; text: string }>,
    after: Array<{ paragraphId: string; text: string }>,
  ): void {
    blockNumber += 1;
    const blockId = `b${blockNumber}`;
    const contextChars = budget.maxChars * budget.contextParagraphs;
    const readOnlyBefore = boundContext([
      ...readOnlyEntries(blocks, body, firstIndex - 1, budget.contextParagraphs),
      ...before,
    ], contextChars, true);
    const readOnlyAfter = boundContext([
      ...after,
      ...readOnlyEntriesAfter(blocks, body, lastIndex + 1, budget.contextParagraphs),
    ], contextChars, false);
    const payload = {
      baseBodyHash: input.baseBodyHash,
      chapterId: input.chapterId,
      blockId,
      targets: ranges,
      readOnlyBefore,
      readOnlyAfter,
    };
    targets.push({
      blockId,
      targets: ranges,
      readOnlyBefore,
      readOnlyAfter,
      inputHash: sha256Hex(canonicalJson(payload)),
    });
  }

  let position = 0;
  while (position < editable.length) {
    const first = editable[position];
    const paragraphText = body.slice(first.block.start, first.block.end);
    if (paragraphText.length > budget.maxChars) {
      const ranges = splitLongParagraph(paragraphText, budget.maxChars);
      for (const range of ranges) {
        const before =
          range.start > 0
            ? [{ paragraphId: first.block.id, text: paragraphText.slice(0, range.start) }]
            : [];
        const after =
          range.end < paragraphText.length
            ? [{ paragraphId: first.block.id, text: paragraphText.slice(range.end) }]
            : [];
        pushTarget(
          [
            {
              paragraphId: first.block.id,
              start: range.start,
              end: range.end,
              text: paragraphText.slice(range.start, range.end),
            },
          ],
          first.index,
          first.index,
          before,
          after,
        );
      }
      position += 1;
      continue;
    }

    const chosen = [first];
    let chars = paragraphText.length;
    let cursor = position + 1;
    while (cursor < editable.length) {
      const next = editable[cursor];
      // 只在连续普通段落之间合并；标题、分隔符等结构不塞进目标块。
      if (next.index !== chosen[chosen.length - 1].index + 1) break;
      const nextText = body.slice(next.block.start, next.block.end);
      if (chosen.length >= budget.maxParagraphs) break;
      if (chars + nextText.length > budget.maxChars) break;
      chosen.push(next);
      chars += nextText.length;
      cursor += 1;
    }
    const ranges = chosen.map((item) => ({
      paragraphId: item.block.id,
      start: 0,
      end: body.slice(item.block.start, item.block.end).length,
      text: body.slice(item.block.start, item.block.end),
    }));
    pushTarget(ranges, first.index, chosen[chosen.length - 1].index, [], []);
    position = cursor;
  }
  return targets;
}

/**
 * 覆盖校验：每个可编辑段落必须被目标区间完整、连续、无重叠地覆盖。
 * 空章（没有普通段落）允许 0 个目标块，由调用方记录“跳过”。
 */
export function chunkCoverageProblems(
  blocks: readonly Block[],
  targets: readonly ProofreadBlockTarget[],
): string[] {
  const problems: string[] = [];
  const seenBlocks = new Set<string>();
  const ranges = new Map<string, Array<{ start: number; end: number }>>();
  for (const target of targets) {
    if (seenBlocks.has(target.blockId))
      problems.push(`重复目标块 ID：${target.blockId}`);
    seenBlocks.add(target.blockId);
    for (const range of target.targets) {
      if (range.start < 0 || range.end < range.start)
        problems.push(`目标区间非法：${target.blockId}/${range.paragraphId}`);
      const list = ranges.get(range.paragraphId) ?? [];
      list.push({ start: range.start, end: range.end });
      ranges.set(range.paragraphId, list);
    }
  }
  for (const block of blocks) {
    if (block.kind !== "paragraph") continue;
    const length = block.end - block.start;
    if (length === 0) continue;
    const list = (ranges.get(block.id) ?? []).sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    if (list.length === 0) {
      problems.push(`段落 ${block.id} 没有目标块`);
      continue;
    }
    let expected = 0;
    for (const range of list) {
      if (range.start !== expected)
        problems.push(
          range.start < expected
            ? `段落 ${block.id} 目标区间重叠`
            : `段落 ${block.id} 目标区间漏块（${expected}-${range.start}）`,
        );
      expected = Math.max(expected, range.end);
    }
    if (expected !== length)
      problems.push(`段落 ${block.id} 目标区间未覆盖到段末（${expected}/${length}）`);
  }
  for (const [paragraphId] of ranges)
    if (!blocks.some((block) => block.id === paragraphId))
      problems.push(`目标区间引用不存在的段落 ${paragraphId}`);
  return problems;
}

export function findTargetForRange(
  targets: readonly ProofreadBlockTarget[],
  paragraphId: string,
  start: number,
  end: number,
): ProofreadBlockTarget | null {
  return (
    targets.find((target) =>
      target.targets.some(
        (range) =>
          range.paragraphId === paragraphId &&
          start >= range.start &&
          end <= range.end,
      ),
    ) ?? null
  );
}
