import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { dialog } from "electron";
import { WorkspaceService } from "../src/main/services/workspace-service";
import { FormatService } from "../src/main/services/format-service";
import { openWorkspaceAt } from "../src/core/workspace/book-store";
import { defaultFormatOptions } from "../src/shared/format-options";
import { makeEpub, xhtml, encoder, decoder } from "./epub-fixtures";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "epub-service-"));
}

function formatService(workspace: WorkspaceService): FormatService {
  return new FormatService(workspace, async () =>
    ({
      complete: async () => ({ content: "", calls: [], finishReason: "stop" }),
    }) as never,
  );
}

function mockSaveDialog(target: string): void {
  (
    dialog as unknown as {
      showSaveDialog: (
        options: unknown,
      ) => Promise<{ canceled: boolean; filePath?: string }>;
    }
  ).showSaveDialog = async () => ({ canceled: false, filePath: target });
}

test("T086/T088 EPUB 导入预览不写盘、入库保留原件与元数据、预览冻结与导出", async (t) => {
  const root = await tempRoot();
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const booksRoot = path.join(root, "books");
  const sourcePath = path.join(root, "中文 路径", "测试 书.epub");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const epubBytes = makeEpub({
    title: "来源书名",
    language: "zh-CN",
    authors: ["作者甲"],
    docs: {
      "text/a.xhtml": xhtml("<h1>第一章</h1><p>正文一。</p><img src=\"a.png\"/>"),
      "text/b.xhtml": xhtml("<h1>第二章</h1><p>正文二。</p>"),
    },
    spine: ["text/a.xhtml", "text/b.xhtml"],
    nav: [
      { label: "第一章", href: "text/a.xhtml" },
      { label: "第二章", href: "text/b.xhtml" },
    ],
  });
  await writeFile(sourcePath, epubBytes);
  const originalHash = createHash("sha256").update(epubBytes).digest("hex");

  const workspace = new WorkspaceService({
    recentFile: path.join(root, "recent.json"),
    booksRoot,
    testSource: sourcePath,
  });
  const source = await workspace.chooseSource(null);
  assert.ok(source);
  assert.equal(source.format, "epub");
  assert.equal(source.byteLength, epubBytes.byteLength);

  const previewResponse = await workspace.preview({
    kind: "epub",
    token: source.token,
  });
  assert.equal(previewResponse.kind, "epub");
  assert.deepEqual(await readdir(booksRoot).catch(() => []), []);
  if (previewResponse.kind !== "epub") return;
  assert.equal(previewResponse.metadata.title, "来源书名");
  assert.deepEqual(previewResponse.metadata.authors, ["作者甲"]);
  assert.equal(previewResponse.version, "3");
  assert.equal(previewResponse.tocSource, "nav");
  assert.equal(previewResponse.groups.length, 2);
  assert.equal(previewResponse.segments[0].title, "第一章");
  assert.ok(
    previewResponse.notices.some((notice) => notice.code === "image-dropped"),
  );

  const mergedPreview = await workspace.preview({
    kind: "epub",
    token: source.token,
    boundaries: [0],
  });
  if (mergedPreview.kind !== "epub") throw new Error("预览类型错误");
  assert.equal(mergedPreview.groups.length, 1);
  assert.ok(mergedPreview.groups[0].title.length > 0);

  const info = await workspace.create({
    previewToken: previewResponse.previewToken,
    bookTitle: "导入后的书名",
    boundaries: [0, 1],
    titles: { 0: "改名的第一章" },
  });
  assert.equal(info.format, "epub");
  assert.equal(info.bodyFormat, "markdown");
  assert.equal(info.chapters.length, 2);
  assert.equal(info.chapters[0].title, "改名的第一章");
  assert.equal(info.metadata.language, "zh-CN");
  assert.deepEqual(info.metadata.authors, ["作者甲"]);
  assert.equal(info.importInfo?.version, "3");
  assert.equal(info.importInfo?.tocSource, "nav");
  assert.ok(
    info.importInfo?.notices.some((notice) => notice.code === "image-dropped"),
  );

  const bookJson = JSON.parse(
    await readFile(path.join(info.root, "book.json"), "utf8"),
  );
  assert.equal(bookJson.format, "epub");
  assert.equal(bookJson.bodyFormat, "markdown");
  assert.equal(bookJson.source.sha256, originalHash);
  assert.equal(bookJson.source.encoding, undefined);
  assert.equal(bookJson.source.eol, undefined);
  const copy = await readFile(path.join(info.root, bookJson.source.copy));
  assert.equal(createHash("sha256").update(copy).digest("hex"), originalHash);

  const reopened = await openWorkspaceAt(info.root);
  assert.equal(reopened.book.format, "epub");
  assert.equal(reopened.chapterFiles[0].title.current, "改名的第一章");
  assert.ok(reopened.chapterFiles[0].body.includes("正文一。"));
  assert.ok(!reopened.chapterFiles[0].body.includes("第一章"));
  assert.ok(reopened.chapterFiles[1].body.includes("正文二。"));

  const format = formatService(workspace);
  const exportMetadata = {
    title: "导出书名",
    language: "zh-CN",
    authors: ["导出作者"],
  };
  const epubPreview = await format.preview({
    chapterIds: [info.chapters[0].chapterId, info.chapters[1].chapterId],
    options: defaultFormatOptions,
    outputFormat: "epub",
    metadata: exportMetadata,
  });
  assert.equal(epubPreview.text, "");
  assert.ok(epubPreview.epub);
  assert.ok(epubPreview.epub?.html.includes("导出书名"));
  assert.equal(epubPreview.epub?.chapters.length, 2);
  assert.equal(epubPreview.inputFingerprint.length, 64);
  assert.equal((await format.status(epubPreview.token)).stale, false);

  const target = path.join(root, "out", "book.epub");
  mockSaveDialog(target);
  const exported = await format.export(epubPreview.token, null);
  assert.equal(exported.cancelled, false);
  assert.equal(exported.path, target);
  const bytes = await readFile(target);
  const files = unzipSync(bytes);
  assert.equal(decoder.decode(files.mimetype), "application/epub+zip");
  assert.equal(Object.keys(files)[0], "mimetype");
  const opf = decoder.decode(files["OEBPS/content.opf"]);
  assert.ok(opf.includes("<dc:title>导出书名</dc:title>"));
  assert.ok(opf.includes("<dc:creator>导出作者</dc:creator>"));
  assert.ok(files["OEBPS/text/chapter-001.xhtml"]);
  assert.ok(files["OEBPS/text/chapter-002.xhtml"]);

  const saved = await workspace.saveChapter({
    chapterId: info.chapters[0].chapterId,
    baseRevision: info.chapters[0].bodyRevision,
    body: `${reopened.chapterFiles[0].body}\n\n新增一段。`,
  });
  assert.ok(saved.body.includes("新增一段。"));
  assert.equal((await format.status(epubPreview.token)).stale, true);
  await assert.rejects(
    () => format.export(epubPreview.token, null),
    (error: unknown) =>
      (error as { code?: string }).code === "STALE_PREVIEW",
  );
});

