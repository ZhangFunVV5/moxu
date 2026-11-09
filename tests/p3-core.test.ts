import test from "node:test";
import assert from "node:assert/strict";
import { deriveBlocks } from "../src/core/text/structure";
import { hashBody } from "../src/core/text/hash";
import {
  defaultProofreadOptions,
  ProofreadError,
  proofreadOptionsSchema,
  type CandidateValidationContext,
  type ModelEditCandidate,
} from "../src/shared/proofreading";
import { validateCandidate, validateCandidateList } from "../src/core/proofread/patch-validator";
import {
  assertNoConflicts,
  buildConflictIndex,
  candidatesConflict,
} from "../src/core/proofread/conflicts";
import { projectBody, type ProjectablePatch } from "../src/core/proofread/body-projector";
import { buildPositionMap } from "../src/core/proofread/position-map";
import { candidateFingerprint } from "../src/core/proofread/fingerprint";

const BODY = "第一段有错字。\n第二段正常。\n第三段也很正常。";
const BLOCKS = deriveBlocks("txt", BODY, "line");

function context(paragraphIndex = 0): CandidateValidationContext {
  const block = BLOCKS[paragraphIndex];
  const text = BODY.slice(block.start, block.end);
  return {
    baseBodyHash: hashBody(BODY),
    chapterId: "ch1",
    block,
    targetStart: 0,
    targetEnd: text.length,
    paragraphText: text,
    chapterBlocks: BLOCKS,
    enabledCategories: defaultProofreadOptions.categories,
  };
}

function edit(overrides: Partial<ModelEditCandidate> = {}): ModelEditCandidate {
  const ctx = context();
  return {
    paragraphId: ctx.block.id,
    before: "错字",
    after: "错词",
    category: "typo",
    reason: "错别字",
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProofreadError) return error.code;
    throw error;
  }
  return "NO_ERROR";
}

test("T034 精校选项与候选 schema：拒绝未知字段、重复类别与五种代表性样例", () => {
  assert.equal(proofreadOptionsSchema.safeParse(defaultProofreadOptions).success, true);
  assert.equal(
    proofreadOptionsSchema.safeParse({ ...defaultProofreadOptions, categories: ["typo", "typo"] }).success,
    false,
  );
  assert.equal(
    proofreadOptionsSchema.safeParse({ ...defaultProofreadOptions, path: "C:/x" }).success,
    false,
  );
  // 替换 / 插入 / 整段删除 / 零意见（空数组）/ 无变化
  const cases: Array<[Partial<ModelEditCandidate>, string | null]> = [
    [{}, null],
    [{ paragraphId: "p1", before: "", after: "补", start: 0, end: 0, category: "typo", reason: "缺字" }, null],
    [{ before: "第一段有错字。", after: "", category: "advertisement", reason: "整段广告" }, null],
    [{ before: "第一段有错字。", after: "第一段有错字。", category: "typo", reason: "没有变化" }, "NO_CHANGE"],
    [{ before: "不存在", after: "x", category: "typo", reason: "错误引句" }, "QUOTE_MISMATCH"],
  ];
  for (const [overrides, expected] of cases) {
    const result = codeOf(() => validateCandidate(edit(overrides), context()));
    assert.equal(result, expected ?? "NO_ERROR");
  }
  assert.deepEqual(validateCandidateList([], context()), []);
});

