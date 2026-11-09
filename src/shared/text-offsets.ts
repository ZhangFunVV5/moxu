import type { Block } from "./book";

/**
 * 文本坐标工具。约定：
 * - 章内坐标：`ChapterFile.body` 内的 UTF-16 code unit 偏移，左闭右开，行分隔符统一为 \n。
 * - 段落坐标：`block.start` 到 `block.end` 的同一套章内坐标。
 * - CodeMirror 的文档偏移与章内坐标一致（body 已规范化为 \n，不使用 CRLF 行分隔符）。
 */
export interface NormalizedText {
  text: string;
  eol: "lf" | "crlf";
}

/** 统一换行；原始 EOL 类型单独记录，导入时不允许隐式丢字。 */
export function normalizeNewlines(input: string): NormalizedText {
  const crlf = input.includes("\r\n");
  const loneCr = !crlf && input.includes("\r");
  return {
    text: input.replace(/\r\n?/g, "\n"),
    eol: crlf || loneCr ? "crlf" : "lf",
  };
}

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * offset 是否切开了 UTF-16 代理对。offset 位于 [0, text.length]，
 * 当 text[offset-1] 是高代理且 text[offset] 是低代理时返回 true。
 */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= text.length)
    return false;
  return (
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  );
}

export function isCodeUnitBoundary(text: string, offset: number): boolean {
  return (
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset <= text.length &&
    !splitsSurrogatePair(text, offset)
  );
}

/** 若 offset 切在代理对中间，向后移动到合法边界；否则原样返回。 */
export function snapToCodeUnitBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(text.length, offset));
  return splitsSurrogatePair(text, clamped) ? clamped + 1 : clamped;
}

/** 返回每一行起始的章内偏移，用于 CodeMirror 行列换算。 */
export function lineStartOffsets(body: string): number[] {
  const starts = [0];
  for (let i = 0; i < body.length; i += 1)
    if (body.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export interface LineColumn {
  /** 0 基行号，与 CodeMirror 一致。 */
  line: number;
  /** 0 基列号，UTF-16 code unit。 */
  column: number;
}

export function offsetToLineColumn(body: string, offset: number): LineColumn {
  const safe = Math.max(0, Math.min(body.length, offset));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < safe; i += 1) {
    if (body.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: safe - lineStart };
}

export function lineColumnToOffset(
  body: string,
  position: LineColumn,
): number {
  const starts = lineStartOffsets(body);
  const line = Math.max(0, Math.min(starts.length - 1, position.line));
  return Math.min(body.length, starts[line] + Math.max(0, position.column));
}

/** 命中 offset 的块；offset 等于块 end 时视为命中该块。块之间空隙返回 null。 */
export function blockAtOffset(
  blocks: readonly Block[],
  offset: number,
): Block | null {
  for (const block of blocks)
    if (offset >= block.start && offset <= block.end) return block;
  return null;
}

export function findBlock(
  blocks: readonly Block[],
  paragraphId: string,
): Block | null {
  return blocks.find((block) => block.id === paragraphId) ?? null;
}

/** 段落内偏移 → 章内偏移；越界或切代理对时返回 null。 */
export function paragraphOffsetToChapterOffset(
  block: Block,
  text: string,
  offsetInParagraph: number,
): number | null {
  if (!Number.isInteger(offsetInParagraph) || offsetInParagraph < 0)
    return null;
  const length = block.end - block.start;
  if (offsetInParagraph > length) return null;
  const chapterOffset = block.start + offsetInParagraph;
  if (splitsSurrogatePair(text, chapterOffset)) return null;
  return chapterOffset;
}

/** 章内偏移 → 段落内偏移；不在任何块内时返回 null。 */
export function chapterOffsetToParagraphOffset(
  blocks: readonly Block[],
  offset: number,
): { block: Block; offsetInParagraph: number } | null {
  const block = blockAtOffset(blocks, offset);
  if (!block) return null;
  return { block, offsetInParagraph: offset - block.start };
}

/** 选区（章内坐标）覆盖的段落，用于状态栏显示与 P3 补丁范围校验。 */
export function blocksInRange(
  blocks: readonly Block[],
  from: number,
  to: number,
): Block[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return blocks.filter((block) => block.end > start && block.start < end);
}