test("T086/T088 TXT 旧路径回归：预览/入库/排版导出保持原行为", async (t) => {
  const root = await tempRoot();
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const sourcePath = path.join(root, "书.txt");
  await writeFile(
    sourcePath,
    "第一章 开始\n正文一。\n\n第二章 继续\n正文二。\n",
    "utf8",
  );
  const workspace = new WorkspaceService({
    recentFile: path.join(root, "recent.json"),
    booksRoot: path.join(root, "books"),
    testSource: sourcePath,
  });
  const source = await workspace.chooseSource(null);
  assert.ok(source);
  assert.equal(source.format, "txt");
  const preview = await workspace.preview({
    kind: "text",
    token: source.token,
    encoding: null,
    splitMode: "auto",
    paragraphMode: "line",
    headingLevel: 0,
  });
  if (preview.kind !== "text") throw new Error("应为文本预览");
  assert.equal(preview.format, "txt");
  assert.equal(preview.groups.length, 2);
  const info = await workspace.create({
    previewToken: preview.previewToken,
    bookTitle: "文本书",
    boundaries: preview.groups.map((group) => group.startSegment),
  });
  assert.equal(info.format, "txt");
  assert.equal(info.bodyFormat, "txt");
  assert.equal(info.source.encoding, "utf-8");
  assert.equal(info.chapters.length, 2);
  assert.equal(info.metadata.language, "zh");

  const format = formatService(workspace);
  const textPreview = await format.preview({
    chapterIds: [info.chapters[0].chapterId],
    options: { ...defaultFormatOptions, headingTemplate: "第{number}章 {title}" },
    outputFormat: "txt",
  });
  assert.ok(textPreview.text.includes("第1章 第一章 开始"));
  assert.ok(textPreview.text.includes("正文一。"));
  assert.equal(textPreview.epub, undefined);
  const target = path.join(root, "out", "book.txt");
  mockSaveDialog(target);
  const exported = await format.export(textPreview.token, null);
  assert.equal(exported.cancelled, false);
  assert.ok((await readFile(target, "utf8")).includes("正文一。"));
});
