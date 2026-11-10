import { _electron as electron } from "playwright";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

/**
 * 阅读引擎互操作核验：在 Electron/Chromium 页面中加载 epub.js 0.3.93，
 * 解析导出的 EPUB，核对目录标题、spine 顺序、逐章正文与选章输出。
 * 运行前需准备 artifacts/tools/{jszip.min.js,epub.min.js} 与两个样本 EPUB；
 * 这只是阅读引擎互操作检查，不能替代桌面阅读器的视觉验收。
 */
const root = await mkdtemp(path.join(process.cwd(), ".tmp-reader-check-"));
const env = { ...process.env, BOOK_WORKBENCH_ROOT: path.join(root, "books") };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [".", "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`],
  env,
});
try {
  const page = await app.firstWindow();
  await page.waitForSelector(".bb-shell");
  await page.addScriptTag({ path: path.join("artifacts", "tools", "jszip.min.js") });
  await page.addScriptTag({ path: path.join("artifacts", "tools", "epub.min.js") });
  const full = (await readFile("artifacts/epub-full.epub")).toString("base64");
  const selected = (await readFile("artifacts/epub-selected.epub")).toString("base64");
  const result = await page.evaluate(async ({ full, selected }) => {
    const bufferOf = (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return bytes.buffer;
    };
    async function inspect(b64) {
      const book = window.ePub(bufferOf(b64));
      await book.ready;
      const navigation = await book.loaded.navigation;
      const titles = [];
      const walk = (items) => {
        for (const item of items) {
          titles.push(String(item.label).trim());
          if (item.subitems?.length) walk(item.subitems);
        }
      };
      walk(navigation.toc);
      const spine = [];
      for (const section of book.spine.spineItems) {
        const doc = await section.load(book.load.bind(book));
        const body = doc.querySelector("body") ?? doc.documentElement;
        spine.push({
          href: section.href,
          heading: (doc.querySelector("h1")?.textContent ?? "").trim(),
          text: (body?.textContent ?? "").replace(/\s+/g, " ").trim(),
        });
        section.unload();
      }
      let jumped = "";
      const second = navigation.toc.find((item) =>
        String(item.label).includes("第二章"),
      );
      if (second) {
        const section = book.spine.get(second.href);
        if (section) {
          const doc = await section.load(book.load.bind(book));
          const body = doc.querySelector("body") ?? doc.documentElement;
          jumped = (body?.textContent ?? "").replace(/\s+/g, " ").trim();
          section.unload();
        }
      }
      return {
        titles,
        spine,
        jumped,
        metadataTitle: book.packaging?.metadata?.title ?? "",
      };
    }
    return { full: await inspect(full), selected: await inspect(selected) };
  }, { full, selected });

  assert.deepEqual(result.full.titles, [
    "第1章 第一章 灯下",
    "第2章 第二章 雨夜",
    "第3章 第三章 清晨",
  ]);
  assert.equal(result.full.spine.length, 3);
  assert.match(result.full.spine[0].text, /雨落在青石板上/);
  assert.match(result.full.spine[1].text, /夜色更深了/);
  assert.match(result.full.spine[2].text, /天亮了/);
  assert.match(result.full.jumped, /夜色更深了/);
  assert.equal(result.full.metadataTitle, "长夜");
  assert.deepEqual(result.selected.titles, ["第2章 第二章 雨夜"]);
  assert.equal(result.selected.spine.length, 1);
  assert.match(result.selected.spine[0].text, /夜色更深了/);
  assert.ok(!result.selected.spine[0].text.includes("雨落在"));
  assert.match(result.selected.spine[0].heading, /第二章 雨夜/);

  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/epub-reader-check.json",
    JSON.stringify(
      {
        engine: "epub.js 0.3.93 / JSZip 3.10.1 in Electron Chromium",
        result,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log("EPUB reader engine check passed", JSON.stringify(result.full.titles));
} finally {
  await app.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
