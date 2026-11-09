import test from "node:test";
import assert from "node:assert/strict";
import { ProofreadService } from "../src/main/services/proofread-service";
import type { WorkspaceService } from "../src/main/services/workspace-service";
import { TaskService } from "../src/main/services/task-service";
import type { Workspace } from "../src/core/workspace/book-store";
import { defaultProofreadOptions } from "../src/shared/proofreading";
test("P3 准备阶段互斥，切换作品拒绝，失败释放占位", async () => {
  const a = {
    root: "a",
    book: { workspaceId: "a", chapterOrder: ["ch1"] },
  } as unknown as Workspace;
  let current = a;
  let release!: () => void;
  let prepared = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const workspace = {
    currentWorkspace: () => current,
  } as unknown as WorkspaceService;
  const task = {
    async createSpec() {
      prepared++;
      throw Error("不应准备其他作品");
    },
  } as unknown as TaskService;
  const service = new ProofreadService(workspace, task, async () => {
    await pending;
    throw Error("缺配置");
  });
  const request = { chapterIds: ["ch1"], options: defaultProofreadOptions };
  const first = service.start(request);
  await assert.rejects(service.start(request), { code: "TASK_BUSY" });
  await assert.rejects(service.resume("anything"), { code: "TASK_BUSY" });
  release();
  await assert.rejects(first, { code: "MODEL_CONFIG_REQUIRED" });
  await assert.rejects(service.start(request), {
    code: "MODEL_CONFIG_REQUIRED",
  });
  assert.equal(prepared, 0);
  const switched = new ProofreadService(workspace, task, async () => {
    current = { ...a, root: "b" };
    return {
      async complete() {
        throw Error("unused");
      },
    };
  });
  await assert.rejects(switched.start(request), { code: "STALE_BATCH" });
  assert.equal(prepared, 0);
});
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkspace } from "../src/core/workspace/book-store";
import { TaskStore } from "../src/agent/tasks/task-store";
import { randomUUID } from "node:crypto";
test("P3 活跃任务恢复不改检查点，批量提交失败回执后可安全重试", async (t) => {
  const dir = await fsp.mkdtemp(path.join(tmpdir(), "proofread-service-"));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const ws = await createWorkspace({
    root: path.join(dir, "book"),
    bookTitle: "test",
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
    chapters: [{ title: "一", body: "一个错字。", kind: "chapter" }],
  });
  const chapterId = ws.book.chapterOrder[0];
  let rejectCache = false;
  const workspace = {
    currentWorkspace: () => ws,
    updateChapterCache: () => {
      if (rejectCache) throw Error("回执失败");
    },
  } as unknown as WorkspaceService;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve)),
    ready = new Promise<void>((resolve) => (entered = resolve));
  const service = new ProofreadService(
    workspace,
    new TaskService(workspace),
    async () => ({
      async complete(messages) {
        if (messages.some((m) => m.role === "tool"))
          return { content: "完成", calls: [], finishReason: "stop" };
        entered();
        await waiting;
        const prompt = messages
          .filter((m) => m.role === "user")
          .at(-1)!.content!;
        const args = {
          chapterId,
          blockId: /blockId=(b[1-9][0-9]*)/.exec(prompt)![1],
          inputHash: /inputHash=([0-9a-f]{64})/.exec(prompt)![1],
          candidates: [
            {
              paragraphId: "p1",
              before: "错字",
              after: "错词",
              category: "typo",
              reason: "错字",
            },
          ],
        };
        return {
          content: "",
          calls: [
            {
              id: "submit",
              type: "function",
              function: {
                name: "submit_edits",
                arguments: JSON.stringify(args),
              },
            },
          ],
          finishReason: "tool_calls",
        };
      },
    }),
  );
  let finished!: () => void;
  const done = new Promise<void>((resolve) => (finished = resolve));
  service.onEvent((e) => {
    if (e.type === "taskStateChanged") finished();
  });
  const started = await service.start({
    chapterIds: [chapterId],
    options: defaultProofreadOptions,
  });
  await ready;
  assert.equal(
    (await TaskStore.open(ws.root, started.taskId)).getCheckpoint(chapterId)
      .status,
    "running",
  );
  await service.recover();
  assert.equal(
    (await TaskStore.open(ws.root, started.taskId)).getCheckpoint(chapterId)
      .status,
    "running",
  );
  release();
  await done;
  const view = await service.chapter({ chapterId });
  const request = {
    chapterId,
    batchId: view.batchId!,
    operationId: randomUUID(),
    category: "typo" as const,
    action: "accept" as const,
    reviewRevision: view.reviewRevision,
    expectedHeadHash: view.expectedHeadHash,
  };
  rejectCache = true;
  await assert.rejects(service.batchApply(request), /回执失败/);
  rejectCache = false;
  const retry = await service.batchApply(request);
  assert.equal(retry.body, "一个错词。");
  assert.equal(retry.reviewRevision, 1);
  await assert.rejects(
    service.batchApply({ ...request, batchId: randomUUID() }),
    { code: "STALE_BATCH" },
  );
});
