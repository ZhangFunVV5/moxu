import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashBody } from "../src/core/text/hash";
import {
  createWorkspace,
  openWorkspaceAt,
  readChapterFile,
  saveChapterBody,
} from "../src/core/workspace/book-store";
import { buildIssueViews } from "../src/core/proofread/review-service";
import { buildChapterView } from "../src/core/proofread/chapter-view";
import {
  addRuleCandidates,
  createBatch,
  loadBatch,
  submitBlock,
} from "../src/core/proofread/batch-store";
import {
  applyReviewOperation,
  attachBatchToChapter,
  undoLastReviewOperation,
} from "../src/core/proofread/chapter-commit";
import {
  defaultProofreadOptions,
  type ModelEditCandidate,
} from "../src/shared/proofreading";
import { buildProofreadReport } from "../src/core/proofread/report";

const REVIEW_BODY = "第一段有错字。\n第二段正常。";

const REPLACE_A: ModelEditCandidate = {
  paragraphId: "p1",
  before: "错字",
  after: "错词",
  category: "typo",
  reason: "错别字",
};
const REPLACE_B: ModelEditCandidate = {
  paragraphId: "p1",
  before: "第一段",
  after: "首段",
  category: "wording",
  reason: "用词",
};

async function reviewFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "book-p3-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "作品");
  const workspace = await createWorkspace({
    root,
    bookTitle: "精校测试",
    format: "txt",
    source: {
      fileName: "book.txt",
      bytes: new TextEncoder().encode("原文"),
      encoding: "utf-8",
      eol: "lf",
    },
    importSettings: {
      splitMode: "auto",
      paragraphMode: "line",
      headingLevel: 0,
      boundaries: [0],
    },
    chapters: [{ title: "第一章", body: REVIEW_BODY, kind: "chapter" }],
  });
  const chapter = workspace.chapterFiles[0];
  const first = chapter.blocks[0];
  const text = chapter.body.slice(first.start, first.end);
  const batch = await createBatch({
    root,
    workspaceId: workspace.book.workspaceId,
    taskId: randomUUID(),
    chapter,
    options: defaultProofreadOptions,
    prompt: { version: "test-v1", hash: hashBody("prompt"), text: "prompt" },
    blockManifest: [
      {
        blockId: "b1",
        targets: [{ paragraphId: first.id, start: 0, end: text.length, text }],
        readOnlyBefore: [],
        readOnlyAfter: [{ paragraphId: "p2", text: "第二段正常。" }],
        inputHash: chapter.bodyHash,
      },
    ],
  });
  await attachBatchToChapter(root, batch);
  return { root, chapterId: chapter.chapterId, batchId: batch.batchId };
}

async function chapterNow(root: string, chapterId: string) {
  const workspace = await openWorkspaceAt(root);
  return readChapterFile(root, workspace.book, chapterId);
}

async function submit(
  root: string,
  batchId: string,
  chapterId: string,
  candidates: readonly unknown[],
) {
  const batch = await loadBatch(root, batchId);
  return submitBlock({
    root,
    batchId,
    chapterId,
    blockId: "b1",
    inputHash: batch.baseBodyHash,
    candidates,
  });
}

function op(
  root: string,
  chapterId: string,
  chapter: Awaited<ReturnType<typeof chapterNow>>,
  kind:
    | "accept"
    | "ignore"
    | "restore"
    | "withdraw"
    | "batch-accept"
    | "batch-ignore",
  commands: Array<{
    patchId: string;
    action: "accept" | "ignore" | "restore" | "withdraw";
  }>,
  operationId = randomUUID(),
) {
  return applyReviewOperation(root, {
    chapterId,
    operationId,
    kind,
    commands,
    reviewRevision: chapter.review!.reviewRevision,
    expectedHeadHash: chapter.bodyHash,
  });
}

