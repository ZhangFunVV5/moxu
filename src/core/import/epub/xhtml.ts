import type { Document, Element, Node } from "@xmldom/xmldom";
import type { ConversionNoticeCode } from "../../../shared/book";
import {
  attrOf,
  elementChildren,
  elementsByLocalName,
  localNameOf,
  normalizedText,
} from "./xml";

export interface BlockNotice {
  code: ConversionNoticeCode;
  count: number;
}

export interface ConvertedBlock {
  markdown: string;
  /** 本块起点对应的文档锚点（元素 id / a[name]）。 */
  anchors: string[];
  headingLevel: number | null;
  /** 标题纯文本，用于导航缺失时的章名回退。 */
  headingText: string;
  notices: BlockNotice[];
}

export interface ConvertedDocument {
  blocks: ConvertedBlock[];
  /** 锚点 → 块下标；同一锚点只取第一次出现。 */
  anchors: Map<string, number>;
  hasText: boolean;
}

interface NoticeSink {
  add(code: ConversionNoticeCode, count?: number): void;
}

function sink(map: Map<ConversionNoticeCode, number>): NoticeSink {
  return {
    add(code, count = 1) {
      map.set(code, (map.get(code) ?? 0) + count);
    },
  };
}

function mapNotices(map: Map<ConversionNoticeCode, number>): BlockNotice[] {
  return [...map.entries()].map(([code, count]) => ({ code, count }));
}

function childNodesOf(element: Element): Node[] {
  const result: Node[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling)
    result.push(node);
  return result;
}

const SKIP_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "head",
  "title",
  "meta",
  "link",
  "nav",
  "template",
]);

const INLINE_ELEMENTS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "ins",
  "kbd",
  "mark",
  "math",
  "object",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "svg",
  "time",
  "tt",
  "u",
  "var",
  "video",
  "audio",
  "iframe",
  "embed",
  "canvas",
  "wbr",
]);

const CONTAINER_ELEMENTS = new Set([
  "body",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "center",
  "figure",
  "figcaption",
  "address",
  "details",
  "summary",
  "form",
  "fieldset",
]);

function isWhitespaceText(node: Node): boolean {
  return (node.nodeType === 3 || node.nodeType === 4) &&
    !(node.nodeValue ?? "").trim();
}

function hasInlineAnchor(element: Element): boolean {
  if (attrOf(element, "id")) return true;
  return localNameOf(element) === "a" && !!attrOf(element, "name");
}

function collectAnchors(nodes: readonly Node[]): string[] {
  const anchors: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (hasInlineAnchor(element)) {
      const id = attrOf(element, "id") ?? attrOf(element, "name");
      if (id) anchors.push(id);
    }
    for (const child of elementChildren(element)) visit(child);
  };
  for (const node of nodes) visit(node);
  return anchors;
}

/** 收集叶子块内部的 inline 锚点，不进入后续的嵌套块容器。 */
function collectInlineAnchors(element: Element): string[] {
  const anchors: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (!INLINE_ELEMENTS.has(localNameOf(child))) return;
    if (hasInlineAnchor(child)) {
      const id = attrOf(child, "id") ?? attrOf(child, "name");
      if (id) anchors.push(id);
    }
    for (const nested of childNodesOf(child)) visit(nested);
  };
  for (const child of childNodesOf(element)) visit(child);
  return anchors;
}

