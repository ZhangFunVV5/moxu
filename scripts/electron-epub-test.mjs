import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { unzipSync, zipSync } from "fflate";

/**
 * EPUB 场景验收：导入预览（元数据/转换提示/合并/改名）→ 创建 → 编辑保存 →
 * EPUB 预览冻结 → 导出 → 过期拦截与刷新 → 重开 → 窄窗口。
 * 样本为本脚本自建的最小 EPUB 3，可合法分发。
 */
const base = path.join(process.cwd(), ".tmp-epub-electron");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const sourceDir = path.join(root, "中文 路径");
const fixture = path.join(sourceDir, "长夜 书.epub");
const booksRoot = path.join(root, "books");
const userData = path.join(root, "user-data");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const esc = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const xhtml = (body, title = "章节") =>
  `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN"><head><title>${esc(title)}</title></head><body>${body}</body></html>`;
const docs = {
  "text/c1.xhtml": xhtml(
    `<h1>第一章 灯下</h1><p>雨落在青石板上。</p><p><em>灯</em>还亮着。</p>`,
  ),
  "text/c2.xhtml": xhtml(`<h1>第二章 旧信</h1><p>信封泛黄。</p><img src="letter.png" alt="信"/>`),
  "text/c3.xhtml": xhtml(`<h1>第三章 清晨</h1><p>天亮了。</p>`),
};
const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:44444444-4444-4444-8444-444444444444</dc:identifier>
<dc:title>长夜</dc:title>
<dc:language>zh-CN</dc:language>
<dc:creator>作者甲</dc:creator>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>
<item id="c3" href="text/c3.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine>
</package>`;
const nav = xhtml(
  `<nav epub:type="toc"><ol><li><a href="text/c1.xhtml">第一章 灯下</a></li><li><a href="text/c2.xhtml">第二章 旧信</a></li><li><a href="text/c3.xhtml">第三章 清晨</a></li></ol></nav>`,
  "目录",
);
const container = `<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const epubBytes = zipSync({
  mimetype: encoder.encode("application/epub+zip"),
  "META-INF/container.xml": encoder.encode(container),
  "OEBPS/content.opf": encoder.encode(opf),
  "OEBPS/nav.xhtml": encoder.encode(nav),
  "OEBPS/text/c1.xhtml": encoder.encode(docs["text/c1.xhtml"]),
  "OEBPS/text/c2.xhtml": encoder.encode(docs["text/c2.xhtml"]),
  "OEBPS/text/c3.xhtml": encoder.encode(docs["text/c3.xhtml"]),
});
await mkdir(sourceDir, { recursive: true });
await writeFile(fixture, epubBytes);
const sourceHash = createHash("sha256").update(epubBytes).digest("hex");

const env = {
  ...process.env,
  BOOK_WORKBENCH_ROOT: booksRoot,
  BOOK_WORKBENCH_TEST_SOURCE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;

let app = null;
async function launch() {
  const instance = await electron.launch({
    args: [".", "--no-sandbox", `--user-data-dir=${userData}`],
    env,
  });
  const page = await instance.firstWindow();
  await page.waitForSelector(".bb-shell");
  return { instance, page };
}
async function waitEnabled(page, label) {
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === name && !button.disabled,
      ),
    label,
  );
}
const evidence = {
  passed: false,
  widths: [375, 768, 1024, 1440],
  imported: false,
  previewWroteNothing: false,
  metadataAndNotices: false,
  mergedAndRenamed: false,
  sourcePreserved: false,
  editedAndSaved: false,
  epubPreview: false,
  metadataEdited: false,
  exported: false,
  staleRejected: false,
  pipelineEpub: false,
  reopened: false,
  cancelWroteNothing: false,
  narrowLayout: false,
  keyboardEscape: false,
};