test("T035 唯一引句定位、重复引句、越界、错段、代理对与空串", () => {
  assert.equal(validateCandidate(edit(), context()).start, BODY.indexOf("错字"));
  assert.equal(
    codeOf(() =>
      validateCandidate(edit({ paragraphId: "p2" }), context()),
    ),
    "FORBIDDEN_RANGE",
  );
  assert.equal(
    codeOf(() => validateCandidate(edit({ before: "复复", after: "x" }), {
      ...context(),
      paragraphText: "复复复",
      targetStart: 0,
      targetEnd: 3,
      block: { ...context().block, end: context().block.start + 3 },
    })),
    "AMBIGUOUS_QUOTE",
  );
  assert.equal(
    codeOf(() => validateCandidate(edit({ start: 999, end: 1000, before: "" }), context())),
    "OUT_OF_RANGE",
  );
  assert.equal(
    codeOf(() => validateCandidate(edit({ start: 2 }), context())),
    "SCHEMA_INVALID",
  );
  assert.equal(
    codeOf(() => validateCandidate(edit({ before: "", after: "补" }), context())),
    "QUOTE_MISMATCH",
  );
  // emoji 代理对：a😀b，offset 2 位于高低代理之间。
  const emojiText = "a😀b";
  const emojiCtx: CandidateValidationContext = {
    ...context(),
    paragraphText: emojiText,
    targetStart: 0,
    targetEnd: emojiText.length,
    block: { id: "p1", kind: "paragraph", start: 0, end: emojiText.length },
  };
  assert.equal(
    codeOf(() =>
      validateCandidate(
        edit({ before: emojiText.slice(2, 3), after: "x", start: 2, end: 3 }),
        emojiCtx,
      ),
    ),
    "INVALID_UNICODE_BOUNDARY",
  );
  // 只读上下文超出目标区间被拒绝
  assert.equal(
    codeOf(() =>
      validateCandidate(edit({ start: 0, end: 2, before: "第一" }), {
        ...context(),
        targetStart: 3,
        targetEnd: 7,
      }),
    ),
    "FORBIDDEN_RANGE",
  );
});

test("T035 类别未启用时不可采纳；批次任一项非法则整体失败", () => {
  assert.equal(
    codeOf(() =>
      validateCandidate(edit({ category: "grammar" }), {
        ...context(),
        enabledCategories: ["typo"],
      }),
    ),
    "FORBIDDEN_RANGE",
  );
  try {
    validateCandidateList([edit(), edit({ before: "不存在" })], context());
    assert.fail("应当整批失败");
  } catch (error) {
    assert.ok(error instanceof ProofreadError);
    assert.equal(error.code, "INVALID_CANDIDATES");
    assert.deepEqual((error.data as { failures: Array<{ index: number }> }).failures.map((item) => item.index), [1]);
  }
});

const c = (patchId: string, start: number, end: number, before = "x"): {
  patchId: string;
  paragraphId: string;
  start: number;
  end: number;
  before: string;
} => ({ patchId, paragraphId: "p1", start, end, before });

test("T036 冲突：相交、同点插入、插入边界与相邻替换", () => {
  assert.equal(candidatesConflict(c("a", 1, 3), c("b", 2, 4)), true);
  assert.equal(candidatesConflict(c("a", 1, 3), c("b", 3, 5)), false, "相邻替换可共存");
  assert.equal(candidatesConflict(c("a", 2, 2, ""), c("b", 2, 2, "")), true);
  assert.equal(candidatesConflict(c("a", 2, 2, ""), c("b", 1, 3)), true, "插入落在替换内部");
  assert.equal(candidatesConflict(c("a", 1, 1, ""), c("b", 1, 3)), true, "插入恰在替换起点");
  assert.equal(candidatesConflict(c("a", 3, 3, ""), c("b", 1, 3)), true, "插入恰在替换终点");
  assert.equal(candidatesConflict(c("a", 4, 4, ""), c("b", 1, 3)), false);
  assert.equal(candidatesConflict(c("a", 1, 3), c("a", 1, 3)), false, "同一 ID 不自我冲突");
  const index = buildConflictIndex([c("a", 1, 3), c("b", 2, 4), c("c", 5, 6)]);
  assert.deepEqual(index.pairs, [["a", "b"]]);
  assert.throws(() => assertNoConflicts([c("a", 1, 3), c("b", 2, 4)]), /互斥修改/);
});

function patch(
  patchId: string,
  paragraphIndex: number,
  start: number,
  end: number,
  before: string,
  after: string,
): ProjectablePatch {
  return {
    patchId,
    paragraphId: BLOCKS[paragraphIndex].id,
    start,
    end,
    before,
    after,
  };
}

