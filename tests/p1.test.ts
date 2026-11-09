import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SCHEMA_VERSION,
  countCodePoints,
  type BookFormat,
  type ImportSettings,
} from "../src/shared/book";
import {
  hashBody,
  sha256Hex,
} from "../src/core/text/hash";
import {
  deriveBlocks,
  blockStructureProblems,
} from "../src/core/text/structure";
import {
  chapterOffsetToParagraphOffset,
  lineColumnToOffset,
  normalizeNewlines,
  offsetToLineColumn,
  paragraphOffsetToChapterOffset,
  splitsSurrogatePair,
} from "../src/shared/text-offsets";
import {
  decodeBuffer,
  decodeWith,
  DecodeError,
} from "../src/core/import/encoding";
import { parseTxtChapters } from "../src/core/import/txt-parser";
import { parseMarkdownChapters } from "../src/core/import/markdown-parser";
import {
  assembleImportChapters,
  buildImportPreview,
  type ImportOptions,
} from "../src/core/import/import-pipeline";
import { segmentBody } from "../src/core/import/segments";
import {
  AtomicWriteError,
  isTemporaryFileName,
  nodeFs,
  WriteQueue,
  writeFileAtomic,
} from "../src/core/workspace/atomic-file";
import {
  createWorkspace,
  openWorkspaceAt,
  readBookFile,
  readChapterFile,
  renameChapter,
  saveChapterBody,
  workspacePaths,
  WorkspaceError,
} from "../src/core/workspace/book-store";
import {
  buildTaskSpec,
  loadTaskSpec,
  persistTaskSpec,
  TaskSpecError,
} from "../src/agent/tasks/task-types";
import {
  TaskStore,
  TaskStoreError,
  artifactRelativePath,
} from "../src/agent/tasks/task-store";
import { dispatch, profile } from "../src/agent/tools/dispatcher";

const NOW = () => new Date("2026-11-08T00:00:00.000Z");
const HASH = (letter: string) => letter.repeat(64);

async function tempRoot(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "book-p1-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

interface ChapterInput {
  title: string;
  body: string;
  kind?: "chapter" | "volume" | "frontmatter" | "extra";
}

async function makeWorkspace(
  root: string,
  chapters: ChapterInput[],
  options: {
    format?: BookFormat;
    bytes?: Uint8Array;
    importSettings?: Partial<ImportSettings>;
    bookTitle?: string;
  } = {},
) {
  const format = options.format ?? "txt";
  const settings: ImportSettings = {
    splitMode: "auto",
    paragraphMode: "line",
    headingLevel: 0,
    boundaries: chapters.map((_chapter, index) => index),
    ...options.importSettings,
  };
  return createWorkspace({
    root,
    bookTitle: options.bookTitle ?? "测试作品",
    format,
    source: {
      fileName: format === "txt" ? "book.txt" : "book.md",
      bytes: options.bytes ?? new TextEncoder().encode("原文快照"),
      encoding: "utf-8",
      eol: "lf",
    },
    importSettings: settings,
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      body: chapter.body,
      kind: chapter.kind ?? "chapter",
    })),
    now: NOW,
  });
}

// ---------------------------------------------------------------- T013

test("T013 章节模型：同名章节不同 ID、章序稳定、标题不改正文 hash、非法结构明确报错", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "作品 A");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "甲段。\n\n乙段。" },
    { title: "第一章", body: "另一个同名章节。" },
    { title: "卷末", body: "卷末正文。", kind: "volume" },
  ]);
  assert.equal(new Set(workspace.chapterFiles.map((c) => c.chapterId)).size, 3);
  assert.notEqual(
    workspace.chapterFiles[0].chapterId,
    workspace.chapterFiles[1].chapterId,
  );
  assert.deepEqual(
    workspace.chapterFiles.map((c) => c.title.current),
    ["第一章", "第一章", "卷末"],
  );
  assert.deepEqual(
    workspace.book.chapterOrder,
    workspace.chapterFiles.map((c) => c.chapterId),
  );
  assert.equal(workspace.book.schemaVersion, SCHEMA_VERSION);

  const target = workspace.chapterFiles[0];
  const beforeHash = target.bodyHash;
  const beforeRevision = target.bodyRevision;
  const renamed = await renameChapter(workspaceRoot, target.chapterId, "改名后的章");
  assert.equal(renamed.title.current, "改名后的章");
  assert.equal(renamed.title.source, "第一章");
  assert.equal(renamed.bodyHash, beforeHash);
  assert.equal(renamed.bodyRevision, beforeRevision);
  assert.equal(renamed.titleRevision, target.titleRevision + 1);

  const reopened = await openWorkspaceAt(workspaceRoot);
  assert.deepEqual(
    reopened.chapterFiles.map((c) => c.title.current),
    ["改名后的章", "第一章", "卷末"],
  );

  const bookFile = workspacePaths(workspaceRoot).book;
  const originalBook = await fsp.readFile(bookFile, "utf8");
  await fsp.writeFile(bookFile, JSON.stringify({ schemaVersion: 99 }));
  await expectCode(openWorkspaceAt(workspaceRoot), "INVALID_BOOK");
  await fsp.writeFile(bookFile, originalBook);

  const chapterFile = workspacePaths(workspaceRoot).chapter(
    workspace.chapterFiles[1].chapterId,
  );
  const originalChapter = await fsp.readFile(chapterFile, "utf8");
  const corrupted = JSON.parse(originalChapter);
  corrupted.bodyHash = HASH("0");
  await fsp.writeFile(chapterFile, JSON.stringify(corrupted));
  await expectCode(openWorkspaceAt(workspaceRoot), "INVALID_CHAPTER");
  await fsp.writeFile(chapterFile, originalChapter);
  await openWorkspaceAt(workspaceRoot);
});

