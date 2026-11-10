import type { Document, Element } from "@xmldom/xmldom";
import {
  attrOf,
  elementChildren,
  elementsByLocalName,
  firstByLocalName,
  localNameOf,
  normalizedText,
} from "./xml";

export interface RawTocEntry {
  label: string;
  /** 原始 href，尚未解析为容器路径。 */
  href: string;
  level: number;
}

function navType(element: Element): string {
  const value =
    attrOf(element, "epub:type") ??
    attrOf(element, "type") ??
    element.getAttributeNS("http://www.idpf.org/2007/ops", "type") ??
    "";
  return value.toLowerCase();
}

function directChild(element: Element, names: readonly string[]): Element | null {
  for (const child of elementChildren(element))
    if (names.includes(localNameOf(child))) return child;
  return null;
}

function navListEntries(list: Element, level: number, out: RawTocEntry[]): void {
  for (const item of elementChildren(list)) {
    if (localNameOf(item) !== "li") continue;
    const labelElement = directChild(item, ["a", "span"]);
    const anchor = labelElement
      ? labelElement
      : directChild(item, ["a"]);
    const label = normalizedText(labelElement);
    const href = anchor ? (attrOf(anchor, "href") ?? "").trim() : "";
    if (label && href) out.push({ label, href, level });
    const nested = directChild(item, ["ol"]);
    if (nested) navListEntries(nested, level + 1, out);
  }
}

/** EPUB 3 导航：优先 epub:type="toc" 的 nav，缺失时用第一个 nav；不读取 landmarks/page-list。 */
export function parseNavToc(document: Document): RawTocEntry[] {
  const navs = elementsByLocalName(document, "nav");
  const toc =
    navs.find((nav) => /(?:^|\s)toc(?:\s|$)/.test(navType(nav))) ?? navs[0];
  if (!toc) return [];
  const list = firstByLocalName(toc, "ol");
  if (!list) return [];
  const out: RawTocEntry[] = [];
  navListEntries(list, 0, out);
  return out;
}

function ncxPoints(container: Element, level: number, out: RawTocEntry[]): void {
  for (const point of elementChildren(container)) {
    if (localNameOf(point) !== "navpoint") continue;
    const label = normalizedText(firstByLocalName(point, "text"));
    const content = firstByLocalName(point, "content");
    const href = content ? (attrOf(content, "src") ?? "").trim() : "";
    if (label && href) out.push({ label, href, level });
    ncxPoints(point, level + 1, out);
  }
}

/** EPUB 2 NCX：navMap 的 navPoint 层级即目录层级。 */
export function parseNcxToc(document: Document): RawTocEntry[] {
  const map = firstByLocalName(document, "navmap");
  if (!map) return [];
  const out: RawTocEntry[] = [];
  ncxPoints(map, 0, out);
  return out;
}