test("T039–T041 连续采纳、逐条撤回、忽略恢复、撤回上次与重开", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [
    REPLACE_A,
    REPLACE_B,
  ]);
  assert.equal(receipt.receipt.candidateCount, 2);
  const [a, b] = receipt.candidates;
  let chapter = await chapterNow(root, chapterId);
  assert.equal(chapter.review?.reviewRevision, 0);

  chapter = (
    await op(root, chapterId, chapter, "accept", [
      { patchId: a.patchId, action: "accept" },
    ])
  ).chapter;
  assert.ok(chapter.body.includes("错词"));
  chapter = (
    await op(root, chapterId, chapter, "accept", [
      { patchId: b.patchId, action: "accept" },
    ])
  ).chapter;
  assert.ok(chapter.body.startsWith("首段有错词。"));

  const withdrawA = await op(root, chapterId, chapter, "withdraw", [
    { patchId: a.patchId, action: "withdraw" },
  ]);
  assert.ok(withdrawA.chapter.body.startsWith("首段有错字。"));
  assert.deepEqual(withdrawA.chapter.review?.acceptedPatchIds, [b.patchId]);
  chapter = withdrawA.chapter;

  const withdrawB = await op(root, chapterId, chapter, "withdraw", [
    { patchId: b.patchId, action: "withdraw" },
  ]);
  assert.equal(withdrawB.chapter.body, REVIEW_BODY);
  chapter = withdrawB.chapter;

  const ignoreB = await op(root, chapterId, chapter, "ignore", [
    { patchId: b.patchId, action: "ignore" },
  ]);
  assert.equal(ignoreB.chapter.body, REVIEW_BODY);
  assert.equal(
    ignoreB.chapter.review?.reviewRevision,
    chapter.review!.reviewRevision + 1,
  );
  assert.equal(ignoreB.chapter.review?.decisions[b.patchId], "ignored");
  chapter = ignoreB.chapter;

  const undoIgnore = await undoLastReviewOperation(root, {
    chapterId,
    operationId: randomUUID(),
    undoneOperationId: chapter.review!.lastOperationId,
    reviewRevision: chapter.review!.reviewRevision,
    expectedHeadHash: chapter.bodyHash,
  });
  assert.equal(undoIgnore.chapter.body, REVIEW_BODY);
  assert.equal(undoIgnore.chapter.review?.decisions[b.patchId], undefined);
  assert.equal(undoIgnore.chapter.review?.operations.length, 4);
  chapter = undoIgnore.chapter;

  const persisted = await chapterNow(root, chapterId);
  const undoWithdrawB = await undoLastReviewOperation(root, {
    chapterId,
    operationId: randomUUID(),
    undoneOperationId: persisted.review!.lastOperationId,
    reviewRevision: persisted.review!.reviewRevision,
    expectedHeadHash: persisted.bodyHash,
  });
  assert.ok(undoWithdrawB.chapter.body.startsWith("首段有错字。"));
  assert.deepEqual(undoWithdrawB.chapter.review?.acceptedPatchIds, [b.patchId]);
  chapter = undoWithdrawB.chapter;

  const undoWithdrawA = await undoLastReviewOperation(root, {
    chapterId,
    operationId: randomUUID(),
    undoneOperationId: chapter.review!.lastOperationId,
    reviewRevision: chapter.review!.reviewRevision,
    expectedHeadHash: chapter.bodyHash,
  });
  assert.ok(undoWithdrawA.chapter.body.startsWith("首段有错词。"));
  assert.equal(undoWithdrawA.chapter.review?.operations.length, 2);
});

test("T036/T039 冲突组合整体拒绝，撤回已采纳项后另一条重新可用", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [
    {
      paragraphId: "p1",
      before: "错字",
      after: "错词",
      category: "typo",
      reason: "A",
    },
    {
      paragraphId: "p1",
      before: "字。",
      after: "词！",
      category: "wording",
      reason: "B",
    },
  ]);
  const [a, b] = receipt.candidates;
  let chapter = await chapterNow(root, chapterId);
  chapter = (
    await op(root, chapterId, chapter, "accept", [
      { patchId: a.patchId, action: "accept" },
    ])
  ).chapter;
  await assert.rejects(
    op(root, chapterId, chapter, "accept", [
      { patchId: b.patchId, action: "accept" },
    ]),
    (error: unknown) => (error as { code?: string }).code === "PATCH_CONFLICT",
  );
  const blocked = buildIssueViews(
    receipt.batch.candidates,
    chapter.review!.decisions,
    chapter.review!.acceptedPatchIds,
    false,
  ).find((issue) => issue.patchId === b.patchId)!;
  assert.equal(blocked.validity, "conflict");
  assert.deepEqual(blocked.conflictWith, [a.patchId]);

  chapter = (
    await op(root, chapterId, chapter, "withdraw", [
      { patchId: a.patchId, action: "withdraw" },
    ])
  ).chapter;
  const available = buildIssueViews(
    receipt.batch.candidates,
    chapter.review!.decisions,
    chapter.review!.acceptedPatchIds,
    false,
  ).find((issue) => issue.patchId === b.patchId)!;
  assert.equal(available.validity, "valid");
});

