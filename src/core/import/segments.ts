import type { ChapterKind } from "../../shared/book";

export interface ParsedSegment {
  index: number;
  title: string;
  kind: ChapterKind;
  /** 包含该行的起始行，0 基。 */
  startLine: number;
  /** 不包含的结束行，0 基。 */
  endLine: number;
  /** 真正标题的完整行范围；无标题和整篇一章不设置。 */
  heading?: { startLine: number; endLine: number };
}

export function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

/** 段落实体：去掉段首段尾空白行，只丢弃结构性空行，不 trim 正文字符。 */
export function segmentBody(
  lines: readonly string[],
  segment: ParsedSegment,
  options: { dropHeading?: boolean } = {},
): string {
  let start = segment.startLine;
  let end = Math.min(segment.endLine, lines.length);
  while (start < end && isBlankLine(lines[start])) start += 1;
  while (end > start && isBlankLine(lines[end - 1])) end -= 1;
  if (options.dropHeading && segment.heading && start === segment.heading.startLine)
    start = Math.min(segment.heading.endLine, end);
  while (start < end && isBlankLine(lines[start])) start += 1;
  return lines.slice(start, end).join("\n");
}

export function pushSegment(
  segments: ParsedSegment[],
  title: string,
  kind: ChapterKind,
  startLine: number,
  endLine: number,
  heading?: ParsedSegment["heading"],
): void {
  if (endLine <= startLine) return;
  segments.push({
    index: segments.length,
    title: title.trim() || `未命名章节 ${segments.length + 1}`,
    kind,
    startLine,
    endLine,
    ...(heading ? { heading } : {}),
  });
}