// ---------------------------------------------------------------- T014

test("T014 原子写入：写入/替换失败保留旧文件，临时文件不被当成正文", async (t) => {
  const root = await tempRoot(t);
  const file = path.join(root, "state.json");
  await fsp.writeFile(file, "旧内容");

  const writeFailing = {
    ...nodeFs,
    writeFile: async () => {
      throw new Error("磁盘写入失败");
    },
  };
  await assert.rejects(
    writeFileAtomic(file, "新内容", { fs: writeFailing }),
    (error: unknown) =>
      error instanceof AtomicWriteError && error.code === "WRITE_FAILED",
  );
  assert.equal(await fsp.readFile(file, "utf8"), "旧内容");
  assert.deepEqual(
    (await fsp.readdir(root)).filter(isTemporaryFileName),
    [],
  );

  const renameFailing = {
    ...nodeFs,
    rename: async () => {
      throw new Error("替换失败");
    },
  };
  await assert.rejects(
    writeFileAtomic(file, "新内容", { fs: renameFailing }),
    (error: unknown) =>
      error instanceof AtomicWriteError && error.code === "RENAME_FAILED",
  );
  assert.equal(await fsp.readFile(file, "utf8"), "旧内容");
  assert.deepEqual(
    (await fsp.readdir(root)).filter(isTemporaryFileName),
    [],
  );

  await writeFileAtomic(file, "新内容");
  assert.equal(await fsp.readFile(file, "utf8"), "新内容");

  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "正文。" },
  ]);
  await fsp.writeFile(
    path.join(workspacePaths(workspaceRoot).chapters, "x.tmp-deadbeef.json"),
    "{ broken",
  );
  const reopened = await openWorkspaceAt(workspaceRoot);
  assert.equal(reopened.chapterFiles.length, 1);
  assert.equal(workspace.book.chapterOrder.length, 1);

  // 建库失败不得留下可打开的“半成品作品”目录。
  const halfRoot = path.join(root, "half-created");
  const failingCreateFs = {
    ...nodeFs,
    writeFile: async (file: string, data: string | Uint8Array) => {
      if (file.includes("book.json")) throw new Error("book.json 写入失败");
      await nodeFs.writeFile(file, data);
    },
  };
  await expectCode(
    createWorkspace({
      root: halfRoot,
      bookTitle: "半成品",
      format: "txt",
      source: {
        fileName: "半成品.txt",
        bytes: new TextEncoder().encode("来源"),
        encoding: "utf-8",
        eol: "lf",
      },
      importSettings: {
        splitMode: "auto",
        paragraphMode: "line",
        headingLevel: 0,
        boundaries: [0],
      },
      chapters: [{ title: "第一章", kind: "chapter", body: "正文。" }],
      fs: failingCreateFs,
    }),
    "WRITE_FAILED",
  );
  await assert.rejects(fsp.stat(halfRoot));
  assert.deepEqual(
    (await fsp.readdir(root)).filter((name) => name.includes("half-created")),
    [],
  );
});

