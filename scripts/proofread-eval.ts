import { promises as fsp } from "node:fs";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createWorkspace } from "../src/core/workspace/book-store";
import { buildTaskSpec } from "../src/agent/tasks/task-types";
import { TaskStore } from "../src/agent/tasks/task-store";
import { runProofreadTask } from "../src/core/proofread/proofread-engine";
import { findLatestBatch } from "../src/core/proofread/batch-store";
import { OpenAICompatible } from "../src/agent/model/openai-compatible";
import { PROOFREAD_PROMPT_VERSION } from "../src/agent/prompts/proofread";
import { PROOFREAD_PROFILE } from "../src/agent/tools/proofread-tools";
import type { Adapter, Response } from "../src/agent/model/model-adapter";
import {
  CATEGORY_LABELS,
  PROOFREAD_CATEGORIES,
  defaultProofreadOptions,
  type ChapterProofreadBatch,
  type ProofreadCategory,
  type ProofreadOptions,
  type StoredEditCandidate,
} from "../src/shared/proofreading";

interface Expected {
  paragraphId: string;
  /** 期望被修改的原句片段；用于定位与匹配。 */
  before: string;
  /** 明确给出 after 时做逐字比较；语法类允许合理改写。 */
  after?: string;
  category: ProofreadCategory;
  /** 广告删除的正例。 */
  advertisement?: boolean;
}

interface EvalSample {
  id: string;
  label: string;
  body: string;
  expected: Expected[];
  /** 人名、方言、口癖、故事内网址、重复诗句等不得被改写的片段。 */
  protect: Array<{ paragraphId: string; text: string }>;
  options?: Partial<ProofreadOptions>;
}

const SAMPLES: EvalSample[] = [
  {
    id: "S01",
    label: "错字：错宁→错字",
    body: "沈舟指着稿纸上的错宁，皱了皱眉。\n他把信放在桌上，没有坐下。",
    expected: [{ paragraphId: "p1", before: "错宁", after: "错字", category: "typo" }],
    protect: [{ paragraphId: "p1", text: "沈舟" }],
  },
  {
    id: "S02",
    label: "专名保护：人名与称呼",
    body: "沈舟对阿箬说：“别走，等我回来。”\n阿箬没有回答，只把门轻轻带上。",
    expected: [],
    protect: [
      { paragraphId: "p1", text: "沈舟" },
      { paragraphId: "p1", text: "阿箬" },
      { paragraphId: "p2", text: "阿箬" },
    ],
  },
  {
    id: "S03",
    label: "方言与口癖保护",
    body: "俺娘说，甭管咋着，先吃饭再说。\n他嘿嘿一笑，没吭声。",
    expected: [],
    protect: [
      { paragraphId: "p1", text: "俺娘" },
      { paragraphId: "p1", text: "甭管咋着" },
      { paragraphId: "p2", text: "嘿嘿" },
    ],
  },
  {
    id: "S04",
    label: "病句：由于……使得……",
    body: "由于下雨的原因，使得他没有出门。\n他在窗边站了一下午。",
    expected: [
      { paragraphId: "p1", before: "由于下雨的原因，使得", category: "grammar" },
    ],
    protect: [],
  },
  {
    id: "S05",
    label: "广告：推广网址与下载引导",
    body: "最新地址：https://promo.example.com/txt 请收藏本站",
    expected: [
      {
        paragraphId: "p1",
        before: "最新地址：https://promo.example.com/txt 请收藏本站",
        after: "",
        category: "advertisement",
        advertisement: true,
      },
    ],
    protect: [],
  },
  {
    id: "S06",
    label: "故事内网址保护",
    body: "他打开 www.example.com 查资料，记下几行笔记。\n窗外雨声渐密。",
    expected: [],
    protect: [{ paragraphId: "p1", text: "www.example.com" }],
  },
  {
    id: "S07",
    label: "重复诗句保护",
    body: "床前明月光，疑是地上霜。\n床前明月光，疑是地上霜。",
    expected: [],
    protect: [
      { paragraphId: "p1", text: "床前明月光" },
      { paragraphId: "p2", text: "床前明月光" },
    ],
  },
  {
    id: "S08",
    label: "广告式对白不整段删除",
    body: "“加我微信，免费领全文。”他说。\n沈舟没有理他，继续往前走。",
    expected: [],
    protect: [
      { paragraphId: "p1", text: "加我微信，免费领全文" },
      { paragraphId: "p1", text: "他说" },
    ],
  },
  {
    id: "S09",
    label: "长章分块：后段错字",
    body: `${"这是一段用于测试分块的长文本，包含若干完整句子。".repeat(12)}他在末尾写下了错宁。\n${"第二段继续叙述，没有明显错误。".repeat(8)}`,
    expected: [{ paragraphId: "p1", before: "错宁", after: "错字", category: "typo" }],
    protect: [],
    options: { blockBudget: { maxChars: 220, maxParagraphs: 2, contextParagraphs: 1 } },
  },
  {
    id: "S10",
    label: "重复引句：不按首次命中误改",
    body: "他说：“走吧。”\n她也说：“走吧。”\n两个人一起出了门。",
    expected: [],
    protect: [
      { paragraphId: "p1", text: "走吧" },
      { paragraphId: "p2", text: "走吧" },
    ],
  },
];

