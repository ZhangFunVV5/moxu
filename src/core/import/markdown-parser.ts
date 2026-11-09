import MarkdownIt from "markdown-it";
import type { SplitMode } from "../../shared/book";
import { isBlankLine, pushSegment, type ParsedSegment } from "./segments";

const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

export interface MarkdownParseOptions {
  splitMode: SplitMode;
  /** 0 = 自动选择层级，1–6 = 指定作为章节边界的标题层级。 */
  headingLevel: number;
}

export interface MarkdownParseResult {
  lines: string[];
  segments: ParsedSegment[];
  /** 实际使用的标题层级；0 表示没有可用标题或整篇一章。 */
  headingLevel: number;
}

interface TopLevelHeading {
  line: number;
  endLine: number;
  level: number;
  title: string;
}

function extractHeadingTitle(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/**
 * 收集顶层标题：按 token.nesting 跟踪容器深度，引用／列表／代码围栏内部的标题
 * 不会成为章节边界（代码围栏本身由 Markdown 解析器识别为 fence，不含 heading token）。
 */
function topLevelHeadings(text: string, lines: readonly string[]): TopLevelHeading[] {
  const tokens = md.parse(text, {});
  const headings: TopLevelHeading[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.nesting === -1) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (token.type === "heading_open" && depth === 0 && token.map) {
      const level = Number(token.tag.slice(1));
      const line = token.map[0];
      const endLine = token.map[1];
      headings.push({
        line,
        endLine,
        level,
        title: token.markup === "=" || token.markup === "-"
          ? lines.slice(line, endLine - 1).join("\n").trim()
          : extractHeadingTitle(lines[line] ?? ""),
      });
    }
    if (token.nesting === 1) depth += 1;
  }
  return headings;
}

function autoHeadingLevel(headings: readonly TopLevelHeading[]): number {
  if (headings.length === 0) return 0;
  const counts = new Map<number, number>();
  for (const heading of headings)
    counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  const multi = levels.find((level) => (counts.get(level) ?? 0) >= 2);
  return multi ?? levels[0];
}

/**
 * Markdown 分章：标题层级可作为章节边界，更深层级保留为章内 heading 块；
 * 标题前内容保留为 frontmatter；代码块、列表、链接与分隔符保留原始 Markdown 行。
 */
export function parseMarkdownChapters(
  text: string,
  options: MarkdownParseOptions,
): MarkdownParseResult {
  const lines = text.split("\n");
  const headings = topLevelHeadings(text, lines);
  if (options.splitMode === "single") {
    return {
      lines,
      headingLevel: 0,
      segments: [
        { index: 0, title: "全文", kind: "chapter", startLine: 0, endLine: lines.length },
      ],
    };
  }

  const level =
    options.headingLevel >= 1 && options.headingLevel <= 6
      ? options.headingLevel
      : autoHeadingLevel(headings);
  const boundaries = level === 0 ? [] : headings.filter((heading) => heading.level === level);

  if (boundaries.length === 0) {
    return {
      lines,
      headingLevel: 0,
      segments: [
        { index: 0, title: "全文", kind: "chapter", startLine: 0, endLine: lines.length },
      ],
    };
  }

  const segments: ParsedSegment[] = [];
  if (lines.slice(0, boundaries[0].line).some((line) => !isBlankLine(line)))
    pushSegment(segments, "标题前内容", "frontmatter", 0, boundaries[0].line);
  for (const [index, heading] of boundaries.entries()) {
    const endLine = boundaries[index + 1]?.line ?? lines.length;
    // 超长标题无法完整进入元数据，原始标题必须保留在正文中。
    pushSegment(segments, heading.title.slice(0, 200), "chapter", heading.line, endLine,
      heading.title.length <= 200
        ? { startLine: heading.line, endLine: heading.endLine }
        : undefined,
    );
  }
  return { lines, segments, headingLevel: level };
}