test("T014 写队列：同章并发保存只成功一个，旧修订不能覆盖新正文", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "原始正文。" },
    { title: "第二章", body: "第二章正文。" },
  ]);
  const [first, second] = workspace.chapterFiles;
  const results = await Promise.allSettled([
    saveChapterBody(workspaceRoot, first.chapterId, "版本甲", first.bodyRevision),
    saveChapterBody(workspaceRoot, first.chapterId, "版本乙", first.bodyRevision),
  ]);
  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<typeof first> =>
      result.status === "fulfilled",
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0].reason as WorkspaceError).code, "VERSION_CONFLICT");
  const winner = fulfilled[0].value.body;
  assert.ok(winner === "版本甲" || winner === "版本乙");

  const reloaded = await readChapterFile(
    workspaceRoot,
    workspace.book,
    first.chapterId,
  );
  assert.equal(reloaded.body, winner);
  assert.equal(reloaded.bodyRevision, first.bodyRevision + 1);

  await expectCode(
    saveChapterBody(workspaceRoot, first.chapterId, "过期写入", first.bodyRevision),
    "VERSION_CONFLICT",
  );
  assert.equal(
    (await readChapterFile(workspaceRoot, workspace.book, first.chapterId)).body,
    winner,
  );

  const parallel = await Promise.all([
    saveChapterBody(workspaceRoot, first.chapterId, "并行甲", reloaded.bodyRevision),
    saveChapterBody(workspaceRoot, second.chapterId, "并行乙", second.bodyRevision),
  ]);
  assert.equal(parallel.length, 2);
  assert.equal(parallel[1].body, "并行乙");

  const queue = new WriteQueue();
  const order: number[] = [];
  await Promise.all([
    queue.run("k", async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(2);
    }),
    queue.run("k", async () => {
      order.push(3);
    }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

// ---------------------------------------------------------------- T015

test("T015 工作区目录：中文与空格路径、重复创建拒绝、非工作区有明确错误", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "中文 目录", "我的 作品");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "序章", body: "序章正文。" },
    { title: "第一章", body: "第一章正文。" },
  ]);
  assert.ok(workspaceRoot.includes("中文 目录"));
  for (const dir of [
    "source",
    "chapters",
    "edits",
    "generated",
    "tasks",
    "presets",
    "output",
  ]) {
    const stat = await fsp.stat(path.join(workspaceRoot, dir));
    assert.ok(stat.isDirectory(), dir);
  }
  await expectCode(
    makeWorkspace(workspaceRoot, [{ title: "重复", body: "正文。" }]),
    "WORKSPACE_EXISTS",
  );

  const empty = path.join(root, "not-a-workspace");
  await fsp.mkdir(empty, { recursive: true });
  await expectCode(openWorkspaceAt(empty), "WORKSPACE_NOT_FOUND");
  await expectCode(openWorkspaceAt(path.join(root, "missing")), "WORKSPACE_NOT_FOUND");

  const reopened = await openWorkspaceAt(workspaceRoot);
  assert.equal(reopened.book.bookTitle, "测试作品");
  const sourceFile = await fsp.readFile(
    path.join(workspaceRoot, reopened.book.source.copy),
  );
  assert.equal(sha256Hex(sourceFile), reopened.book.source.sha256);
});

// ---------------------------------------------------------------- T016

test("T016 字节解码：UTF-8、BOM、UTF-16、GB18030、显式编码与二进制拒绝", () => {
  const chinese = Buffer.from("中文😀\n第二行", "utf8");
  const utf8 = decodeBuffer(chinese);
  assert.equal(utf8.encoding, "utf-8");
  assert.equal(utf8.text, "中文😀\n第二行");
  assert.equal(utf8.requiresChoice, false);

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), chinese]);
  const utf8Bom = decodeBuffer(bom);
  assert.equal(utf8Bom.encoding, "utf-8");
  assert.equal(utf8Bom.bom, true);
  assert.equal(utf8Bom.text.startsWith("\uFEFF"), false);

  const utf16le = Buffer.from([
    0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65, 0x0a, 0x00, 0x41, 0x00,
  ]);
  assert.equal(decodeBuffer(utf16le).text, "中文\nA");
  const utf16be = Buffer.from([
    0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87, 0x00, 0x0a, 0x00, 0x41,
  ]);
  assert.equal(decodeBuffer(utf16be).encoding, "utf-16be");
  assert.equal(decodeBuffer(utf16be).text, "中文\nA");

  const gb = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  const gbDecoded = decodeBuffer(gb);
  assert.equal(gbDecoded.encoding, "gb18030");
  assert.equal(gbDecoded.text, "中文");
  assert.equal(gbDecoded.requiresChoice, true);
  assert.ok(gbDecoded.candidates.some((c) => c.encoding === "gb18030"));
  assert.equal(decodeWith(gb, "gb18030").text, "中文");

  const crlf = decodeBuffer(Buffer.from("第一行\r\n第二行\r\n", "utf8"));
  assert.equal(crlf.eol, "crlf");
  assert.equal(crlf.text.includes("\r"), false);

  assert.throws(
    () => decodeBuffer(new Uint8Array()),
    (error: unknown) => error instanceof DecodeError && error.code === "EMPTY_FILE",
  );
  const binary = new Uint8Array(600);
  for (let i = 0; i < binary.length; i += 1) binary[i] = 0x01 + (i % 5);
  assert.throws(
    () => decodeBuffer(binary),
    (error: unknown) => error instanceof DecodeError && error.code === "BINARY_FILE",
  );
});

// ---------------------------------------------------------------- T017

