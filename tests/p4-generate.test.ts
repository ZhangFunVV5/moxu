import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createWorkspace,
  readChapterFile,
  saveChapterBody,
} from "../src/core/workspace/book-store";
import { buildTaskSpec } from "../src/agent/tasks/task-types";
import { TaskStore } from "../src/agent/tasks/task-store";
import { runGenerateTask } from "../src/core/generate/engine";
import { listArtifacts, saveArtifact } from "../src/core/generate/store";
import {
  validateTitle,
  validateTitles,
  validateText,
  chunkBody,
} from "../src/core/generate/validate";
import {
  DEFAULT_TITLE_OPTIONS,
  DEFAULT_SUMMARY_OPTIONS,
  GENERATE_PROFILE_VERSION,
} from "../src/shared/generate";
import type { Adapter } from "../src/agent/model/model-adapter";
import { GenerateService } from "../src/main/services/generate-service";
import type { WorkspaceService } from "../src/main/services/workspace-service";
import { TaskService } from "../src/main/services/task-service";
async function fixture(
  t: { after(fn: () => Promise<void>): void },
  body = "他们走进树林。",
  count = 1,
) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "generate-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = await createWorkspace({
    root: path.join(dir, "book"),
    bookTitle: "测试",
    format: "txt",
    source: {
      fileName: "a.txt",
      bytes: new TextEncoder().encode("原文"),
      encoding: "utf-8",
      eol: "lf",
    },
    importSettings: {
      splitMode: "auto",
      paragraphMode: "line",
      headingLevel: 0,
      boundaries: Array.from({ length: count }, (_, i) => i),
    },
    chapters: Array.from({ length: count }, (_, i) => ({
      title: `第${i + 1}章 旧标题`,
      body,
      kind: "chapter" as const,
    })),
  });
  const chapters = await Promise.all(
    workspace.book.chapterOrder.map((id) =>
      readChapterFile(workspace.root, workspace.book, id),
    ),
  );
  const options = DEFAULT_TITLE_OPTIONS;
  const spec = buildTaskSpec({
    workspaceId: workspace.book.workspaceId,
    type: "generate_title",
    chapterIds: workspace.book.chapterOrder,
    inputHashes: Object.fromEntries(
      chapters.map((c) => [c.chapterId, c.bodyHash]),
    ),
    options: {
      generateOptions: JSON.stringify(options),
      ...Object.fromEntries(
        chapters.map((c) => [`sourceTitle:${c.chapterId}`, c.title.source]),
      ),
    },
    profileVersion: GENERATE_PROFILE_VERSION,
    modelConfigId: "fixture-model",
  });
  const taskStore = await TaskStore.create(workspace.root, spec);
  return { workspace, chapters, spec, taskStore };
}
function adapter(fail?: "missing" | "length", seen?: string[]): Adapter {
  return {
    async complete(messages) {
      const prompt = JSON.parse(messages[1].content!);
      if (messages.at(-1)?.role === "tool")
        return { content: "完成", calls: [], finishReason: "stop" };
      seen?.push(prompt.mode);
      if (fail)
        return {
          content: "完成",
          calls: [],
          finishReason: fail === "length" ? "length" : "stop",
        };
      const notes = prompt.mode.startsWith("仅");
      return {
        content: "",
        calls: [
          {
            id: "call",
            type: "function",
            function: {
              name: notes ? "submit_summary" : "submit_titles",
              arguments: JSON.stringify({
                chapterId: prompt.chapterId,
                inputHash: prompt.inputHash,
                ...(notes
                  ? { summary: "他们走入树林，听见风声。" }
                  : { titles: ["林间来客", "风起林深", "远途初行"] }),
              }),
            },
          },
        ],
        finishReason: "tool_calls",
      };
    },
  };
}
const execute = (
  f: Awaited<ReturnType<typeof fixture>>,
  a: Adapter,
  signal = new AbortController().signal,
) => runGenerateTask({ ...f, adapter: a, signal });
test("P4 Unicode、非法输出及分块覆盖", () => {
  assert.equal(
    validateText("中😀文", { minLength: 3, maxLength: 3 }),
    "中😀文",
  );
  assert.throws(() => validateTitle("第一章 风声", DEFAULT_TITLE_OPTIONS));
  assert.throws(() =>
    validateTitles(["风声", "风声", "林间"], DEFAULT_TITLE_OPTIONS),
  );
  assert.throws(() => validateText("短", DEFAULT_SUMMARY_OPTIONS));
  const source = "😀".repeat(12001);
  assert.equal(chunkBody(source).join(""), source);
  assert.deepEqual(
    chunkBody(source).map((x) => [...x].length),
    [6000, 6000, 1],
  );
});
test("P4 产物独立持久化、选标题和原标题保留不改正文", async (t) => {
  const f = await fixture(t);
  assert.equal((await execute(f, adapter())).status, "completed");
  const artifacts = await listArtifacts(
    f.workspace.root,
    f.chapters[0].chapterId,
  );
  assert.equal(artifacts.length, 1);
  assert.equal(
    (await TaskStore.open(f.workspace.root, f.spec.taskId)).getCheckpoint(
      f.chapters[0].chapterId,
    ).status,
    "completed",
  );
  const ws = {
    currentWorkspace: () => f.workspace,
    updateChapterCache: () => {},
  } as unknown as WorkspaceService;
  const service = new GenerateService(ws, new TaskService(ws), async () =>
    adapter(),
  );
  const c = f.chapters[0];
  let view = await service.selectTitle({
    chapterId: c.chapterId,
    artifactId: artifacts[0].artifactId,
    candidateIndex: 0,
    expectedBodyHash: c.bodyHash,
    expectedTitleRevision: c.titleRevision,
  });
  assert.equal(view.currentTitle, "第1章 林间来客");
  assert.equal(view.bodyHash, c.bodyHash);
  assert.equal(view.artifacts[0].stale, false);
  view = await service.selectTitle({
    chapterId: c.chapterId,
    artifactId: artifacts[0].artifactId,
    candidateIndex: -1,
    expectedBodyHash: c.bodyHash,
    expectedTitleRevision: view.titleRevision,
  });
  assert.equal(view.currentTitle, c.title.source);
  const current = await readChapterFile(
    f.workspace.root,
    f.workspace.book,
    c.chapterId,
  );
  assert.equal(current.bodyRevision, c.bodyRevision);
  await assert.rejects(
    saveArtifact(f.workspace.root, { ...artifacts[0], titles: undefined }),
    { code: "INVALID_ARTIFACT" },
  );
});
test("P4 无产物/截断不完成，可重试且不重复已完成章节", async (t) => {
  const f = await fixture(t, "正文", 2);
  assert.equal((await execute(f, adapter("missing"))).status, "failed");
  assert.equal((await execute(f, adapter("length"))).status, "failed");
  assert.equal((await execute(f, adapter())).status, "completed");
  let calls = 0;
  const noCall: Adapter = {
    async complete() {
      calls++;
      throw Error("不能重做");
    },
  };
  assert.equal((await execute(f, noCall)).status, "completed");
  assert.equal(calls, 0);
});
test("P4 长章先完整分块提要，再生成标题", async (t) => {
  const f = await fixture(t, "树林中风声响起。".repeat(1800));
  const seen: string[] = [];
  assert.equal(
    (await execute(f, adapter(undefined, seen))).status,
    "completed",
  );
  assert.equal(seen.length, chunkBody(f.chapters[0].body).length + 1);
  assert.equal(
    seen.slice(0, -1).every((s) => s.startsWith("仅")),
    true,
  );
  assert.equal(
    (await listArtifacts(f.workspace.root, f.chapters[0].chapterId)).length,
    1,
  );
});
test("P4 取消保留先前提交，剩余章节取消", async (t) => {
  const f = await fixture(t, "正文", 2);
  const controller = new AbortController();
  await runGenerateTask({
    ...f,
    adapter: adapter(),
    signal: controller.signal,
    emit: (e) => {
      if (e.state === "completed") controller.abort();
    },
  });
  assert.equal(
    f.taskStore.getCheckpoint(f.chapters[0].chapterId).status,
    "completed",
  );
  assert.equal(
    f.taskStore.getCheckpoint(f.chapters[1].chapterId).status,
    "cancelled",
  );
  assert.equal(
    (await listArtifacts(f.workspace.root, f.chapters[0].chapterId)).length,
    1,
  );
});

