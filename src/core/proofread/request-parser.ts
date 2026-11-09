import {
  ProofreadError,
  type ProofreadCategory,
  type ProofreadOptions,
} from "../../shared/proofreading";

export interface ParsedProofreadRequest {
  options: ProofreadOptions;
  notes: string[];
}

const UNSUPPORTED = /(润色|扩写|续写|重写|改写剧情|改变剧情|翻译|人物分析|剧情分析|知识库)/;
const AUTO_APPLY = /(自动应用|自动采纳|直接改文|自动修改)/;

const CATEGORY_PATTERNS: Array<[ProofreadCategory, RegExp, string]> = [
  ["typo", /(错字|错别字|错词|别字|缺字|多字)/, "错字"],
  ["wording", /(用词|搭配|词语)/, "用词"],
  ["grammar", /(语法|病句|标点|句式)/, "语法"],
  ["advertisement", /(广告|推广|网址|链接|下载|页眉|页脚)/, "广告"],
];

/**
 * 自然语言精校入口：只解析到同一个 ProofreadOptions。
 * 不扩大章节范围、不增加自动应用类别、不授予任何写正文权限。
 */
export function parseProofreadRequest(
  text: string,
  base: ProofreadOptions,
): ParsedProofreadRequest {
  const request = text.trim();
  if (!request) return { options: base, notes: [] };
  if (UNSUPPORTED.test(request))
    throw new ProofreadError(
      "UNSUPPORTED_REQUEST",
      "当前精校只支持错字、用词、语法和广告检查，不提供润色、扩写或剧情分析",
      request.slice(0, 120),
    );
  const categories: ProofreadCategory[] = [];
  const notes: string[] = [];
  for (const [category, pattern, label] of CATEGORY_PATTERNS) {
    if (pattern.test(request) && !categories.includes(category)) {
      categories.push(category);
    }
  }
  if (AUTO_APPLY.test(request))
    notes.push("自动应用必须在精校设置中显式开启；自然语言请求不会增加写正文权限。");
  if (/(整书|全书)/.test(request))
    notes.push("检查范围仍由当前选择决定，自然语言请求不会扩大章节范围。");
  if (categories.length)
    notes.unshift(`已识别检查类别：${categories.join("、")}`);
  return {
    options: {
      ...base,
      categories: categories.length ? categories : base.categories,
      userRequest: request,
    },
    notes,
  };
}
