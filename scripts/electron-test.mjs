import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer as createViteServer } from "vite";
const launchEnv = { ...process.env };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const base = path.join(process.cwd(), ".tmp-test", "p0-electron");
await mkdir(base, { recursive: true });
const userData = await mkdtemp(path.join(base, "ud-"));
let hang = false;
let requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const input = JSON.parse(body);
    requests.push(input);
    if (hang) return;
    res.setHeader("Content-Type", "text/event-stream");
    const read = input.messages.some((m) => m.role === "tool");
    const delta = read
      ? { content: "固定服务验证：" }
      : {
          tool_calls: [
            {
              index: 0,
              id: "fixture-read",
              type: "function",
              function: {
                name: "read_sample_chapter",
                arguments: '{"chapterId":"c1"}',
              },
            },
          ],
        };
    const chunks = [{ choices: [{ delta, finish_reason: null }] }];
    if (read)
      chunks.push({
        choices: [
          {
            delta: { content: "已读取雨夜归人的示例正文。" },
            finish_reason: null,
          },
        ],
      });
    chunks.push({
      choices: [{ delta: {}, finish_reason: read ? "stop" : "tool_calls" }],
    });
    res.end(
      chunks
        .map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n")
        .join("") + "data: [DONE]\n\n",
    );
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
let app;
async function launch(extra = []) {
  const a = await electron.launch({
    // 测试进程由受限宿主启动 Chromium，需要 --no-sandbox；正常产品启动不传此参数。
    args: [".", "--no-sandbox", `--user-data-dir=${userData}`, ...extra],
    env: launchEnv,
  });
  const page = await a.firstWindow();
  await page.waitForSelector(".bb-paper");
  return [a, page];
}
try {
  let page;
  [app, page] = await launch();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  const bad = await page.evaluate(() => window.desktop.start({ bad: true }));
  assert.equal(bad.error.code, "INVALID_REQUEST");
  await page.getByRole("button", { name: "模型设置" }).click();
  await page
    .getByText("Base URL", { exact: true })
    .locator("input")
    .fill(`http://127.0.0.1:${port}/v1`);
  await page
    .getByText("模型名", { exact: true })
    .locator("input")
    .fill("fixture-model");
  await page
    .getByText("API Key", { exact: true })
    .locator("input")
    .fill("fixture-secret");
  await page.getByRole("button", { name: "保存设置" }).click();
  // Windows may need its first Chromium encryption-key commit before save succeeds.
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  const cfg = await page.evaluate(() => window.desktop.getConfig());
  assert.equal(cfg.data.hasKey, true);
  assert.equal("apiKey" in cfg.data, false);
  await page.getByRole("button", { name: "运行只读样例" }).click();
  await page.getByTestId("status").filter({ hasText: "completed" }).waitFor();
  assert.deepEqual(
    requests[1].messages.map((m) => m.role),
    ["system", "user", "assistant", "tool"],
  );
  assert.equal(requests[0].max_tokens, 1024);
  assert.equal(
    await page
      .locator(".bb-log")
      .getByText("固定服务验证：已读取雨夜归人的示例正文。", { exact: true })
      .count(),
    1,
  );
  await page.evaluate(() => {
    window.received = 0;
    const dispose = window.desktop.onEvent(() => window.received++);
    dispose();
    window.unsubscribe = window.desktop.onEvent(() => window.received++);
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("task:event", {
      workspaceId: "sample-book",
      requestId: "old-request",
      taskId: "old-task",
      type: "taskStateChanged",
      message: "旧事件不得覆盖",
      state: "failed",
    }),
  );
  await page.waitForFunction(() => window.received === 1);
  assert.equal(await page.getByTestId("status").innerText(), "completed");
  await page.evaluate(() => window.unsubscribe());
  await page.screenshot({
    path: "artifacts/electron-task-completed.png",
    fullPage: true,
  });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `overflow ${width}`,
    );
    await page.screenshot({
      path: `artifacts/electron-${width}.png`,
      fullPage: true,
    });
  }
  for (const mode of ["排版", "标题与摘要", "精校"])
    await page.getByRole("button", { name: mode, exact: true }).click();
  hang = true;
  await page.getByRole("button", { name: "运行只读样例" }).click();
  await page.getByRole("button", { name: "取消任务" }).click();
  await page.getByTestId("status").filter({ hasText: "cancelled" }).waitFor();
  const concurrent = await page.evaluate(() =>
    Promise.all(
      [1, 2].map(() =>
        window.desktop.start({
          requestId: crypto.randomUUID(),
          workspaceId: "sample-book",
          chapterId: "c1",
          prompt: "读取示例",
        }),
      ),
    ),
  );
  assert.equal(concurrent.filter((r) => r.ok).length, 1);
  assert.equal(concurrent.find((r) => !r.ok).error.code, "BUSY");
  await page.evaluate(
    (taskId) =>
      window.desktop.cancel({
        requestId: crypto.randomUUID(),
        workspaceId: "sample-book",
        taskId,
      }),
    concurrent.find((r) => r.ok).data.taskId,
  );
  assert.equal(errors.length, 0);
  await app.close();
  [app, page] = await launch();
  const reopened = await page.evaluate(() => window.desktop.getConfig());
  assert.equal(reopened.data.model, "fixture-model");
  assert.equal(reopened.data.hasKey, true);
  assert.equal(JSON.stringify(reopened).includes("fixture-secret"), false);
  await app.close();
  app = null;
  const vite = await createViteServer({
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: { ignored: ["**/.tmp-test/**"] },
    },
  });
  await vite.listen();
  try {
    [app, page] = await launch(["--dev"]);
    assert.match(page.url(), /^http:\/\/127\.0\.0\.1:5173/);
    await app.close();
    app = null;
  } finally {
    await vite.close();
  }
  await writeFile(
    "artifacts/electron-test.json",
    JSON.stringify(
      {
        passed: true,
        widths: [375, 768, 1024, 1440],
        nodeIsolated: true,
        configReopened: true,
        credentialsMasked: true,
        fixedServiceLoop: true,
        cancelled: true,
        realModel: false,
        devWindowLoaded: true,
        subscriptionsAndOldEvents: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Electron: isolation, IPC, encrypted settings/reopen, fixed HTTP loop, cancellation, 4 responsive screenshots passed",
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  server.close();
  await rm(userData, { recursive: true, force: true }).catch(() => undefined);
}