test("T049 规则候选与模型候选去重合并；提交重放与块冲突", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const rule = await addRuleCandidates({
    root,
    batchId,
    blockId: "b1",
    items: [
      { ruleId: "ad-url", candidate: { ...REPLACE_A, reason: "规则命中" } },
    ],
  });
  assert.equal(rule.length, 1);
  const receipt = await submit(root, batchId, chapterId, [REPLACE_A]);
  assert.equal(receipt.replayed, false);
  assert.deepEqual(receipt.receipt.patchIds, [rule[0].patchId]);
  assert.deepEqual(
    receipt.batch.candidates.map((item) => item.sources),
    [["model", "rule"]],
  );
  const replay = await submit(root, batchId, chapterId, [REPLACE_A]);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    submit(root, batchId, chapterId, [REPLACE_B]),
    (error: unknown) =>
      (error as { code?: string }).code === "BLOCK_ALREADY_COMMITTED",
  );
});

test("T039–T041 operationId 幂等、同 ID 不同请求拒绝、过期与批次外编辑", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [REPLACE_A]);
  const [a] = receipt.candidates;
  const chapter = await chapterNow(root, chapterId);
  const operationId = randomUUID();
  const first = await op(
    root,
    chapterId,
    chapter,
    "accept",
    [{ patchId: a.patchId, action: "accept" }],
    operationId,
  );
  const again = await op(
    root,
    chapterId,
    chapter,
    "accept",
    [{ patchId: a.patchId, action: "accept" }],
    operationId,
  );
  assert.equal(again.replayed, true);
  assert.equal(again.chapter.bodyHash, first.chapter.bodyHash);
  await assert.rejects(
    op(
      root,
      chapterId,
      first.chapter,
      "ignore",
      [{ patchId: a.patchId, action: "ignore" }],
      operationId,
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "OPERATION_CONFLICT",
  );
  await assert.rejects(
    op(root, chapterId, chapter, "withdraw", [
      { patchId: a.patchId, action: "withdraw" },
    ]),
    (error: unknown) => (error as { code?: string }).code === "STALE_REVIEW",
  );
  const saved = await saveChapterBody(
    root,
    chapterId,
    REVIEW_BODY + "\n手工补写。",
    first.chapter.bodyRevision,
  );
  assert.ok(saved.body.includes("手工补写"));
  await assert.rejects(
    op(root, chapterId, first.chapter, "withdraw", [
      { patchId: a.patchId, action: "withdraw" },
    ]),
    (error: unknown) => (error as { code?: string }).code === "STALE_BODY",
  );
  const afterManual = await chapterNow(root, chapterId);
  assert.equal(afterManual.bodyHash, saved.bodyHash);
  assert.deepEqual(afterManual.review?.acceptedPatchIds, [a.patchId]);
});

test("T053 报告只把最终采纳项写成成稿修改，忽略与撤回单列且不含本机路径", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [
    REPLACE_A,
    REPLACE_B,
  ]);
  const [a, b] = receipt.candidates;
  let chapter = await chapterNow(root, chapterId);
  chapter = (
    await op(root, chapterId, chapter, "accept", [
      { patchId: a.patchId, action: "accept" },
    ])
  ).chapter;
  chapter = (
    await op(root, chapterId, chapter, "ignore", [
      { patchId: b.patchId, action: "ignore" },
    ])
  ).chapter;
  const batch = await loadBatch(root, chapter.review!.batchId);
  const report = buildProofreadReport({
    bookTitle: "精校测试",
    chapters: [{ chapter, batch }],
    generatedAt: "2026-11-09T00:00:00.000Z",
  });
  const finalSection = report.split("### 未生效意见")[0];
  assert.ok(finalSection.includes("错词"));
  assert.ok(!finalSection.includes("首段"), "已忽略意见不得残留成稿修改");
  assert.ok(report.includes("### 未生效意见"));
  assert.ok(report.includes("已忽略"));
  assert.ok(report.includes(batch.baseBodyHash));
  assert.ok(report.includes(chapter.bodyHash));
  assert.ok(!report.includes(root), "报告不得包含本机工作区路径");
  assert.equal(report.includes("apiKey"), false);
  assert.ok(report.includes("### 审阅操作记录"));
});

