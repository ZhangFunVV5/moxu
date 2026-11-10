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
  Array.from(
    { length: 24 },
    (_, i) =>
      `第${i + 1}章 原有标题\n沈舟回家，发现桌上放着一封旧信。门开着，屋里没有人。`,
  ).join("\n\n"),
);
const env = {
  ...process.env,
  BOOK_WORKBENCH_ROOT: path.join(root, "books"),
  BOOK_WORKBENCH_TEST_SOURCE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
let mode = "ok",
  generation = 0,
  failChapterId = null,
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
    if (title && prompt.chapterId === failChapterId) {
      sse(response, { content: "失败" }, "stop");
      return;
    }
    const args = title
      ? {
          chapterId: prompt.chapterId,
          inputHash: prompt.inputHash,
          titles: (generation
            ? ["夜归旧宅", "信中往事", "钥匙之谜"]
            : ["雨夜来信", "空屋旧事", "门后的信"]
          ).slice(0, prompt.options.candidateCount),
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
  const launchEnv = { ...env };
  if (process.env.BW_PACKAGED_EXE) {
    for (const key of Object.keys(launchEnv))
      if (key.toLowerCase() === "path") delete launchEnv[key];
    launchEnv.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
    delete launchEnv.NODE_PATH;
    delete launchEnv.NODE_OPTIONS;
  }
  app = await electron.launch({
    ...(process.env.BW_PACKAGED_EXE
      ? { executablePath: process.env.BW_PACKAGED_EXE, cwd: root }
      : {}),
    args: [
      ...(process.env.BW_PACKAGED_EXE ? [] : [".", "--no-sandbox"]),
      `--user-data-dir=${path.join(root, "userdata")}`,
    ],
    env: launchEnv,
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
  await page.getByRole("button", { name: "导入书籍", exact: true }).click();
  await page.getByRole("button", { name: "创建作品", exact: true }).click();
  await page.waitForSelector(".bb-book-name");
  const state = await page.evaluate(() => window.desktop.workspace.state());
  const ids = state.data.chapterOrder;
  await page.evaluate(
    (port) =>
      window.desktop.saveConfig({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "fixture-batch",
        apiKey: "fixture",
        temperature: 0.2,
        stream: true,
      }),
    port,
  );
  await page.getByRole("button", { name: "标题与摘要", exact: true }).click();
  await page.getByLabel("任务范围").selectOption("all");
  await page.getByTestId("generate-title").click();
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(await page.locator(".bb-batch-row input:checked").count(), 24);
  assert.equal(await page.locator(".bb-batch-dialog button").count(), 2);
  await page.screenshot({
    path: "artifacts/title-batch-long-desktop.png",
    fullPage: true,
  });
  for (const size of [
    { width: 375, height: 520 },
    { width: 768, height: 400 },
  ]) {
    await page.setViewportSize(size);
    const box = await page
      .locator(".bb-batch-dialog button")
      .first()
      .boundingBox();
    assert.ok(box && box.y + box.height <= size.height);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator(".bb-batch-row input").last().focus();
    await page.keyboard.press("Space");
    assert.equal(
      await page.locator(".bb-batch-row input").last().isChecked(),
      false,
    );
    await page.keyboard.press("Space");
    await page.screenshot({
      path: `artifacts/title-batch-long-${size.width}.png`,
      fullPage: true,
    });
  }
  await page.keyboard.press("Escape");
  await until(
    async () =>
      !(await page.locator(".bb-batch-dialog").evaluate((d) => d.open)),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  // Cancel after exactly one committed chapter; no modal until resume finishes.
  const cancelledTask = await page.evaluate(async (ids) => {
    let id;
    const off = window.desktop.generate.onEvent((e) => {
      if (
        e.taskId === id &&
        e.type === "chapterUpdated" &&
        e.state === "completed"
      ) {
        off();
        void window.desktop.generate.cancel({ taskId: id });
      }
    });
    const r = await window.desktop.generate.start({
      kind: "title",
      chapterIds: ids.slice(0, 3),
      options: {
        minLength: 2,
        maxLength: 12,
        candidateCount: 3,
        style: "贴合原文",
        allowSpoilers: false,
      },
    });
    id = r.data.taskId;
    return id;
  }, ids);
  await idle(page);
  let cancelledResult = await page.evaluate(
    (taskId) => window.desktop.generate.taskResult({ taskId }),
    cancelledTask,
  );
  assert.equal(cancelledResult.data.state, "cancelled");
  assert.equal(cancelledResult.data.succeeded, 1);
  assert.equal(
    await page.locator(".bb-batch-dialog").evaluate((d) => d.open),
    false,
  );
  await page.evaluate(
    (taskId) => window.desktop.generate.resume({ taskId }),
    cancelledTask,
  );
  await page.locator(".bb-batch-dialog[open]").waitFor();
  await page
    .locator(".bb-batch-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await until(
    async () =>
      !(await page.locator(".bb-batch-dialog").evaluate((d) => d.open)),
  );
  failChapterId = ids[1];
  const failedTask = await page.evaluate(
    async (ids) =>
      (
        await window.desktop.generate.start({
          kind: "title",
          chapterIds: ids.slice(0, 3),
          options: {
            minLength: 2,
            maxLength: 12,
            candidateCount: 3,
            style: "贴合原文",
            allowSpoilers: false,
          },
        })
      ).data.taskId,
    ids,
  );
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(await page.locator(".bb-batch-row input:disabled").count(), 1);
  assert.equal(await page.locator(".bb-batch-row input:checked").count(), 2);
  await page
    .locator(".bb-batch-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await until(
    async () =>
      !(await page.locator(".bb-batch-dialog").evaluate((d) => d.open)),
  );
  failChapterId = null;
  // A newer B must not hide a resumed older A.
  const newerTask = await page.evaluate(
    async (ids) =>
      (
        await window.desktop.generate.start({
          kind: "title",
          chapterIds: ids.slice(0, 3),
          options: {
            minLength: 2,
            maxLength: 12,
            candidateCount: 3,
            style: "贴合原文",
            allowSpoilers: false,
          },
        })
      ).data.taskId,
    ids,
  );
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(
    await page.locator(".bb-batch-dialog").getAttribute("data-task-id"),
    newerTask,
  );
  await page
    .locator(".bb-batch-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await until(
    async () =>
      !(await page.locator(".bb-batch-dialog").evaluate((d) => d.open)),
  );
  await page.evaluate(
    (taskId) => window.desktop.generate.resume({ taskId }),
    failedTask,
  );
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(await page.locator(".bb-batch-row input:checked").count(), 3);
  assert.equal(
    await page.locator(".bb-batch-dialog").getAttribute("data-task-id"),
    failedTask,
  );
  const beforeOlderReopen = requests;
  await app.close();
  app = null;
  page = await launch();
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(
    await page.locator(".bb-batch-dialog").getAttribute("data-task-id"),
    failedTask,
  );
  assert.equal(requests, beforeOlderReopen);

  await page
    .locator(".bb-batch-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await until(
    async () =>
      !(await page.locator(".bb-batch-dialog").evaluate((d) => d.open)),
  );
  const out = path.join(root, "batch-output.txt");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, out);
  async function pipeline() {
    const r = await page.evaluate(async (ids) => {
      const p = await window.desktop.format.getPreset();
      return window.desktop.pipeline.start({
        chapterIds: ids.slice(0, 3),
        title: {
          minLength: 2,
          maxLength: 12,
          candidateCount: 3,
          style: "贴合原文",
          allowSpoilers: false,
        },
        format: { options: p.data, outputFormat: "txt" },
        export: true,
      });
    }, ids);
    assert.ok(r.ok);
    return r.data.pipelineId;
  }
  async function waiting(id, state) {
    await until(async () => {
      const r = await page.evaluate(() => window.desktop.pipeline.list());
      return r.ok && r.data.find((p) => p.pipelineId === id)?.state === state;
    });
  }
  const run = await pipeline();
  await waiting(run, "waiting-title");
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(await readFile(out, "utf8").catch(() => null), null);
  // Persist waiting-title and the candidates across a real process restart.
  const before = requests;
  await app.close();
  app = null;
  page = await launch();
  await page.locator(".bb-batch-dialog[open]").waitFor();
  assert.equal(requests, before);
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, out);
  await page.locator(".bb-batch-row input").nth(1).uncheck();
  await page.locator(".bb-batch-row input").nth(2).uncheck();
  await page
    .locator(".bb-batch-dialog")
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await waiting(run, "completed");
  const text = await readFile(out, "utf8");
  assert.match(text, /第1章 雨夜来信/);
  assert.match(text, /第2章 原有标题/);
  const cancelled = await pipeline();
  await waiting(cancelled, "waiting-title");
  await page.locator(".bb-batch-dialog[open]").waitFor();
  await page
    .locator(".bb-batch-dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await waiting(cancelled, "completed");
  assert.equal(await readFile(out, "utf8"), text);
  const decisionSaved = await pipeline();
  await waiting(decisionSaved, "waiting-title");
  await page.locator(".bb-batch-dialog[open]").waitFor();
  const record = (
    await page.evaluate(() => window.desktop.pipeline.list())
  ).data.find((p) => p.pipelineId === decisionSaved);
  const titleTask = record.stages.find((s) => s.kind === "title").taskId;
  await page.evaluate(
    async ({ workspaceId, taskId }) =>
      window.desktop.generate.applyBatch({
        workspaceId,
        taskId,
        action: "cancel",
        selections: [],
      }),
    { workspaceId: record.workspaceId, taskId: titleTask },
  );
  await app.close();
  app = null;
  page = await launch();
  await page.waitForSelector(".bb-book-name");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, out);
  await page
    .getByRole("button", { name: "标题决议后继续流程", exact: true })
    .click();
  await waiting(decisionSaved, "completed");
  assert.equal(await readFile(out, "utf8"), text);
  await writeFile(
    process.env.BW_PACKAGED_EXE
      ? "artifacts/title-batch-packaged-electron.json"
      : "artifacts/title-batch-electron.json",
    JSON.stringify(
      {
        passed: true,
        packaged: !!process.env.BW_PACKAGED_EXE,
        chapters: 24,
        requests,
        longList: true,
        keyboard: true,
        reopenPending: true,
        pipelinePartialExport: true,
        pipelineCancelExport: true,
        cancelledProgressAndResume: true,
        partialFailureAndResume: true,
        savedDecisionReopenContinue: true,
        resumedOlderTaskTracked: true,
        resumedOlderTaskReopenPending: true,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("Batch title Electron verification passed");
} catch (error) {
  if (app) {
    const p = await app.firstWindow();
    await p.screenshot({
      path: "artifacts/title-batch-failure.png",
      fullPage: true,
    });
    console.log(await p.locator("body").innerText());
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
