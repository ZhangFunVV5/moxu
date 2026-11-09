import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

// 独立作品和配置；不要与 npm test 并行（其入口会清理整个 .tmp-test）。
const base = path.join(process.cwd(), ".tmp-test", "p1-review-regression");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const userData = path.join(root, "user-data");
const fixture = path.join(root, "source.txt");
await writeFile(fixture, "第一章 起点\n甲正文\n\n第二章 终点\n乙正文", "utf8");
const env = { ...process.env, BOOK_WORKBENCH_ROOT: path.join(root, "books"), BOOK_WORKBENCH_TEST_SOURCE: fixture };
delete env.ELECTRON_RUN_AS_NODE;
let app;
async function launch() {
  app = await electron.launch({ args: [".", "--no-sandbox", `--user-data-dir=${userData}`], env });
  const page = await app.firstWindow();
  await page.waitForSelector(".bb-shell");
  return page;
}
async function previewReady(page, count) {
  await page.waitForFunction((expected) => {
    const create = [...document.querySelectorAll("button")].find((item) => item.textContent === "创建作品");
    return !create?.disabled && document.querySelectorAll(".bb-import-chapter").length === expected;
  }, count);
}
async function prepare(page) {
  return page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    return window.desktop.tasks.prepare({ type: "proofread", chapterIds: state.data.chapterOrder,
      options: {}, profileVersion: "review-regression" });
  });
}
try {
  let page = await launch();
  await page.getByRole("button", { name: "导入书籍" }).click();
  await previewReady(page, 2);
  // 延迟合并预览回执，允许验证保存标题和忽略旧响应。
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("workspace:preview");
    globalThis.reviewPreviewPending = 0;
    ipcMain.removeHandler("workspace:preview");
    ipcMain.handle("workspace:preview", async (...args) => {
      globalThis.reviewPreviewPending += 1;
      try {
        const result = await original(...args);
        if (args[1].boundaries) await new Promise((resolve) => setTimeout(resolve, 400));
        return result;
      } finally { globalThis.reviewPreviewPending -= 1; }
    });
  });
  const merge = () => page.getByRole("button", { name: "并入上一章" }).nth(1).click();
  await page.getByLabel("第 1 章标题").fill("用户标题");
  await merge();
  await page.getByLabel("第 1 章标题").fill("合并中仍可修改标题");
  await previewReady(page, 1);
  assert.equal(await page.getByLabel("第 1 章标题").inputValue(), "合并中仍可修改标题");
  assert.match(await page.locator(".bb-import-meta").innerText(), /15 字/);
  assert.equal(await page.locator(".bb-snippet").innerText(), "甲正文 第二章 终点 乙正文");
  await page.getByRole("button", { name: "重置分章" }).click();
  await previewReady(page, 2);
  assert.equal(await page.getByLabel("第 1 章标题").inputValue(), "第一章 起点");
  await merge();
  await page.getByLabel("分章方式").selectOption("single");
  await page.getByLabel("分章方式").selectOption("auto");
  await previewReady(page, 2);
  await app.evaluate(async () => {
    while (globalThis.reviewPreviewPending) await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(await page.locator(".bb-import-chapter").count(), 2, "旧合并响应不得回滚最新分章设置");
  await merge();
  await previewReady(page, 1);
  await page.getByLabel("第 1 章标题").fill("最终标题");
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  await page.waitForSelector(".cm-content");
  const workspace = await page.evaluate(async () => (await window.desktop.workspace.state()).data);
  const chapterPath = path.join(workspace.root, "chapters", `${workspace.chapterOrder[0]}.json`);
  const chapter = JSON.parse(await readFile(chapterPath, "utf8"));
  assert.equal(chapter.title.current, "最终标题");
  assert.equal(chapter.body, "甲正文\n\n第二章 终点\n乙正文");
  assert.equal([...chapter.body].length, 15);

  // 以合法格式外部改写正文，get 与 tasks.prepare 都必须读取新权威文件。
  chapter.body = chapter.body.replace("甲正文", "新正文");
  chapter.bodyHash = createHash("sha256").update(chapter.body).digest("hex");
  chapter.bodyRevision += 1;
  await writeFile(chapterPath, JSON.stringify(chapter), "utf8");
  const current = await page.evaluate(async (chapterId) =>
    window.desktop.chapters.get({ chapterId }), chapter.chapterId);
  assert.equal(current.ok, true);
  assert.equal(current.data.bodyHash, chapter.bodyHash);
  const prepared = await prepare(page);
  assert.equal(prepared.ok, true);
  const spec = JSON.parse(await readFile(path.join(workspace.root, prepared.data.specPath), "utf8"));
  assert.equal(spec.inputHashes[chapter.chapterId], chapter.bodyHash);
  assert.equal(spec.workspaceId, workspace.workspaceId);
  const validChapter = JSON.stringify(chapter);
  chapter.bodyHash = "0".repeat(64);
  await writeFile(chapterPath, JSON.stringify(chapter), "utf8");
  const invalid = await prepare(page);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_CHAPTER");
  await writeFile(chapterPath, validChapter, "utf8");
  // 在权威文件读取处暂停，再切换作品；任务必须始终写入发起时的作品。
  await app.evaluate((_electron, filePath) => {
    const { promises: fs } = process.getBuiltinModule("fs");
    const original = fs.readFile;
    globalThis.reviewReadStarted = new Promise((resolve) => { globalThis.reviewReadStartedResolve = resolve; });
    const gate = new Promise((resolve) => { globalThis.reviewReleaseRead = resolve; });
    fs.readFile = async (file, ...args) => {
      if (file === filePath) {
        fs.readFile = original;
        globalThis.reviewReadStartedResolve();
        await gate;
      }
      return original(file, ...args);
    };
  }, chapterPath);
  await page.evaluate(() => {
    window.reviewPendingTask = (async () => {
      const state = (await window.desktop.workspace.state()).data;
      return window.desktop.tasks.prepare({ type: "proofread", chapterIds: state.chapterOrder,
        options: {}, profileVersion: "switch-regression" });
    })();
  });
  await app.evaluate(async () => { await globalThis.reviewReadStarted; });
  const other = await page.evaluate(async () => {
    const source = (await window.desktop.workspace.chooseSource()).data;
    const preview = (await window.desktop.workspace.preview({ token: source.token, encoding: "utf-8",
      splitMode: "single", paragraphMode: "line", headingLevel: 0 })).data;
    return (await window.desktop.workspace.create({ previewToken: preview.previewToken,
      bookTitle: "另一作品", boundaries: [0] })).data;
  });
  assert.notEqual(other.workspaceId, workspace.workspaceId);
  await app.evaluate(() => { globalThis.reviewReleaseRead(); });
  const raced = await page.evaluate(() => window.reviewPendingTask);
  assert.equal(raced.ok, true);
  const racedSpec = JSON.parse(await readFile(path.join(workspace.root, raced.data.specPath), "utf8"));
  assert.equal(racedSpec.workspaceId, workspace.workspaceId);
  assert.equal(racedSpec.inputHashes[chapter.chapterId], current.data.bodyHash);
  await assert.rejects(readFile(path.join(other.root, raced.data.specPath)));
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace.root);
  await page.evaluate(() => window.desktop.workspace.open());
  await app.close(); app = null;

  // 自动重开失败必须可见，最近记录逐字保留；手动打开修复后的作品可恢复。
  const recentPath = path.join(userData, "recent-workspaces.json");
  const recentBefore = await readFile(recentPath, "utf8");
  const bookPath = path.join(workspace.root, "book.json");
  const validBook = await readFile(bookPath, "utf8");
  await writeFile(bookPath, "{ damaged", "utf8");
  page = await launch();
  await page.getByTestId("startup-error").waitFor();
  assert.match(await page.getByTestId("startup-error").innerText(), /INVALID_BOOK.*无法自动打开最近工作区/);
  assert.equal(await readFile(recentPath, "utf8"), recentBefore);
  await page.setViewportSize({ width: 375, height: 960 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false,
    "损坏工作区的长路径错误在375px不能产生横向溢出");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/electron-p1-startup-error-375.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: "artifacts/electron-p1-startup-error-1440.png", fullPage: true });
  await page.getByRole("button", { name: "打开工作区" }).waitFor();
  await writeFile(bookPath, validBook, "utf8");
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
  }, workspace.root);
  await page.getByRole("button", { name: "打开工作区" }).click();
  await page.waitForSelector(".bb-book-name");
  await page.waitForSelector(".cm-content");
  assert.equal(await page.getByTestId("startup-error").count(), 0);
  assert.match(await page.locator(".cm-content").innerText(), /新正文/);
  console.log("Electron review regression: merged preview/title/reset/stale response, authoritative task hashes/integrity, startup error/recent preservation/manual recovery passed");
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