try {
  let page;
  ({ instance: app, page } = await launch());
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.getByRole("heading", { name: "导入书籍" }).waitFor();
  await page.getByTestId("epub-meta").waitFor();
  assert.match(
    await page.getByTestId("epub-meta").innerText(),
    /EPUB 版本：3/,
  );
  assert.equal(await page.locator(".bb-import-chapter").count(), 3);
  assert.equal(await page.locator(".bb-import-notices").count(), 1);
  assert.match(await page.locator(".bb-import-notices").innerText(), /图片/);
  assert.equal(await page.getByLabel("编码").count(), 0);
  assert.equal(await page.getByLabel("分章方式").count(), 0);
  evidence.metadataAndNotices = true;
  await page.screenshot({ path: "artifacts/electron-epub-import.png", fullPage: true });

  await page.getByRole("button", { name: "整书一章" }).click();
  await page.waitForFunction(() =>
    document.querySelector(".bb-import-summary")?.textContent?.includes("共 1 章"),
  );
  assert.equal(await page.locator(".bb-import-chapter").count(), 1);
  await page.getByRole("button", { name: "重置分章" }).click();
  await page.waitForFunction(() =>
    document.querySelector(".bb-import-summary")?.textContent?.includes("共 3 章"),
  );
  await page
    .locator(".bb-import-chapter")
    .nth(2)
    .getByRole("button", { name: "并入上一章" })
    .click();
  await page.waitForFunction(() =>
    document.querySelector(".bb-import-summary")?.textContent?.includes("共 2 章"),
  );
  assert.equal(await page.locator(".bb-import-chapter").count(), 2);
  await page
    .locator(".bb-import-chapter input")
    .first()
    .fill("改名的第一章");
  await page.getByLabel("书名").fill("EPUB 验收书");
  evidence.mergedAndRenamed = true;
  assert.deepEqual(await readdir(booksRoot).catch(() => []), []);
  evidence.previewWroteNothing = true;

  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  await page.waitForFunction(
    () => document.querySelector(".bb-book-name")?.textContent === "EPUB 验收书",
  );
  evidence.imported = true;
  const workspace = path.join(booksRoot, (await readdir(booksRoot))[0]);
  const book = JSON.parse(await readFile(path.join(workspace, "book.json"), "utf8"));
  assert.equal(book.format, "epub");
  assert.equal(book.bodyFormat, "markdown");
  assert.equal(book.chapterOrder.length, 2);
  assert.equal(book.source.sha256, sourceHash);
  assert.equal(book.source.encoding, undefined);
  assert.equal(book.importInfo.version, "3");
  assert.equal(book.importInfo.tocSource, "nav");
  assert.ok(book.importInfo.notices.some((notice) => notice.code === "image-dropped"));
  assert.equal(
    createHash("sha256").update(await readFile(fixture)).digest("hex"),
    sourceHash,
  );
  evidence.sourcePreserved = true;
  assert.match(
    await page.locator(".bb-book .bb-sub").innerText(),
    /EPUB · Markdown 正文/,
  );

  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("新增一段。");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-state"]')?.textContent === "未保存",
  );
  await page.keyboard.press("Control+S");
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-state"]')?.textContent === "已保存",
  );
  evidence.editedAndSaved = true;

  await page.getByRole("button", { name: "排版", exact: true }).click();
  await page.getByLabel("任务范围").selectOption("all");
  await page.getByLabel("输出格式").selectOption("epub");
  await page.locator("iframe.bb-epub-preview").waitFor();
  const frame = page.frameLocator("iframe.bb-epub-preview");
  await frame.locator("h1").first().waitFor();
  assert.match(await frame.locator("body").innerText(), /改名的第一章/);
  assert.match(await frame.locator("body").innerText(), /新增一段。/);
  assert.equal(await page.locator(".bb-epub-toc li").count(), 2);
  assert.equal(await page.getByLabel("书名（导出元数据）").inputValue(), "EPUB 验收书");
  assert.equal(await page.getByLabel("语言").inputValue(), "zh-CN");
  assert.equal(await page.getByLabel("作者（可选，逗号分隔）").inputValue(), "作者甲");
  evidence.epubPreview = true;
  await waitEnabled(page, "导出");

  await page.getByLabel("书名（导出元数据）").fill("导出验收书");
  await frame.getByText("导出验收书").first().waitFor({ timeout: 15000 });
  evidence.metadataEdited = true;
  await waitEnabled(page, "导出");

  const output = path.join(root, "验收导出.epub");
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    },
    output,
  );
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByTestId("message").filter({ hasText: "已导出" }).waitFor();
  const exported = await readFile(output);
  const files = unzipSync(exported);
  assert.equal(decoder.decode(files.mimetype), "application/epub+zip");
  assert.equal(Object.keys(files)[0], "mimetype");
  assert.match(decoder.decode(files["OEBPS/content.opf"]), /<dc:title>导出验收书<\/dc:title>/);
  assert.ok(files["OEBPS/text/chapter-001.xhtml"]);
  assert.ok(files["OEBPS/text/chapter-002.xhtml"]);
  await writeFile("artifacts/electron-epub-export.epub", exported);
  evidence.exported = true;

  await page.getByRole("button", { name: "精校", exact: true }).click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("过期后新增。");
  await page.getByRole("button", { name: "保存正文" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-state"]')?.textContent === "已保存",
  );
  await page.getByRole("button", { name: "排版", exact: true }).click();
  await page
    .getByText("正文、标题、范围、元数据或规则已变化", { exact: false })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "导出", exact: true }).isDisabled(),
    true,
  );
  evidence.staleRejected = true;
  await page.getByRole("button", { name: "刷新预览" }).click();
  await waitEnabled(page, "导出");
  const refreshed = path.join(root, "刷新导出.epub");
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    },
    refreshed,
  );
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByTestId("message").filter({ hasText: "已导出" }).waitFor();
  const refreshedFiles = unzipSync(await readFile(refreshed));
  assert.match(
    decoder.decode(refreshedFiles["OEBPS/text/chapter-001.xhtml"]),
    /过期后新增。/,
  );

  const pipelineOutput = path.join(root, "组合流程.epub");
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    },
    pipelineOutput,
  );
  const pipeline = page.locator(".bb-pipeline");
  await pipeline.getByText("组合流程 · 当前范围", { exact: false }).click();
  await pipeline.getByLabel("精校").uncheck();
  await pipeline.getByLabel("成稿格式").selectOption("epub");
  await page.getByTestId("pipeline-start").click();
  await pipeline
    .getByTestId("pipeline-record")
    .filter({ hasText: "已完成" })
    .waitFor({ timeout: 30000 });
  const pipelineFiles = unzipSync(await readFile(pipelineOutput));
  assert.match(
    decoder.decode(pipelineFiles["OEBPS/content.opf"]),
    /<dc:title>EPUB 验收书<\/dc:title>/,
  );
  const pipelineName = (
    await readdir(path.join(workspace, "tasks"))
  ).find((name) => name.startsWith("pipeline-"));
  const pipelineRecord = JSON.parse(
    await readFile(path.join(workspace, "tasks", pipelineName), "utf8"),
  );
  assert.equal(pipelineRecord.request.format.outputFormat, "epub");
  assert.equal(pipelineRecord.request.format.metadata.title, "EPUB 验收书");
  assert.deepEqual(pipelineRecord.request.format.metadata.authors, ["作者甲"]);
  evidence.pipelineEpub = true;

  for (const width of evidence.widths) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow ${width}`,
    );
    await page.screenshot({
      path: `artifacts/electron-epub-${width}.png`,
      fullPage: true,
    });
  }
  evidence.narrowLayout = true;

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  await app.close();
  app = null;
  ({ instance: app, page } = await launch());
  await page.waitForSelector(".bb-book-name");
  await page.waitForFunction(
    () => document.querySelector(".bb-book-name")?.textContent === "EPUB 验收书",
  );
  assert.match(await page.locator(".bb-book .bb-sub").innerText(), /EPUB/);
  assert.match(await page.locator(".bb-paper h2").innerText(), /改名的第一章/);
  assert.match(await page.locator(".cm-content").innerText(), /过期后新增。/);
  evidence.reopened = true;

  const before = (await readdir(booksRoot)).sort();
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.getByRole("heading", { name: "导入书籍" }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForSelector("dialog.bb-import", { state: "detached" });
  assert.deepEqual((await readdir(booksRoot)).sort(), before);
  evidence.keyboardEscape = true;
  evidence.cancelWroteNothing = true;

  evidence.passed = true;
  await writeFile(
    "artifacts/electron-epub-test.json",
    JSON.stringify({ ...evidence, checkedAt: new Date().toISOString() }, null, 2),
  );
  console.log(
    "Electron EPUB: import/preview/merge/rename/create/edit/format/export/stale/reopen/Esc/narrow passed",
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
