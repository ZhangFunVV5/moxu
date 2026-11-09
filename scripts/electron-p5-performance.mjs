import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
const root = await mkdtemp(path.join(process.cwd(), ".tmp-p5-performance-"));
const fixture = path.join(root, "合成长书.txt");
const paragraph =
  "清晨的风吹过河岸，行人沿着石阶缓缓走向集市。书院的窗前摆着旧纸与灯盏，记录着这一日平静而普通的生活。远处的钟声响起，船夫收好绳索，等待同行的人带来新的消息。";
const text = Array.from(
  { length: 24 },
  (_, i) =>
    `第${i + 1}章 合成章节${i + 1}\n${Array.from({ length: 135 }, (_, p) => `段落${p + 1}：${paragraph}`).join("\n")}\n`,
).join("\n");
assert.ok(text.length >= 200000);
await writeFile(fixture, text, "utf8");
const sourceHash = createHash("sha256").update(text).digest("hex");
const evidence = {
  passed: false,
  fixture: {
    chapters: 24,
    utf16Characters: text.length,
    utf8Bytes: Buffer.byteLength(text),
    sourceSha256: sourceHash,
    synthetic: true,
  },
  modelCalls: 0,
  phases: [],
  capacityLimit:
    "单次24章、约27万字符的合成TXT观察；不代表海量书籍、真实模型吞吐或其他硬件性能保证。",
  environment: { platform: process.platform, node: process.version },
  error: undefined,
};
let app, page;
async function memory() {
  return page.evaluate(() => ({
    jsHeap: performance.memory
      ? {
          usedBytes: performance.memory.usedJSHeapSize,
          totalBytes: performance.memory.totalJSHeapSize,
          limitBytes: performance.memory.jsHeapSizeLimit,
        }
      : null,
  }));
}
async function measure(name, fn) {
  await page.evaluate(() => {
    window.__perfFrames = { last: performance.now(), gaps: [] };
  });
  const start = performance.now();
  const result = await fn();
  const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
  await page.waitForTimeout(120);
  const frames = await page.evaluate(() => {
    const gaps = window.__perfFrames.gaps;
    return {
      heartbeatCount: gaps.length,
      maxFrameGapMs: gaps.length ? Math.max(...gaps) : null,
      framesOver50Ms: gaps.filter((x) => x > 50).length,
    };
  });
  const mem = await memory();
  evidence.phases.push({
    name,
    elapsedMs,
    heartbeatIncludesSettleMs: 120,
    ...frames,
    ...mem,
  });
  return result;
}
async function until(fn) {
  for (let n = 0; n < 300; n++) {
    if (await fn()) return;
    await page.waitForTimeout(50);
  }
  throw Error("condition timeout");
}
try {
  const env = {
    ...process.env,
    BOOK_WORKBENCH_ROOT: path.join(root, "books"),
    BOOK_WORKBENCH_TEST_SOURCE: fixture,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    args: [
      ".",
      "--no-sandbox",
      `--user-data-dir=${path.join(root, "user-data")}`,
    ],
    env,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    window.__perfFrames = { last: performance.now(), gaps: [] };
    function tick(now) {
      const state = window.__perfFrames;
      state.gaps.push(now - state.last);
      state.last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  evidence.environment.electron = await app.evaluate(
    () => process.versions.electron,
  );
  await measure("import-preview-create-display", async () => {
    await page.getByRole("button", { name: "导入书籍", exact: true }).click();
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await page.waitForSelector(".bb-book-name");
    await page.waitForSelector(".cm-content");
  });
  const workspace = await page.evaluate(() => window.desktop.workspace.state());
  assert.ok(workspace.ok);
  const ids = workspace.data.chapterOrder;
  assert.equal(ids.length, 24);
  const chapter = await page.evaluate(
    (id) => window.desktop.chapters.get({ chapterId: id }),
    ids[0],
  );
  assert.ok(chapter.ok);
  evidence.fixture.chapterCharacters = chapter.data.body.length;
  await measure("editor-input", async () => {
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await editor.press("Control+End");
    await editor.press("End");
    await editor.pressSequentially("性能验证输入。", { delay: 15 });
    await page
      .getByRole("button", { name: "保存正文", exact: true })
      .waitFor({ state: "visible" });
  });
  await measure("editor-save", async () => {
    await page.getByRole("button", { name: "保存正文", exact: true }).click();
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.chapters.get({ chapterId: id }),
        ids[0],
      );
      return r.ok && r.data.body.includes("性能验证输入。");
    });
  });
  const options = {
    headingTemplate: "{title}",
    indent: "fullwidth",
    customPrefix: "",
    paragraphBlankLines: 1,
    headingBlankLinesBefore: 1,
    headingBlankLinesAfter: 1,
    trimTrailingWhitespace: true,
    eol: "lf",
    encoding: "utf8",
    paragraphMode: "line",
  };
  const preview = await measure("whole-book-format-preview", () =>
    page.evaluate(
      async ({ ids, options }) =>
        window.desktop.format.preview({
          chapterIds: ids,
          options,
          outputFormat: "txt",
        }),
      { ids, options },
    ),
  );
  assert.ok(preview.ok, JSON.stringify(preview));
  evidence.outputCharacters = preview.data.text.length;
  const target = path.join(root, "long-book-export.txt");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, target);
  const exported = await measure("whole-book-export", () =>
    page.evaluate(
      (token) => window.desktop.format.export({ token }),
      preview.data.token,
    ),
  );
  assert.ok(exported.ok);
  assert.equal(exported.data.cancelled, false);
  const output = await readFile(target, "utf8");
  assert.equal(output, preview.data.text);
  assert.ok(output.includes("性能验证输入。"));
  assert.equal(
    createHash("sha256")
      .update(await readFile(fixture))
      .digest("hex"),
    sourceHash,
  );
  evidence.processMemory = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((p) => ({ type: p.type, memory: p.memory })),
  );
  evidence.memoryNotes =
    "Electron process memory values are KiB; performance.memory JS heap values are bytes and may be rounded by Chromium.";
  evidence.outputSha256 = createHash("sha256").update(output).digest("hex");
  evidence.passed = true;
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/electron-p5-performance.json",
    JSON.stringify(evidence, null, 2),
  );
}
console.log(JSON.stringify(evidence, null, 2));
