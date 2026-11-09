import { z } from "zod";
export const formatOptionsSchema = z.object({
  headingTemplate: z.string().min(1).max(160).refine(v => !/[\r\n]/.test(v) && !v.replace(/\{(?:title|number)\}/g, "").match(/[{}]/), "仅支持 {title} 和 {number}"),
  indent: z.enum(["none", "fullwidth", "custom"]),
  customPrefix: z.string().max(20).regex(/^[ 　]*$/, '缩进前缀仅支持半角或全角空格'),
  paragraphBlankLines: z.number().int().min(0).max(3),
  headingBlankLinesBefore: z.number().int().min(0).max(3),
  headingBlankLinesAfter: z.number().int().min(0).max(3),
  trimTrailingWhitespace: z.boolean(),
  eol: z.enum(["lf", "crlf"]),
  encoding: z.enum(["utf8", "utf8-bom"]),
  paragraphMode: z.enum(["line", "blank"]),
}).strict();
export type FormatOptions = z.infer<typeof formatOptionsSchema>;
export const defaultFormatOptions: FormatOptions = { headingTemplate: "{title}", indent: "fullwidth", customPrefix: "", paragraphBlankLines: 1, headingBlankLinesBefore: 1, headingBlankLinesAfter: 1, trimTrailingWhitespace: true, eol: "lf", encoding: "utf8", paragraphMode: "line" };