function escapeText(text: string): string {
  return text
    .replace(/([\\`*_[\]])/g, "\\$1")
    .replace(/&(?=(?:#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);)/g, "\\&");
}

function collapseWhitespace(text: string): string {
  return text.replace(/[\t\r\n\f ]+/g, " ");
}

function wrapEmphasis(inner: string, marker: string): string {
  if (!inner.trim()) return inner;
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  if (!match) return inner;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function markdownUrl(url: string): string {
  const cleaned = url.replace(/[\r\n]/g, "").trim();
  return /[()<>\s]/.test(cleaned) ? `<${cleaned.replace(/[<>]/g, "")}>` : cleaned;
}

function externalHref(href: string): "safe" | "unsafe" | "internal" {
  if (/^https?:/i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href))
    return "safe";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    return "unsafe";
  return "internal";
}

function renderInlineNode(node: Node, notices: NoticeSink): string {
  if (node.nodeType === 3 || node.nodeType === 4)
    return escapeText(collapseWhitespace(node.nodeValue ?? ""));
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const name = localNameOf(element);
  if (SKIP_ELEMENTS.has(name)) return "";
  const children = (): string => renderInlineNodes(childNodesOf(element), notices);
  switch (name) {
    case "br":
      return "\\\n";
    case "img":
    case "svg":
      notices.add("image-dropped");
      return "";
    case "video":
    case "audio":
    case "object":
    case "iframe":
    case "embed":
    case "canvas":
      notices.add("media-dropped");
      return "";
    case "ruby": {
      notices.add("ruby-flattened");
      let text = "";
      for (const child of childNodesOf(element)) {
        if (child.nodeType === 1) {
          const childName = localNameOf(child as Element);
          if (childName === "rt" || childName === "rp") continue;
        }
        text += renderInlineNode(child, notices);
      }
      return text;
    }
    case "rt":
    case "rp":
      return "";
    case "em":
    case "i":
    case "cite":
    case "dfn":
      return wrapEmphasis(children(), "*");
    case "strong":
    case "b":
      return wrapEmphasis(children(), "**");
    case "code":
    case "kbd":
    case "samp":
    case "tt": {
      const value = collapseWhitespace(element.textContent ?? "");
      if (!value) return "";
      const delimiter = value.includes("`") ? "``" : "`";
      const padded = /^\s|\s$/.test(value) ? ` ${value} ` : value;
      return `${delimiter}${padded}${delimiter}`;
    }
    case "a": {
      const inner = children();
      const href = (attrOf(element, "href") ?? "").trim();
      if (!href) return inner;
      const kind = externalHref(href);
      if (kind === "safe")
        return `[${inner || escapeText(href)}](${markdownUrl(href)})`;
      if (kind === "unsafe") {
        notices.add("external-link-degraded");
        return inner || escapeText(href);
      }
      notices.add("internal-link-degraded");
      return inner || escapeText(href);
    }
    case "sub":
    case "sup":
    case "mark":
    case "del":
    case "s":
    case "u":
    case "ins":
    case "small":
    case "big":
      notices.add("inline-style-flattened");
      return children();
    case "math":
      notices.add("unsupported-content-flattened");
      return children();
    case "q":
      return `“${children()}”`;
    default:
      return children();
  }
}

function renderInlineNodes(nodes: readonly Node[], notices: NoticeSink): string {
  let out = "";
  for (const node of nodes) out += renderInlineNode(node, notices);
  return out;
}

function escapeBlockStart(markdown: string): string {
  const value = markdown.replace(/ +$/g, "");
  if (/^(?:#{1,6}(?:\s|$)|>|[-+*](?:\s|$)|\d+[.)](?:\s|$)|={3,}\s*$|-{3,}\s*$)/.test(value))
    return `\\${value}`;
  return value;
}

function paragraphOf(nodes: readonly Node[], notices: NoticeSink): string {
  const rendered = renderInlineNodes(nodes, notices)
    .replace(/[ \t]+/g, " ")
    .trim();
  return rendered ? escapeBlockStart(rendered) : "";
}

function headingOf(element: Element, level: number, notices: NoticeSink): ConvertedBlock {
  const text = paragraphOf(childNodesOf(element), notices);
  const markdown = text ? `${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}` : "";
  return {
    markdown,
    anchors: collectInlineAnchors(element),
    headingLevel: level,
    headingText: normalizedText(element),
    notices: [],
  };
}

function isFootnoteAside(element: Element): boolean {
  const type = (
    attrOf(element, "epub:type") ??
    attrOf(element, "type") ??
    element.getAttributeNS("http://www.idpf.org/2007/ops", "type") ??
    ""
  ).toLowerCase();
  const role = (attrOf(element, "role") ?? "").toLowerCase();
  return /(?:^|\s)(?:footnote|endnote|note|doc-footnote)(?:\s|$)/.test(
    `${type} ${role}`,
  );
}

function preMarkdown(element: Element): string {
  const codeElement = elementChildren(element).find(
    (child) => localNameOf(child) === "code",
  );
  const raw = (codeElement ? codeElement.textContent : element.textContent) ?? "";
  const code = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "");
  if (!code) return "";
  const className = codeElement ? (attrOf(codeElement, "class") ?? "") : "";
  const language = /(?:^|\s)language-([A-Za-z0-9_+-]+)/.exec(className)?.[1] ?? "";
  let fence = "```";
  while (code.includes(fence)) fence += "`";
  return `${fence}${language}\n${code}\n${fence}`;
}

function listMarkdown(element: Element, notices: NoticeSink): string {
  const ordered = localNameOf(element) === "ol";
  const parsedStart = Number(attrOf(element, "start"));
  const start = Number.isFinite(parsedStart) && parsedStart > 0 ? parsedStart : 1;
  const lines: string[] = [];
  let index = 0;
  for (const item of elementChildren(element)) {
    if (localNameOf(item) !== "li") continue;
    const parts: Array<{ markdown: string; inline: boolean }> = [];
    let inlineNodes: Node[] = [];
    const flushInline = (): void => {
      const markdown = paragraphOf(inlineNodes, notices);
      inlineNodes = [];
      if (markdown) parts.push({ markdown, inline: true });
    };
    const appendBlock = (child: Element): void => {
      const converted = convertBlockElement(child, notices);
      for (const block of converted)
        for (const notice of block.notices)
          notices.add(notice.code, notice.count);
      const markdown = converted
        .map((block) => block.markdown.trim())
        .filter(Boolean)
        .join("\n\n");
      if (markdown) parts.push({ markdown, inline: false });
    };
    for (const node of childNodesOf(item)) {
      if (node.nodeType === 3 || node.nodeType === 4) {
        inlineNodes.push(node);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      const name = localNameOf(child);
      if (name === "p") {
        flushInline();
        const markdown = paragraphOf(childNodesOf(child), notices);
        if (markdown) parts.push({ markdown, inline: true });
      } else if (name === "ul" || name === "ol") {
        flushInline();
        const markdown = listMarkdown(child, notices);
        if (markdown) parts.push({ markdown, inline: false });
      } else if (
        name === "blockquote" ||
        name === "pre" ||
        name === "div" ||
        name === "section" ||
        name === "table"
      ) {
        flushInline();
        appendBlock(child);
      } else inlineNodes.push(child);
    }
    flushInline();
    if (!parts.length) continue;
    const marker = ordered ? `${start + index}. ` : "- ";
    index += 1;
    const indent = " ".repeat(marker.length);
    const [first, ...rest] = parts;
    const continuationParts = first.inline ? rest : parts;
    const continuation = continuationParts
      .map(({ markdown }) =>
        markdown
          .split("\n")
          .map((line) => `${indent}${line}`)
          .join("\n"),
      )
      .join("\n\n");
    lines.push(
      `${marker}${first.inline ? first.markdown : ""}${
        continuation
          ? `${first.inline ? "\n\n" : "\n"}${continuation}`
          : ""
      }`,
    );
  }
  return lines.join("\n");
}

function quoteMarkdown(blocks: readonly ConvertedBlock[]): string {
  const inner = blocks
    .map((block) => block.markdown)
    .filter((value) => value.trim())
    .join("\n\n");
  if (!inner) return "";
  return inner
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function tableMarkdown(element: Element, notices: NoticeSink): string {
  notices.add("table-flattened");
  const rows: Element[] = [];
  const collect = (parent: Element): void => {
    for (const child of elementChildren(parent)) {
      const name = localNameOf(child);
      if (name === "tr") rows.push(child);
      else if (name === "thead" || name === "tbody" || name === "tfoot")
        collect(child);
    }
  };
  collect(element);
  const lines: string[] = [];
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of elementChildren(row)) {
      if (localNameOf(cell) !== "td" && localNameOf(cell) !== "th") continue;
      const value = paragraphOf(childNodesOf(cell), notices).replace(/\n+/g, " ");
      cells.push(value);
    }
    if (cells.some((cell) => cell.trim()))
      lines.push(cells.join(" ｜ "));
  }
  return lines.join("\n\n");
}

function withAnchors(
  blocks: ConvertedBlock[],
  element: Element,
  anchors: string[],
): ConvertedBlock[] {
  const ids = [...anchors];
  const id = attrOf(element, "id");
  if (id) ids.unshift(id);
  if (!ids.length) return blocks;
  if (blocks.length === 0)
    blocks.push({
      markdown: "",
      anchors: ids,
      headingLevel: null,
      headingText: "",
      notices: [],
    });
  else blocks[0].anchors.unshift(...ids);
  return blocks;
}

/**
 * 把一个 XHTML 正文文档转成有序的 Markdown 块与锚点表。
 * 块边界同时服务于分章：导航锚点落在哪个块，章节就从哪里开始。
 */
function convertBlockElement(element: Element, notices: NoticeSink): ConvertedBlock[] {
  const name = localNameOf(element);
  if (name === "h1" || name === "h2" || name === "h3" || name === "h4" || name === "h5" || name === "h6") {
    const level = Number(name.slice(1));
    const blockNotices = new Map<ConversionNoticeCode, number>();
    const block = headingOf(element, level, sink(blockNotices));
    block.notices = mapNotices(blockNotices);
    return [block];
  }
  if (name === "p" || name === "dt" || name === "dd") {
    const blockNotices = new Map<ConversionNoticeCode, number>();
    let markdown = paragraphOf(childNodesOf(element), sink(blockNotices));
    if (name === "dt" && markdown) markdown = `**${markdown}**`;
    return [
      {
        markdown,
        anchors: collectInlineAnchors(element),
        headingLevel: null,
        headingText: "",
        notices: mapNotices(blockNotices),
      },
    ];
  }
  if (name === "hr") {
    return [{ markdown: "---", anchors: [], headingLevel: null, headingText: "", notices: [] }];
  }
  if (name === "pre") {
    return [
      {
        markdown: preMarkdown(element),
        anchors: [],
        headingLevel: null,
        headingText: "",
        notices: [],
      },
    ];
  }
  if (name === "ul" || name === "ol") {
    const blockNotices = new Map<ConversionNoticeCode, number>();
    const markdown = listMarkdown(element, sink(blockNotices));
    return [
      {
        markdown,
        anchors: [],
        headingLevel: null,
        headingText: "",
        notices: mapNotices(blockNotices),
      },
    ];
  }
  if (name === "table") {
    const blockNotices = new Map<ConversionNoticeCode, number>();
    const markdown = tableMarkdown(element, sink(blockNotices));
    return [
      {
        markdown,
        anchors: [],
        headingLevel: null,
        headingText: "",
        notices: mapNotices(blockNotices),
      },
    ];
  }
  if (name === "blockquote") {
    const inner = walkChildren(element);
    const markdown = quoteMarkdown(inner.blocks);
    const notices = inner.blocks.flatMap((block) => block.notices);
    return [
      {
        markdown,
        anchors: [],
        headingLevel: null,
        headingText: "",
        notices,
      },
    ];
  }
  if (name === "aside" || isFootnoteAside(element)) {
    const inner = walkChildren(element);
    const markdown = quoteMarkdown(inner.blocks);
    if (markdown)
      notices.add("footnote-flattened");
    return [
      {
        markdown,
        anchors: [],
        headingLevel: null,
        headingText: "",
        notices: inner.blocks.flatMap((block) => block.notices),
      },
    ];
  }
  if (CONTAINER_ELEMENTS.has(name)) return walkChildren(element).blocks;
  // 未知块级元素：保留其文本内容，并计入“不能完整转换”的提示。
  notices.add("unsupported-content-flattened");
  return walkChildren(element).blocks;
}

function walkChildren(parent: Element): { blocks: ConvertedBlock[] } {
  const blocks: ConvertedBlock[] = [];
  let inlineNodes: Node[] = [];
  let pendingAnchors: string[] = [];

  const flush = (force = false): void => {
    if (!inlineNodes.length && !force && !pendingAnchors.length) return;
    const noticeMap = new Map<ConversionNoticeCode, number>();
    const markdown = paragraphOf(inlineNodes, sink(noticeMap));
    const anchors = [...pendingAnchors, ...collectAnchors(inlineNodes)];
    const notices = mapNotices(noticeMap);
    inlineNodes = [];
    pendingAnchors = [];
    if (!markdown && notices.length === 0 && anchors.length === 0) return;
    if (!markdown && anchors.length && notices.length === 0) {
      // 空锚点（<a id="x"></a>）挂到下一个真正的块，避免制造空章节起点。
      pendingAnchors = anchors;
      return;
    }
    blocks.push({
      markdown,
      anchors,
      headingLevel: null,
      headingText: "",
      notices,
    });
  };

  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3 || node.nodeType === 4) {
      if ((node.nodeValue ?? "").trim() || inlineNodes.length) inlineNodes.push(node);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const name = localNameOf(element);
    if (SKIP_ELEMENTS.has(name)) continue;
    if (INLINE_ELEMENTS.has(name) && !isFootnoteAside(element)) {
      inlineNodes.push(element);
      continue;
    }
    flush();
    const localNotices = new Map<ConversionNoticeCode, number>();
    const produced = convertBlockElement(element, sink(localNotices));
    const extra = mapNotices(localNotices);
    if (extra.length) {
      if (produced.length) produced[0].notices.push(...extra);
      else
        produced.push({
          markdown: "",
          anchors: [],
          headingLevel: null,
          headingText: "",
          notices: extra,
        });
    }
    if (produced.length) {
      const withElement = withAnchors(produced, element, []);
      if (pendingAnchors.length) {
        const target = withElement.find(
          (block) => block.markdown.trim() || block.notices.length > 0,
        );
        if (target) {
          target.anchors.unshift(...pendingAnchors);
          pendingAnchors = [];
        }
      }
      blocks.push(...withElement);
    }
  }
  flush();
  if (pendingAnchors.length) {
    const noticeMap = new Map<ConversionNoticeCode, number>();
    blocks.push({
      markdown: "",
      anchors: pendingAnchors,
      headingLevel: null,
      headingText: "",
      notices: [],
    });
  }
  return { blocks };
}

export function convertXhtml(document: Document, _docPath: string): ConvertedDocument {
  const body =
    elementsByLocalName(document, "body")[0] ?? document.documentElement;
  if (!body)
    return { blocks: [], anchors: new Map(), hasText: false };
  const { blocks } = walkChildren(body);
  const anchors = new Map<string, number>();
  for (const [index, block] of blocks.entries())
    for (const anchor of block.anchors)
      if (!anchors.has(anchor)) anchors.set(anchor, index);
  return {
    blocks,
    anchors,
    hasText: blocks.some((block) => block.markdown.trim().length > 0),
  };
}
