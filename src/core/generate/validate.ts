import { countCodePoints } from "../../shared/book";
import {
  GenerateError,
  type TitleOptions,
  type SummaryOptions,
} from "../../shared/generate";
export function validateText(text: string, options: SummaryOptions): string {
  const value = text.trim();
  const n = countCodePoints(value);
  if (n < options.minLength || n > options.maxLength)
    throw new GenerateError(
      "INVALID_LENGTH",
      `Unicode 字符数 ${n} 不在 ${options.minLength}–${options.maxLength} 范围`,
    );
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(value))
    throw new GenerateError("INVALID_TEXT", "包含非法字符或未配对代理项");
  return value;
}
export const chapterPrefix =
  /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷回部篇]|chapter\s*\d+|[\d一二三四五六七八九十]+[、.．])/i;
export function validateTitle(text: string, options: SummaryOptions): string {
  const value = validateText(text, options);
  if (/[\r\n]/.test(value) || chapterPrefix.test(value))
    throw new GenerateError(
      "INVALID_TITLE",
      "候选仅可包含标题正文，不能重复章号或换行",
    );
  return value;
}
export function validateTitles(
  values: string[],
  options: TitleOptions,
): string[] {
  if (values.length !== options.candidateCount)
    throw new GenerateError(
      "INVALID_COUNT",
      `必须提交 ${options.candidateCount} 项候选`,
    );
  const titles = values.map((x) => validateTitle(x, options));
  if (new Set(titles).size !== titles.length)
    throw new GenerateError("DUPLICATE_TITLE", "标题候选完全重复");
  return titles;
}
/** Unicode code point 分块，优先在段落结束，长段落也不切开代理对。 */
export function chunkBody(body: string, max = 6000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of body.split(/(?<=\n)/u)) {
    if ([...current].length + [...paragraph].length <= max) {
      current += paragraph;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    const chars = [...paragraph];
    while (chars.length > max) chunks.push(chars.splice(0, max).join(""));
    current = chars.join("");
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}