test("T017 TXT 分章：标题前内容、重复章号、卷、序章、番外、CRLF 与整篇一章", () => {
  const raw = [
    "书名页第一行",
    "",
    "书名页第二段",
    "序章 起点",
    "序章正文。",
    "第一章 雨夜",
    "第一章正文。",
    "第一章 归来",
    "重复章号正文。",
    "第一卷 风起",
    "卷首说明。",
    "第二章 渡口",
    "第二章正文。",
    "番外一 旧事",
    "番外正文。",
  ].join("\r\n");
  const normalized = normalizeNewlines(raw);
  assert.equal(normalized.eol, "crlf");
  const parsed = parseTxtChapters(normalized.text, "auto");
  assert.deepEqual(
    parsed.segments.map((segment) => segment.title),
    ["标题前内容", "序章 起点", "第一章 雨夜", "第一章 归来", "第一卷 风起", "第二章 渡口", "番外一 旧事"],
  );
  assert.deepEqual(
    parsed.segments.map((segment) => segment.kind),
    ["frontmatter", "chapter", "chapter", "chapter", "volume", "chapter", "extra"],
  );
  assert.equal(
    parsed.segments.filter((segment) => segment.title === "第一章 雨夜").length,
    1,
  );
  const duplicateNumbers = parsed.segments.filter((segment) =>
    /^第一章/.test(segment.title),
  );
  assert.equal(duplicateNumbers.length, 2);
  assert.notEqual(duplicateNumbers[0].startLine, duplicateNumbers[1].startLine);

  const bodies = parsed.segments.map((segment) =>
    segmentBody(parsed.lines, segment, { dropHeading: true }),
  );
  const joined = bodies.join("\n");
  for (const line of normalized.text.split("\n")) {
    if (line.trim())
      assert.ok(
        joined.includes(line) ||
          parsed.segments.some((segment) => segment.title === line.trim()),
        line,
      );
  }
  assert.equal(bodies[1], "序章正文。");
  assert.equal(bodies[2], "第一章正文。");

  const noHeading = parseTxtChapters("只有正文。\n第二行。", "auto");
  assert.equal(noHeading.segments.length, 1);
  assert.equal(noHeading.segments[0].title, "全文");
  const single = parseTxtChapters("第一章 名称\n正文。\n第二章 名称", "single");
  assert.equal(single.segments.length, 1);

  const notHeadings = parseTxtChapters(
    "第一章雨夜就开始奔跑。\n第一章节的内容还在继续。\n第一章 真正的标题\n正文。",
    "auto",
  );
  assert.equal(notHeadings.segments.length, 2);
  assert.equal(notHeadings.segments[0].kind, "frontmatter");
  assert.equal(notHeadings.segments[1].title, "第一章 真正的标题");

  const emptyTitle = parseTxtChapters("第12章\n\n第13章\n内容。", "auto");
  assert.deepEqual(
    emptyTitle.segments.map((segment) => segment.title),
    ["第12章", "第13章"],
  );
});

// ---------------------------------------------------------------- T018

test("T018 Markdown：代码围栏内标题不分章，列表/链接/分隔符/引用结构保留", () => {
  const text = [
    "# 书名",
    "",
    "书名下的说明。",
    "",
    "## 第一章 起点",
    "",
    "正文 [链接](https://example.com) 与**强调**。",
    "",
    "### 场景",
    "",
    "- 列表一",
    "- 列表二",
    "",
    "---",
    "",
    "```ts",
    "# 第一章 代码里的标题",
    "const a = 1;",
    "```",
    "",
    "> ## 引用里的标题",
    "> 引用正文。",
    "",
    "## 第二章 终点",
    "",
    "结束。",
  ].join("\n");
  const parsed = parseMarkdownChapters(text, {
    splitMode: "auto",
    headingLevel: 0,
  });
  assert.equal(parsed.headingLevel, 2);
  assert.deepEqual(
    parsed.segments.map((segment) => segment.title),
    ["标题前内容", "第一章 起点", "第二章 终点"],
  );
  assert.equal(
    parsed.segments.filter((segment) => segment.title.includes("代码里的标题"))
      .length,
    0,
  );
  const body = segmentBody(parsed.lines, parsed.segments[1], {
    dropHeading: true,
  });
  assert.equal(body.startsWith("## 第一章"), false);
  assert.ok(body.includes("### 场景"));
  assert.ok(body.includes("[链接](https://example.com)"));
  assert.ok(body.includes("- 列表一"));
  assert.ok(body.includes("---"));
  assert.ok(body.includes("# 第一章 代码里的标题"));
  assert.ok(body.includes("> ## 引用里的标题"));

  const blocks = deriveBlocks("markdown", body, "line");
  const kinds = new Set(blocks.map((block) => block.kind));
  for (const kind of ["heading", "paragraph", "list", "separator", "code", "quote"])
    assert.ok(kinds.has(kind as never), kind);
  const codeBlock = blocks.find((block) => block.kind === "code");
  assert.ok(codeBlock);
  assert.ok(body.slice(codeBlock.start, codeBlock.end).includes("# 第一章 代码里的标题"));
  assert.deepEqual(blockStructureProblems(body, blocks), []);

  const single = parseMarkdownChapters(text, { splitMode: "single", headingLevel: 0 });
  assert.equal(single.segments.length, 1);
});

