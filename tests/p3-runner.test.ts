import test from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createWorkspace,
  openWorkspaceAt,
  readBookFile,
  readChapterFile,
} from "../src/core/workspace/book-store";
import {
  applyReviewOperation,
  attachBatchToChapter,
} from "../src/core/proofread/chapter-commit";
import { buildChapterView } from "../src/core/proofread/chapter-view";
import { hashBody } from "../src/core/text/hash";
import { buildTaskSpec } from "../src/agent/tasks/task-types";
import { TaskStore } from "../src/agent/tasks/task-store";
import {
  listProofreadTasks,
  recoverProofreadTasks,
  resumeProofreadTask,
  runProofreadTask,
} from "../src/core/proofread/proofread-engine";
import {
  createBatch,
  loadBatch,
  submitBlock,
} from "../src/core/proofread/batch-store";
import {
  PROOFREAD_PROFILE,
  proofreadToolEntries,
} from "../src/agent/tools/proofread-tools";
import { dispatch, visibleTools, type Context } from "../src/agent/tools/dispatcher";
import type { Adapter, Message, Response } from "../src/agent/model/model-adapter";
import {
  defaultProofreadOptions,
  type ProofreadOptions,
} from "../src/shared/proofreading";
import { parseProofreadRequest } from "../src/core/proofread/request-parser";

const BODY = "第一段有错字。\n第二段正常。";

