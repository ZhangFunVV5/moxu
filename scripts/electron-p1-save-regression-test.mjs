import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const base = path.join(process.cwd(), ".tmp-test", "p1-save-regression");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const fixture = path.join(root, "source.txt");
await writeFile(fixture, "第一章 起点\n初始正文\n第二章 终点\n第二章正文", "utf8");
const env = { ...process.env,
  BOOK_WORKBENCH_ROOT: path.join(root, "books"),
  BOOK_WORKBENCH_TEST_SOURCE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
async function launch() {
  app = await electron.launch({
    args: [".", "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`], env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".bb-shell");
  return page;
}
async function state(page, value) {
  await page.waitForFunction((expected) =>
    document.querySelector('[data-testid="save-state"]')?.textContent === expected, value);
}
async function replace(page, text) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(text);
}
async function detail(page) {
  return page.evaluate(async () => {
    const workspace = (await window.desktop.workspace.state()).data;
    return (await window.desktop.chapters.get({ chapterId: workspace.chapterOrder[0] })).data;
  });
}
try {
  let page = await launch();
  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  await page.waitForSelector(".cm-content");
  const initial = await detail(page);
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("chapter:save");
    globalThis.saveRegressionCalls = 0;
    ipcMain.removeHandler("chapter:save");
    ipcMain.handle("chapter:save", async (...args) => {
      globalThis.saveRegressionCalls += 1;
      const result = await original(...args);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return result;
    });
  });
  await replace(page, "保存请求 A");
  await page.keyboard.press("Control+S");
  await state(page, "保存中…");
  await replace(page, "保存期间继续输入 B😀");
  await page.keyboard.press("Control+S");
  await page.keyboard.press("Control+S");
  await state(page, "未保存");
  assert.equal(await page.locator(".cm-content").innerText(), "保存期间继续输入 B😀");
  assert.equal((await detail(page)).body, "保存请求 A");
  assert.equal(await app.evaluate(() => globalThis.saveRegressionCalls), 1);
  assert.equal(await page.getByTestId("save-error").count(), 0);
  await page.locator(".bb-sidebar .bb-chapter").nth(1).click();
  await page.getByRole("heading", { name: "未保存的修改" }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await state(page, "未保存");
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+S");
  await page.keyboard.press("Control+S");
  await state(page, "已保存");
  const saved = await detail(page);
  assert.equal(saved.body, "保存期间继续输入 B😀");
  assert.equal(saved.bodyRevision, initial.bodyRevision + 2);
  assert.equal(await app.evaluate(() => globalThis.saveRegressionCalls), 2);
  assert.equal(await page.getByTestId("save-error").count(), 0);

  // 草稿恢复到旧基线后切章，迟到的保存回执不能把另一章替换掉。
  await replace(page, "迟到的回执 C");
  await page.keyboard.press("Control+S");
  await state(page, "保存中…");
  await replace(page, saved.body);
  await page.locator(".bb-sidebar .bb-chapter").nth(1).click();
  await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent === "第二章正文");
  await state(page, "已保存");
  assert.equal(await page.locator(".cm-content").innerText(), "第二章正文");
  assert.equal(await page.locator(".bb-paper h2").innerText(), "第二章 终点");
  await app.close();
  app = null;
  page = await launch();
  await page.waitForSelector(".bb-book-name");
  await page.waitForSelector(".cm-content");
  assert.equal((await detail(page)).body, "迟到的回执 C");
  assert.equal(await page.locator(".cm-content").innerText(), "迟到的回执 C");
  await state(page, "已保存");
  console.log("Electron save regression: edits retained, repeated Ctrl+S coalesced, switch guard and stale response protected, reopen persisted");
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