// ---------------------------------------------------------------- T019

test("T019 段落 ID、hash 与坐标：重载稳定、单字变化、CRLF、emoji 代理对", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const body = "第一段😀文字\n第二段";
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body },
  ]);
  const chapter = workspace.chapterFiles[0];
  assert.equal(hashBody(body), chapter.bodyHash);
  assert.deepEqual(
    chapter.blocks.map((block) => block.id),
    ["p1", "p2"],
  );
  assert.equal(chapter.blocks[0].start, 0);
  assert.equal(chapter.blocks[0].end, "第一段😀文字".length);
  assert.equal(
    body.slice(chapter.blocks[0].start, chapter.blocks[0].end),
    "第一段😀文字",
  );

  const reopened = await openWorkspaceAt(workspaceRoot);
  assert.equal(reopened.chapterFiles[0].bodyHash, chapter.bodyHash);
  assert.deepEqual(reopened.chapterFiles[0].blocks, chapter.blocks);

  const changed = await saveChapterBody(
    workspaceRoot,
    chapter.chapterId,
    body.replace("文", "闻"),
    chapter.bodyRevision,
  );
  assert.notEqual(changed.bodyHash, chapter.bodyHash);
  assert.equal(changed.bodyRevision, chapter.bodyRevision + 1);
  assert.equal(changed.blocks[0].id, "p1");

  const normalized = normalizeNewlines("甲\r\n乙\r丙");
  assert.equal(normalized.eol, "crlf");
  assert.equal(normalized.text, "甲\n乙\n丙");

  assert.equal(splitsSurrogatePair(body, 4), true);
  assert.equal(splitsSurrogatePair(body, 5), false);
  assert.equal(splitsSurrogatePair(body, 0), false);
  assert.equal(paragraphOffsetToChapterOffset(chapter.blocks[0], body, 4), null);
  assert.equal(paragraphOffsetToChapterOffset(chapter.blocks[0], body, 5), 5);
  assert.equal(
    paragraphOffsetToChapterOffset(chapter.blocks[0], body, 99),
    null,
  );
  const atSecond = chapterOffsetToParagraphOffset(chapter.blocks, 8);
  assert.equal(atSecond?.block.id, "p2");
  assert.equal(atSecond?.offsetInParagraph, 0);
  const lineColumn = offsetToLineColumn(body, 8);
  assert.deepEqual(lineColumn, { line: 1, column: 0 });
  assert.equal(lineColumnToOffset(body, lineColumn), 8);
  assert.equal(countCodePoints("中文😀"), 3);
});

// ---------------------------------------------------------------- T020

test("T020 导入预览与正式写入：预览不写盘、合并章界与标题一致、来源副本 hash", async (t) => {
  const root = await tempRoot(t);
  const original = path.join(root, "原书 文件.txt");
  const text = [
    "书名页",
    "",
    "序章 开端",
    "序章正文。",
    "第一章 相遇",
    "第一章正文。",
    "第二章 分别",
    "第二章正文。",
  ].join("\n");
  await fsp.writeFile(original, text, "utf8");
  const before = await fsp.readFile(original);

  const source = {
    fileName: path.basename(original),
    format: "txt" as const,
    bytes: new Uint8Array(before),
  };
  const options: ImportOptions = {
    encoding: null,
    splitMode: "auto",
    paragraphMode: "line",
    headingLevel: 0,
  };
  const preview = buildImportPreview(source, options);
  assert.equal(preview.encoding, "utf-8");
  assert.equal(preview.requiresChoice, false);
  assert.deepEqual(
    preview.segments.map((segment) => segment.title),
    ["标题前内容", "序章 开端", "第一章 相遇", "第二章 分别"],
  );
  assert.equal(preview.segments[1].excerpt.includes("序章 开端"), false);
  assert.deepEqual(
    await fsp.readdir(root),
    [path.basename(original)],
    "预览不得写盘",
  );

  const boundaries = [0, 2];
  const titles = { 0: "书名与序章", 2: "第一章（合并后）" };
  const assembled = assembleImportChapters(source, options, boundaries, titles);
  assert.deepEqual(
    assembled.chapters.map((chapter) => chapter.title),
    ["书名与序章", "第一章（合并后）"],
  );
  assert.ok(assembled.chapters[0].body.includes("序章正文。"));
  assert.ok(assembled.chapters[0].body.includes("书名页"));
  assert.equal(assembled.chapters[1].body.startsWith("第一章 相遇"), false);
  assert.ok(assembled.chapters[1].body.includes("第一章正文。"));

  const workspaceRoot = path.join(root, "工作区");
  const workspace = await createWorkspace({
    root: workspaceRoot,
    bookTitle: "迁移测试",
    format: "txt",
    source: {
      fileName: source.fileName,
      bytes: source.bytes,
      encoding: preview.encoding,
      eol: preview.eol,
    },
    importSettings: {
      splitMode: "auto",
      paragraphMode: "line",
      headingLevel: 0,
      boundaries,
    },
    chapters: assembled.chapters,
    now: NOW,
  });
  assert.deepEqual(
    workspace.chapterFiles.map((chapter) => chapter.title.current),
    assembled.chapters.map((chapter) => chapter.title),
  );
  assert.deepEqual(
    workspace.chapterFiles.map((chapter) => chapter.title.source),
    ["标题前内容", "第一章 相遇"],
  );
  assert.deepEqual(
    workspace.chapterFiles.map((chapter) => chapter.body),
    assembled.chapters.map((chapter) => chapter.body),
  );
  assert.deepEqual(workspace.book.importSettings.boundaries, boundaries);
  assert.equal(
    sha256Hex(await fsp.readFile(path.join(workspaceRoot, workspace.book.source.copy))),
    sha256Hex(before),
  );
  assert.deepEqual(await fsp.readFile(original), before);
  assert.equal(workspace.book.source.sha256, sha256Hex(before));
});