test("T037 从基础正文倒序投影：采纳 A→B→撤回 A 后 B 保留，插入删除不破坏后续补丁", () => {
  const a = patch("a", 0, 4, 6, "错字", "错词");
  const b = patch("b", 2, 0, 2, "第三", "第三章");
  const inserted = patch("i", 1, 0, 0, "", "开头");
  const removed = patch("d", 0, 0, 3, "第一段", "");
  const onlyB = projectBody(BODY, BLOCKS, [b]);
  assert.ok(onlyB.body.includes("第三章段也很正常。"));
  const aB = projectBody(BODY, BLOCKS, [a, b]);
  assert.ok(aB.body.includes("第一段有错词。"));
  assert.ok(aB.body.includes("第三章段也很正常。"));
  const afterWithdrawA = projectBody(BODY, BLOCKS, [b]);
  assert.equal(afterWithdrawA.body, onlyB.body);
  const mixed = projectBody(BODY, BLOCKS, [a, inserted, removed, b]);
  // 后续补丁的坐标始终基于基础正文，不受前面长度变化影响。
  assert.ok(mixed.body.includes("开头第二段正常。"));
  assert.ok(mixed.body.includes("有错词。"));
  assert.ok(mixed.body.includes("第三章段也很正常。"));
  assert.deepEqual(projectBody(BODY, BLOCKS, []).body, BODY);
});

test("T037 批量冲突整体不应用；未采纳段落不变", () => {
  const a = patch("a", 0, 4, 6, "错字", "错词");
  const overlap = patch("o", 0, 5, 7, "字。", "词！");
  assert.throws(() => projectBody(BODY, BLOCKS, [a, overlap]), /互斥修改/);
  const clean = projectBody(BODY, BLOCKS, [a]);
  assert.ok(clean.body.includes("第二段正常。"));
  assert.ok(clean.body.includes("第三段也很正常。"));
});

test("T038 位置映射：多处插入删除、删除锚点、重复引句按坐标定位", () => {
  const inserted = patch("i", 0, 0, 0, "", "前缀");
  const removed = patch("d", 1, 0, 3, "第二段", "");
  const map = buildPositionMap(BLOCKS, [inserted, removed]);
  const first = map.locate(inserted, true);
  assert.equal(first.from, 0);
  assert.equal(first.to, 2);
  const deletion = map.locate(removed, true);
  assert.equal(deletion.anchor, true);
  assert.equal(deletion.kind, "deletion");
  const block2Start = BLOCKS[2].start;
  // 插入 +2，删除 -3（段 1 在段 2 之前），故第三段整体前移 1。
  assert.equal(map.mapOffset(block2Start), block2Start - 1);
  const pending = map.locate(
    { ...patch("p", 1, 0, 3, "第二段", "第二段改"), patchId: "p" },
    false,
  );
  assert.equal(pending.kind, "pending");
  assert.equal(pending.to - pending.from, 3);
});

test("T036 指纹忽略理由与来源，相同修改合并", () => {
  const left = candidateFingerprint({
    baseBodyHash: hashBody(BODY),
    chapterId: "ch1",
    paragraphId: "p1",
    start: 3,
    end: 5,
    before: "错字",
    after: "错词",
    category: "typo",
  });
  const right = candidateFingerprint({
    baseBodyHash: hashBody(BODY),
    chapterId: "ch1",
    paragraphId: "p1",
    start: 3,
    end: 5,
    before: "错字",
    after: "错词",
    category: "typo",
  });
  assert.deepEqual(left, right);
  assert.match(left.patchId, /^pt-[0-9a-f]{16}$/);
  const differentReasonText = candidateFingerprint({
    baseBodyHash: hashBody(BODY),
    chapterId: "ch1",
    paragraphId: "p1",
    start: 3,
    end: 5,
    before: "错字",
    after: "错词",
    category: "wording",
  });
  assert.notEqual(differentReasonText.patchId, left.patchId);
});

test("T038/T043 相同句子出现在不同段落时按坐标定位，不串到第一处", () => {
  const body = "他说：“走吧。”\n她说：“走吧。”";
  const blocks = deriveBlocks("txt", body, "line");
  const patches = blocks.map((block, index): ProjectablePatch => {
    const text = body.slice(block.start, block.end);
    const start = text.indexOf("走吧");
    return {
      patchId: `same-${index}`,
      paragraphId: block.id,
      start,
      end: start + 2,
      before: "走吧",
      after: "走啊",
    };
  });
  const map = buildPositionMap(blocks, patches);
  const first = map.locate(patches[0], false);
  const second = map.locate(patches[1], false);
  assert.ok(first.from < blocks[1].start);
  assert.ok(second.from >= blocks[1].start);
  assert.ok(second.from > first.from);
  assert.equal(second.to - second.from, 2);
});
