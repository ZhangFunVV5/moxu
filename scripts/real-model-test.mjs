import { _electron as electron } from "playwright";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const text = await readFile("docs/deepseek official api.csv", "utf8");
const rows = text
  .replace(/^\uFEFF/, "")
  .trim()
  .split(/\r?\n/)
  .map((line) =>
    line
      .match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g)
      .filter((v) => v !== "")
      .map((v) =>
        v.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'),
      ),
  );
const values = Object.fromEntries(
  rows.slice(1).map(([k, v]) => [k.trim(), v.trim()]),
);
if (!values.apiKey || !values.openAiCompatible || !values.model)
  throw new Error("配置 CSV 缺少必要字段");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const userData = await mkdtemp(path.join(tmpdir(), "book-real-model-"));
let app;
let outcome;
try {
  app = await electron.launch({
    args: [".", `--user-data-dir=${userData}`],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".bb-paper");
  const saved = await page.evaluate(
    (config) => window.desktop.saveConfig(config),
    {
      baseUrl: values.openAiCompatible,
      model: values.model,
      apiKey: values.apiKey,
      temperature: 0.2,
      stream: true,
    },
  );
  assert.equal(saved.ok, true, "模型配置保存失败");
  assert.equal("apiKey" in saved.data, false);
  await page.getByRole("button", { name: "运行只读样例" }).click();
  await page.waitForFunction(
    () =>
      ["completed", "failed", "cancelled"].includes(
        document.querySelector("[data-testid=status]")?.textContent,
      ),
    null,
    { timeout: 90000 },
  );
  const state = await page.getByTestId("status").innerText();
  const activity = await page.locator(".bb-log").innerText();
  assert.equal(activity.includes(values.apiKey), false);
  outcome = {
    model: values.model,
    source: "docs/deepseek official api.csv",
    state,
    toolExecuted: activity.includes("只读工具执行成功"),
    feedbackReceived: activity.includes("只读模型→工具→反馈完成"),
    activity,
  };
  await page.screenshot({
    path: "artifacts/electron-real-model.png",
    fullPage: true,
  });
  await writeFile(
    "artifacts/real-model-test.json",
    JSON.stringify(outcome, null, 2),
  );
  console.log(
    JSON.stringify({
      model: values.model,
      state,
      toolExecuted: outcome.toolExecuted,
      feedbackReceived: outcome.feedbackReceived,
    }),
  );
  if (state !== "completed" || !outcome.toolExecuted) process.exitCode = 1;
} finally {
  if (app) await app.close();
}