// ---------------------------------------------------------------- T021

test("T021 保存正文：重开一致、同内容不增修订、旧修订拒绝覆盖", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "原始正文。" },
  ]);
  const chapter = workspace.chapterFiles[0];
  const saved = await saveChapterBody(
    workspaceRoot,
    chapter.chapterId,
    "修改后的正文。\n\n第二段。",
    chapter.bodyRevision,
  );
  assert.equal(saved.bodyRevision, chapter.bodyRevision + 1);
  assert.equal(saved.body, "修改后的正文。\n\n第二段。");
  assert.deepEqual(saved.blocks.map((block) => block.id), ["p1", "p2"]);

  const reopened = await openWorkspaceAt(workspaceRoot);
  assert.equal(reopened.chapterFiles[0].body, saved.body);
  assert.equal(reopened.chapterFiles[0].bodyHash, saved.bodyHash);

  const same = await saveChapterBody(
    workspaceRoot,
    chapter.chapterId,
    saved.body,
    saved.bodyRevision,
  );
  assert.equal(same.bodyRevision, saved.bodyRevision);

  await expectCode(
    saveChapterBody(workspaceRoot, chapter.chapterId, "越权覆盖", chapter.bodyRevision),
    "VERSION_CONFLICT",
  );
  assert.equal(
    (await readChapterFile(workspaceRoot, workspace.book, chapter.chapterId)).body,
    saved.body,
  );
});

// ---------------------------------------------------------------- T022

test("T022 范围绑定：TaskSpec 章序与 hash 只含所选章，调度层拒绝范围外章节", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "甲。" },
    { title: "第二章", body: "乙。" },
    { title: "第三章", body: "丙。" },
    { title: "第四章", body: "丁。" },
  ]);
  const chosen = workspace.chapterFiles.slice(0, 3);
  const spec = buildTaskSpec({
    workspaceId: workspace.book.workspaceId,
    type: "proofread",
    chapterIds: chosen.map((chapter) => chapter.chapterId),
    inputHashes: Object.fromEntries(
      chosen.map((chapter) => [chapter.chapterId, chapter.bodyHash]),
    ),
    options: { glossary: ["沈舟"], categories: ["typo"] },
    profileVersion: "p1-test",
    now: NOW,
  });
  assert.equal(spec.chapterIds.length, 3);
  assert.equal(
    spec.chapterIds.includes(workspace.chapterFiles[3].chapterId),
    false,
  );
  assert.equal(
    Object.keys(spec.inputHashes).includes(workspace.chapterFiles[3].chapterId),
    false,
  );

  const outside = await dispatch(
    "read_sample_chapter",
    { chapterId: "c4" },
    {
      workspaceId: "sample-book",
      chapterIds: ["c1", "c2", "c3"],
      source: "gui",
      allowWrite: false,
      version: 1,
    },
    profile,
  );
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.error.code, "SCOPE_DENIED");

  const inside = await dispatch(
    "read_sample_chapter",
    { chapterId: "c2" },
    {
      workspaceId: "sample-book",
      chapterIds: ["c1", "c2", "c3"],
      source: "gui",
      allowWrite: false,
      version: 1,
    },
    profile,
  );
  assert.equal(inside.ok, true);
});

// ---------------------------------------------------------------- T023