test("P3 继续旧待审任务不能处理后来创建的新批次", async (t) => {
  const fx = await fixture(t);
  await run(fx, adapterWith(() => [REPLACE]));
  const chapter = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  const oldBatch = await loadBatch(fx.root, chapter.review!.batchId);
  const newBatch = await createBatch({
    root: fx.root, workspaceId: fx.workspace.book.workspaceId, taskId: randomUUID(),
    chapter, options: oldBatch.options, prompt: oldBatch.prompt,
    blockManifest: oldBatch.blockManifest,
  });
  await attachBatchToChapter(fx.root, newBatch);
  await submitBlock({
    root: fx.root, batchId: newBatch.batchId, chapterId: chapter.chapterId,
    blockId: newBatch.blockManifest[0].blockId,
    inputHash: newBatch.blockManifest[0].inputHash, candidates: [REPLACE],
  });
  const result = await resumeProofreadTask({
    workspace: fx.workspace, taskStore: await TaskStore.open(fx.root, fx.spec.taskId),
    spec: fx.spec, adapter: adapterWith(() => []), signal: new AbortController().signal,
    emit: () => undefined,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.chapters[0].errorCode, "STALE_BATCH");
  const saved = await readChapterFile(fx.root, fx.workspace.book, chapter.chapterId);
  assert.equal(saved.body, BODY);
  assert.equal(saved.review!.batchId, newBatch.batchId);
  assert.deepEqual(saved.review!.decisions, {});
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "book-runner-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "作品");
  const workspace = await createWorkspace({
    root,
    bookTitle: "精校运行",
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
    chapters: [{ title: "第一章", body: BODY, kind: "chapter" }],
  });
  const chapter = workspace.chapterFiles[0];
  const spec = buildTaskSpec({
    workspaceId: workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [chapter.chapterId],
    inputHashes: { [chapter.chapterId]: chapter.bodyHash },
    options: {},
    profileVersion: defaultProofreadOptions.profileVersion,
  });
  const store = await TaskStore.create(root, spec);
  return { root, workspace, chapter, spec, store };
}

function promptOf(messages: readonly Message[]): string {
  return messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
}

function submissionFromPrompt(prompt: string, candidates: unknown[]) {
  const chapterId = /chapterId=([A-Za-z0-9_-]+)/.exec(prompt)![1];
  const blockId = /blockId=(b[1-9][0-9]*)/.exec(prompt)![1];
  const inputHash = /inputHash=([0-9a-f]{64})/.exec(prompt)![1];
  return {
    chapterId,
    blockId,
    inputHash,
    candidates,
  };
}

const REPLACE = {
  paragraphId: "p1",
  before: "错字",
  after: "错词",
  category: "typo",
  reason: "错别字",
};

function adapterWith(
  makeCandidates: (prompt: string, round: number) => unknown[] | "stop",
): Adapter {
  const rounds = new Map<string, number>();
  return {
    async complete(messages): Promise<Response> {
      const prompt = promptOf(messages);
      const key = /blockId=(b[1-9][0-9]*)/.exec(prompt)?.[1] ?? "none";
      const round = rounds.get(key) ?? 0;
      rounds.set(key, round + 1);
      const hasToolResult = messages.some((message) => message.role === "tool");
      const candidates = makeCandidates(prompt, round);
      if (hasToolResult || candidates === "stop")
        return { content: "本块完成", calls: [], finishReason: "stop" };
      return {
        content: "",
        calls: [
          {
            id: `call-${key}-${round}`,
            type: "function",
            function: {
              name: "submit_edits",
              arguments: JSON.stringify(submissionFromPrompt(prompt, candidates)),
            },
          },
        ],
        finishReason: "tool_calls",
      };
    },
  };
}

async function run(
  fx: Awaited<ReturnType<typeof fixture>>,
  adapter: Adapter,
  options: ProofreadOptions = defaultProofreadOptions,
  signal = new AbortController().signal,
) {
  return runProofreadTask({
    workspace: fx.workspace,
    taskStore: fx.store,
    spec: fx.spec,
    options,
    adapter,
    signal,
    emit: () => undefined,
  });
}

test("T048 精校 Profile 只暴露四个工具，提交块/hash 越权被拒绝", async () => {
  assert.deepEqual(visibleTools(PROOFREAD_PROFILE).map((tool) => (tool as { function: { name: string } }).function.name), [
    "list_chapters",
    "read_chapter",
    "scan_text_rules",
    "submit_edits",
  ]);
  assert.equal(Object.keys(proofreadToolEntries).length, 4);
  const executed: string[] = [];
  const context: Context = {
    workspaceId: "workspace",
    chapterIds: ["ch1"],
    source: "agent",
    allowWrite: false,
    version: 1,
    proofread: {
      chapterIds: ["ch1"],
      blockId: "b1",
      inputHash: "a".repeat(64),
      execute: async (name) => {
        executed.push(name);
        return { ok: true, data: { name } };
      },
    },
  };
  assert.equal((await dispatch("read_chapter", { chapterId: "ch2" }, context, PROOFREAD_PROFILE)).ok, false);
  assert.equal(
    (
      await dispatch(
        "submit_edits",
        {
          chapterId: "ch1",
          blockId: "b2",
          inputHash: "a".repeat(64),
          candidates: [],
        },
        context,
        PROOFREAD_PROFILE,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await dispatch(
        "submit_edits",
        {
          chapterId: "ch1",
          blockId: "b1",
          inputHash: "b".repeat(64),
          candidates: [],
        },
        context,
        PROOFREAD_PROFILE,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await dispatch(
        "submit_edits",
        {
          chapterId: "ch1",
          blockId: "b1",
          inputHash: "a".repeat(64),
          candidates: [REPLACE],
          permissions: { canWriteBody: true },
        },
        context,
        PROOFREAD_PROFILE,
      )
    ).ok,
    false,
  );
  assert.equal(
    (
      await dispatch(
        "submit_edits",
        {
          chapterId: "ch1",
          blockId: "b1",
          inputHash: "a".repeat(64),
          candidates: [],
        },
        context,
        PROOFREAD_PROFILE,
      )
    ).ok,
    true,
  );
  assert.deepEqual(executed, ["submit_edits"]);
});

test("T050 有意见章进入 waiting-review，候选与正文分开保存", async (t) => {
  const fx = await fixture(t);
  const result = await run(fx, adapterWith(() => [REPLACE]));
  assert.equal(result.status, "waiting-review");
  assert.equal(result.chapters[0].candidateCount, 1);
  const store = await TaskStore.open(fx.root, fx.spec.taskId);
  assert.equal(store.getCheckpoint(fx.chapter.chapterId).status, "waiting-review");
  const chapter = await readChapterFile(
    fx.root,
    (await openWorkspaceAt(fx.root)).book,
    fx.chapter.chapterId,
  );
  assert.equal(chapter.body, BODY, "采纳前正文不变");
  const batch = await loadBatch(fx.root, chapter.review!.batchId);
  assert.equal(batch.candidates.length, 1);
  assert.deepEqual(store.getCheckpoint(fx.chapter.chapterId).completedBlockIds, ["b1"]);
});

test("T050 空数组是有效的零意见结果；模型声称完成但没提交不能结束", async (t) => {
  const empty = await fixture(t);
  const emptyResult = await run(empty, adapterWith(() => []));
  assert.equal(emptyResult.status, "completed");
  assert.equal(emptyResult.chapters[0].candidateCount, 0);

  const claimed = await fixture(t);
  const noSubmit: Adapter = {
    async complete() {
      return { content: "已完成，没有问题。", calls: [], finishReason: "stop" };
    },
  };
  const claimedResult = await run(claimed, noSubmit);
  assert.equal(claimedResult.status, "failed");
  assert.equal(claimedResult.chapters[0].errorCode, "NO_ARTIFACT");
  const store = await TaskStore.open(claimed.root, claimed.spec.taskId);
  assert.equal(store.getCheckpoint(claimed.chapter.chapterId).status, "failed");
});

test("T049 非法候选整批拒绝、逐项错误反馈后在剩余轮数修正", async (t) => {
  const fx = await fixture(t);
  let sawToolError = false;
  const adapter: Adapter = {
    async complete(messages): Promise<Response> {
      const prompt = promptOf(messages);
      const tool = messages.filter((message) => message.role === "tool").at(-1);
      if (tool?.content?.includes("INVALID_CANDIDATES")) {
        sawToolError = true;
        assert.ok(JSON.parse(tool.content!).error.data.failures.length > 0);
        return {
          content: "",
          calls: [
            {
              id: "fix",
              type: "function",
              function: {
                name: "submit_edits",
                arguments: JSON.stringify(submissionFromPrompt(prompt, [REPLACE])),
              },
            },
          ],
          finishReason: "tool_calls",
        };
      }
      if (tool)
        return { content: "本块完成", calls: [], finishReason: "stop" };
      return {
        content: "",
        calls: [
          {
            id: "bad",
            type: "function",
            function: {
              name: "submit_edits",
              arguments: JSON.stringify(
                submissionFromPrompt(prompt, [
                  { ...REPLACE, before: "不存在的原句" },
                ]),
              ),
            },
          },
        ],
        finishReason: "tool_calls",
      };
    },
  };
  const result = await run(fx, adapter);
  assert.equal(result.status, "waiting-review");
  assert.equal(sawToolError, true);
});

test("T050 截断与取消可区分；取消不写正式正文", async (t) => {
  const truncated = await fixture(t);
  const truncating: Adapter = {
    async complete() {
      return { content: "写到一半", calls: [], finishReason: "length" };
    },
  };
  const truncatedResult = await run(truncated, truncating);
  assert.equal(truncatedResult.status, "failed");
  assert.equal(truncatedResult.chapters[0].errorCode, "TRUNCATED");

  const cancelled = await fixture(t);
  const controller = new AbortController();
  const hanging: Adapter = {
    async complete() {
      controller.abort();
      return { content: "", calls: [], finishReason: "stop" };
    },
  };
  const cancelledResult = await run(cancelled, hanging, defaultProofreadOptions, controller.signal);
  assert.equal(cancelledResult.status, "cancelled");
  const chapter = await readChapterFile(
    cancelled.root,
    (await openWorkspaceAt(cancelled.root)).book,
    cancelled.chapter.chapterId,
  );
  assert.equal(chapter.body, BODY);
});

test("T046 规则候选自动进入批次，模型空提交仍保留待审广告意见", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "book-runner-ad-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "广告作品");
  const adBody = "正文正常。\n最新地址：https://promo.example.com/txt 请收藏本站";
  const workspace = await createWorkspace({
    root,
    bookTitle: "广告",
    format: "txt",
    source: {
      fileName: "ad.txt",
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
    chapters: [{ title: "第一章", body: adBody, kind: "chapter" }],
  });
  const chapter = workspace.chapterFiles[0];
  const spec = buildTaskSpec({
    workspaceId: workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [chapter.chapterId],
    inputHashes: { [chapter.chapterId]: chapter.bodyHash },
    options: {},
    profileVersion: defaultProofreadOptions.profileVersion,
  });
  const store = await TaskStore.create(root, spec);
  const result = await runProofreadTask({
    workspace,
    taskStore: store,
    spec,
    options: defaultProofreadOptions,
    adapter: adapterWith(() => []),
    signal: new AbortController().signal,
    emit: () => undefined,
  });
  assert.equal(result.status, "waiting-review");
  const saved = await readChapterFile(root, workspace.book, chapter.chapterId);
  const batch = await loadBatch(root, saved.review!.batchId);
  assert.ok(batch.candidates.some((candidate) => candidate.sources.includes("rule")));
  assert.ok(batch.candidates.every((candidate) => candidate.category === "advertisement"));
});


// ---------------------------------------------------------------- T055 恢复

async function attachIncompleteBatch(fx: Awaited<ReturnType<typeof fixture>>) {
  const chapter = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  const first = chapter.blocks[0];
  const text = chapter.body.slice(first.start, first.end);
  const batch = await createBatch({
    root: fx.root,
    workspaceId: fx.workspace.book.workspaceId,
    taskId: fx.spec.taskId,
    chapter,
    options: defaultProofreadOptions,
    prompt: { version: "test", hash: hashBody("p"), text: "p" },
    blockManifest: [
      {
        blockId: "b1",
        targets: [{ paragraphId: first.id, start: 0, end: text.length, text }],
        readOnlyBefore: [],
        readOnlyAfter: [],
        inputHash: chapter.bodyHash,
      },
    ],
  });
  await attachBatchToChapter(fx.root, batch);
  return { batch, chapter };
}

test("T055 关闭重开：产物已提交但进度未写可补齐，不重复应用", async (t) => {
  const fx = await fixture(t);
  const { batch } = await attachIncompleteBatch(fx);
  await submitBlock({
    root: fx.root,
    batchId: batch.batchId,
    chapterId: fx.chapter.chapterId,
    blockId: "b1",
    inputHash: batch.baseBodyHash,
    candidates: [REPLACE],
  });
  const store = await TaskStore.open(fx.root, fx.spec.taskId);
  await store.setState(fx.chapter.chapterId, "running");
  const recovery = await recoverProofreadTasks(fx.root, await readBookFile(fx.root));
  assert.equal(recovery.repaired.length, 1);
  assert.deepEqual(recovery.interrupted, []);
  const reopened = await TaskStore.open(fx.root, fx.spec.taskId);
  assert.equal(reopened.getCheckpoint(fx.chapter.chapterId).status, "waiting-review");
  const artifact = await reopened.readArtifact(fx.chapter.chapterId);
  assert.ok(artifact);
  assert.deepEqual(artifact!.completedBlockIds, ["b1"]);
});

test("T055 未提交完的块标 interrupted，继续任务只补未完成块", async (t) => {
  const fx = await fixture(t);
  await attachIncompleteBatch(fx);
  const store = await TaskStore.open(fx.root, fx.spec.taskId);
  await store.setState(fx.chapter.chapterId, "running");
  const recovery = await recoverProofreadTasks(fx.root, await readBookFile(fx.root));
  assert.equal(recovery.interrupted.length, 1);
  assert.equal(
    (await TaskStore.open(fx.root, fx.spec.taskId)).getCheckpoint(fx.chapter.chapterId).status,
    "interrupted",
  );
  const result = await resumeProofreadTask({
    workspace: fx.workspace,
    taskStore: await TaskStore.open(fx.root, fx.spec.taskId),
    spec: fx.spec,
    adapter: adapterWith(() => [REPLACE]),
    signal: new AbortController().signal,
    emit: () => undefined,
  });
  assert.equal(result.status, "waiting-review");
  const chapter = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  const batch = await loadBatch(fx.root, chapter.review!.batchId);
  assert.equal(batch.receipts.length, 1);
  assert.equal(batch.candidates.length, 1);
});

test("T055 模型失败前的已完成块保留，恢复不重复插入候选", async (t) => {
  const fx = await fixture(t);
  const failing: Adapter = {
    async complete() {
      throw new Error("network down");
    },
  };
  const first = await run(fx, failing);
  assert.equal(first.status, "failed");
  const resumed = await resumeProofreadTask({
    workspace: fx.workspace,
    taskStore: await TaskStore.open(fx.root, fx.spec.taskId),
    spec: fx.spec,
    adapter: adapterWith(() => [REPLACE]),
    signal: new AbortController().signal,
    emit: () => undefined,
  });
  assert.equal(resumed.status, "waiting-review");
  const chapter = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  const batch = await loadBatch(fx.root, chapter.review!.batchId);
  assert.equal(batch.candidates.length, 1);
});


test("T051 自然语言入口与按钮使用同一选项，不扩范围、不增写权限", () => {
  const base = defaultProofreadOptions;
  const parsed = parseProofreadRequest("检查本章错字和广告，整书自动应用", base);
  assert.deepEqual([...parsed.options.categories].sort(), ["advertisement", "typo"]);
  assert.equal(parsed.options.userRequest, "检查本章错字和广告，整书自动应用");
  assert.deepEqual(parsed.options.autoApplyCategories, []);
  assert.ok(parsed.notes.some((note) => note.includes("不会增加写正文权限")));
  assert.ok(parsed.notes.some((note) => note.includes("不会扩大章节范围")));
  assert.throws(
    () => parseProofreadRequest("帮我润色这一章", base),
    (error: unknown) => (error as { code?: string }).code === "UNSUPPORTED_REQUEST",
  );
});

test("T052 仅应用层授权类别自动应用；未授权时保留待审", async (t) => {
  const authorized = await fixture(t);
  const autoOptions: ProofreadOptions = {
    ...defaultProofreadOptions,
    autoApplyCategories: ["typo"],
  };
  const authorizedSpec = buildTaskSpec({
    workspaceId: authorized.workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [authorized.chapter.chapterId],
    inputHashes: { [authorized.chapter.chapterId]: authorized.chapter.bodyHash },
    options: {},
    profileVersion: autoOptions.profileVersion,
    autoApplyCategories: ["typo"],
  });
  const authorizedStore = await TaskStore.create(authorized.root, authorizedSpec);
  const result = await runProofreadTask({
    workspace: authorized.workspace,
    taskStore: authorizedStore,
    spec: authorizedSpec,
    options: autoOptions,
    adapter: adapterWith(() => [REPLACE]),
    signal: new AbortController().signal,
    emit: () => undefined,
  });
  assert.equal(result.status, "completed");
  const authorizedChapter = await readChapterFile(
    authorized.root,
    authorized.workspace.book,
    authorized.chapter.chapterId,
  );
  assert.ok(authorizedChapter.body.includes("错词"));
  assert.equal(authorizedChapter.review?.acceptedPatchIds.length, 1);

  const denied = await fixture(t);
  const deniedSpec = buildTaskSpec({
    workspaceId: denied.workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [denied.chapter.chapterId],
    inputHashes: { [denied.chapter.chapterId]: denied.chapter.bodyHash },
    options: {},
    profileVersion: autoOptions.profileVersion,
    autoApplyCategories: [],
  });
  const deniedStore = await TaskStore.create(denied.root, deniedSpec);
  const deniedResult = await runProofreadTask({
    workspace: denied.workspace,
    taskStore: deniedStore,
    spec: deniedSpec,
    options: autoOptions,
    adapter: adapterWith(() => [REPLACE]),
    signal: new AbortController().signal,
    emit: () => undefined,
  });
  assert.equal(deniedResult.status, "waiting-review");
  const deniedChapter = await readChapterFile(
    denied.root,
    denied.workspace.book,
    denied.chapter.chapterId,
  );
  assert.equal(deniedChapter.body, BODY);
});

test("T048 批次保存可版本化提示词快照与专名词表", async (t) => {
  const fx = await fixture(t);
  const options: ProofreadOptions = {
    ...defaultProofreadOptions,
    glossary: ["沈舟"],
  };
  const spec = buildTaskSpec({
    workspaceId: fx.workspace.book.workspaceId,
    type: "proofread",
    chapterIds: [fx.chapter.chapterId],
    inputHashes: { [fx.chapter.chapterId]: fx.chapter.bodyHash },
    options: {},
    profileVersion: options.profileVersion,
  });
  const store = await TaskStore.create(fx.root, spec);
  await runProofreadTask({
    workspace: fx.workspace,
    taskStore: store,
    spec,
    options,
    adapter: adapterWith(() => []),
    signal: new AbortController().signal,
    emit: () => undefined,
  });
  const chapter = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  const batch = await loadBatch(fx.root, chapter.review!.batchId);
  assert.match(batch.prompt.hash, /^[0-9a-f]{64}$/);
  assert.match(batch.prompt.version, /proofread-profile-v1/);
  assert.ok(batch.prompt.text.includes("submit_edits"));
  assert.deepEqual(batch.options.glossary, ["沈舟"]);
});

test("T056 两个作品并行运行，结果各归其作品且正文不串写", async (t) => {
  const left = await fixture(t);
  const right = await fixture(t);
  const [leftResult, rightResult] = await Promise.all([
    run(left, adapterWith(() => [REPLACE])),
    run(right, adapterWith(() => [REPLACE])),
  ]);
  assert.equal(leftResult.status, "waiting-review");
  assert.equal(rightResult.status, "waiting-review");
  const leftChapter = await readChapterFile(left.root, left.workspace.book, left.chapter.chapterId);
  const rightChapter = await readChapterFile(right.root, right.workspace.book, right.chapter.chapterId);
  assert.notEqual(leftChapter.review?.batchId, rightChapter.review?.batchId);
  const leftBatch = await loadBatch(left.root, leftChapter.review!.batchId);
  const rightBatch = await loadBatch(right.root, rightChapter.review!.batchId);
  assert.equal(leftBatch.workspaceId, left.workspace.book.workspaceId);
  assert.equal(rightBatch.workspaceId, right.workspace.book.workspaceId);
  assert.notEqual(leftBatch.workspaceId, rightBatch.workspaceId);
  assert.equal(leftChapter.body, BODY);
  assert.equal(rightChapter.body, BODY);
});


test("T050 目标块未全部提交时不能正式采纳或撤回", async (t) => {
  const fx = await fixture(t);
  const { batch } = await attachIncompleteBatch(fx);
  const chapter = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  await assert.rejects(
    applyReviewOperation(fx.root, {
      chapterId: fx.chapter.chapterId,
      batchId: batch.batchId,
      operationId: "00000000-0000-4000-8000-000000000001",
      kind: "accept",
      commands: [{ patchId: "pt-0000000000000000", action: "accept" }],
      reviewRevision: chapter.review!.reviewRevision,
      expectedHeadHash: chapter.bodyHash,
    }),
    (error: unknown) => (error as { code?: string }).code === "INCOMPLETE_BATCH",
  );
  const chapterNow = await readChapterFile(fx.root, fx.workspace.book, fx.chapter.chapterId);
  const view = await buildChapterView({
    root: fx.root,
    book: fx.workspace.book,
    chapter: chapterNow,
    taskStore: await TaskStore.open(fx.root, fx.spec.taskId),
  });
  assert.equal(view.reviewReady, false);
});

test("P3 cancelled 章节继续且已提交块不重复",async(t)=>{
 const fx=await fixture(t); const {batch}=await attachIncompleteBatch(fx);
 await submitBlock({root:fx.root,batchId:batch.batchId,chapterId:fx.chapter.chapterId,blockId:"b1",inputHash:batch.baseBodyHash,candidates:[REPLACE]});
 await fx.store.setState(fx.chapter.chapterId,"running");await fx.store.cancelChapter(fx.chapter.chapterId);
 let calls=0;
 const result=await resumeProofreadTask({workspace:fx.workspace,taskStore:fx.store,spec:fx.spec,adapter:{async complete(){calls++;throw Error("重复请求");}},signal:new AbortController().signal,emit:()=>undefined});
 assert.equal(result.status,"waiting-review");assert.equal(fx.store.getCheckpoint(fx.chapter.chapterId).status,"waiting-review");assert.equal(calls,0);
});

test("P3 等待审阅前章不能遮蔽后章取消或失败",async(t)=>{
 const fx=await fixture(t);const first=fx.chapter.chapterId,second="ch2";
 const spec=buildTaskSpec({workspaceId:fx.workspace.book.workspaceId,type:"proofread",chapterIds:[first,second],inputHashes:{[first]:fx.chapter.bodyHash,[second]:fx.chapter.bodyHash},options:{},profileVersion:defaultProofreadOptions.profileVersion});
 const store=await TaskStore.create(fx.root,spec);await store.setState(first,"running");await store.enterWaitingReview(first);await store.cancelChapter(second);
 assert.equal((await listProofreadTasks(fx.root)).find(task=>task.taskId===spec.taskId)!.status,"cancelled");
 await store.setState(second,"running");await store.failChapter(second,"NETWORK");
 assert.equal((await listProofreadTasks(fx.root)).find(task=>task.taskId===spec.taskId)!.status,"failed");
});
