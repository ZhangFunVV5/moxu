import type { Block } from "../../shared/book";
import {
  PROOFREAD_CATEGORIES,
  ProofreadError,
  modelEditCandidateSchema,
  type CandidateValidationContext,
  type NormalizedCandidate,
  type ProofreadCategory,
  type ProofreadErrorCode,
  type ProofreadOptions,
} from "../../shared/proofreading";
import { splitsSurrogatePair } from "../../shared/text-offsets";

export interface CandidateValidationFailure {
  index: number;
  code: string;
  message: string;
  field?: string;
}

function fail(
  code: ProofreadErrorCode,
  message: string,
  detail = "",
): never {
  throw new ProofreadError(code, message, detail);
}

function categoryEnabled(
  category: ProofreadCategory,
  enabled: readonly ProofreadCategory[],
): boolean {
  return enabled.includes(category);
}

function blockOf(
  paragraphId: string,
  ctx: CandidateValidationContext,
): Block {
  if (ctx.block.id !== paragraphId)
    fail(
      "FORBIDDEN_RANGE",
      "候选段落不在当前目标块内",
      `目标 ${ctx.block.id}，候选 ${paragraphId}`,
    );
  if (ctx.block.kind !== "paragraph")
    fail("FORBIDDEN_RANGE", "只有普通段落允许提精校补丁");
  return ctx.block;
}

/** 在段落目标区间内定位唯一非空引句；返回段落内坐标。 */
function locateUniqueQuote(
  text: string,
  targetStart: number,
  targetEnd: number,
  quote: string,
): number {
  if (!quote)
    fail("QUOTE_MISMATCH", "空引句不能自动定位，插入必须提供明确坐标");
  const target = text.slice(targetStart, targetEnd);
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const index = target.indexOf(quote, from);
    if (index < 0) break;
    // 命中必须完整落在目标区间内（目标区间就是其自身，天然成立）。
    hits.push(targetStart + index);
    // 逐字符推进以识别重叠出现（“复复复”中的“复复”出现两次）。
    from = index + 1;
    if (hits.length > 1) break;
  }
  if (hits.length === 0)
    fail("QUOTE_MISMATCH", "原句与基础段落不一致", quote.slice(0, 80));
  if (hits.length > 1)
    fail("AMBIGUOUS_QUOTE", "原句在目标区间内重复，必须提供明确坐标");
  return hits[0];
}

/**
 * PF-02 单候选校验。顺序：类别 → 段落／目标块 → 坐标与引句 → UTF-16 边界 → 无变化。
 * 返回规范化后的候选；任何不满足条件的候选都给出明确错误，不做猜测。
 */
export function validateCandidate(
  raw: unknown,
  ctx: CandidateValidationContext,
): NormalizedCandidate {
  const parsed = modelEditCandidateSchema.safeParse(raw);
  if (!parsed.success)
    fail(
      "SCHEMA_INVALID",
      "候选结构非法",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("；"),
    );
  const candidate = parsed.data;
  if (!PROOFREAD_CATEGORIES.includes(candidate.category))
    fail("SCHEMA_INVALID", "未知精校类别");
  if (!categoryEnabled(candidate.category, ctx.enabledCategories))
    fail(
      "FORBIDDEN_RANGE",
      "该检查类别未启用，候选不能进入可采纳列表",
      candidate.category,
    );
  blockOf(candidate.paragraphId, ctx);
  const text = ctx.paragraphText;
  if (
    ctx.targetStart < 0 ||
    ctx.targetEnd > text.length ||
    ctx.targetStart > ctx.targetEnd
  )
    fail("OUT_OF_RANGE", "目标区间超出基础段落");

  let start: number;
  let end: number;
  if (candidate.start === undefined && candidate.end === undefined) {
    start = locateUniqueQuote(text, ctx.targetStart, ctx.targetEnd, candidate.before);
    end = start + candidate.before.length;
  } else if (candidate.start === undefined || candidate.end === undefined) {
    fail("SCHEMA_INVALID", "start / end 必须同时提供或同时省略");
  } else {
    start = candidate.start;
    end = candidate.end;
    if (start > end) fail("OUT_OF_RANGE", "start 大于 end");
    if (end > text.length)
      fail("OUT_OF_RANGE", "坐标超出基础段落长度", `${end} > ${text.length}`);
    if (start < ctx.targetStart || end > ctx.targetEnd)
      fail(
        "FORBIDDEN_RANGE",
        "候选越出当前目标块或只读上下文",
        `${start}-${end} 不在 ${ctx.targetStart}-${ctx.targetEnd}`,
      );
  }

  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end))
    fail("INVALID_UNICODE_BOUNDARY", "坐标切开了 UTF-16 代理对");

  const slice = text.slice(start, end);
  if (slice !== candidate.before)
    fail(
      "QUOTE_MISMATCH",
      "before 必须逐字等于基础段落区间原文",
      `实际“${slice.slice(0, 80)}” ≠ 声明“${candidate.before.slice(0, 80)}”`,
    );

  if (candidate.before === "" && candidate.after !== "" && start !== end)
    fail("OUT_OF_RANGE", "插入必须使用 start === end");
  if (candidate.before === candidate.after)
    fail("NO_CHANGE", "候选没有产生任何文字变化");
  if (candidate.before === "" && candidate.after === "")
    fail("NO_CHANGE", "before 与 after 同时为空");

  return {
    paragraphId: candidate.paragraphId,
    start,
    end,
    before: candidate.before,
    after: candidate.after,
    category: candidate.category,
    reason: candidate.reason.trim(),
  };
}

/**
 * 一次提交的整批校验：任一项非法则整批失败，返回逐项错误供模型修正，
 * 不允许“悄悄丢掉非法项后标成功”。`resolveContext` 用于把候选映射到
 * 所属段落目标区间（一个目标块可含多个段落）。
 */
export function validateCandidateBatch(
  rawList: readonly unknown[],
  resolveContext: (candidate: {
    paragraphId: string;
  }) => CandidateValidationContext,
): NormalizedCandidate[] {
  const failures: CandidateValidationFailure[] = [];
  const normalized: NormalizedCandidate[] = [];
  rawList.forEach((raw, index) => {
    try {
      const parsed = modelEditCandidateSchema.safeParse(raw);
      if (!parsed.success)
        throw new ProofreadError(
          "SCHEMA_INVALID",
          "候选结构非法",
          parsed.error.issues
            .map(
              (issue) =>
                `${issue.path.join(".") || "<root>"}: ${issue.message}`,
            )
            .join("；"),
        );
      const ctx = resolveContext(parsed.data);
      normalized.push(validateCandidate(parsed.data, ctx));
    } catch (error) {
      const failure =
        error instanceof ProofreadError
          ? { index, code: error.code, message: error.message }
          : {
              index,
              code: "SCHEMA_INVALID",
              message: error instanceof Error ? error.message : "候选校验失败",
            };
      failures.push(failure);
    }
  });
  if (failures.length)
    throw new ProofreadError(
      "INVALID_CANDIDATES",
      "提交包含非法候选，整批未保存",
      failures
        .map((item) => `#${item.index + 1} ${item.code}：${item.message}`)
        .join("；"),
      { failures },
    );
  return normalized;
}

export function validateCandidateList(
  rawList: readonly unknown[],
  ctx: CandidateValidationContext,
): NormalizedCandidate[] {
  return validateCandidateBatch(rawList, () => ctx);
}

export function optionsAllowCategory(
  options: ProofreadOptions,
  category: ProofreadCategory,
): boolean {
  return options.categories.includes(category);
}