test("P4 来源变化保留旧产物并在正文回退后恢复一致；选项指纹隔离", async (t) => {
  const f = await fixture(t);
  await execute(f, adapter());
  const c = f.chapters[0];
  const ws = {
    currentWorkspace: () => f.workspace,
    updateChapterCache: () => {},
  } as unknown as WorkspaceService;
  const service = new GenerateService(ws, new TaskService(ws), async () =>
    adapter(),
  );
  let edited = await saveChapterBody(
    f.workspace.root,
    c.chapterId,
    "后续正文",
    c.bodyRevision,
  );
  assert.equal(
    (await service.chapter({ chapterId: c.chapterId })).artifacts[0].stale,
    true,
  );
  await saveChapterBody(
    f.workspace.root,
    c.chapterId,
    c.body,
    edited.bodyRevision,
  );
  assert.equal(
    (await service.chapter({ chapterId: c.chapterId })).artifacts[0].stale,
    false,
  );
  const changed = buildTaskSpec({
    workspaceId: f.spec.workspaceId,
    type: f.spec.type,
    chapterIds: f.spec.chapterIds,
    inputHashes: f.spec.inputHashes,
    profileVersion: f.spec.profileVersion,
    modelConfigId: f.spec.modelConfigId,
    options: {
      ...f.spec.options,
      generateOptions: JSON.stringify({
        ...DEFAULT_TITLE_OPTIONS,
        style: "悬念",
      }),
    },
  });
  assert.notEqual(changed.inputFingerprint, f.spec.inputFingerprint);
});
test("P4 摘要独立、重开恢复、损坏产物报错", async (t) => {
  const f = await fixture(t);
  const spec = buildTaskSpec({
    workspaceId: f.spec.workspaceId,
    type: "generate_summary",
    chapterIds: f.spec.chapterIds,
    inputHashes: f.spec.inputHashes,
    options: {
      ...f.spec.options,
      generateOptions: JSON.stringify({ minLength: 4, maxLength: 100 }),
    },
    profileVersion: GENERATE_PROFILE_VERSION,
  });
  const taskStore = await TaskStore.create(f.workspace.root, spec);
  const a: Adapter = {
    async complete(messages) {
      const p = JSON.parse(messages[1].content!);
      return messages.at(-1)?.role === "tool"
        ? { content: "完成", calls: [], finishReason: "stop" }
        : {
            content: "",
            calls: [
              {
                id: "x",
                type: "function",
                function: {
                  name: "submit_summary",
                  arguments: JSON.stringify({
                    chapterId: p.chapterId,
                    inputHash: p.inputHash,
                    summary: "他们走进树林，听见风声。",
                  }),
                },
              },
            ],
            finishReason: "tool_calls",
          };
    },
  };
  assert.equal(
    (
      await runGenerateTask({
        workspace: f.workspace,
        spec,
        taskStore,
        adapter: a,
        signal: new AbortController().signal,
      })
    ).status,
    "completed",
  );
  const saved = (
    await listArtifacts(f.workspace.root, f.chapters[0].chapterId)
  )[0];
  assert.equal(saved.summary, "他们走进树林，听见风声。");
  assert.equal(
    (
      await readChapterFile(
        f.workspace.root,
        f.workspace.book,
        f.chapters[0].chapterId,
      )
    ).body,
    f.chapters[0].body,
  );
  assert.equal(
    (await TaskStore.open(f.workspace.root, spec.taskId)).getCheckpoint(
      f.chapters[0].chapterId,
    ).status,
    "completed",
  );
  await fs.writeFile(
    path.join(f.workspace.root, "generated", saved.artifactId + ".json"),
    "{broken",
  );
  await assert.rejects(
    listArtifacts(f.workspace.root, f.chapters[0].chapterId),
    { code: "INVALID_ARTIFACT" },
  );
});

