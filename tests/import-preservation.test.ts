import test from "node:test";
import assert from "node:assert/strict";
import {
  assembleImportChapters,
  buildImportPreview,
  type ImportOptions,
} from "../src/core/import/import-pipeline";
import type { BookFormat } from "../src/shared/book";
import { hashBody } from "../src/core/text/hash";

const options: ImportOptions = {
  encoding: "utf-8",
  splitMode: "auto",
  paragraphMode: "line",
  headingLevel: 0,
};

function assemble(text: string, format: BookFormat, splitMode = options.splitMode) {
  return assembleImportChapters(
    { fileName: "source", format, bytes: new TextEncoder().encode(text) },
    { ...options, splitMode },
    [0],
  );
}

test("导入无标题正文和整篇一章均保留首行", () => {
  for (const format of ["txt", "markdown"] as const) {
    for (const text of ["唯一一行正文", "首行正文\n第二行正文", "第一段正文\n\n第二段正文"]) {
      for (const splitMode of ["auto", "single"] as const) {
        const result = assemble(text, format, splitMode);
        assert.equal(result.chapters[0].body, text);
        assert.equal(result.preview.segments[0].charCount, [...text].length);
      }
    }
    const text = format === "txt" ? "第一章 标题\n正文" : "# 标题\n正文";
    assert.equal(assemble(text, format, "single").chapters[0].body, text);
    assert.equal(assemble(text, format).chapters[0].body, "正文");
  }
});

test("Markdown Setext 完整标题进入元数据，合并后续章节保留原始标题", () => {
  for (const title of ["第一章", "第一章\n标题续行"]) {
    const result = assemble(`${title}\n=====\n正文`, "markdown");
    assert.equal(result.chapters[0].sourceTitle, title);
    assert.equal(result.chapters[0].body, "正文");
    assert.equal(result.preview.segments[0].excerpt, "正文");
  }
  const result = assemble("第一章\n=====\n甲\n\n第二章\n=====\n乙", "markdown");
  assert.equal(result.chapters[0].body, "甲\n\n第二章\n=====\n乙");
});

test("Markdown 超过元数据长度的标题保留原文，200 字标题完整移动", () => {
  for (const marker of ["atx", "setext"] as const) {
    for (const length of [200, 201]) {
      const title = "题".repeat(length);
      const text = marker === "atx" ? `# ${title}\n正文` : `${title}\n=====\n正文`;
      const result = assemble(text, "markdown");
      assert.equal(result.chapters[0].sourceTitle, title.slice(0, 200));
      assert.equal(result.chapters[0].body, length === 200 ? "正文" : text);
    }
  }
});

test("合并预览与正式组装共享字数、摘要、hash，包含后续标题与换行", () => {
  for (const format of ["txt", "markdown"] as const) {
    const text = format === "txt"
      ? "第一章 起点\n甲正文\n\n第二章 终点\n乙正文\n第三章\n丙正文"
      : "第一章 起点\n=====\n甲正文\n\n第二章\n标题续行\n=====\n乙正文\n第三章\n=====\n丙正文";
    const source = { fileName: "source", format, bytes: new TextEncoder().encode(text) };
    for (const boundaries of [[0], [0, 2], [0, 1, 2]]) {
      const preview = buildImportPreview(source, options, boundaries);
      const assembled = assembleImportChapters(source, options, boundaries);
      assert.equal(preview.groups.length, assembled.chapters.length);
      preview.groups.forEach((group, index) => {
        const body = assembled.chapters[index].body;
        assert.equal(group.charCount, [...body].length);
        assert.equal(group.excerpt, body.replace(/\s+/g, " ").trim());
        assert.equal(group.bodyHash, hashBody(body));
      });
    }
    assert.throws(() => buildImportPreview(source, options, [1]), /首个分章边界/);
  }
});
