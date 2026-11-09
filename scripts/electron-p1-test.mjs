import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

/**
 * P1 Electron 端到端：真实导入预览 → 合并章界 → 创建作品 → 编辑保存 →
 * 未保存切换保护 → 重命名 → 旧修订拒绝 → 取消导入不写盘 → 关闭重开一致。
 */
const base = path.join(process.cwd(), ".tmp-test", "p1-electron");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const userData = path.join(root, "user-data");
const booksRoot = path.join(root, "books");
const sourceDir = path.join(root, "中文 路径");
const fixture = path.join(sourceDir, "长夜 书.txt");
const launchEnv = { ...process.env };
delete launchEnv.ELECTRON_RUN_AS_NODE;
launchEnv.BOOK_WORKBENCH_ROOT = booksRoot;
launchEnv.BOOK_WORKBENCH_TEST_SOURCE = fixture;

const fixtureText = [
  "长夜",
  "",
  "这是一本用于 P1 验收的短书。",
  "",
  "序章 灯下",
  "雨落在青石板上，像细密的鼓点。",
  "",
  "第一章 雨夜",
  "沈舟站在旧宅门前。",
  "",
  "***",
  "",
  "“你终于回来了。”门里传来一个熟悉的声音。",
  "",
  "第一章 归来",
  "重复的章号仍然保留。",
  "",
  "番外一 旧信",
  "信封已经泛黄。",
  "",
  "结尾一行😀",
].join("\r\n");
await mkdir(sourceDir, { recursive: true });
await writeFile(fixture, fixtureText, "utf8");
const sourceBefore = await readFile(fixture);
const sourceHash = createHash("sha256").update(sourceBefore).digest("hex");

async function hashDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => entry.name).sort();
}

let app = null;
async function launch() {
  const instance = await electron.launch({
    // 测试进程由受限宿主启动 Chromium，需要 --no-sandbox；正常产品启动不传此参数。
    args: [".", "--no-sandbox", `--user-data-dir=${userData}`],
    env: launchEnv,
  });
  const page = await instance.firstWindow();
  await page.waitForSelector(".bb-shell");
  return { instance, page };
}

async function waitEnabled(page, label) {
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.includes(name) && !button.disabled,
      ),
    label,
  );
}

async function saveState(page, expected) {
  await page.waitForFunction(
    (value) =>
      document.querySelector('[data-testid="save-state"]')?.textContent?.trim() ===
      value,
    expected,
  );
}

const evidence = {
  passed: false,
  imported: false,
  mergedChapterBoundary: false,
  previewWroteNothing: false,
  sourceUnchanged: false,
  editedAndSaved: false,
  rangeUi: false,
  headingSeparated: false,
  unsavedGuard: false,
  renameKeptBodyHash: false,
  staleRevisionRejected: false,
  taskSpecPrepared: false,
  taskScopeEnforced: false,
  saveFailureVisible: false,
  openDialogWorkspace: false,
  cancelImportWroteNothing: false,
  reopened: false,
  widths: [375, 768, 1024, 1440],
  utf8AfterReopen: false,
};

