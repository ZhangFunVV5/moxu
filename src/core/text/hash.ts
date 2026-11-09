import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 正文 hash 的唯一规则：对 `ChapterFile.body` 的 UTF-8 字节取 SHA-256。
 * body 使用 \n 行分隔，标题、块类型与导入选项都不进入正文 hash。
 */
export function hashBody(body: string): string {
  return sha256Hex(body);
}