test("T052 类别批量采纳是一条历史，撤回上次恢复整次决议", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [
    REPLACE_A,
    REPLACE_B,
  ]);
  const chapter = await chapterNow(root, chapterId);
  const accepted = await op(
    root,
    chapterId,
    chapter,
    "batch-accept",
    receipt.candidates.map((candidate) => ({
      patchId: candidate.patchId,
      action: "accept" as const,
    })),
  );
  assert.equal(accepted.chapter.review?.acceptedPatchIds.length, 2);
  assert.ok(accepted.chapter.body.includes("首段有错词。"));
  assert.equal(accepted.chapter.review?.operations.length, 1);
  const undone = await undoLastReviewOperation(root, {
    chapterId,
    operationId: randomUUID(),
    undoneOperationId: accepted.chapter.review!.lastOperationId,
    reviewRevision: accepted.chapter.review!.reviewRevision,
    expectedHeadHash: accepted.chapter.bodyHash,
  });
  assert.equal(undone.chapter.body, REVIEW_BODY);
  assert.deepEqual(undone.chapter.review?.acceptedPatchIds, []);
  assert.equal(undone.chapter.review?.operations.length, 0);
});

test("T045 重新检查前的批次归档，旧意见仍按真实决议只读查看", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [REPLACE_A]);
  const [a] = receipt.candidates;
  let chapter = await chapterNow(root, chapterId);
  chapter = (
    await op(root, chapterId, chapter, "accept", [
      { patchId: a.patchId, action: "accept" },
    ])
  ).chapter;
  assert.ok(chapter.body.includes("错词"));
  const second = await createBatch({
    root,
    workspaceId: chapter.workspaceId,
    taskId: randomUUID(),
    chapter,
    options: defaultProofreadOptions,
    prompt: { version: "test-v2", hash: hashBody("prompt2"), text: "prompt2" },
    blockManifest: [
      {
        blockId: "b1",
        targets: [
          {
            paragraphId: "p1",
            start: 0,
            end: chapter.blocks[0].end - chapter.blocks[0].start,
            text: chapter.body.slice(
              0,
              chapter.blocks[0].end - chapter.blocks[0].start,
            ),
          },
        ],
        readOnlyBefore: [],
        readOnlyAfter: [],
        inputHash: chapter.bodyHash,
      },
    ],
  });
  await attachBatchToChapter(root, second);
  const archived = await loadBatch(root, batchId);
  assert.equal(archived.archivedReview?.decisions[a.patchId], "accepted");
  const workspaceNow = await openWorkspaceAt(root);
  const chapterNowFile = await readChapterFile(
    root,
    workspaceNow.book,
    chapterId,
  );
  assert.equal(chapterNowFile.review?.batchId, second.batchId);
  const oldView = await buildChapterView({
    root,
    book: workspaceNow.book,
    chapter: chapterNowFile,
    batchId,
  });
  assert.equal(oldView.readOnly, true);
  assert.equal(oldView.batchId, batchId);
  assert.equal(
    oldView.issues.find((issue) => issue.patchId === a.patchId)?.decision,
    "accepted",
  );
  assert.equal(
    oldView.issues.every((issue) => issue.locate === null),
    true,
  );
});

test("T036/T049 同一提交内的重复候选先按指纹去重，回执不重复计数", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [
    REPLACE_A,
    REPLACE_A,
  ]);
  assert.equal(receipt.receipt.candidateCount, 1);
  assert.equal(receipt.batch.candidates.length, 1);
  const replay = await submit(root, batchId, chapterId, [REPLACE_A]);
  assert.equal(replay.replayed, true);
});

test("P3 手工保存后传当前 hash 也拒绝旧批次采纳和撤回", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [REPLACE_A]);
  let c = await chapterNow(root, chapterId);
  c = (
    await op(root, chapterId, c, "accept", [
      { patchId: receipt.candidates[0].patchId, action: "accept" },
    ])
  ).chapter;
  await saveChapterBody(root, chapterId, c.body + "手工新内容", c.bodyRevision);
  const current = await chapterNow(root, chapterId);
  await assert.rejects(
    op(root, chapterId, current, "withdraw", [
      { patchId: receipt.candidates[0].patchId, action: "withdraw" },
    ]),
    { code: "STALE_BODY" },
  );
  await assert.rejects(
    undoLastReviewOperation(root, {
      chapterId,
      batchId,
      operationId: randomUUID(),
      reviewRevision: current.review!.reviewRevision,
      expectedHeadHash: current.bodyHash,
    }),
    { code: "STALE_BODY" },
  );
  assert.deepEqual(await chapterNow(root, chapterId), current);
});

