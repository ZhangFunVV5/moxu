import test from "node:test";
import assert from "node:assert/strict";
import { zipSync, unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import MarkdownIt from "markdown-it";
import {
  bodyFormatOf,
  bookFileSchema,
  type BookMetadata,
  type ChapterFile,
} from "../src/shared/book";
import { defaultFormatOptions } from "../src/shared/format-options";
import { buildEpub } from "../src/core/format/epub/export";
import {
  assembleEpubChapters,
  buildEpubImportPreview,
  parseEpub,
} from "../src/core/import/epub/parse";
import { EpubError } from "../src/core/import/epub/epub-error";
import { convertXhtml } from "../src/core/import/epub/xhtml";
import { parseXml } from "../src/core/import/epub/xml";
import { proposeTask } from "../src/agent/tasks/task-proposal";
import { pipelineStartSchema } from "../src/shared/pipeline-contracts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xhtml(body: string, title = "章节"): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>${xml(title)}</title></head>
<body>${body}</body>
</html>`;
}

interface TocItem {
  label: string;
  href: string;
}

interface FixtureOptions {
  version?: "2" | "3";
  title?: string;
  language?: string;
  authors?: string[];
  docs: Record<string, string>;
  /** 相对 OPF 目录的容器路径，顺序即 spine 阅读顺序。 */
  spine: string[];
  /** OPF 中的 href 覆盖（用于 URL 编码测试）。 */
  hrefs?: Record<string, string>;
  nav?: TocItem[];
  ncx?: TocItem[];
  extraMeta?: string;
  encryption?: string;
  extraFiles?: Record<string, string>;
  packageDir?: string;
  omitContainer?: boolean;
  omitOpf?: boolean;
}

function makeEpub(options: FixtureOptions): Uint8Array {
  const version = options.version ?? "3";
  const packageDir = options.packageDir ?? "OEBPS";
  const opfPath = `${packageDir}/content.opf`;
  const docKeys = Object.keys(options.docs);
  const items = docKeys
    .map(
      (key, index) =>
        `<item id="doc-${index}" href="${xml(options.hrefs?.[key] ?? key)}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const navItem =
    options.nav !== undefined
      ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
      : "";
  const ncxItem =
    options.ncx !== undefined
      ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
      : "";
  const spineIndex = new Map(docKeys.map((key, index) => [key, index]));
  const itemrefs = options.spine
    .map((key) => {
      const index = spineIndex.get(key);
      assert.ok(index !== undefined, `spine 引用不存在的文档：${key}`);
      return `<itemref idref="doc-${index}"/>`;
    })
    .join("\n");
  const creators = (options.authors ?? [])
    .map((author) => `<dc:creator>${xml(author)}</dc:creator>`)
    .join("");
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="pub-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:uuid:11111111-1111-4111-8111-111111111111</dc:identifier>
<dc:title>${xml(options.title ?? "测试书")}</dc:title>
<dc:language>${xml(options.language ?? "zh-CN")}</dc:language>
${creators}
${options.extraMeta ?? ""}
</metadata>
<manifest>
${navItem}
${ncxItem}
${items}
</manifest>
<spine${options.ncx ? ' toc="ncx"' : ""}>
${itemrefs}
</spine>
</package>`;
  const nav =
    options.nav !== undefined
      ? xhtml(
          `<nav epub:type="toc" id="toc"><ol>${options.nav
            .map((item) => `<li><a href="${xml(item.href)}">${xml(item.label)}</a></li>`)
            .join("")}</ol></nav>`,
          "目录",
        )
      : "";
  const ncx =
    options.ncx !== undefined
      ? `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:11111111-1111-4111-8111-111111111111"/></head>
<docTitle><text>${xml(options.title ?? "测试书")}</text></docTitle>
<navMap>${options.ncx
        .map(
          (item, index) =>
            `<navPoint id="n${index}" playOrder="${index + 1}"><navLabel><text>${xml(item.label)}</text></navLabel><content src="${xml(item.href)}"/></navPoint>`,
        )
        .join("")}</navMap>
</ncx>`
      : "";
  const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="${xml(opfPath)}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const entries: Record<string, Uint8Array> = {
    mimetype: encoder.encode("application/epub+zip"),
  };
  if (!options.omitContainer)
    entries["META-INF/container.xml"] = encoder.encode(containerXml);
  if (!options.omitOpf) entries[opfPath] = encoder.encode(opf);
  for (const [key, body] of Object.entries(options.docs))
    entries[`${packageDir}/${key}`] = encoder.encode(body);
  if (options.nav !== undefined) entries[`${packageDir}/nav.xhtml`] = encoder.encode(nav);
  if (options.ncx !== undefined) entries[`${packageDir}/toc.ncx`] = encoder.encode(ncx);
  if (options.encryption)
    entries["META-INF/encryption.xml"] = encoder.encode(options.encryption);
  for (const [path, body] of Object.entries(options.extraFiles ?? {}))
    entries[path] = encoder.encode(body);
  return zipSync(entries);
}

function parseError(bytes: Uint8Array, code: string): void {
  assert.throws(
    () => parseEpub({ fileName: "book.epub", bytes }),
    (error: unknown) =>
      error instanceof EpubError && error.code === code,
    `期望错误 ${code}`,
  );
}

test("T085 EPUB3：spine 阅读顺序优先于目录与 ZIP 顺序，章标题与正文分离", () => {
  const bytes = makeEpub({
    docs: {
      "text/a.xhtml": xhtml("<h1>第一章 灯下</h1><p>甲段。</p><h2>小节</h2><p>甲小节。</p>"),
      "text/b.xhtml": xhtml("<h1>第二章 雨夜</h1><p>乙段。</p>"),
    },
    spine: ["text/b.xhtml", "text/a.xhtml"],
    nav: [
      { label: "第一章 灯下", href: "text/a.xhtml" },
      { label: "第二章 雨夜", href: "text/b.xhtml" },
    ],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.equal(parsed.version, "3");
  assert.equal(parsed.tocSource, "nav");
  assert.deepEqual(
    parsed.segments.map((segment) => segment.title),
    ["第二章 雨夜", "第一章 灯下"],
  );
  assert.deepEqual(
    parsed.segments.map((segment) => segment.body),
    ["乙段。", "甲段。\n\n## 小节\n\n甲小节。"],
  );
  assert.equal(parsed.segments[1].headingMarkdown, "# 第一章 灯下");
  assert.equal(parsed.segments[1].sourceTitle, "第一章 灯下");
  assert.equal(parsed.metadata.title, "测试书");
  assert.equal(parsed.metadata.language, "zh-CN");
  assert.equal(parsed.spineCount, 2);
});

test("T085 单文件多章：目录锚点切分、重复导航不重复正文、缺锚点有提示", () => {
  const bytes = makeEpub({
    docs: {
      "text/all.xhtml": xhtml(
        `<section id="s1"><h2>一</h2><p>正文一。</p></section><section id="s2"><h2>二</h2><p>正文二。</p></section><section id="s3"><h2>三</h2><p>正文三。</p></section>`,
      ),
    },
    spine: ["text/all.xhtml"],
    nav: [
      { label: "一", href: "text/all.xhtml#s1" },
      { label: "一（重复）", href: "text/all.xhtml#s1" },
      { label: "二", href: "text/all.xhtml#s2" },
      { label: "不存在", href: "text/all.xhtml#missing" },
      { label: "三", href: "text/all.xhtml#s3" },
    ],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.deepEqual(
    parsed.segments.map((segment) => segment.title),
    ["一", "二", "三"],
  );
  assert.deepEqual(
    parsed.segments.map((segment) => segment.body),
    ["正文一。", "正文二。", "正文三。"],
  );
  const invalid = parsed.notices.find((notice) => notice.code === "nav-invalid-anchor");
  assert.ok(invalid);
  assert.equal(invalid.count, 1);
  assert.deepEqual(invalid.chapters, [0, 1, 2]);
  const preview = buildEpubImportPreview(parsed);
  assert.equal(preview.groups.length, 3);
  assert.deepEqual(
    preview.groups.map((group) => group.title),
    ["一", "二", "三"],
  );
});

test("T085 缺目录回退：正文文件与有效标题；EPUB2 使用 NCX；合并保留后续章标题", () => {
  const noToc = makeEpub({
    docs: {
      "text/a.xhtml": xhtml("<h1>甲</h1><p>甲正文。</p>"),
      "text/b.xhtml": xhtml("<p>无标题正文。</p>"),
    },
    spine: ["text/a.xhtml", "text/b.xhtml"],
  });
  const parsedNoToc = parseEpub({ fileName: "book.epub", bytes: noToc });
  assert.equal(parsedNoToc.tocSource, "none");
  assert.deepEqual(
    parsedNoToc.segments.map((segment) => segment.title),
    ["甲", "b"],
  );
  assert.deepEqual(
    parsedNoToc.segments.map((segment) => segment.body),
    ["甲正文。", "无标题正文。"],
  );

  const epub2 = makeEpub({
    version: "2",
    docs: {
      "text/a.xhtml": xhtml("<h2>卷一</h2><p>甲。</p>"),
      "text/b.xhtml": xhtml("<h2>卷二</h2><p>乙。</p>"),
    },
    spine: ["text/a.xhtml", "text/b.xhtml"],
    ncx: [
      { label: "卷一", href: "text/a.xhtml" },
      { label: "卷二", href: "text/b.xhtml" },
    ],
  });
  const parsed2 = parseEpub({ fileName: "book.epub", bytes: epub2 });
  assert.equal(parsed2.version, "2");
  assert.equal(parsed2.tocSource, "ncx");
  assert.deepEqual(
    parsed2.segments.map((segment) => segment.title),
    ["卷一", "卷二"],
  );
  const merged = assembleEpubChapters(parsed2, [0]);
  assert.equal(merged.chapters.length, 1);
  assert.equal(merged.chapters[0].title, "卷一");
  assert.ok(merged.chapters[0].body.includes("## 卷二"));
  assert.ok(merged.chapters[0].body.includes("乙。"));
});

test("T085 中文路径、URL 编码、实体与特殊字符", () => {
  const bytes = makeEpub({
    docs: {
      "正文/第一章.xhtml": xhtml(
        "<h1>第一章 &amp; 起点</h1><p>“引号” &lt;标签&gt; 😀 结束。</p>",
      ),
    },
    spine: ["正文/第一章.xhtml"],
    hrefs: {
      "正文/第一章.xhtml":
        "%E6%AD%A3%E6%96%87/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml",
    },
    nav: [
      {
        label: "第一章 & 起点",
        href: "%E6%AD%A3%E6%96%87/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml",
      },
    ],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.equal(parsed.segments.length, 1);
  assert.equal(parsed.segments[0].title, "第一章 & 起点");
  assert.equal(parsed.segments[0].body, "“引号” <标签> 😀 结束。");
});

test("T085 基础结构转换与转换提示：图片/表格/脚注/链接/注音不静默丢弃", () => {
  const bytes = makeEpub({
    docs: {
      "text/a.xhtml": xhtml(`<h2>章</h2>
<p>普通 <em>强调</em> 与 <strong>重点</strong>、<code>代码</code>。<br/>换行</p>
<p>实体&nbsp;与&mdash;保留。</p>
<ul><li>一</li><li>二</li></ul>
<blockquote><p>引用</p></blockquote>
<pre><code class="language-js">const a = 1;</code></pre>
<p><a href="https://example.com/x">外链</a> <a href="#note">内链</a> <a href="javascript:alert(1)">坏链</a></p>
<img src="a.png" alt="图"/>
<table><tr><th>甲</th><th>乙</th></tr><tr><td>1</td><td>2</td></tr></table>
<p><ruby>漢<rt>かん</rt></ruby></p>
<aside epub:type="footnote"><p>脚注</p></aside>
<script>alert(1)</script>`),
    },
    spine: ["text/a.xhtml"],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  const body = parsed.segments[0].body;
  for (const expected of [
    "*强调*",
    "**重点**",
    "`代码`",
    "\\\n",
    "- 一",
    "- 二",
    "> 引用",
    "```js",
    "const a = 1;",
    "[外链](https://example.com/x)",
    "内链",
    "坏链",
    "实体\u00a0与—保留。",
    "甲 ｜ 乙",
    "1 ｜ 2",
    "漢",
    "> 脚注",
  ])
    assert.ok(body.includes(expected), `正文缺少：${expected}`);
  assert.ok(!body.includes("javascript:"));
  assert.ok(!body.includes("alert(1)"));
  assert.ok(!body.includes("かん"));
  const codes = parsed.notices.map((notice) => notice.code);
  for (const code of [
    "image-dropped",
    "table-flattened",
    "footnote-flattened",
    "internal-link-degraded",
    "external-link-degraded",
    "ruby-flattened",
  ])
    assert.ok(codes.includes(code as never), `缺少提示：${code}`);
  const image = parsed.notices.find((notice) => notice.code === "image-dropped");
  assert.equal(image?.count, 1);
  assert.ok(image?.message.includes("1 张图片"));
});

