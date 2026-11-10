import MarkdownIt from "markdown-it";
import {
  type Block,
  type BlockKind,
  type BodyFormat,
  type ParagraphMode,
} from "../../shared/book";
import { lineStartOffsets } from "../../shared/text-offsets";

const md = new MarkdownIt({ html: true, linkify: false, typographer: false });

const SEPARATOR = /^\s*(?:[-*_=—·~]{3,}|(?:×|x|X)\s*){1,}\s*$/;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function lineEnd(lineStarts: readonly number[], body: string, line: number): number {
  return line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : body.length;
}

function pushBlock(
  out: Block[],
  kind: BlockKind,
  body: string,
  start: number,
  end: number,
): void {
  if (end <= start) return;
  const previous = out[out.length - 1];
  // 防止解析器给出重叠区间：只在同一正文版本内生成有序、互不重叠的块。
  if (previous && start < previous.end) return;
  out.push({ id: `p${out.length + 1}`, kind, start, end });
}

/** TXT：每行一段 / 空行分段。空白行不生成段落，但保留在 body 中。 */
function deriveTxtBlocks(body: string, paragraphMode: ParagraphMode): Block[] {
  const lines = body.split("\n");
  const starts = lineStartOffsets(body);
  const blocks: Block[] = [];
  if (paragraphMode === "line") {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isBlank(line)) continue;
      const start = starts[i];
      const end = lineEnd(starts, body, i);
      pushBlock(blocks, SEPARATOR.test(line) ? "separator" : "paragraph", body, start, end);
    }
    return blocks;
  }
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && isBlank(lines[index])) index += 1;
    if (index >= lines.length) break;
    const first = index;
    let last = index;
    index += 1;
    while (index < lines.length && !isBlank(lines[index])) {
      last = index;
      index += 1;
    }
    const start = starts[first];
    const end = lineEnd(starts, body, last);
    const text = body.slice(start, end);
    const single = first === last;
    pushBlock(
      blocks,
      single && SEPARATOR.test(text) ? "separator" : "paragraph",
      body,
      start,
      end,
    );
  }
  return blocks;
}

type TokenLike = {
  type: string;
  tag?: string;
  map?: [number, number] | null;
  nesting: number;
};

function markdownBlockKind(token: TokenLike): BlockKind | null {
  if (token.type === "heading_open") return "heading";
  if (token.type === "paragraph_open") return "paragraph";
  if (token.type === "fence" || token.type === "code_block") return "code";
  if (token.type === "bullet_list_open" || token.type === "ordered_list_open")
    return "list";
  if (token.type === "blockquote_open") return "quote";
  if (token.type === "hr") return "separator";
  if (token.type === "html_block") return "html";
  return null;
}

/** Markdown：按解析器的顶层 token 保留标题、段落、代码、列表、引用与分隔符结构。 */
function deriveMarkdownBlocks(body: string): Block[] {
  const tokens = md.parse(body, {}) as unknown as TokenLike[];
  const starts = lineStartOffsets(body);
  const blocks: Block[] = [];
  for (const token of tokens) {
    const kind = markdownBlockKind(token);
    if (!kind) continue;
    const map = token.map;
    if (!map) continue;
    const start = starts[map[0]] ?? body.length;
    const end = map[1] >= starts.length ? body.length : starts[map[1]] - 1;
    pushBlock(blocks, kind, body, start, Math.max(start, end));
  }
  return blocks;
}

/**
 * 从正文派生段落／特殊块。块 ID 在同一正文版本内稳定（p1、p2…），
 * 正文变化后重新生成；旧版本坐标由 bodyHash / revision 校验，不跨版本猜测。
 */
export function deriveBlocks(
  format: BodyFormat,
  body: string,
  paragraphMode: ParagraphMode = "line",
): Block[] {
  return format === "txt"
    ? deriveTxtBlocks(body, paragraphMode)
    : deriveMarkdownBlocks(body);
}

/** 校验块结构是否与正文自洽（不重叠、顺序、范围合法）。 */
export function blockStructureProblems(
  body: string,
  blocks: readonly Block[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  let previousEnd = 0;
  for (const block of blocks) {
    if (seen.has(block.id)) problems.push(`重复段落 ID：${block.id}`);
    seen.add(block.id);
    if (block.start < 0 || block.end > body.length)
      problems.push(`段落 ${block.id} 超出正文范围`);
    if (block.start > block.end) problems.push(`段落 ${block.id} 起止颠倒`);
    if (block.start < previousEnd)
      problems.push(`段落 ${block.id} 与前一段落重叠`);
    if (block.end > block.start && block.end - block.start > 200_000)
      problems.push(`段落 ${block.id} 超过单段长度上限`);
    previousEnd = Math.max(previousEnd, block.end);
  }
  return problems;
}