test("P4 独立摘要导出按所选章序，且不写入正文", async (t) => {
  const f = await fixture(t, "正文", 2);
  const { dialog } = await import("electron");
  const { randomUUID } = await import("node:crypto");
  const target = path.join(f.workspace.root, "output", "summaries.txt");
  (
    dialog as unknown as { showSaveDialog: () => Promise<unknown> }
  ).showSaveDialog = async () => ({ canceled: false, filePath: target });
  for (const c of f.chapters)
    await saveArtifact(f.workspace.root, {
      schemaVersion: 1,
      artifactId: randomUUID(),
      workspaceId: f.spec.workspaceId,
      taskId: f.spec.taskId,
      chapterId: c.chapterId,
      kind: "summary",
      sourceBodyHash: c.bodyHash,
      inputFingerprint: f.spec.inputFingerprint,
      sourceTitle: c.title.source,
      profileVersion: GENERATE_PROFILE_VERSION,
      options: { minLength: 1, maxLength: 100 },
      summary: `独立摘要${c.order}`,
      createdAt: new Date().toISOString(),
    });
  const ws = {
    currentWorkspace: () => f.workspace,
    updateChapterCache: () => {},
  } as unknown as WorkspaceService;
  const service = new GenerateService(ws, new TaskService(ws), async () =>
    adapter(),
  );
  assert.equal(
    (await service.exportSummaries([f.chapters[1].chapterId], null)).cancelled,
    false,
  );
  const text = await fs.readFile(target, "utf8");
  assert.match(text, /第2章/);
  assert.doesNotMatch(text, /第1章/);
  assert.equal(
    (
      await readChapterFile(
        f.workspace.root,
        f.workspace.book,
        f.chapters[1].chapterId,
      )
    ).body,
    "正文",
  );
});