test("T023 TaskSpec：指纹覆盖正文/词表/选项/Profile，快照不可变，伪造权限被拒绝", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "甲。" },
    { title: "第二章", body: "乙。" },
  ]);
  const ids = workspace.chapterFiles.map((chapter) => chapter.chapterId);
  const hashes = Object.fromEntries(
    workspace.chapterFiles.map((chapter) => [chapter.chapterId, chapter.bodyHash]),
  );
  const base = {
    workspaceId: workspace.book.workspaceId,
    type: "proofread" as const,
    chapterIds: ids,
    inputHashes: hashes,
    options: { glossary: ["沈舟"], categories: ["typo", "wording"] },
    profileVersion: "proofread-v1",
    modelConfigId: "model-a",
    now: NOW,
  };
  const specA = buildTaskSpec(base);
  const specB = buildTaskSpec(base);
  assert.notEqual(specA.taskId, specB.taskId);
  assert.equal(specA.inputFingerprint, specB.inputFingerprint);
  assert.deepEqual(specA.permissions, {
    source: "application",
    canWriteBody: false,
    autoApplyCategories: [],
  });

  const differentGlossary = buildTaskSpec({
    ...base,
    options: { glossary: ["沈舟", "阿鸢"], categories: ["typo", "wording"] },
  });
  const differentOptions = buildTaskSpec({
    ...base,
    options: { glossary: ["沈舟"], categories: ["typo"] },
  });
  const differentProfile = buildTaskSpec({ ...base, profileVersion: "proofread-v2" });
  const differentModel = buildTaskSpec({ ...base, modelConfigId: "model-b" });
  const differentBody = buildTaskSpec({
    ...base,
    inputHashes: { ...hashes, [ids[0]]: HASH("f") },
  });
  for (const other of [
    differentGlossary,
    differentOptions,
    differentProfile,
    differentModel,
    differentBody,
  ])
    assert.notEqual(specA.inputFingerprint, other.inputFingerprint);

  assert.throws(
    () =>
      buildTaskSpec({
        ...base,
        permissions: { source: "application", canWriteBody: true, autoApplyCategories: [] },
      } as never),
    (error: unknown) =>
      error instanceof TaskSpecError && error.code === "INVALID_INPUT",
  );
  assert.throws(
    () =>
      buildTaskSpec({
        ...base,
        chapterIds: [ids[0], ids[0]],
      }),
    (error: unknown) =>
      error instanceof TaskSpecError && error.code === "INVALID_INPUT",
  );

  const file = await persistTaskSpec(workspaceRoot, specA);
  const stored = await loadTaskSpec(workspaceRoot, specA.taskId);
  assert.deepEqual(stored, specA);
  assert.equal(await persistTaskSpec(workspaceRoot, specA), file);

  // 正文后来被编辑，旧 TaskSpec 快照必须保持原 hash 与范围。
  const changed = await saveChapterBody(
    workspaceRoot,
    ids[0],
    "任务创建后修改的正文",
    workspace.chapterFiles[0].bodyRevision,
  );
  const afterEdit = await loadTaskSpec(workspaceRoot, specA.taskId);
  assert.deepEqual(afterEdit, specA);
  assert.equal(afterEdit.inputHashes[ids[0]], hashes[ids[0]]);
  assert.notEqual(changed.bodyHash, afterEdit.inputHashes[ids[0]]);

  await expectCode(
    persistTaskSpec(
      workspaceRoot,
      { ...specA, inputFingerprint: HASH("a") },
    ),
    "IMMUTABLE_TASK_SPEC",
  );
});

// ---------------------------------------------------------------- T024