const CSV_PATH = "docs/deepseek official api.csv";

function parseCsv(text: string): Record<string, string> {
  const rows = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g)!
        .filter((value) => value !== "")
        .map((value) =>
          value.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'),
        ),
    );
  return Object.fromEntries(rows.slice(1).map(([key, value]) => [key.trim(), (value ?? "").trim()]));
}

function rangeOf(text: string, quote: string): { start: number; end: number } | null {
  if (!quote) return null;
  const index = text.indexOf(quote);
  if (index < 0) return null;
  return { start: index, end: index + quote.length };
}

function overlaps(
  candidate: StoredEditCandidate,
  range: { start: number; end: number } | null,
): boolean {
  if (!range) return false;
  if (candidate.start === candidate.end)
    return candidate.start >= range.start && candidate.start <= range.end;
  return candidate.start < range.end && range.start < candidate.end;
}

interface CandidateAudit {
  patchId: string;
  paragraphId: string;
  start: number;
  end: number;
  before: string;
  after: string;
  category: ProofreadCategory;
  reason: string;
  matched: boolean;
  protectedHit: boolean;
  adFalseDeletion: boolean;
  /** 与同一语法问题重叠的额外片段：语法合理分歧，单列而不强算 FP。 */
  grammarDispute: boolean;
}

interface SampleResult {
  id: string;
  label: string;
  status: string;
  error?: string;
  expected: number;
  candidates: number;
  tp: number;
  fp: number;
  fn: number;
  seriousMisEdits: string[];
  adFalseDeletions: number;
  grammarDisputes: string[];
  candidatesAudit: CandidateAudit[];
  durationMs: number;
  usage: unknown[];
}