try {
  let page;
  ({ instance: app, page } = await launch());
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 1) 从只读示例进入导入预览
  assert.equal(await page.locator(".bb-preview-badge").innerText(), "P0 · 只读示例");
  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.getByRole("heading", { name: "导入书籍" }).waitFor();
  await waitEnabled(page, "创建作品");
  const summary = await page.locator(".bb-import-summary").innerText();
  assert.match(summary, /共 5 章/);
  const chapterTitles = await page
    .locator(".bb-import-chapter input")
    .evaluateAll((nodes) => nodes.map((node) => node.value));
  assert.deepEqual(chapterTitles, [
    "标题前内容",
    "序章 灯下",
    "第一章 雨夜",
    "第一章 归来",
    "番外一 旧信",
  ]);
  assert.equal(await page.locator(".bb-import-chapter").count(), 5);
  await page.screenshot({ path: "artifacts/electron-p1-import.png", fullPage: true });

  // 2) 修正章界：把“番外”并入上一章，验证预览重算
  await page
    .locator(".bb-import-chapter")
    .nth(4)
    .getByRole("button", { name: "并入上一章" })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".bb-import-summary")?.textContent?.includes("共 4 章"),
  );
  evidence.mergedChapterBoundary = true;
  assert.equal(await page.locator(".bb-import-chapter").count(), 4);
  await page.getByLabel("书名").fill("长夜 书");
  assert.deepEqual(await hashDir(booksRoot), [], "预览阶段不得创建作品目录");
  evidence.previewWroteNothing = true;
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  await page.waitForFunction(
    () => document.querySelector(".bb-book-name")?.textContent === "长夜 书",
  );
  evidence.imported = true;
  assert.equal((await hashDir(booksRoot)).length, 1);
  const workspaceRoot = path.join(booksRoot, (await hashDir(booksRoot))[0]);
  const book = JSON.parse(await readFile(path.join(workspaceRoot, "book.json"), "utf8"));
  assert.equal(book.chapterOrder.length, 4);
  assert.equal(book.importSettings.boundaries.length, 4);
  assert.equal(book.source.sha256, createHash("sha256").update(await readFile(fixture)).digest("hex"));
  evidence.previewWroteNothing = true;
  evidence.sourceUnchanged = (await readFile(fixture)).equals(sourceBefore);
  assert.ok(evidence.sourceUnchanged);

  // 2b) 范围 UI：当前章／选定范围／整书与复选框联动
  const rangeSelect = page.getByLabel("任务范围");
  await rangeSelect.selectOption("range");
  await page.getByLabel("选择第 2 章").check();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="scope-label"]')?.textContent?.includes(
      "选定范围 2 章",
    ),
  );
  assert.equal(await page.locator(".bb-chapter-check").count(), 4);
  await rangeSelect.selectOption("all");
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="scope-label"]')?.textContent?.includes(
      "全书 4 章",
    ),
  );
  await rangeSelect.selectOption("current");
  evidence.rangeUi = true;

  // 3) 首章载入、编辑、保存
  await page.waitForFunction(
    () => document.querySelector(".bb-paper h2")?.textContent?.includes("标题前内容"),
  );
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("新增一行😀");
  await saveState(page, "未保存");
  await page.keyboard.press("Control+S");
  await saveState(page, "已保存");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("第二处保存");
  await saveState(page, "未保存");
  await page.getByRole("button", { name: "保存正文" }).click();
  await saveState(page, "已保存");
  assert.match(
    await page.getByTestId("message").innerText(),
    /已保存/,
  );
  await page
    .locator(".cm-line", { hasText: "这是一本用于 P1 验收的短书。" })
    .click();
  await page.waitForFunction(() =>
    /段落 p\d+/.test(
      document.querySelector('[data-testid="paragraph-status"]')?.textContent ?? "",
    ),
  );
  evidence.editedAndSaved = true;

  const headingSeparated = await page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    const chapter = state.data.chapters[2];
    const detail = (await window.desktop.chapters.get({ chapterId: chapter.chapterId })).data;
    return { title: detail.title, body: detail.body };
  });
  assert.equal(headingSeparated.title, "第一章 雨夜");
  assert.equal(headingSeparated.body.includes("第一章 雨夜"), false);
  assert.ok(headingSeparated.body.startsWith("沈舟站在旧宅门前。"));
  evidence.headingSeparated = true;

  const beforeRename = await page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    const id = state.data.chapters[0].chapterId;
    return (await window.desktop.chapters.get({ chapterId: id })).data;
  });
  await page.getByRole("button", { name: "重命名" }).click();
  const renameDialog = page.locator("dialog[open]");
  await renameDialog.locator("input").fill("雨夜（改名）");
  await renameDialog.getByRole("button", { name: "保存标题" }).click();
  await page.waitForFunction(
    () => document.querySelector(".bb-paper h2")?.textContent === "雨夜（改名）",
  );
  const afterRename = await page.evaluate(async (chapterId) => {
    return (await window.desktop.chapters.get({ chapterId })).data;
  }, beforeRename.chapterId);
  assert.equal(afterRename.title, "雨夜（改名）");
  assert.equal(afterRename.bodyHash, beforeRename.bodyHash);
  evidence.renameKeptBodyHash = true;

  // 4) 未保存切换保护：取消 → 放弃修改
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("临时未保存");
  await saveState(page, "未保存");
  const chapters = page.locator(".bb-sidebar .bb-chapter");
  const currentTitle = await page.locator(".bb-paper h2").innerText();
  await chapters.nth(2).click();
  await page.getByRole("heading", { name: "未保存的修改" }).waitFor();
  await page.getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(
    (title) => document.querySelector(".bb-paper h2")?.textContent === title,
    currentTitle,
  );
  await saveState(page, "未保存");
  await chapters.nth(2).click();
  await page.getByRole("button", { name: "放弃修改" }).click();
  await page.waitForFunction(() =>
    document.querySelector(".bb-paper h2")?.textContent?.includes("第一章 雨夜"),
  );
  await chapters.nth(0).click();
  await page.waitForFunction(
    (title) => document.querySelector(".bb-paper h2")?.textContent === title,
    currentTitle,
  );
  await page.waitForFunction(
    () => !document.body.textContent?.includes("临时未保存"),
  );
  evidence.unsavedGuard = true;

  // 5) 旧修订号不能覆盖新正文（真实 IPC）
  const stale = await page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    const id = state.data.chapters[0].chapterId;
    const current = (await window.desktop.chapters.get({ chapterId: id })).data;
    const result = await window.desktop.chapters.save({
      chapterId: id,
      baseRevision: current.bodyRevision - 1,
      body: "不应覆盖的旧修订",
    });
    return { result, body: (await window.desktop.chapters.get({ chapterId: id })).data.body };
  });
  assert.equal(stale.result.ok, false);
  assert.equal(stale.result.error.code, "VERSION_CONFLICT");
  assert.ok(stale.body.includes("新增一行😀"));
  evidence.staleRevisionRejected = true;

  // 5.5) TaskSpec 快照：真实 IPC 写入 tasks/<id>，范围按 book.json 章序收敛
  const prepared = await page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    const ids = state.data.chapters.map((chapter) => chapter.chapterId);
    const request = {
      type: "proofread",
      chapterIds: [ids[1], ids[0]],
      options: { glossary: ["沈舟"], categories: ["typo"] },
      profileVersion: "p1-electron",
    };
    const created = await window.desktop.tasks.prepare(request);
    const outside = await window.desktop.tasks.prepare({
      ...request,
      chapterIds: ["ch-not-in-book"],
    });
    const duplicated = await window.desktop.tasks.prepare({
      ...request,
      chapterIds: [ids[0], ids[0]],
    });
    return { ids, created, outside, duplicated };
  });
  assert.equal(prepared.created.ok, true);
  assert.deepEqual(prepared.created.data.chapterIds, [
    prepared.ids[0],
    prepared.ids[1],
  ]);
  assert.equal(prepared.created.data.states[prepared.ids[0]], "queued");
  assert.equal(prepared.outside.ok, false);
  assert.equal(prepared.outside.error.code, "CHAPTER_NOT_FOUND");
  assert.equal(prepared.duplicated.ok, false);
  assert.equal(prepared.duplicated.error.code, "INVALID_INPUT");
  const taskDir = path.join(workspaceRoot, "tasks", prepared.created.data.taskId);
  const storedSpec = JSON.parse(
    await readFile(path.join(taskDir, "task-spec.json"), "utf8"),
  );
  const storedCheckpoints = JSON.parse(
    await readFile(path.join(taskDir, "checkpoints.json"), "utf8"),
  );
  assert.equal(storedSpec.taskId, prepared.created.data.taskId);
  assert.deepEqual(storedSpec.chapterIds, prepared.created.data.chapterIds);
  assert.equal(storedSpec.permissions.canWriteBody, false);
  assert.equal(storedCheckpoints.chapters[prepared.ids[0]].status, "queued");
  assert.deepEqual(
    Object.keys(storedSpec.inputHashes),
    prepared.created.data.chapterIds,
  );
  evidence.taskSpecPrepared = true;
  evidence.taskScopeEnforced = true;

  // 5.5b) 保存失败可见：后台先推进修订号，GUI 保存必须显示失败而非“已保存”
  await page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    const id = state.data.chapters[0].chapterId;
    const current = (await window.desktop.chapters.get({ chapterId: id })).data;
    await window.desktop.chapters.save({
      chapterId: id,
      baseRevision: current.bodyRevision,
      body: `${current.body}\n后台修改`,
    });
  });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("前台未保存");
  await page.getByRole("button", { name: "保存正文" }).click();
  await page.getByTestId("save-error").waitFor();
  assert.match(await page.getByTestId("save-error").innerText(), /别处被修改|VERSION_CONFLICT/);
  await saveState(page, "未保存");
  await page.getByRole("button", { name: "重新载入最新正文" }).click();
  await page.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent?.includes("后台修改"),
  );
  await page.getByTestId("save-error").waitFor({ state: "detached" });
  await saveState(page, "已保存");
  evidence.saveFailureVisible = true;

  // 5.6) 打开对话框路径：关闭工作区后经 main 的目录选择重新打开
  await app.evaluate(
    ({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    },
    workspaceRoot,
  );
  await page.getByRole("button", { name: "关闭工作区" }).click();
  await page.waitForFunction(
    () => document.querySelector(".bb-preview-badge")?.textContent === "P0 · 只读示例",
  );
  await page.getByRole("button", { name: "打开工作区" }).click();
  await page.waitForFunction(
    () => document.querySelector(".bb-book-name")?.textContent === "长夜 书",
  );
  evidence.openDialogWorkspace = true;

  // 6) 取消导入不写盘
  const beforeCancel = await hashDir(booksRoot);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("heading", { name: "导入书籍" }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  assert.deepEqual(await hashDir(booksRoot), beforeCancel);
  evidence.cancelImportWroteNothing = true;

  // 7) 响应式与截图
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      `overflow ${width}`,
    );
    await page.screenshot({
      path: `artifacts/electron-p1-${width}.png`,
      fullPage: true,
    });
  }
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await app.close();
  app = null;

  // 8) 关闭重开一致（同一 userData，最近工作区自动载入）
  ({ instance: app, page } = await launch());
  await page.waitForSelector(".bb-book-name");
  await page.waitForFunction(
    () => document.querySelector(".bb-book-name")?.textContent === "长夜 书",
  );
  const reopened = await page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    const chapters = state.data.chapters;
    const detail = (await window.desktop.chapters.get({ chapterId: chapters[0].chapterId })).data;
    return { title: detail.title, body: detail.body, chapters: chapters.length };
  });
  assert.equal(reopened.title, "雨夜（改名）");
  assert.equal(reopened.chapters, 4);
  assert.ok(reopened.body.includes("新增一行😀"));
  evidence.utf8AfterReopen = true;
  evidence.reopened = true;
  await page.screenshot({
    path: "artifacts/electron-p1-reopened.png",
    fullPage: true,
  });
  await app.close();
  app = null;

  evidence.passed = true;
  await writeFile(
    "artifacts/electron-p1-test.json",
    JSON.stringify(
      {
        ...evidence,
        fixture: path.basename(fixture),
        sourceSha256: sourceHash,
        workspace: path.basename(workspaceRoot),
        bookTitle: book.bookTitle,
        importSettings: book.importSettings,
        taskId: prepared.created.data.taskId,
        taskChapterCount: prepared.created.data.chapterIds.length,
        taskStates: prepared.created.data.states,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    "Electron P1: import preview/merge -> create -> edit/save -> guard -> rename -> stale revision -> cancel -> reopen passed",
  );
} finally {
  if (app && !evidence.passed) {
    const failedPage = app.windows()[0];
    if (failedPage) {
      console.error("P1 failure screen:", await failedPage.locator("body").innerText().catch(() => "unavailable"));
      await failedPage.screenshot({ path: "artifacts/electron-p1-failure.png", fullPage: true }).catch(() => undefined);
    }
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => undefined);
  }
  if (app) await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
