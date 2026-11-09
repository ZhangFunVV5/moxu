import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { proposeTask } from "../src/agent/tasks/task-proposal";
import { pipelineStartSchema } from "../src/shared/pipeline-contracts";
import { defaultFormatOptions } from "../src/shared/format-options";
import { PipelineService } from "../src/main/services/pipeline-service";
import {
  createWorkspace,
  saveChapterBody,
} from "../src/core/workspace/book-store";
import type { WorkspaceService } from "../src/main/services/workspace-service";
import type { ProofreadService } from "../src/main/services/proofread-service";
import type { GenerateService } from "../src/main/services/generate-service";
import type { FormatService } from "../src/main/services/format-service";
test("P5 提案保留范围、否定与参数，拒绝权限和路径", () => {
  const p = proposeTask(
    "不精校，只排版不要缩进，段间两空行，不要生成章名，不要梗概",
    ["b", "a"],
  );
  assert.equal(p.kind, "ready");
  if (p.kind === "ready") {
    assert.equal(p.request.proofread, undefined);
    assert.equal(p.request.title, undefined);
    assert.equal(p.request.summary, undefined);
    assert.deepEqual(p.request.chapterIds, ["b", "a"]);
    assert.equal(p.request.format?.options.indent, "none");
    assert.equal(p.request.format?.options.paragraphBlankLines, 2);
  }
  const s = proposeTask("摘要50字", ["a"]);
  assert.equal(s.kind, "ready");
  if (s.kind === "ready") assert.equal(s.request.summary?.maxLength, 50);
  assert.equal(
    pipelineStartSchema.safeParse({
      chapterIds: ["a"],
      format: { options: defaultFormatOptions, outputFormat: "txt" },
      permissions: { canWriteBody: true },
    }).success,
    false,
  );
  assert.equal(proposeTask("扩写然后精校", ["a"]).kind, "clarification");
});
test("P5 仅排版无需模型，恢复重建同指纹，正文修改拒绝混合恢复", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "pipeline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const w = await createWorkspace({
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
    chapters: [{ title: "一", body: "正文", kind: "chapter" }],
  });
  const workspace = {
    currentWorkspace: () => w,
  } as unknown as WorkspaceService;
  let modelCalls = 0;
  const proof = {
    start() {
      modelCalls++;
      throw Error("不应调用模型");
    },
  } as unknown as ProofreadService;
  const gen = proof as unknown as GenerateService;
  let exports = 0;
  let token = "";
  const fingerprint = "a".repeat(64);
  const format = {
    async preview() {
      token = randomUUID();
      return { token, inputFingerprint: fingerprint };
    },
    async status(given: string) {
      if (given !== token) throw Error("missing");
      return { stale: false };
    },
    async export() {
      exports++;
      return { cancelled: exports === 1, path: "out.txt" };
    },
  } as unknown as FormatService;
  const service = new PipelineService(workspace, proof, gen, format);
  const r = await service.start({
    chapterIds: w.book.chapterOrder,
    format: { options: defaultFormatOptions, outputFormat: "txt" },
    export: true,
  });
  const until = async (s: PipelineService, state: string) => {
    for (let i = 0; i < 100; i++) {
      const v = (await s.list()).find((x) => x.pipelineId === r.pipelineId)!;
      if (v.state === state) return v;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("timeout");
  };
  await until(service, "cancelled");
  token = "";
  const reopened = new PipelineService(workspace, proof, gen, format);
  await reopened.resume({ pipelineId: r.pipelineId });
  const result = await until(reopened, "completed");
  assert.equal(result.outputPath, "out.txt");
  assert.equal(modelCalls, 0);
  assert.equal(exports, 2);
  exports = 0;
  const second = await reopened.start({
    chapterIds: w.book.chapterOrder,
    format: { options: defaultFormatOptions, outputFormat: "txt" },
    export: true,
  });
  const waitSecond = async (state: string) => {
    for (let i = 0; i < 100; i++) {
      const v = (await reopened.list()).find(
        (x) => x.pipelineId === second.pipelineId,
      )!;
      if (v.state === state) return v;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("timeout");
  };
  await waitSecond("cancelled");
  await saveChapterBody(w.root, w.book.chapterOrder[0], "新的正文", 1);
  await reopened.resume({ pipelineId: second.pipelineId });
  const failed = await waitSecond("failed");
  assert.match(failed.error!, /快照已变化/);
  assert.equal(exports, 1);
});