function evaluateSample(
  sample: EvalSample,
  batch: ChapterProofreadBatch,
  status: string,
  error: string | undefined,
  durationMs: number,
  usage: unknown[],
): SampleResult {
  const paragraphs = new Map(
    batch.baseBlocks.map((block) => [
      block.id,
      batch.baseBody.slice(block.start, block.end),
    ]),
  );
  const used = new Set<string>();
  let tp = 0;
  let fn = 0;
  for (const expected of sample.expected) {
    const text = paragraphs.get(expected.paragraphId) ?? "";
    const expectedRange = rangeOf(text, expected.before);
    const matched = batch.candidates.find((candidate) => {
      if (used.has(candidate.patchId)) return false;
      if (candidate.category !== expected.category) return false;
      if (candidate.paragraphId !== expected.paragraphId) return false;
      if (!overlaps(candidate, expectedRange)) return false;
      if (expected.after !== undefined) {
        if (candidate.after === expected.after) return true;
        // 模型只改错字本身（如“宁”→“字”）也是同一处最小修复。
        return (
          expected.before.includes(candidate.before) &&
          expected.after.includes(candidate.after)
        );
      }
      return true;
    });
    if (matched) {
      used.add(matched.patchId);
      tp += 1;
    } else {
      fn += 1;
    }
  }
  const seriousMisEdits: string[] = [];
  const grammarDisputes: string[] = [];
  let adFalseDeletions = 0;
  let fp = 0;
  const audit: CandidateAudit[] = [];
  for (const candidate of batch.candidates) {
    const text = paragraphs.get(candidate.paragraphId) ?? "";
    const protectedRanges = sample.protect
      .filter((item) => item.paragraphId === candidate.paragraphId)
      .map((item) => rangeOf(text, item.text));
    const protectedHit = protectedRanges.some((range) => overlaps(candidate, range));
    const matched = used.has(candidate.patchId);
    const grammarDispute =
      !matched &&
      (candidate.category === "grammar" || candidate.category === "wording") &&
      sample.expected.some((expected) => {
        if (expected.category !== "grammar") return false;
        if (expected.paragraphId !== candidate.paragraphId) return false;
        const expectedRange = rangeOf(
          paragraphs.get(expected.paragraphId) ?? "",
          expected.before,
        );
        return overlaps(candidate, expectedRange);
      });
    if (!matched && !grammarDispute) fp += 1;
    if (grammarDispute)
      grammarDisputes.push(
        `${candidate.paragraphId} [${candidate.start},${candidate.end}) ${candidate.before} → ${candidate.after || "（删除）"}；${candidate.reason}`,
      );
    const adFalseDeletion =
      candidate.category === "advertisement" &&
      candidate.after === "" &&
      !sample.expected.some(
        (expected) => expected.advertisement && expected.paragraphId === candidate.paragraphId,
      );
    if (adFalseDeletion) adFalseDeletions += 1;
    if (protectedHit && !matched) {
      seriousMisEdits.push(
        `${candidate.paragraphId} [${candidate.start},${candidate.end}) ${candidate.before} → ${candidate.after || "（删除）"}`,
      );
    }
    audit.push({
      patchId: candidate.patchId,
      paragraphId: candidate.paragraphId,
      start: candidate.start,
      end: candidate.end,
      before: candidate.before,
      after: candidate.after,
      category: candidate.category,
      reason: candidate.reason,
      matched,
      protectedHit,
      adFalseDeletion,
      grammarDispute,
    });
  }
  return {
    id: sample.id,
    label: sample.label,
    status,
    error,
    expected: sample.expected.length,
    candidates: batch.candidates.length,
    tp,
    fp,
    fn,
    seriousMisEdits,
    adFalseDeletions,
    grammarDisputes,
    candidatesAudit: audit,
    durationMs,
    usage,
  };
}