test("T085 空锚点与块内锚点指向后续真实块", () => {
  const bytes = makeEpub({
    docs: {
      "text/all.xhtml": xhtml(
        `<a id="a"></a><h1>第一章</h1><p>正文甲。</p><a id="b"></a><h1>第二章</h1><p>正文乙。</p>`,
      ),
    },
    spine: ["text/all.xhtml"],
    nav: [
      { label: "第一章", href: "text/all.xhtml#a" },
      { label: "第二章", href: "text/all.xhtml#b" },
    ],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.deepEqual(
    parsed.segments.map(({ title, body }) => ({ title, body })),
    [
      { title: "第一章", body: "正文甲。" },
      { title: "第二章", body: "正文乙。" },
    ],
  );

  const document = parseXml(
    xhtml(
      `<h1><span id="heading">标题</span></h1><p><a id="paragraph"></a>段落。</p><section><h2 id="later">后续</h2><p><a id="nested"></a>后续正文。</p></section>`,
    ),
    "text/anchors.xhtml",
    "application/xhtml+xml",
  );
  const converted = convertXhtml(document, "text/anchors.xhtml");
  assert.equal(converted.anchors.get("heading"), 0);
  assert.equal(converted.anchors.get("paragraph"), 1);
  assert.equal(converted.anchors.get("later"), 2);
  assert.equal(converted.anchors.get("nested"), 3);
});

test("T085 XML 实体只解码一次且保留 CDATA", () => {
  const bytes = makeEpub({
    title: "&lt;书名&gt; &#65;",
    docs: {
      "text/a.xhtml": xhtml(
        `<h1>实体章</h1><p>&amp;lt;tag&amp;gt; 与 &amp;#65;、&nbsp;&mdash;。</p><p><![CDATA[正文文字 <标记>]]></p><pre><![CDATA[const value = "<tag>";]]></pre><ul><li>&amp;lt;list&amp;gt; &amp;#66; <![CDATA[以及 <标记>]]></li></ul>`,
      ),
    },
    spine: ["text/a.xhtml"],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.equal(parsed.metadata.title, "&lt;书名&gt; &#65;");
  assert.ok(
    parsed.segments[0].body.includes("\\&lt;tag\\&gt; 与 \\&#65;、\u00a0—。"),
    JSON.stringify(parsed.segments[0].body),
  );
  assert.ok(parsed.segments[0].body.includes("正文文字 <标记>"));
  assert.ok(parsed.segments[0].body.includes('const value = "<tag>";'));
  assert.ok(
    parsed.segments[0].body.includes(
      "- \\&lt;list\\&gt; \\&#66; 以及 <标记>",
    ),
  );
  const rendered = new MarkdownIt({ html: false }).render(parsed.segments[0].body);
  const visible = parseXml(
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${rendered}</body></html>`,
    "rendered.xhtml",
    "application/xhtml+xml",
  );
  const visibleText = visible.getElementsByTagName("body").item(0)?.textContent ?? "";
  assert.ok(visibleText.includes("&lt;tag&gt; 与 &#65;"));
  assert.ok(visibleText.includes("&lt;list&gt; &#66;"));
});

test("T085 列表保留行内空白、段落边界与表格转换提示", () => {
  const bytes = makeEpub({
    docs: {
      "text/a.xhtml": xhtml(
        `<h1>列表</h1><ul><li>中文<strong>重点</strong>后文</li><li><p>第一段</p><p>第二段</p></li><li>前文<table><tr><td>单元格</td></tr></table>后文</li></ul>`,
      ),
    },
    spine: ["text/a.xhtml"],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.ok(parsed.segments[0].body.includes("- 中文**重点**后文"));
  assert.ok(parsed.segments[0].body.includes("- 第一段\n\n  第二段"));
  assert.ok(
    parsed.segments[0].body.includes("- 前文\n\n  单元格\n\n  后文"),
  );
  const tableNotice = parsed.notices.find(
    (notice) => notice.code === "table-flattened",
  );
  assert.equal(tableNotice?.count, 1);
});

test("T085 导航标题与正文标题不同或超长时保留正文标题", () => {
  const navHeading = makeEpub({
    docs: {
      "text/a.xhtml": xhtml("<h2>保留的小节</h2><p>正文。</p>"),
    },
    spine: ["text/a.xhtml"],
    nav: [{ label: "第一章", href: "text/a.xhtml" }],
  });
  const parsedNav = parseEpub({ fileName: "book.epub", bytes: navHeading });
  assert.equal(parsedNav.segments[0].title, "第一章");
  assert.equal(parsedNav.segments[0].body, "## 保留的小节\n\n正文。");

  const longHeading = "长".repeat(201);
  const noNav = makeEpub({
    docs: { "text/a.xhtml": xhtml(`<h2>${longHeading}</h2><p>正文。</p>`) },
    spine: ["text/a.xhtml"],
  });
  const parsedLong = parseEpub({ fileName: "book.epub", bytes: noNav });
  assert.equal(parsedLong.segments[0].title, longHeading.slice(0, 200));
  assert.equal(parsedLong.segments[0].body, `## ${longHeading}\n\n正文。`);
});

test("T085 合并没有 XHTML 标题的导航章节时保留后续章名", () => {
  const bytes = makeEpub({
    docs: {
      "text/all.xhtml": xhtml(`<p id="a">正文甲。</p><p id="b">正文乙。</p>`),
    },
    spine: ["text/all.xhtml"],
    nav: [
      { label: "第一章", href: "text/all.xhtml#a" },
      { label: "第二章", href: "text/all.xhtml#b" },
    ],
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.deepEqual(
    parsed.segments.map((segment) => segment.body),
    ["正文甲。", "正文乙。"],
  );
  const merged = assembleEpubChapters(parsed, [0]);
  assert.equal(merged.chapters[0].body, "正文甲。\n\n## 第二章\n\n正文乙。");
});

test("T085 异常：缺容器/缺 OPF/损坏 ZIP/缺 spine 资源/DRM/固定版式/纯图片/越界路径", () => {
  parseError(
    makeEpub({ docs: {}, spine: [], omitContainer: true }),
    "MISSING_CONTAINER",
  );
  parseError(
    makeEpub({ docs: {}, spine: [], omitOpf: true }),
    "MISSING_OPF",
  );
  parseError(new Uint8Array([1, 2, 3, 4]), "INVALID_ZIP");
  const missingSpineDoc = unzipSync(
    makeEpub({
      docs: { "text/a.xhtml": xhtml("<h1>甲</h1><p>正文。</p>") },
      spine: ["text/a.xhtml"],
      nav: [{ label: "甲", href: "text/a.xhtml" }],
    }),
  );
  delete missingSpineDoc["OEBPS/text/a.xhtml"];
  parseError(zipSync(missingSpineDoc), "MISSING_SPINE_RESOURCE");
  parseError(
    makeEpub({
      docs: { "text/a.xhtml": xhtml("<h1>甲</h1><p>正文。</p>") },
      spine: ["text/a.xhtml"],
      encryption: `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/><CipherData><CipherReference URI="text/a.xhtml"/></CipherData></EncryptedData></encryption>`,
    }),
    "DRM_PROTECTED",
  );
  parseError(
    makeEpub({
      docs: { "text/a.xhtml": xhtml("<h1>甲</h1><p>正文。</p>") },
      spine: ["text/a.xhtml"],
      extraMeta: `<meta property="rendition:layout">pre-paginated</meta>`,
    }),
    "FIXED_LAYOUT",
  );
  parseError(
    makeEpub({
      docs: {
        "text/a.xhtml": xhtml(`<img src="a.png" alt="图"/>`),
      },
      spine: ["text/a.xhtml"],
      nav: [{ label: "图", href: "text/a.xhtml" }],
    }),
    "NO_TEXT_CONTENT",
  );
  const zip = unzipSync(
    makeEpub({
      docs: { "text/a.xhtml": xhtml("<h1>甲</h1><p>正文。</p>") },
      spine: ["text/a.xhtml"],
    }),
  );
  zip["../evil.xhtml"] = encoder.encode(xhtml("<p>越界。</p>"));
  parseError(zipSync(zip), "UNSAFE_PATH");
});

test("T085 字体混淆放行：仅指向字体的 encryption.xml 不判定为 DRM", () => {
  const bytes = makeEpub({
    docs: { "text/a.xhtml": xhtml("<h1>甲</h1><p>正文。</p>") },
    spine: ["text/a.xhtml"],
    extraFiles: { "OEBPS/fonts/book.ttf": "font" },
    encryption: `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OEBPS/fonts/book.ttf"/></CipherData></EncryptedData></encryption>`,
  });
  const parsed = parseEpub({ fileName: "book.epub", bytes });
  assert.equal(parsed.segments.length, 1);
  assert.ok(parsed.notices.some((notice) => notice.code === "fonts-obfuscated-ignored"));
});

function chapter(
  order: number,
  title: string,
  body: string,
  kind: ChapterFile["kind"] = "chapter",
): ChapterFile {
  return {
    schemaVersion: 1,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    chapterId: `c${order}`,
    order,
    kind,
    title: { current: title, source: title },
    body,
    blocks: [],
    bodyRevision: 1,
    bodyHash: "0".repeat(64),
    titleRevision: 1,
    createdAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
  };
}

const metadata: BookMetadata = {
  title: "测试 & 书",
  language: "zh-CN",
  authors: ["甲", "乙"],
};

test("T087 EPUB3 导出：mimetype 首项不压缩、OPF/nav/XHTML 合法、元数据与章序正确", () => {
  const chapters = [
    chapter(
      0,
      "第一章",
      "第一段。\n\n## 小节\n\n**重点**与[外链](https://example.com/a)。\n\n- 列表\n\n> 引用\n\n![图](img/a.png)\n\n[内部](#x)",
    ),
    chapter(1, "第二章", "第二段。", "frontmatter"),
  ];
  const built = buildEpub({
    chapters,
    bodyFormat: "markdown",
    options: { ...defaultFormatOptions, headingTemplate: "第{number}章 {title}" },
    metadata,
    identifier: "urn:uuid:22222222-2222-4222-8222-222222222222",
    modifiedAt: new Date("2026-11-10T00:00:00.000Z"),
  });
  assert.ok(built.bytes instanceof Uint8Array);
  const view = new DataView(
    built.bytes.buffer,
    built.bytes.byteOffset,
    built.bytes.byteLength,
  );
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(8, true), 0, "mimetype 必须 stored");
  assert.equal(decoder.decode(built.bytes.slice(30, 30 + 8)), "mimetype");
  const files = unzipSync(built.bytes);
  assert.equal(decoder.decode(files.mimetype), "application/epub+zip");
  assert.equal(Object.keys(files)[0], "mimetype");
  assert.ok(files["META-INF/container.xml"]);
  assert.ok(files["OEBPS/content.opf"]);
  assert.ok(files["OEBPS/nav.xhtml"]);
  assert.ok(files["OEBPS/style.css"]);
  assert.ok(files["OEBPS/text/chapter-001.xhtml"]);
  assert.ok(files["OEBPS/text/chapter-002.xhtml"]);

  const parse = (name: string) =>
    new DOMParser({ onError: () => undefined }).parseFromString(
      decoder.decode(files[name]),
      "application/xml",
    );
  const opf = parse("OEBPS/content.opf");
  const text = (name: string) => {
    const all = opf.getElementsByTagName(name);
    return all.item(0)?.textContent ?? "";
  };
  assert.equal(text("dc:title"), "测试 & 书");
  assert.equal(text("dc:language"), "zh-CN");
  assert.equal(text("dc:identifier"), "urn:uuid:22222222-2222-4222-8222-222222222222");
  assert.equal(text("dc:creator"), "甲");
  assert.equal(
    opf.getElementsByTagName("meta").item(0)?.textContent,
    "2026-11-10T00:00:00Z",
  );
  const spine = opf.getElementsByTagName("itemref");
  assert.equal(spine.length, 2);
  assert.equal(spine.item(0)?.getAttribute("idref"), "chapter-1");
  assert.equal(spine.item(1)?.getAttribute("idref"), "chapter-2");
  const navItem = [...opf.getElementsByTagName("item")].find(
    (item) => item.getAttribute("properties") === "nav",
  );
  assert.equal(navItem?.getAttribute("href"), "nav.xhtml");

  const nav = parse("OEBPS/nav.xhtml");
  const links = nav.getElementsByTagName("a");
  assert.equal(links.length, 2);
  assert.equal(links.item(0)?.textContent, "第1章 第一章");
  assert.equal(links.item(1)?.textContent, "第2章 第二章");

  const first = parse("OEBPS/text/chapter-001.xhtml");
  assert.equal(first.getElementsByTagName("h1").item(0)?.textContent, "第1章 第一章");
  const html = decoder.decode(files["OEBPS/text/chapter-001.xhtml"]);
  assert.ok(html.includes("<strong>重点</strong>"));
  assert.ok(html.includes("<ul>"));
  assert.ok(html.includes("<blockquote>"));
  assert.ok(html.includes('<a href="https://example.com/a">外链</a>'));
  assert.ok(html.includes("<span>内部</span>"));
  assert.ok(!html.includes('href="#x"'));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("图"));
  assert.ok(built.warnings.some((warning) => warning.includes("图片")));
  assert.ok(built.warnings.some((warning) => warning.includes("链接")));

  const second = decoder.decode(files["OEBPS/text/chapter-002.xhtml"]);
  assert.ok(!second.includes("<h1"));
  assert.ok(second.includes("第二段。"));
  assert.ok(built.previewHtml.includes("EPUB 预览"));
  assert.ok(built.previewHtml.includes("第1章 第一章"));
});

test("T087 选章导出与回环：导出后再解析，章节标题与正文规范化一致", () => {
  const chapters = [
    chapter(0, "一", "第一段。"),
    chapter(1, "二", "第二段。\n\n第三段。"),
    chapter(2, "三", "第三段。"),
  ];
  const built = buildEpub({
    chapters: [chapters[1]],
    bodyFormat: "txt",
    options: defaultFormatOptions,
    metadata,
    identifier: "urn:uuid:33333333-3333-4333-8333-333333333333",
    modifiedAt: new Date("2026-11-10T00:00:00.000Z"),
  });
  const files = unzipSync(built.bytes);
  assert.equal(Object.keys(files).filter((name) => name.endsWith(".xhtml")).length, 2);
  assert.equal(built.chapters.length, 1);
  assert.equal(built.chapters[0].title, "二");
  const parsed = parseEpub({ fileName: "roundtrip.epub", bytes: built.bytes });
  assert.equal(parsed.segments.length, 1);
  assert.equal(parsed.segments[0].title, "二");
  assert.equal(parsed.segments[0].body, "第二段。\n\n第三段。");
});

test("T089 组合流程合同与自然语言：EPUB 输出、元数据快照、否定不误判", () => {
  const request = pipelineStartSchema.parse({
    chapterIds: ["c1"],
    format: {
      options: defaultFormatOptions,
      outputFormat: "epub",
      metadata,
    },
    export: true,
  });
  assert.equal(request.format?.outputFormat, "epub");
  assert.equal(request.format?.metadata?.title, "测试 & 书");
  assert.equal(
    pipelineStartSchema.safeParse({
      chapterIds: ["c1"],
      format: { options: defaultFormatOptions, outputFormat: "pdf" },
    }).success,
    false,
  );
  const proposal = proposeTask("导出 EPUB", ["c1"]);
  assert.equal(proposal.kind, "ready");
  if (proposal.kind === "ready") {
    assert.equal(proposal.request.format?.outputFormat, "epub");
    assert.equal(proposal.request.export, true);
  }
  const negated = proposeTask("排版导出 TXT，不要 EPUB", ["c1"]);
  assert.equal(negated.kind, "ready");
  if (negated.kind === "ready") assert.equal(negated.request.format?.outputFormat, "txt");
  assert.equal(proposeTask("上传 EPUB 文件", ["c1"]).kind, "clarification");
});

test("T084 旧工作区兼容：缺 bodyFormat/metadata 时按来源格式回退", () => {
  const oldBook = {
    schemaVersion: 1,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    bookTitle: "旧书",
    format: "markdown",
    chapterOrder: ["c1"],
    source: {
      fileName: "a.md",
      byteLength: 3,
      sha256: "a".repeat(64),
      encoding: "utf-8",
      eol: "lf",
      copy: "source/a.md",
    },
    importSettings: {
      splitMode: "auto",
      paragraphMode: "line",
      headingLevel: 0,
      boundaries: [0],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const parsed = bookFileSchema.parse(oldBook);
  assert.equal(bodyFormatOf(parsed), "markdown");
  const epubBook = bookFileSchema.parse({
    ...oldBook,
    format: "epub",
    bodyFormat: "markdown",
    source: {
      fileName: "a.epub",
      byteLength: 3,
      sha256: "a".repeat(64),
      copy: "source/a.epub",
    },
    metadata: { language: "zh" },
    importInfo: {
      kind: "epub",
      version: "3",
      tocSource: "nav",
      spineCount: 1,
      notices: [],
    },
  });
  assert.equal(bodyFormatOf(epubBook), "markdown");
  assert.equal(epubBook.source.encoding, undefined);
});
