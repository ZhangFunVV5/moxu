import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const base = path.join(process.cwd(), ".tmp-p4-electron");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const fixture = path.join(root, "标题摘要原书.txt");
await writeFile(
  fixture,
  "第一章 雨夜\n沈舟回家，发现桌上放着一封旧信。门开着，屋里没有人。\n\n第二章 旧信\n沈舟拆开信封，认出了母亲的字迹。信里提到故乡和一把遗失的钥匙。",
);
const env = {
  ...process.env,
  BOOK_WORKBENCH_ROOT: path.join(root, "books"),
  BOOK_WORKBENCH_TEST_SOURCE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
let mode = "ok",
  generation = 0,
  requests = 0;
const summary =
  "沈舟回家后发现桌上放着一封旧信，门开着，屋里却没有人。他拆开泛黄的信封，认出了熟悉的字迹，并从信中的文字里读到关于故乡和遗失钥匙的消息。眼前的信件让他重新留意起家中的异常，也使这次归家变得不同寻常。他仍需要确认留下信件的人，以及信中线索与眼前情形的联系。";
function sse(response, delta, finish) {
  response.setHeader("Content-Type", "text/event-stream");
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  );
}
const server = createServer((request, response) => {
  let raw = "";
  request.on("data", (c) => (raw += c));
  request.on("end", () => {
    requests++;
    if (mode === "fail") {
      response.writeHead(401);
      response.end("{}");
      return;
    }
    if (mode === "slow") {
      setTimeout(() => {
        if (!response.destroyed) sse(response, { content: "未提交" }, "stop");
      }, 1500);
      return;
    }
    const input = JSON.parse(raw);
    if (input.messages.some((m) => m.role === "tool")) {
      sse(response, { content: "已提交" }, "stop");
      return;
    }
    const prompt = JSON.parse(
      input.messages.findLast((m) => m.role === "user").content,
    );
    const title = input.tools.some((t) => t.function.name === "submit_titles");
    const args = title
      ? {
          chapterId: prompt.chapterId,
          inputHash: prompt.inputHash,
          titles: generation
            ? ["夜归旧宅", "信中往事", "钥匙之谜"]
            : ["雨夜来信", "空屋旧事", "门后的信"],
        }
      : { chapterId: prompt.chapterId, inputHash: prompt.inputHash, summary };
    sse(
      response,
      {
        tool_calls: [
          {
            index: 0,
            id: "fixed-call",
            type: "function",
            function: {
              name: title ? "submit_titles" : "submit_summary",
              arguments: JSON.stringify(args),
            },
          },
        ],
      },
      "tool_calls",
    );
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
let app;
const evidence = {
  passed: false,
  modelEvidence:
    "Deterministic local HTTP/SSE fixture in actual Electron; no semantic quality claim",
  widths: [375, 768, 1024, 1440],
};
async function launch() {
  app = await electron.launch({
    args: [
      ".",
      "--no-sandbox",
      `--user-data-dir=${path.join(root, "userdata")}`,
    ],
    env,
  });
  return app.firstWindow();
}
async function view(page, id) {
  return page.evaluate(
    (id) => window.desktop.generate.chapter({ chapterId: id }),
    id,
  );
}
async function until(predicate) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("async IPC condition timeout");
}
async function idle(page) {
  await until(async () => {
    const r = await page.evaluate(() => window.desktop.generate.summary());
    return (
      r.ok && !r.data.tasks.some((t) => ["running", "queued"].includes(t.state))
    );
  });
}

try {
  let page = await launch();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  const state = await page.evaluate(() => window.desktop.workspace.state());
  assert.ok(state.ok);
  const ids = state.data.chapterOrder;
  const original = await page.evaluate(
    (id) => window.desktop.chapters.get({ chapterId: id }),
    ids[0],
  );
  await page.getByRole("button", { name: "标题与摘要", exact: true }).click();
  await page.getByTestId("generate-title").click();
  await page.getByTestId("generate-error").waitFor();
  assert.match(
    await page.getByTestId("generate-error").innerText(),
    /配置|模型|Key/,
  );
  evidence.noConfiguration = true;
  await page.evaluate(
    async (port) =>
      window.desktop.saveConfig({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "fixture-p4",
        apiKey: "",
        temperature: 0.2,
        stream: true,
      }),
    port,
  );
  await page.getByTestId("generate-title").click();
  await page
    .getByTestId("generate-error")
    .filter({ hasText: "API Key" })
    .waitFor();
  assert.equal(requests, 0);
  evidence.noKeyNoRequest = true;
  await page.evaluate(
    async (port) =>
      window.desktop.saveConfig({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "fixture-p4",
        apiKey: "fixture-not-real",
        temperature: 0.2,
        stream: true,
      }),
    port,
  );
  await page.getByLabel("任务范围").selectOption("all");
  await page.getByTestId("generate-title").click();
  await page.getByTestId("title-candidate-2").waitFor();
  await idle(page);
  assert.equal(
    (await view(page, ids[1])).data.artifacts.filter((a) => a.kind === "title")
      .length,
    1,
  );
  evidence.multiChapterScope = true;
  assert.equal(
    (await view(page, ids[0])).data.currentTitle,
    original.data.title,
  );
  evidence.noAutoReplace = true;
  await page.getByLabel("候选 1", { exact: true }).fill("归家旧信");
  await page.getByLabel("候选 1", { exact: true }).press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".bb-title-row h2")
      ?.textContent?.includes("归家旧信"),
  );
  assert.ok(
    await page
      .locator(".bb-chapter[aria-pressed=true]")
      .innerText()
      .then((t) => t.includes("归家旧信")),
  );
  assert.equal(
    (await view(page, ids[0])).data.bodyHash,
    original.data.bodyHash,
  );
  evidence.keyboardTitleSelection = true;
  await page.getByRole("button", { name: "保留原标题", exact: true }).click();
  await page.waitForFunction(
    (title) =>
      document.querySelector(".bb-title-row h2")?.textContent === title,
    original.data.title,
  );
  evidence.keepOriginal = true;
  await page.getByText("标题生成设置", { exact: true }).click();
  await page.getByLabel("标题风格").fill("简洁");
  await page
    .getByTestId("title-source")
    .filter({ hasText: "生成要求已变化" })
    .waitFor();
  evidence.optionsFingerprintState = true;
  generation++;
  await page.getByTestId("generate-title").click();
  await page
    .getByLabel("候选 1", { exact: true })
    .filter({ visible: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector("#candidate-0")?.value === "夜归旧宅",
  );
  await idle(page);
  evidence.latestRegeneratedVisible = true;
  await page.getByTestId("generate-summary").click();
  await page.getByTestId("generated-summary").waitFor();
  await idle(page);
  assert.equal(
    await page.getByTestId("generated-summary").innerText(),
    summary,
  );
  const body = await page.evaluate(
    (id) => window.desktop.chapters.get({ chapterId: id }),
    ids[0],
  );
  assert.equal(body.data.body, original.data.body);
  evidence.summaryIndependent = true;
  // Test export through the real dialog API with only the dialog selection deterministically supplied.
  const exported = path.join(root, "范围摘要.txt");
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, exported);
  await page.getByLabel("任务范围").selectOption("current");
  await page.getByRole("button", { name: "独立导出摘要", exact: true }).click();
  await page
    .getByTestId("message")
    .filter({ hasText: "摘要已独立导出" })
    .waitFor();
  const text = await readFile(exported, "utf8");
  assert.ok(text.includes(original.data.title));
  assert.ok(!text.includes("第二章"));
  evidence.exportSelectedScope = true;
  const edited = await page.evaluate(async (id) => {
    const c = await window.desktop.chapters.get({ chapterId: id });
    return window.desktop.chapters.save({
      chapterId: id,
      baseRevision: c.data.bodyRevision,
      body: c.data.body + "\n他收起旧信。",
    });
  }, ids[0]);
  assert.ok(edited.ok);
  await page.getByRole("button", { name: "排版", exact: true }).click();
  await page.getByRole("button", { name: "标题与摘要", exact: true }).click();
  await page
    .getByTestId("summary-source")
    .filter({ hasText: "来源已过期" })
    .waitFor();
  await page
    .getByTestId("title-source")
    .filter({ hasText: "来源已过期" })
    .waitFor();
  await page.screenshot({
    path: "artifacts/electron-p4-stale.png",
    fullPage: true,
  });
  evidence.bodyChangeStale = true;
  // Restore the exact body: source identity follows content hash, not revision count.
  await page.evaluate(
    async ({ id, body }) => {
      const c = await window.desktop.chapters.get({ chapterId: id });
      return window.desktop.chapters.save({
        chapterId: id,
        baseRevision: c.data.bodyRevision,
        body,
      });
    },
    { id: ids[0], body: original.data.body },
  );
  await page.getByRole("button", { name: "排版", exact: true }).click();
  await page.getByRole("button", { name: "标题与摘要", exact: true }).click();
  await page
    .getByTestId("summary-source")
    .filter({ hasText: "基于当前正文" })
    .waitFor();
  evidence.bodyHashRollback = true;
  await page.locator(".bb-chapter").nth(1).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".bb-title-row h2")?.textContent === "第二章 旧信",
  );
  await page.locator(".bb-chapter").nth(0).click();
  await page.waitForFunction(
    () =>
      document.querySelector(".bb-title-row h2")?.textContent === "第一章 雨夜",
  );
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n他收好信封。");
  await page.getByTestId("save-state").filter({ hasText: "未保存" }).waitFor();
  await page.getByTestId("generate-title").click();
  await idle(page);
  await until(async () => {
    const r = await view(page, ids[0]);
    return (
      r.ok && r.data.artifacts.filter((a) => a.kind === "title").length === 3
    );
  });
  const savedDraft = await page.evaluate(
    (id) => window.desktop.chapters.get({ chapterId: id }),
    ids[0],
  );
  assert.ok(savedDraft.data.body.endsWith("他收好信封。"));
  assert.equal(
    (await view(page, ids[0])).data.artifacts.find((a) => a.kind === "title")
      .sourceBodyHash,
    savedDraft.data.bodyHash,
  );
  evidence.unsavedSavedBeforeGenerate = true;
  await page.getByLabel("候选 2", { exact: true }).fill("故乡信封");
  await page.getByLabel("候选 2", { exact: true }).press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector(".bb-title-row h2")
      ?.textContent?.includes("故乡信封"),
  );
  mode = "fail";
  await page.getByTestId("generate-summary").click();
  await idle(page);
  await page.waitForFunction(() =>
    document
      .querySelector("[data-testid=generate-error]")
      ?.textContent?.includes("AUTH"),
  );
  assert.equal(
    (await view(page, ids[0])).data.artifacts.filter(
      (a) => a.kind === "summary",
    ).length,
    1,
  );
  evidence.failurePreservesArtifact = true;
  mode = "slow";
  await page.getByTestId("generate-title").click();
  await page.getByRole("button", { name: "取消生成", exact: true }).click();
  await idle(page);
  evidence.cancel = true;
  mode = "ok";
  await page.getByTestId("generate-summary").click();
  await until(async () => {
    const r = await view(page, ids[0]);
    return (
      r.ok && r.data.artifacts.filter((a) => a.kind === "summary").length === 2
    );
  });
  await idle(page);
  for (const width of evidence.widths) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setContentSize(width, 1000),
      width,
    );
    await page.waitForTimeout(120);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `overflow ${width}`,
    );
    await page.screenshot({
      path: `artifacts/electron-p4-${width}.png`,
      fullPage: true,
    });
  }
  const focus = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    focus.push(await page.evaluate(() => document.activeElement?.tagName));
  }
  assert.ok(focus.every((t) => t !== "BODY"));
  evidence.keyboardFocus = focus;
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  page = await launch();
  await page.waitForSelector(".bb-book-name");
  await page.getByRole("button", { name: "标题与摘要", exact: true }).click();
  await page.getByTestId("generated-summary").waitFor();
  assert.equal(
    await page.getByTestId("generated-summary").innerText(),
    summary,
  );
  assert.ok((await view(page, ids[0])).data.currentTitle.includes("故乡信封"));
  assert.equal(
    (await view(page, ids[0])).data.bodyHash,
    savedDraft.data.bodyHash,
  );
  assert.ok(
    (await page.locator(".bb-title-row h2").innerText()).includes("故乡信封"),
  );
  assert.ok(
    (await page.locator(".bb-chapter[aria-pressed=true]").innerText()).includes(
      "故乡信封",
    ),
  );
  evidence.reopenPersisted = true;
  evidence.passed = true;
  await writeFile(
    "artifacts/electron-p4-test.json",
    JSON.stringify(
      { ...evidence, requests, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log("Electron P4 deterministic acceptance passed");
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.log(await page.locator(".bb-generate").innerText());
    console.log(
      JSON.stringify(
        await page.evaluate(() => window.desktop.generate.summary()),
      ),
    );
    await page.screenshot({
      path: "artifacts/electron-p4-failure.png",
      fullPage: true,
    });
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
