import { defaultProofreadOptions } from "../../shared/proofreading";
import {
  DEFAULT_TITLE_OPTIONS,
  DEFAULT_SUMMARY_OPTIONS,
} from "../../shared/generate";
import { defaultFormatOptions } from "../../shared/format-options";
import type {
  TaskProposal,
  PipelineStartRequest,
} from "../../shared/pipeline-contracts";
import { parseProofreadRequest } from "../../core/proofread/request-parser";
export function proposeTask(
  prompt: string,
  chapterIds: string[],
): TaskProposal {
  const clarify = (message: string): TaskProposal => ({
    kind: "clarification",
    message,
  });
  if (
    /人物系统|剧情讨论|知识库|EPUB|云端同步|删除作品|上传|任意路径|润色|扩写|续写|翻译/i.test(
      prompt,
    )
  )
    return clarify("此要求包含尚未支持的功能，请指定精校、标题、摘要或排版。");
  const enabled = (words: string) => {
    const positive = new RegExp(words);
    return prompt
      .split(/[，,。；;]|然后|再/)
      .some(
        (part) =>
          positive.test(part) &&
          !new RegExp(
            `(?:不要|无需|不需要|不|跳过)(?:生成|进行|做)?(?:${words})`,
          ).test(part),
      );
  };
  const request: PipelineStartRequest = { chapterIds: [...chapterIds] };
  if (enabled("精校|校对|错字|错别字|病句|广告"))
    request.proofread = {
      ...parseProofreadRequest(prompt, defaultProofreadOptions).options,
      autoApplyCategories: [],
    };
  if (enabled("标题|章名")) request.title = { ...DEFAULT_TITLE_OPTIONS };
  if (enabled("摘要|梗概")) request.summary = { ...DEFAULT_SUMMARY_OPTIONS };
  if (enabled("排版|导出"))
    request.format = {
      options: { ...defaultFormatOptions },
      outputFormat: /markdown|\.md/i.test(prompt) ? "markdown" : "txt",
    };
  if (enabled("导出")) request.export = true;
  const size = prompt.match(
    /(?:摘要|梗概)\s*(?:约|为|控制在)?\s*(\d+)\s*(?:字|字符)/,
  );
  if (size && request.summary) {
    const n = Number(size[1]);
    if (n < 1 || n > 2000) return clarify("摘要长度需在1至2000字符之间。");
    request.summary = { minLength: n, maxLength: n };
  }
  const titleSize = prompt.match(/(?:标题|章名)\s*(\d+)\s*字/);
  if (titleSize && request.title) {
    const n = Number(titleSize[1]);
    if (n < 1 || n > 100) return clarify("标题长度需在1至100字符之间。");
    request.title = { ...request.title, minLength: n, maxLength: n };
  }
  if (request.title && /允许剧透/.test(prompt))
    request.title.allowSpoilers = true;
  if (request.format) {
    const o = request.format.options;
    if (/不(?:要)?缩进|无缩进/.test(prompt)) o.indent = "none";
    if (/两(?:个)?全角/.test(prompt)) o.indent = "fullwidth";
    const lines = prompt.match(
      /段间(?:留|保留)?\s*([零一二两三0123])\s*(?:个)?空行/,
    );
    if (lines)
      o.paragraphBlankLines = Number.isNaN(Number(lines[1]))
        ? ({ 零: 0, 一: 1, 二: 2, 两: 2, 三: 3 } as Record<string, number>)[
            lines[1]
          ]
        : Number(lines[1]);
    if (/CRLF/i.test(prompt)) o.eol = "crlf";
    if (/BOM/i.test(prompt)) o.encoding = "utf8-bom";
  }
  if (/自定义|风格|模板|每行|段落模式|换行|标点转换/.test(prompt))
    return clarify("请在对应规则面板设置这项具体约束，再运行任务。");
  if (
    !request.proofread &&
    !request.title &&
    !request.summary &&
    !request.format
  )
    return clarify("请说明要精校、生成标题、生成摘要还是排版导出。");
  return {
    kind: "ready",
    request,
    notes: [
      "沿用当前选定章节，不自动扩大范围；精校意见由你审阅，标题候选不会自动替换。",
    ],
  };
}
