export const SUPPORTED_ENCODINGS = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "gb18030",
  "big5",
] as const;
export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number];

export const ENCODING_LABELS: Record<SupportedEncoding, string> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  gb18030: "GB18030 / GBK",
  big5: "Big5",
};

export function isSupportedEncoding(value: string): value is SupportedEncoding {
  return (SUPPORTED_ENCODINGS as readonly string[]).includes(value);
}
