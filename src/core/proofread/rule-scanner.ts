import type { ModelEditCandidate } from "../../shared/proofreading";

export interface RuleHit {
  ruleId: string;
  candidate: ModelEditCandidate;
}

export interface RuleScanInput {
  paragraphId: string;
  /** 完整段落文本，坐标以它为基准。 */
  paragraphText: string;
  /** 当前目标区间（段落内），只在该区间产生候选。 */
  targetStart: number;
  targetEnd: number;
  glossary: readonly string[];
  /** 章节内重复出现的段落文本（trim 后）；仅作为广告线索，单独重复不构成候选。 */
  repeatedTexts?: ReadonlySet<string>;
}

const PROMO_CUE =
  /(下载|首发|最新|免费|全文|阅读|收藏|网址|链接|搜索|关注|公众号|加群|更新|本章未完|请点击|下一页|加入书架|推荐票|月票|无弹窗|TXT|txt|手机版|电脑版)/;
const HEADER_OR_FOOTER =
  /(本章未完|请点击下一页|加入书架|投推荐票|求月票|求收藏|手机阅读|手机版|电脑版|无弹窗|更新最快|首发地址|内容来源|转载|笔趣阁|小说网|请记住本站|返回目录|章节目录|更多精彩)/;
const DOWNLOAD_GUIDE =
  /(请|求|记得|务必|欢迎).{0,10}(收藏|推荐|订阅|下载|关注|加群|扫码)/;
const REPEAT_PROMO = /(下载|首发|最新|免费|全文|阅读|网址|链接|关注|公众号|加群|更新|推荐票|月票|无弹窗|TXT|txt)/;
const URL_PATTERN =
  /(?:https?:\/\/|www\.)[^\s，。！？、；：""''（）()〈〉《》【】<>]+/gi;

const MAX_WHOLE_LINE = 120;

function hasGlossary(text: string, glossary: readonly string[]): boolean {
  return glossary.some((term) => term.length > 0 && text.includes(term));
}

function wholeParagraphHit(
  input: RuleScanInput,
  ruleId: string,
  reason: string,
): RuleHit | null {
  // 整段删除只对“整个段落都是目标”的短行生效，避免把长段落里的一句话整段删掉。
  if (input.targetStart !== 0 || input.targetEnd !== input.paragraphText.length)
    return null;
  if (input.paragraphText.trim().length > MAX_WHOLE_LINE) return null;
  if (hasGlossary(input.paragraphText, input.glossary)) return null;
  if (!input.paragraphText.trim()) return null;
  return {
    ruleId,
    candidate: {
      paragraphId: input.paragraphId,
      before: input.paragraphText,
      after: "",
      start: 0,
      end: input.paragraphText.length,
      category: "advertisement",
      reason,
    },
  };
}

function spanHit(
  input: RuleScanInput,
  ruleId: string,
  start: number,
  end: number,
  reason: string,
): RuleHit | null {
  if (start < input.targetStart || end > input.targetEnd) return null;
  const before = input.paragraphText.slice(start, end);
  if (!before.trim()) return null;
  if (hasGlossary(before, input.glossary)) return null;
  return {
    ruleId,
    candidate: {
      paragraphId: input.paragraphId,
      before,
      after: "",
      start,
      end,
      category: "advertisement",
      reason,
    },
  };
}

function overlaps(
  hit: RuleHit,
  accepted: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  const start = hit.candidate.start ?? 0;
  const end = hit.candidate.end ?? start + hit.candidate.before.length;
  return accepted.some((range) => start < range.end && range.start < end);
}

/**
 * PF-05 首批确定性广告规则：推广网址、下载引导、站点页眉／页脚、重复推广行。
 * 只产生候选，不删除正文；重复诗句、故事内网址和人物对白不会仅因字符命中被删。
 */
export function scanTargetRules(input: RuleScanInput): RuleHit[] {
  const targetText = input.paragraphText.slice(input.targetStart, input.targetEnd);
  if (!targetText.trim()) return [];
  // 引用／对白里的推广措辞可能是剧情；留给模型和人工判断，不生成可自动应用的规则删除。
  if (/[“”「」『』"‘’']/.test(input.paragraphText)) return [];
  const hits: RuleHit[] = [];

  const header = HEADER_OR_FOOTER.exec(targetText);
  if (header && PROMO_CUE.test(input.paragraphText)) {
    const whole = wholeParagraphHit(
      input,
      "site-header-footer",
      `站点页眉／页脚：命中“${header[0]}”`,
    );
    if (whole) hits.push(whole);
  }

  if (
    input.repeatedTexts?.has(input.paragraphText.trim()) &&
    REPEAT_PROMO.test(input.paragraphText)
  ) {
    const whole = wholeParagraphHit(
      input,
      "repeated-promo-line",
      "重复推广行：同一段落在授权范围内重复出现且包含推广特征",
    );
    if (whole) hits.push(whole);
  }

  if (DOWNLOAD_GUIDE.test(input.paragraphText)) {
    const whole = wholeParagraphHit(
      input,
      "download-guide",
      "下载引导：要求收藏／下载／关注",
    );
    if (whole) hits.push(whole);
  }

  const acceptedRanges: Array<{ start: number; end: number }> = hits.map((hit) => ({
    start: hit.candidate.start ?? 0,
    end:
      hit.candidate.end ??
      (hit.candidate.start ?? 0) + hit.candidate.before.length,
  }));
  if (hits.length) return hits;

  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(targetText)) !== null) {
    const url = match[0];
    // 故事内网址：没有推广语境时不产生候选，交由人工／模型判断。
    if (!PROMO_CUE.test(input.paragraphText)) continue;
    const start = input.targetStart + match.index;
    const end = start + url.length;
    // URL 前后紧邻引号或对话标记时更像故事内容，规则保持保守。
    const around = input.paragraphText.slice(Math.max(0, start - 2), Math.min(input.paragraphText.length, end + 2));
    if (/[“”"「」『』]/.test(around) && !/(下载|首发|最新|免费|全文|网址|链接)/.test(around))
      continue;
    const reason = `推广网址：${url.slice(0, 80)}`;
    const whole = wholeParagraphHit(input, "promo-url", reason);
    const hit = whole ?? spanHit(input, "promo-url", start, end, reason);
    if (!hit) continue;
    if (overlaps(hit, acceptedRanges)) continue;
    hits.push(hit);
    acceptedRanges.push({ start, end });
  }
  return hits;
}

/** 统计授权范围内重复出现的段落文本；仅作为规则线索，单独重复不产生候选。 */
export function repeatedParagraphTexts(
  paragraphs: ReadonlyArray<{ text: string }>,
): Set<string> {
  const counts = new Map<string, number>();
  for (const paragraph of paragraphs) {
    const text = paragraph.text.trim();
    if (!text || text.length < 4) continue;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([text]) => text),
  );
}