async function main(): Promise<void> {
  const csv = parseCsv(await fsp.readFile(CSV_PATH, "utf8"));
  if (!csv.apiKey || !csv.openAiCompatible || !csv.model)
    throw new Error("配置 CSV 缺少 apiKey / openAiCompatible / model");
  const baseOptions: ProofreadOptions = {
    ...defaultProofreadOptions,
    modelConfigId: csv.model,
  };
  const runRoot = await mkdtemp(path.join(tmpdir(), "proofread-eval-"));
  await fsp.mkdir(runRoot, { recursive: true });
  const results: SampleResult[] = [];
  const startedAt = new Date();
  try {
    for (const sample of SAMPLES) {
      const options: ProofreadOptions = {
        ...baseOptions,
        ...sample.options,
        blockBudget: {
          ...baseOptions.blockBudget,
          ...(sample.options?.blockBudget ?? {}),
        },
      };
      const workspaceRoot = path.join(runRoot, sample.id);
      const workspace = await createWorkspace({
        root: workspaceRoot,
        bookTitle: `评估 ${sample.id}`,
        format: "txt",
        source: {
          fileName: `${sample.id}.txt`,
          bytes: new TextEncoder().encode(sample.body),
          encoding: "utf-8",
          eol: "lf",
        },
        importSettings: {
          splitMode: "auto",
          paragraphMode: "line",
          headingLevel: 0,
          boundaries: [0],
        },
        chapters: [{ title: `样本 ${sample.id}`, body: sample.body, kind: "chapter" }],
      });
      const chapter = workspace.chapterFiles[0];
      const spec = buildTaskSpec({
        workspaceId: workspace.book.workspaceId,
        type: "proofread",
        chapterIds: [chapter.chapterId],
        inputHashes: { [chapter.chapterId]: chapter.bodyHash },
        options: {},
        profileVersion: options.profileVersion,
      });
      const store = await TaskStore.create(workspaceRoot, spec);
      const usage: unknown[] = [];
      let durationMs = 0;
      const base = new OpenAICompatible({
        baseUrl: csv.openAiCompatible,
        model: csv.model,
        apiKey: csv.apiKey,
        temperature: 0.2,
        stream: true,
      });
      const adapter: Adapter = {
        async complete(messages, tools, signal, onText, maxOutputTokens): Promise<Response> {
          const start = Date.now();
          try {
            const response = await base.complete(
              messages,
              tools,
              signal,
              onText,
              maxOutputTokens,
            );
            if (response.usage !== undefined) usage.push(response.usage);
            return response;
          } finally {
            durationMs += Date.now() - start;
          }
        },
      };
      let status = "completed";
      let error: string | undefined;
      try {
        const run = await runProofreadTask({
          workspace,
          taskStore: store,
          spec,
          options,
          adapter,
          signal: new AbortController().signal,
          emit: (event) => {
            if (event.type === "toolFinished" && event.message !== "只读工具执行成功") {
              // 工具错误会在下一轮反馈给模型；这里只记录最终任务结果。
            }
          },
        });
        status = run.status;
        if (run.status === "failed")
          error = run.chapters.map((chapter) => chapter.errorCode).filter(Boolean).join(",");
      } catch (caught) {
        status = "error";
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const latest = await findLatestBatch(workspaceRoot, {
        chapterId: chapter.chapterId,
      });
      if (!latest) {
        results.push({
          id: sample.id,
          label: sample.label,
          status,
          error: error ?? "模型未留下批次",
          expected: sample.expected.length,
          candidates: 0,
          tp: 0,
          fp: 0,
          fn: sample.expected.length,
          seriousMisEdits: [],
          adFalseDeletions: 0,
          grammarDisputes: [],
          candidatesAudit: [],
          durationMs,
          usage,
        });
        continue;
      }
      results.push(
        evaluateSample(sample, latest, status, error, durationMs, usage),
      );
      console.log(
        `${sample.id} ${status} candidates=${latest.candidates.length} tp/fp/fn=${results.at(-1)!.tp}/${results.at(-1)!.fp}/${results.at(-1)!.fn}`,
      );
    }
    const categories = PROOFREAD_CATEGORIES.map((category) => {
      const tp = results.reduce(
        (sum, result) =>
          sum +
          result.candidatesAudit.filter(
            (candidate) => candidate.matched && candidate.category === category,
          ).length,
        0,
      );
      const fp = results.reduce(
        (sum, result) =>
          sum +
          result.candidatesAudit.filter(
            (candidate) => !candidate.matched && !candidate.grammarDispute && candidate.category === category,
          ).length,
        0,
      );
      const fn = results.reduce(
        (sum, result) =>
          sum +
          SAMPLES.find((sample) => sample.id === result.id)!.expected.filter(
            (expected) => expected.category === category,
          ).length -
          result.candidatesAudit.filter(
            (candidate) => candidate.matched && candidate.category === category,
          ).length,
        0,
      );
      return {
        category,
        label: CATEGORY_LABELS[category],
        tp,
        fp,
        fn,
        precision: tp + fp === 0 ? null : tp / (tp + fp),
        recall: tp + fn === 0 ? null : tp / (tp + fn),
      };
    });
    const report = {
      generatedAt: new Date().toISOString(),
      startedAt: startedAt.toISOString(),
      model: csv.model,
      baseUrl: csv.openAiCompatible,
      profileVersion: baseOptions.profileVersion,
      promptVersion: PROOFREAD_PROMPT_VERSION,
      maxOutputTokens: PROOFREAD_PROFILE.maxOutputTokens,
      ruleVersion: baseOptions.ruleVersion,
      options: baseOptions,
      sampleCount: SAMPLES.length,
      totals: {
        expected: results.reduce((sum, result) => sum + result.expected, 0),
        candidates: results.reduce((sum, result) => sum + result.candidates, 0),
        tp: results.reduce((sum, result) => sum + result.tp, 0),
        fp: results.reduce((sum, result) => sum + result.fp, 0),
        fn: results.reduce((sum, result) => sum + result.fn, 0),
        adFalseDeletions: results.reduce((sum, result) => sum + result.adFalseDeletions, 0),
        seriousMisEdits: results.reduce((sum, result) => sum + result.seriousMisEdits.length, 0),
        grammarDisputes: results.reduce((sum, result) => sum + result.grammarDisputes.length, 0),
        durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
      },
      categories,
      inputs: SAMPLES.map((sample) => ({
        id: sample.id,
        label: sample.label,
        body: sample.body,
        expected: sample.expected,
        protect: sample.protect,
        options: sample.options ?? null,
      })),
      results,
    };
    await fsp.mkdir("artifacts", { recursive: true });
    await fsp.writeFile(
      "artifacts/proofread-eval.json",
      JSON.stringify(report, null, 2),
    );
    const lines = [
      "# P3 真实模型精校效果评估",
      "",
      `- 日期：${report.generatedAt}`,
      `- 模型：${report.model}（${report.baseUrl}）`,
      `- Profile：${report.profileVersion}；提示词：${report.promptVersion}；规则：${report.ruleVersion}`,
      `- 参数：temperature=0.2，stream=true，maxOutputTokens=${report.maxOutputTokens}，blockBudget=${JSON.stringify(report.options.blockBudget)}`,
      `- 样例：${report.sampleCount}；实际请求耗时：${report.totals.durationMs} ms`,
      "",
      "## 分类指标",
      "",
      "| 类别 | TP | FP | FN | 精确率 | 召回率 |",
      "| --- | --- | --- | --- | --- | --- |",
      ...categories.map(
        (item) =>
          `| ${item.label} | ${item.tp} | ${item.fp} | ${item.fn} | ${item.precision === null ? "不适用" : item.precision.toFixed(2)} | ${item.recall === null ? "不适用" : item.recall.toFixed(2)} |`,
      ),
      "",
      `- 广告误删：${report.totals.adFalseDeletions}`,
      `- 严重误改（专名／方言／故事内网址等）：${report.totals.seriousMisEdits}`,
      `- 语法合理分歧（单列，不计入 FP）：${report.totals.grammarDisputes}`,
      "",
      "## 语法合理分歧",
      "",
      ...(results.flatMap((result) => result.grammarDisputes).length
        ? results.flatMap((result) => result.grammarDisputes.map((item) => `- ${item}`))
        : ["（无）"]),
      "",
      "## 样例",
      "",
      "| 样例 | 状态 | 候选 | TP | FP | FN | 严重误改 |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...results.map(
        (result) =>
          `| ${result.id} ${result.label} | ${result.status}${result.error ? ` (${result.error})` : ""} | ${result.candidates} | ${result.tp} | ${result.fp} | ${result.fn} | ${result.seriousMisEdits.length} |`,
      ),
      "",
      "## 样例输入与标注",
      "",
      ...SAMPLES.flatMap((sample) => [
        `### ${sample.id} ${sample.label}`,
        "",
        "```text",
        sample.body,
        "```",
        "",
        sample.expected.length
          ? `标注：${sample.expected.map((expected) => `${expected.paragraphId} ${expected.category} “${expected.before}”${expected.after !== undefined ? `→“${expected.after}”` : ""}`).join("；")}`
          : "标注：应为零意见（含保护片段）。",
        sample.protect.length
          ? `保护片段：${sample.protect.map((item) => `${item.paragraphId} “${item.text}”`).join("；")}`
          : "",
        "",
      ]),
      "## 候选明细",
      "",
      ...results.flatMap((result) => [
        `### ${result.id} ${result.label}`,
        "",
        ...result.candidatesAudit.map(
          (candidate) =>
            `- [${candidate.matched ? "匹配" : "未匹配"}${candidate.adFalseDeletion ? " · 广告误删" : ""}${candidate.protectedHit ? " · 命中保护片段" : ""}] [${CATEGORY_LABELS[candidate.category]}] ${candidate.paragraphId} [${candidate.start},${candidate.end}) ${candidate.before} → ${candidate.after || "（删除）"}；${candidate.reason}`,
        ),
        "",
      ]),
      "> 本报告只记录真实模型输出与人工标注的对照，不把固定响应或格式有效当作语义正确。",
      "",
    ];
    await fsp.writeFile("artifacts/proofread-eval.md", lines.join("\n"));
    console.log(
      JSON.stringify({
        samples: report.sampleCount,
        totals: report.totals,
        categories,
        output: "artifacts/proofread-eval.json",
      }),
    );
  } finally {
    await fsp.rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
