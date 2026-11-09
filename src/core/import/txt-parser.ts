import type { SplitMode } from "../../shared/book";
import {
  isBlankLine,
  pushSegment,
  type ParsedSegment,
} from "./segments";

export interface TxtParseResult {
  segments: ParsedSegment[];
  lines: string[];
}

const NUM = "0-9０-９零〇一二三四五六七八九十百千万两";
const SEP = "[\\s：:、.．·\\-—]";

const CHAPTER_RE = new RegExp(
  `^(第\\s*[${NUM}]+\\s*[章节回])(?=$|${SEP})(.*)$`,
);
const VOLUME_RE = new RegExp(
  `^(第\\s*[${NUM}]+\\s*[卷部篇]|卷\\s*[${NUM}]+)(?=$|${SEP})(.*)$`,
);
const SPECIAL_RE =
  /^(序章|序言|序幕|楔子|引子|前言|尾声|终章|后记|番外(?:篇)?(?:\s*[\d一二三四五六七八九十百]+)?|附录(?:\s*[\d一二三四五六七八九十百]+)?)(?=$|[\s：:、.．·\-—])(.*)$/;
const ENGLISH_RE = /^(chapter|prologue|epilogue|part)\s+[0-9ivxlcdm]+(?=$|[\s:.\-—])(.*)$/i;

const MAX_HEADING_LENGTH = 50;

function specialKind(head: string) {
  if (/^(序章|序言|序幕|楔子|引子|前言)/.test(head)) return "chapter" as const;
  if (/^(尾声|终章|后记|番外|附录)/.test(head)) return "extra" as const;
  return "chapter" as const;
}

function matchHeading(line: string): { kind: "chapter" | "volume" | "extra" } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return null;
  if (VOLUME_RE.test(trimmed)) return { kind: "volume" };
  if (CHAPTER_RE.test(trimmed)) return { kind: "chapter" };
  const special = SPECIAL_RE.exec(trimmed);
  if (special) return { kind: specialKind(special[1]) };
  const english = ENGLISH_RE.exec(trimmed);
  if (english) {
    const word = english[1].toLowerCase();
    return {
      kind: word === "prologue" || word === "epilogue" ? "extra" : "chapter",
    };
  }
  return null;
}

function headingTitle(line: string): string {
  return line
    .trim()
    .replace(/^\u3000+|\u3000+$/g, "")
    .slice(0, 200);
}

/**
 * TXT 分章：
 * - 识别中文章号、回／节、卷／部／篇、序章／楔子／前言／尾声／后记／番外，以及 Chapter N；
 * - 标题前内容作为 frontmatter 保留，不把第一段正文当标题丢弃；
 * - 重复章号不合并、不去重，每段都有独立索引；
 * - splitMode=single 时整篇一章；没有任何标题时同样整篇一章。
 */
export function parseTxtChapters(
  text: string,
  splitMode: SplitMode,
): TxtParseResult {
  const lines = text.split("\n");
  const headings: Array<{ line: number; title: string; kind: "chapter" | "volume" | "extra" }> = [];
  if (splitMode === "auto") {
    for (let i = 0; i < lines.length; i += 1) {
      const match = matchHeading(lines[i]);
      if (match) headings.push({ line: i, title: headingTitle(lines[i]), kind: match.kind });
    }
  }

  if (headings.length === 0) {
    return {
      lines,
      segments: [
        {
          index: 0,
          title: "全文",
          kind: "chapter",
          startLine: 0,
          endLine: lines.length,
        },
      ],
    };
  }

  const segments: ParsedSegment[] = [];
  const firstHeading = headings[0];
  if (lines.slice(0, firstHeading.line).some((line) => !isBlankLine(line)))
    pushSegment(segments, "标题前内容", "frontmatter", 0, firstHeading.line);
  for (const [index, heading] of headings.entries()) {
    const endLine = headings[index + 1]?.line ?? lines.length;
    pushSegment(segments, heading.title, heading.kind, heading.line, endLine, {
      startLine: heading.line,
      endLine: heading.line + 1,
    });
  }
  return { lines, segments };
}
