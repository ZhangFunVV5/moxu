import { _electron as electron } from "playwright";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

/**
 * T051 的真实模型 Electron 链路：自然语言入口 → 真实模型 → 候选落盘 → GUI 审阅。
 * 密钥从 docs/deepseek official api.csv 读取，不写入证据文件。
 */
const csv = (
  await readFile("docs/deepseek official api.csv", "utf8")
)
  .replace(/^\uFEFF/, "")
  .trim()
  .split(/\r?\n/)
  .map((line) =>
    line
      .match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g)
      .filter((value) => value !== "")
      .map((value) =>
        value.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'),
      ),
  );
const config = Object.fromEntries(
  csv.slice(1).map(([key, value]) => [key.trim(), (value ?? "").trim()]),
);
if (!config.apiKey || !config.openAiCompatible || !config.model)
  throw new Error("配置 CSV 缺少必要字段");

const root = await mkdtemp(path.join(path.resolve(".tmp-p3-electron"), "real-"));
const fixture = path.join(root, "真实精校样本.txt");
const booksRoot = path.join(root, "books");
const original = [
  "第一章 雨夜",
  "沈舟指着稿纸上的错宁，皱了皱眉。",
  "最新地址：https://promo.example.com/txt 请收藏本站",
].join("\r\n");
await writeFile(fixture, original);
const env = {
  ...process.env,
  BOOK_WORKBENCH_ROOT: booksRoot,
  BOOK_WORKBENCH_TEST_SOURCE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;

let app = null;
const startedAt = Date.now();
try {
  app = await electron.launch({
    args: [".", "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".bb-shell");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  const saved = await page.evaluate(
    (value) => window.desktop.saveConfig(value),
    {
      baseUrl: config.openAiCompatible,
      model: config.model,
      apiKey: config.apiKey,
      temperature: 0.2,
      stream: true,
    },
  );
  assert.equal(saved.ok, true, "真实模型配置保存失败");

  // 自然语言入口：与按钮共用 ProofreadOptions。
  await page.getByText("Agent 精校任务", { exact: true }).click();
  await page
    .getByLabel("自然语言精校要求")
    .fill("检查本章错字和广告，保留人名和口癖");
  await page.getByRole("button", { name: "发送精校请求" }).click();
  await page.getByTestId("proofread-progress").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () =>
      /精校结束|检查完成/.test(
        document.querySelector('[data-testid="proofread-status"]')?.textContent ?? "",
      ),
    null,
    { timeout: 240_000 },
  );
  await page.getByRole("tab", { name: /^全部/ }).click();

  const state = await page.evaluate(async () => {
    const workspace = await window.desktop.workspace.state();
    const chapterId = workspace.data.chapters[0].chapterId;
    return window.desktop.proofread.chapter({ chapterId });
  });
  assert.equal(state.ok, true, state.ok ? "" : state.error.message);
  const view = state.data;
  const modelIssues = view.issues.filter((issue) => issue.sources.includes("model"));
  assert.ok(modelIssues.length > 0, "真实模型未产生可审阅意见");
  const typo =
    modelIssues.find((issue) => issue.before.includes("错宁")) ??
    modelIssues.find((issue) => issue.category === "typo") ??
    modelIssues[0];
  const beforeBody = view.body;

  const card = page.locator(`[data-testid="proofread-issue-${typo.patchId}"]`);
  await card.getByRole("button", { name: "采纳" }).click();
  await page.getByTestId("message").filter({ hasText: "已采纳" }).waitFor({
    timeout: 30_000,
  });
  const after = await page.evaluate(async () => {
    const workspace = await window.desktop.workspace.state();
    const chapterId = workspace.data.chapters[0].chapterId;
    return window.desktop.proofread.chapter({ chapterId });
  });
  assert.ok(after.ok);
  assert.notEqual(after.data.body, beforeBody, "采纳后正文未变化");
  if (typo.after) assert.ok(after.data.body.includes(typo.after));
  else assert.ok(!after.data.body.includes(typo.before));

  const pageText = await page.locator("body").innerText();
  assert.equal(pageText.includes(config.apiKey), false, "页面泄露 API Key");
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.screenshot({ path: "artifacts/electron-p3-real-model.png", fullPage: true });
  const evidence = {
    model: config.model,
    profileVersion: view.options.profileVersion,
    promptVersion: "proofread-prompt-v3",
    naturalLanguageEntry: true,
    taskState: view.state,
    issueCount: view.counts.total,
    modelIssueCount: modelIssues.length,
    adoptedPatch: typo.patchId,
    adoptedBefore: typo.before,
    adoptedAfter: typo.after,
    bodyChanged: after.data.body !== beforeBody,
    keyLeak: false,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
  await writeFile(
    "artifacts/electron-p3-real-model.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    `Electron P3 real model: ${config.model} natural-language -> ${view.counts.total} issues (${modelIssues.length} model) -> adopted ${typo.before}→${typo.after}`,
  );
} finally {
  if (app) await app.close().catch(() => undefined);
}
