import { normalizeNewlines } from "../../shared/text-offsets";
import {
  ENCODING_LABELS,
  SUPPORTED_ENCODINGS,
  isSupportedEncoding,
  type SupportedEncoding,
} from "../../shared/encoding";

export { ENCODING_LABELS, SUPPORTED_ENCODINGS, isSupportedEncoding };
export type { SupportedEncoding };


export interface EncodingCandidate {
  encoding: SupportedEncoding;
  label: string;
  confidence: "high" | "medium" | "low";
  replacements: number;
  bom: boolean;
}

export interface DecodedText {
  encoding: SupportedEncoding;
  text: string;
  eol: "lf" | "crlf";
  candidates: EncodingCandidate[];
  /** 仍有歧义或存在替换字符时必须让用户显式选择编码，不能默认吞掉坏字节。 */
  requiresChoice: boolean;
  replacements: number;
  bom: boolean;
}

export class DecodeError extends Error {
  readonly code: "EMPTY_FILE" | "BINARY_FILE" | "UNSUPPORTED_ENCODING";
  constructor(code: DecodeError["code"], message: string) {
    super(message);
    this.name = "DecodeError";
    this.code = code;
  }
}

interface BomInfo {
  encoding?: SupportedEncoding;
  length: number;
}

function detectBom(buffer: Uint8Array): BomInfo {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
    return { encoding: "utf-8", length: 3 };
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe)
    return { encoding: "utf-16le", length: 2 };
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff)
    return { encoding: "utf-16be", length: 2 };
  return { length: 0 };
}

function decodeStrict(buffer: Uint8Array, encoding: SupportedEncoding): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function decodeLoose(
  buffer: Uint8Array,
  encoding: SupportedEncoding,
): { text: string; replacements: number } {
  const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
  let replacements = 0;
  for (const char of text) if (char === "\uFFFD") replacements += 1;
  return { text, replacements };
}

function isCjk(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

function looksLikeBinary(buffer: Uint8Array): boolean {
  if (buffer.length === 0) return false;
  let control = 0;
  const sample = Math.min(buffer.length, 8192);
  for (let i = 0; i < sample; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) control += 1;
  }
  return control / sample > 0.3;
}

function looksUtf16(buffer: Uint8Array, endian: "le" | "be"): boolean {
  if (buffer.length < 4) return false;
  let zeroEven = 0;
  let zeroOdd = 0;
  const sample = Math.min(buffer.length - (buffer.length % 2), 4096);
  for (let i = 0; i < sample; i += 2) {
    if (buffer[i] === 0) zeroEven += 1;
    if (buffer[i + 1] === 0) zeroOdd += 1;
  }
  const pairs = sample / 2;
  return endian === "le" ? zeroOdd / pairs > 0.2 : zeroEven / pairs > 0.2;
}

function cjkRatio(text: string): number {
  let cjk = 0;
  let visible = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 10 || code === 13 || code === 32 || code === 9) continue;
    visible += 1;
    if (isCjk(code)) cjk += 1;
  }
  return visible === 0 ? 0 : cjk / visible;
}

function scoreCandidate(text: string, replacements: number): number {
  let control = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) control += 1;
  }
  return replacements * 1000 + control * 50 - cjkRatio(text) * 30;
}

/**
 * 字节解码：
 * - 有 BOM 时按 BOM 解码；
 * - 无 BOM 时先严格试 UTF-8，失败后比较 UTF-16 / GB18030 / Big5 候选；
 * - 只有存在替换字符或多个同样干净的候选时才对用户要求显式选择，
 *   不使用替换字符静默覆盖原文。
 */