test("T024 检查点：状态转换、重启 interrupted、产物先落盘可修复、缺失产物不算完成", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "甲。" },
    { title: "第二章", body: "乙。" },
  ]);
  const [first, second] = workspace.chapterFiles;
  const spec = buildTaskSpec({
    workspaceId: workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [first.chapterId, second.chapterId],
    inputHashes: {
      [first.chapterId]: first.bodyHash,
      [second.chapterId]: second.bodyHash,
    },
    options: {},
    profileVersion: "proofread-v1",
    now: NOW,
  });

  let store = await TaskStore.create(workspaceRoot, spec, NOW);
  assert.equal(store.getCheckpoint(first.chapterId).status, "queued");
  await expectCode(
    store.enterWaitingReview(first.chapterId),
    "INVALID_TRANSITION",
  );
  await store.setState(first.chapterId, "running", { now: NOW });
  assert.equal(store.getCheckpoint(first.chapterId).attempt, 1);
  store = await TaskStore.open(workspaceRoot, spec.taskId);
  let report = await store.recover(NOW);
  assert.deepEqual(report.interrupted, [first.chapterId]);
  assert.equal(store.getCheckpoint(first.chapterId).status, "interrupted");

  await store.setState(first.chapterId, "running", { now: NOW });
  assert.equal(store.getCheckpoint(first.chapterId).attempt, 2);
  await store.writeArtifact(first.chapterId, {
    kind: "proofread-candidates",
    completedBlockIds: [],
    payload: { candidates: [] },
  });
  assert.equal(store.getCheckpoint(first.chapterId).status, "running");
  store = await TaskStore.open(workspaceRoot, spec.taskId);
  report = await store.recover(NOW);
  assert.deepEqual(report.repaired, [first.chapterId]);
  assert.equal(store.getCheckpoint(first.chapterId).status, "completed");
  assert.deepEqual(store.getCheckpoint(first.chapterId).completedBlockIds, []);
  assert.deepEqual(await store.verifyCompletedArtifacts(), {
    missing: [],
    completed: [first.chapterId],
  });

  await fsp.rm(
    path.join(
      workspaceRoot,
      "tasks",
      spec.taskId,
      artifactRelativePath(first.chapterId),
    ),
  );
  store = await TaskStore.open(workspaceRoot, spec.taskId);
  report = await store.recover(NOW);
  assert.deepEqual(report.missingArtifacts, [first.chapterId]);
  const missing = store.getCheckpoint(first.chapterId);
  assert.equal(missing.status, "failed");
  assert.equal(missing.errorCode, "ARTIFACT_MISSING");

  await store.setState(second.chapterId, "running", { now: NOW });
  await store.failChapter(second.chapterId, "MODEL_FAILED");
  assert.equal(store.getCheckpoint(second.chapterId).status, "failed");
  assert.equal(store.getCheckpoint(second.chapterId).errorCode, "MODEL_FAILED");
  assert.deepEqual(await store.verifyCompletedArtifacts(), {
    missing: [],
    completed: [],
  });
});

test("P3 后章检查与前章审阅使用不同 TaskStore 时不互相覆盖检查点", async (t) => {
  const root = path.join(await tempRoot(t), "ws");
  const workspace = await makeWorkspace(root, [
    { title: "第一章", body: "甲。" },
    { title: "第二章", body: "乙。" },
  ]);
  const [first, second] = workspace.chapterFiles;
  const spec = buildTaskSpec({
    workspaceId: workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [first.chapterId, second.chapterId],
    inputHashes: Object.fromEntries(workspace.chapterFiles.map(chapter => [chapter.chapterId, chapter.bodyHash])),
    options: {},
    profileVersion: "proofread-v1",
  });
  const runner = await TaskStore.create(root, spec);
  await runner.setState(first.chapterId, "running");
  await runner.writeArtifact(first.chapterId, { kind: "proofread-batch", completedBlockIds: ["b1"], payload: {} });
  await runner.markReviewReady(first.chapterId);
  const reviewer = await TaskStore.open(root, spec.taskId);
  await Promise.all([
    reviewer.completeChapter(first.chapterId),
    runner.setState(second.chapterId, "running"),
  ]);
  let reopened = await TaskStore.open(root, spec.taskId);
  assert.equal(reopened.getCheckpoint(first.chapterId).status, "completed");
  assert.equal(reopened.getCheckpoint(second.chapterId).status, "running");
  await Promise.all([
    reviewer.setState(first.chapterId, "waiting-review"),
    runner.cancelChapter(second.chapterId),
  ]);
  await runner.setState(second.chapterId, "running");
  reopened = await TaskStore.open(root, spec.taskId);
  assert.equal(reopened.getCheckpoint(first.chapterId).status, "waiting-review");
  assert.equal(reopened.getCheckpoint(second.chapterId).status, "running");
  assert.equal(reopened.getCheckpoint(second.chapterId).attempt, 2);
});

// ---------------------------------------------------------------- 其他一致性

test("章节标题非法输入被拒绝；正文 hash 与 block 结构在加载时交叉校验", async (t) => {
  const root = await tempRoot(t);
  const workspaceRoot = path.join(root, "ws");
  const workspace = await makeWorkspace(workspaceRoot, [
    { title: "第一章", body: "第一段。\n\n第二段。" },
  ]);
  const chapter = workspace.chapterFiles[0];
  await expectCode(renameChapter(workspaceRoot, chapter.chapterId, "   "), "INVALID_TITLE");
  await expectCode(
    renameChapter(workspaceRoot, chapter.chapterId, "标题\u0001"),
    "INVALID_TITLE",
  );

  const file = workspacePaths(workspaceRoot).chapter(chapter.chapterId);
  const original = JSON.parse(await fsp.readFile(file, "utf8"));
  const corrupted = { ...original, blocks: [{ id: "p1", kind: "paragraph", start: 0, end: 999999 }] };
  await fsp.writeFile(file, JSON.stringify(corrupted));
  await expectCode(openWorkspaceAt(workspaceRoot), "INVALID_CHAPTER");
  const book = await readBookFile(workspaceRoot);
  await expectCode(readChapterFile(workspaceRoot, book, chapter.chapterId), "INVALID_CHAPTER");
});