test("P4 长摘要中间块失败不落最终产物，重试覆盖全章", async (t) => {
  const f = await fixture(t, "第一段树林。".repeat(2400));
  const spec = buildTaskSpec({
    workspaceId: f.spec.workspaceId,
    type: "generate_summary",
    chapterIds: f.spec.chapterIds,
    inputHashes: f.spec.inputHashes,
    options: {
      ...f.spec.options,
      generateOptions: JSON.stringify({ minLength: 4, maxLength: 100 }),
    },
    profileVersion: GENERATE_PROFILE_VERSION,
  });
  const taskStore = await TaskStore.create(f.workspace.root, spec);
  let shouldFail = true;
  let blocks: string[] = [];
  let finalInputs: string[] = [];
  const a: Adapter = {
    async complete(messages) {
      if (messages.at(-1)?.role === "tool")
        return { content: "已提交", calls: [], finishReason: "stop" };
      const p = JSON.parse(messages[1].content!);
      const local = p.mode.startsWith("仅");
      if (local) {
        blocks.push(p.body);
        if (shouldFail && blocks.length === 2)
          return { content: "无法提交", calls: [], finishReason: "stop" };
      } else finalInputs.push(p.body);
      return {
        content: "",
        calls: [
          {
            id: "summary",
            type: "function",
            function: {
              name: "submit_summary",
              arguments: JSON.stringify({
                chapterId: p.chapterId,
                inputHash: p.inputHash,
                summary: local
                  ? `局部要点${blocks.length}：人物进入树林。`
                  : "人物走进树林，沿途察看林中景物。",
              }),
            },
          },
        ],
        finishReason: "tool_calls",
      };
    },
  };
  const run = () =>
    runGenerateTask({
      workspace: f.workspace,
      spec,
      taskStore,
      adapter: a,
      signal: new AbortController().signal,
    });
  assert.equal((await run()).status, "failed");
  assert.equal(blocks.length, 2);
  assert.equal(finalInputs.length, 0);
  assert.equal(
    taskStore.getCheckpoint(f.chapters[0].chapterId).errorCode,
    "NO_ARTIFACT",
  );
  assert.equal(await taskStore.readArtifact(f.chapters[0].chapterId), null);
  assert.equal(
    (await listArtifacts(f.workspace.root, f.chapters[0].chapterId)).length,
    0,
  );
  shouldFail = false;
  blocks = [];
  assert.equal((await run()).status, "completed");
  assert.deepEqual(blocks, chunkBody(f.chapters[0].body));
  assert.equal(finalInputs.length, 1);
  for (let i = 1; i <= blocks.length; i++)
    assert.match(finalInputs[0], new RegExp(`局部要点${i}`));
  const artifacts = await listArtifacts(
    f.workspace.root,
    f.chapters[0].chapterId,
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "summary");
  assert.equal(artifacts[0].summary, "人物走进树林，沿途察看林中景物。");
  assert.equal(
    taskStore.getCheckpoint(f.chapters[0].chapterId).completedBlockIds.length,
    blocks.length,
  );
});

