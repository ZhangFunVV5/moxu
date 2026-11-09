import test from "node:test";
import assert from "node:assert/strict";
import { deriveBlocks } from "../src/core/text/structure";
import { hashBody } from "../src/core/text/hash";
import {
  buildChapterChunks,
  chunkCoverageProblems,
} from "../src/core/proofread/chapter-chunker";
import {
  repeatedParagraphTexts,
  scanTargetRules,
} from "../src/core/proofread/rule-scanner";

function chapter(body: string) {
  return {
    chapterId: "ch1",
    baseBodyHash: hashBody(body),
    body,
    blocks: deriveBlocks("txt", body, "line"),
  };
}

test("T047 分块覆盖完整、目标不重叠、只读邻接固定", () => {
  const body = ["第一段。", "第二段。", "第三段。", "第四段。", "第五段。"]
    .join("\n");
  const input = chapter(body);
  const targets = buildChapterChunks({
    ...input,
    budget: { maxChars: 8, maxParagraphs: 1, contextParagraphs: 1 },
  });
  assert.equal(targets.length, 5);
  assert.deepEqual(chunkCoverageProblems(input.blocks, targets), []);
  assert.deepEqual(targets.map((target) => target.blockId), ["b1", "b2", "b3", "b4", "b5"]);
  assert.deepEqual(targets[1].readOnlyBefore.map((item) => item.paragraphId), ["p1"]);
  assert.deepEqual(targets[1].readOnlyAfter.map((item) => item.paragraphId), ["p3"]);
  // 目标文本只来自目标区间，不包含只读上下文。
  assert.equal(targets[1].targets[0].text, "第二段。");
});

test("T047 超长段落按句界切成段落内区间，坐标基点仍是整段", () => {
  const sentence = "这是一个很长的句子，用于测试切分。";
  const long = sentence.repeat(30);
  const input = chapter(long);
  const targets = buildChapterChunks({
    ...input,
    budget: { maxChars: 80, maxParagraphs: 5, contextParagraphs: 1 },
  });
  assert.ok(targets.length > 1);
  assert.deepEqual(chunkCoverageProblems(input.blocks, targets), []);
  for (const target of targets) {
    assert.ok(target.targets[0].end <= long.length);
    assert.equal(
      long.slice(target.targets[0].start, target.targets[0].end),
      target.targets[0].text,
    );
  }
  assert.equal(targets[0].targets[0].start, 0);
  assert.equal(targets.at(-1)!.targets[0].end, long.length);
  // 除首尾块外，同段前后余文作为只读上下文出现。
  assert.ok(targets[1].readOnlyBefore.some((item) => item.paragraphId === "p1"));
});

test("T047 覆盖校验能发现漏块、重叠和空章", () => {
  const body = "第一段。\n第二段。";
  const input = chapter(body);
  const targets = buildChapterChunks({
    ...input,
    budget: { maxChars: 100, maxParagraphs: 5, contextParagraphs: 0 },
  });
  assert.deepEqual(chunkCoverageProblems(input.blocks, targets), []);
  const missing = structuredClone(targets);
  missing[0].targets = missing[0].targets.filter((range) => range.paragraphId !== "p2");
  assert.ok(chunkCoverageProblems(input.blocks, missing).some((problem) => problem.includes("没有目标块")));
  const overlap = structuredClone(targets);
  overlap.push({
    blockId: "b9",
    targets: [{ paragraphId: "p1", start: 0, end: 3, text: "第一段" }],
    readOnlyBefore: [],
    readOnlyAfter: [],
    inputHash: "a".repeat(64),
  });
  assert.ok(chunkCoverageProblems(input.blocks, overlap).some((problem) => problem.includes("重叠")));
  const empty = chapter("");
  assert.deepEqual(
    buildChapterChunks({
      ...empty,
      budget: { maxChars: 100, maxParagraphs: 5, contextParagraphs: 0 },
    }),
    [],
  );
});

