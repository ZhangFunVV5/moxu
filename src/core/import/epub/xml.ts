import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { EpubError } from "./epub-error";

/** 单个 XML/XHTML 文档的大小上限；超过即判定为超限输入。 */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

export interface DecodedXml {
  text: string;
  encoding: string;
}

/**
 * 按 BOM 或 XML 声明解码，不把整个 EPUB 当成某种文本编码。
 * 声明不被运行时支持时明确失败，而不是用替换字符静默改写正文。
 */
export function decodeXmlBytes(
  bytes: Uint8Array,
  maxBytes: number = MAX_XML_BYTES,
): DecodedXml {
  if (bytes.byteLength > maxBytes)
    throw new EpubError(
      "XML_TOO_LARGE",
      "EPUB 中的 XML/XHTML 文档超过解析大小上限",
      `${bytes.byteLength} 字节`,
    );
  let label = "utf-8";
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = "utf-8";
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = "utf-16le";
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) label = "utf-16be";
  else {
    // XML 声明本身是 ASCII；先按 UTF-8 读取前 256 字节再取 encoding。
    const head = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(0, Math.min(256, bytes.byteLength)),
    );
    const match = /^<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(head);
    if (match) label = match[1].trim();
  }
  let text: string;
  try {
    text = new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new EpubError(
        "UNSUPPORTED_ENCODING",
        `EPUB 中的 XML/XHTML 声明了不支持的编码：${label}`,
      );
    }
  }
  return { text, encoding: label.toLowerCase() };
}

/** XML 解析：外部实体不会被解析器抓取；error 及以上都视为结构非法。 */
export function parseXml(
  source: string,
  file: string,
  mimeType: "application/xml" | "application/xhtml+xml" = "application/xml",
): XmlDocument {
  // 书内 XML 不应自定义实体；拒绝 ENTITY 声明以避免实体展开型资源消耗。
  if (/<!ENTITY/i.test(source))
    throw new EpubError(
      "INVALID_XML",
      "EPUB 中的 XML 包含自定义实体声明，已拒绝解析",
      file,
    );
  const problems: string[] = [];
  let document: XmlDocument | null = null;
  try {
    document = new DOMParser({
      onError: (level, message) => {
        // 未知实体保留为字面量；其余结构性错误仍然拒绝。
        if (/entity not found/i.test(message)) return;
        if (level !== "warning") problems.push(message);
      },
    }).parseFromString(source, mimeType);
  } catch (error) {
    throw new EpubError(
      "INVALID_XML",
      "EPUB 中的 XML/XHTML 无法解析",
      `${file}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!document?.documentElement)
    throw new EpubError("INVALID_XML", "EPUB 中的 XML/XHTML 缺少根元素", file);
  if (problems.length)
    throw new EpubError(
      "INVALID_XML",
      "EPUB 中的 XML/XHTML 结构非法",
      `${file}：${problems.slice(0, 3).join("；")}`,
    );
  return document;
}

export function localNameOf(node: { localName?: string | null; nodeName: string }): string {
  return (node.localName || node.nodeName || "").toLowerCase();
}

export function elementChildren(element: XmlElement): XmlElement[] {
  const result: XmlElement[] = [];
  for (let node = element.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1) result.push(node as XmlElement);
  return result;
}

/** 兼容未声明命名空间的写法：先精确属性名，再按 localName 匹配。 */
export function attrOf(element: XmlElement, name: string): string | null {
  const direct = element.getAttribute(name);
  if (direct !== null && direct !== "") return direct;
  const target = name.includes(":")
    ? name.slice(name.indexOf(":") + 1).toLowerCase()
    : name.toLowerCase();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attr = element.attributes.item(index);
    if (!attr) continue;
    if ((attr.localName || attr.name).toLowerCase() === target)
      return attr.value;
  }
  return null;
}

export function elementsByLocalName(
  root: XmlDocument | XmlElement,
  name: string,
): XmlElement[] {
  const target = name.toLowerCase();
  const result: XmlElement[] = [];
  const all = root.getElementsByTagName("*");
  for (let index = 0; index < all.length; index += 1) {
    const element = all.item(index) as XmlElement | null;
    if (element && localNameOf(element) === target) result.push(element);
  }
  return result;
}

export function firstByLocalName(
  root: XmlDocument | XmlElement,
  name: string,
): XmlElement | null {
  return elementsByLocalName(root, name)[0] ?? null;
}

/** 读取文本内容并按 HTML 空白规则折叠；用于标题、元数据与目录标签。 */
export function normalizedText(element: XmlElement | null): string {
  if (!element) return "";
  return (element.textContent ?? "")
    .replace(/[\t\r\n ]+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}