export function decodeBuffer(buffer: Uint8Array): DecodedText {
  if (buffer.byteLength === 0) throw new DecodeError("EMPTY_FILE", "文件为空");

  const bom = detectBom(buffer);
  const body = bom.length ? buffer.subarray(bom.length) : buffer;

  if (bom.encoding) {
    const strict = decodeStrict(body, bom.encoding);
    const decoded = strict ?? decodeLoose(body, bom.encoding).text;
    const replacements = strict ? 0 : decodeLoose(body, bom.encoding).replacements;
    const normalized = normalizeNewlines(decoded);
    return {
      encoding: bom.encoding,
      text: normalized.text,
      eol: normalized.eol,
      candidates: [
        {
          encoding: bom.encoding,
          label: ENCODING_LABELS[bom.encoding],
          confidence: strict ? "high" : "low",
          replacements,
          bom: true,
        },
      ],
      requiresChoice: !strict || replacements > 0,
      replacements,
      bom: true,
    };
  }

  const utf16 =
    looksUtf16(body, "le") ? "utf-16le" : looksUtf16(body, "be") ? "utf-16be" : null;
  if (!utf16 && looksLikeBinary(body))
    throw new DecodeError("BINARY_FILE", "文件看起来是二进制，不是文本");

  const tried: Array<{ encoding: SupportedEncoding; text: string; replacements: number }> = [];
  const strictUtf8 = decodeStrict(body, "utf-8");
  if (strictUtf8 !== null)
    tried.push({ encoding: "utf-8", text: strictUtf8, replacements: 0 });
  if (utf16 === "utf-16le")
    tried.push({ encoding: "utf-16le", ...decodeLoose(body, "utf-16le") });
  if (utf16 === "utf-16be")
    tried.push({ encoding: "utf-16be", ...decodeLoose(body, "utf-16be") });
  for (const encoding of ["gb18030", "big5"] as const) {
    if (strictUtf8 !== null && encoding === "big5") continue;
    tried.push({ encoding, ...decodeLoose(body, encoding) });
  }

  const encodingRank = (encoding: SupportedEncoding): number =>
    encoding === "utf-8" ? 0 : encoding === "gb18030" ? 1 : encoding === "big5" ? 3 : 2;
  tried.sort((a, b) => {
    const scoreA = scoreCandidate(a.text, a.replacements);
    const scoreB = scoreCandidate(b.text, b.replacements);
    if (Math.abs(scoreA - scoreB) > 1) return scoreA - scoreB;
    const cleanA = a.replacements === 0 ? 0 : 1;
    const cleanB = b.replacements === 0 ? 0 : 1;
    if (cleanA !== cleanB) return cleanA - cleanB;
    return encodingRank(a.encoding) - encodingRank(b.encoding);
  });
  const best = tried[0];
  if (!best || best.text.trim().length === 0)
    throw new DecodeError("UNSUPPORTED_ENCODING", "无法识别文件编码");

  const clean = tried.filter((candidate) => candidate.replacements === 0);
  const candidates: EncodingCandidate[] = tried.map((candidate) => ({
    encoding: candidate.encoding,
    label: ENCODING_LABELS[candidate.encoding],
    confidence:
      candidate.encoding === best.encoding
        ? candidate.replacements === 0
          ? cjkRatio(candidate.text) > 0.2
            ? "medium"
            : "low"
          : "low"
        : "low",
    replacements: candidate.replacements,
    bom: false,
  }));
  const normalized = normalizeNewlines(best.text);
  return {
    encoding: best.encoding,
    text: normalized.text,
    eol: normalized.eol,
    candidates,
    requiresChoice: clean.length !== 1 || best.replacements > 0,
    replacements: best.replacements,
    bom: false,
  };
}

export function decodeWith(
  buffer: Uint8Array,
  encoding: SupportedEncoding,
): { text: string; eol: "lf" | "crlf"; replacements: number } {
  if (!SUPPORTED_ENCODINGS.includes(encoding))
    throw new DecodeError("UNSUPPORTED_ENCODING", "不支持的编码");
  const bom = detectBom(buffer);
  const body = bom.length ? buffer.subarray(bom.length) : buffer;
  const decoded = decodeLoose(body, encoding);
  const normalized = normalizeNewlines(decoded.text);
  return {
    text: normalized.text,
    eol: normalized.eol,
    replacements: decoded.replacements,
  };
}