test("P3 超长段落及相邻长段的只读上下文受预算约束", () => {
  const input = chapter("长句😀。".repeat(5000) + "\n" + "相邻段😀。".repeat(5000));
  const targets = buildChapterChunks({
    ...input,
    budget: { maxChars: 200, maxParagraphs: 1, contextParagraphs: 1 },
  });
  assert.deepEqual(chunkCoverageProblems(input.blocks, targets), []);
  for (const target of targets) {
    for (const context of [target.readOnlyBefore, target.readOnlyAfter]) {
      assert.ok(context.reduce((sum, item) => sum + item.text.length, 0) <= 200);
      assert.ok(context.every(item => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(item.text)));
    }
  }
  const withoutContext = buildChapterChunks({
    ...input,
    budget: { maxChars: 200, maxParagraphs: 1, contextParagraphs: 0 },
  });
  assert.ok(withoutContext.every(target => target.readOnlyBefore.length === 0 && target.readOnlyAfter.length === 0));
});

test("P3 人物对白中的收藏引导和故事网址不产生规则删除候选", () => {
  for (const text of [
    "书生说道：“请记得收藏这枚玉佩。”",
    "掌柜笑道：“欢迎关注小店，今日全场五折！”",
    "他读出纸上的字：“请收藏本站，最新地址 https://story.example.com。”",
  ]) {
    assert.deepEqual(scanTargetRules({
      paragraphId: "p1", paragraphText: text, targetStart: 0,
      targetEnd: text.length, glossary: [],
    }), []);
  }
});

test("T046 广告规则只提候选：推广网址、站点页眉、下载引导与重复推广行", () => {
  const ad = "最新地址：https://promo.example.com/txt 请收藏本站";
  const hit = scanTargetRules({
    paragraphId: "p1",
    paragraphText: ad,
    targetStart: 0,
    targetEnd: ad.length,
    glossary: [],
  });
  assert.ok(hit.length > 0);
  const whole = hit.find((item) => item.candidate.after === "");
  assert.ok(whole);
  assert.equal(whole!.candidate.before, ad);

  const header = "本章未完，请点击下一页继续阅读，更新最快。";
  assert.ok(
    scanTargetRules({
      paragraphId: "p1",
      paragraphText: header,
      targetStart: 0,
      targetEnd: header.length,
      glossary: [],
    }).some((item) => item.ruleId === "site-header-footer"),
  );

  const repeated = "请收藏本站最新域名";
  const repeatedSet = repeatedParagraphTexts([{ text: repeated }, { text: repeated }]);
  assert.ok(repeatedSet.has(repeated));
  assert.ok(
    scanTargetRules({
      paragraphId: "p1",
      paragraphText: repeated,
      targetStart: 0,
      targetEnd: repeated.length,
      glossary: [],
      repeatedTexts: repeatedSet,
    }).some((item) => item.ruleId === "repeated-promo-line"),
  );
});

test("T046 重复诗句、故事内网址与专名不被规则误删", () => {
  const poem = "床前明月光";
  const repeatedSet = repeatedParagraphTexts([{ text: poem }, { text: poem }]);
  assert.deepEqual(
    scanTargetRules({
      paragraphId: "p1",
      paragraphText: poem,
      targetStart: 0,
      targetEnd: poem.length,
      glossary: [],
      repeatedTexts: repeatedSet,
    }),
    [],
  );
  const storyUrl = "沈舟打开 www.example.com 查资料。";
  assert.deepEqual(
    scanTargetRules({
      paragraphId: "p1",
      paragraphText: storyUrl,
      targetStart: 0,
      targetEnd: storyUrl.length,
      glossary: ["沈舟"],
    }),
    [],
  );
  // 长段落里的广告句只删命中片段，不整段删除；专名出现在被删片段时保护。
  const protectedAd = "沈舟说：这是本站最新地址请收藏，然后继续赶路。";
  const hits = scanTargetRules({
    paragraphId: "p1",
    paragraphText: protectedAd,
    targetStart: 0,
    targetEnd: protectedAd.length,
    glossary: ["沈舟"],
  });
  assert.ok(hits.every((item) => item.candidate.before !== protectedAd));
  assert.ok(hits.every((item) => !item.candidate.before.includes("沈舟")));
});