test("P4 服务失败事件保留错误码，收到终态即可继续成功", async (t) => {
  const f = await fixture(t);
  let failing = true;
  const ws = {
    currentWorkspace: () => f.workspace,
    updateChapterCache: () => {},
  } as unknown as WorkspaceService;
  const service = new GenerateService(ws, new TaskService(ws), async () =>
    failing ? adapter("missing") : adapter(),
  );
  let retry: Promise<{ taskId: string }> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    service.onEvent((event) => {
      if (event.type !== "taskStateChanged") return;
      if (event.state === "failed") {
        try {
          assert.match(event.message, /NO_ARTIFACT/);
        } catch (e) {
          reject(e);
          return;
        }
        failing = false;
        retry = service.resume(event.taskId);
        retry.catch(reject);
      } else if (event.state === "completed") resolve();
    });
  });
  await service.start({
    kind: "title",
    chapterIds: f.spec.chapterIds,
    options: DEFAULT_TITLE_OPTIONS,
  });
  await done;
  assert.ok(retry);
  assert.equal(
    (await service.chapter({ chapterId: f.chapters[0].chapterId })).artifacts
      .length,
    1,
  );
});

test("P4 模型或 Profile 改变后拒绝继续旧任务", async (t) => {
  const f = await fixture(t);
  const ws = {
    currentWorkspace: () => f.workspace,
    updateChapterCache: () => {},
  } as unknown as WorkspaceService;
  let adapterCalls = 0;
  const service = new GenerateService(
    ws,
    new TaskService(ws),
    async () => {
      adapterCalls++;
      return adapter();
    },
    async () => "different-model",
  );
  await assert.rejects(service.resume(f.spec.taskId), {
    code: "MODEL_CHANGED",
  });
  assert.equal(adapterCalls, 0);
  const old = buildTaskSpec({
    workspaceId: f.spec.workspaceId,
    type: f.spec.type,
    chapterIds: f.spec.chapterIds,
    inputHashes: f.spec.inputHashes,
    options: f.spec.options,
    profileVersion: "generate-old",
    modelConfigId: "different-model",
  });
  await TaskStore.create(f.workspace.root, old);
  await assert.rejects(service.resume(old.taskId), { code: "PROFILE_CHANGED" });
  assert.equal(adapterCalls, 0);
  assert.equal(
    (await TaskStore.open(f.workspace.root, f.spec.taskId)).getCheckpoint(
      f.chapters[0].chapterId,
    ).status,
    "queued",
  );
  assert.equal(
    (await TaskStore.open(f.workspace.root, old.taskId)).getCheckpoint(
      f.chapters[0].chapterId,
    ).status,
    "queued",
  );
});