test("P3 类别批量重放保留身份且不会重复提交", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  await submit(root, batchId, chapterId, [REPLACE_A]);
  const c = await chapterNow(root, chapterId);
  const request = {
    chapterId,
    batchId,
    operationId: randomUUID(),
    kind: "batch-accept" as const,
    batchCategory: "typo" as const,
    commands: [],
    reviewRevision: c.review!.reviewRevision,
    expectedHeadHash: c.bodyHash,
  };
  const first = await applyReviewOperation(root, request);
  const retry = await applyReviewOperation(root, request);
  assert.equal(retry.replayed, true);
  assert.equal(retry.chapter.bodyRevision, first.chapter.bodyRevision);
  assert.equal(retry.chapter.review!.operations.length, 1);
  await assert.rejects(
    applyReviewOperation(root, { ...request, batchId: randomUUID() }),
    { code: "STALE_BATCH" },
  );
  await assert.rejects(
    applyReviewOperation(root, { ...request, batchCategory: "grammar" }),
    { code: "OPERATION_CONFLICT" },
  );
});
test("P3 历史视图拒绝其他章节或作品批次", async (t) => {
  const a = await reviewFixture(t),
    b = await reviewFixture(t);
  const chapter = await chapterNow(a.root, a.chapterId);
  const workspace = await openWorkspaceAt(a.root);
  const batch = await loadBatch(b.root, b.batchId);
  await fsp.copyFile(
    path.join(b.root, "edits", b.batchId + ".json"),
    path.join(a.root, "edits", b.batchId + ".json"),
  );
  await assert.rejects(
    buildChapterView({
      root: a.root,
      book: workspace.book,
      chapter,
      batchId: batch.batchId,
    }),
    { code: "STALE_BATCH" },
  );
});

test("P3 撤回最后一条后重放不重新执行，报告保留原操作", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [REPLACE_A]);
  const original = await chapterNow(root, chapterId);
  const operationId = randomUUID();
  const commands = [
    { patchId: receipt.candidates[0].patchId, action: "accept" as const },
  ];
  const accepted = await op(
    root,
    chapterId,
    original,
    "accept",
    commands,
    operationId,
  );
  const undoRequest = {
    chapterId,
    batchId,
    operationId: randomUUID(),
    reviewRevision: accepted.chapter.review!.reviewRevision,
    expectedHeadHash: accepted.chapter.bodyHash,
  };
  const undone = await undoLastReviewOperation(root, undoRequest);
  assert.equal(
    (await undoLastReviewOperation(root, undoRequest)).replayed,
    true,
  );
  await assert.rejects(
    undoLastReviewOperation(root, {
      ...undoRequest,
      undoneOperationId: randomUUID(),
    }),
    { code: "OPERATION_CONFLICT" },
  );
  const replay = await op(
    root,
    chapterId,
    original,
    "accept",
    commands,
    operationId,
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(
    await chapterNow(root, chapterId),
    JSON.parse(JSON.stringify(undone.chapter)),
  );
  const report = buildProofreadReport({
    bookTitle: "test",
    chapters: [
      { chapter: undone.chapter, batch: await loadBatch(root, batchId) },
    ],
    generatedAt: "now",
  });
  assert.ok(report.includes("撤回上次操作"));
  assert.ok(report.includes(operationId));
  assert.ok(report.includes(undoRequest.operationId));
  assert.ok(report.includes(accepted.operation!.createdAt));
});

test("P3 kind 与实际命令不匹配必须拒绝，包括相同ID重试", async (t) => {
  const { root, chapterId, batchId } = await reviewFixture(t);
  const receipt = await submit(root, batchId, chapterId, [REPLACE_A]);
  const chapter = await chapterNow(root, chapterId);
  const operationId = randomUUID();
  await op(
    root,
    chapterId,
    chapter,
    "accept",
    [{ patchId: receipt.candidates[0].patchId, action: "accept" }],
    operationId,
  );
  await assert.rejects(
    op(
      root,
      chapterId,
      chapter,
      "accept",
      [{ patchId: receipt.candidates[0].patchId, action: "ignore" }],
      operationId,
    ),
    { code: "SCHEMA_INVALID" },
  );
});
