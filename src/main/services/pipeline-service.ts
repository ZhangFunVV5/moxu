import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { writeFileAtomic } from "../../core/workspace/atomic-file";
import { bookMetadataOf } from "../../shared/book";
import {
  readChapterFile,
  type Workspace,
} from "../../core/workspace/book-store";
import { loadTaskSpec } from "../../agent/tasks/task-types";
import { TaskStore } from "../../agent/tasks/task-store";
import { proposeTask } from "../../agent/tasks/task-proposal";
import {
  pipelineRecordSchema,
  pipelineStartSchema,
  pipelineResumeSchema,
  pipelineIdSchema,
  pipelineProposeSchema,
  type PipelineRecord,
  type PipelineStartRequest,
  type PipelineStage,
} from "../../shared/pipeline-contracts";
import type { WorkspaceService } from "./workspace-service";
import type { ProofreadService } from "./proofread-service";
import type { GenerateService } from "./generate-service";
import type { FormatService } from "./format-service";
export class PipelineError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export class PipelineService {
  private active: {
    record: PipelineRecord;
    workspace: Workspace;
    cancelled: boolean;
    done: Promise<void>;
  } | null = null;
  private preparing = false;
  private records = new Map<string, PipelineRecord>();
  private preparingId: string | null = null;
  private volatileFailures = new Map<string, PipelineRecord>();
  private outcomes = new Map<string, { state: string; message: string }>();
  constructor(
    private workspace: WorkspaceService,
    private proofread: ProofreadService,
    private generate: GenerateService,
    private format: FormatService,
    private parent: () => BrowserWindow | null = () => null,
  ) {
    const watch = (event: {
      taskId: string;
      type: string;
      state?: string;
      message: string;
    }) => {
      if (
        event.type === "taskStateChanged" &&
        event.state &&
        event.state !== "running"
      )
        this.outcomes.set(event.taskId, {
          state: event.state,
          message: event.message,
        });
    };
    proofread.onEvent?.(watch);
    generate.onEvent?.(watch);
  }
  private current() {
    const w = this.workspace.currentWorkspace();
    if (!w) throw new PipelineError("NO_WORKSPACE", "尚未打开作品");
    return w;
  }
  private assertCurrent(w: Workspace) {
    if (
      this.workspace.currentWorkspace()?.book.workspaceId !== w.book.workspaceId
    )
      throw new PipelineError("CONTEXT_CHANGED", "作品已切换，任务停止");
  }
  private file(w: Workspace, id: string) {
    return path.join(w.root, "tasks", `pipeline-${id}.json`);
  }
  /** 终态记录不再占用 active；避免在收尾微任务前误报“已有组合任务运行”。 */
  private releaseFinishedActive(): void {
    const active = this.active;
    if (
      active &&
      ["completed", "failed", "cancelled", "interrupted"].includes(
        active.record.state,
      )
    )
      this.active = null;
  }
  private async save(w: Workspace, r: PipelineRecord) {
    this.records.set(r.pipelineId, r);
    r.updatedAt = new Date().toISOString();
    await writeFileAtomic(
      this.file(w, r.pipelineId),
      JSON.stringify(r, null, 2),
    );
  }
  async propose(raw: unknown) {
    const r = pipelineProposeSchema.parse(raw);
    const w = this.current();
    this.ordered(w, r.chapterIds);
    return proposeTask(r.prompt, r.chapterIds);
  }
  private ordered(w: Workspace, ids: string[]) {
    const sorted = w.book.chapterOrder.filter((id) => ids.includes(id));
    if (sorted.length !== ids.length)
      throw new PipelineError("FORBIDDEN_RANGE", "章节范围无效或重复");
    return sorted;
  }
  async start(raw: PipelineStartRequest) {
    this.releaseFinishedActive();
    if (this.active || this.preparing)
      throw new PipelineError("TASK_BUSY", "已有组合任务运行");
    this.preparing = true;
    try {
      const request = pipelineStartSchema.parse(raw);
      const w = this.current();
      request.chapterIds = this.ordered(w, request.chapterIds);
      // EPUB 元数据在启动时冻结为快照；恢复时沿用，不重新读取可能已变化的设置。
      if (request.format?.outputFormat === "epub" && !request.format.metadata)
        request.format.metadata = bookMetadataOf(w.book);
      const kinds: PipelineStage[] = [];
      if (request.proofread) kinds.push("proofread", "review");
      if (request.title) kinds.push("title");
      if (request.summary) kinds.push("summary");
      if (request.format) kinds.push("format");
      if (request.export) kinds.push("export");
      const r: PipelineRecord = {
        schemaVersion: 1,
        pipelineId: randomUUID(),
        workspaceId: w.book.workspaceId,
        request,
        state: "queued",
        stages: kinds.map((kind) => ({ kind, state: "queued" })),
        updatedAt: new Date().toISOString(),
      };
      this.preparingId = r.pipelineId;
      await this.save(w, r);
      if (!request.proofread)
        r.inputHashes = await this.hashes(w, request.chapterIds);
      await this.save(w, r);
      this.launch(w, r);
      return structuredClone(r);
    } finally {
      this.preparing = false;
      this.preparingId = null;
    }
  }
  async list() {
    const w = this.current();
    const records: PipelineRecord[] = [];
    for (const name of await fs
      .readdir(path.join(w.root, "tasks"))
      .catch(() => [])) {
      if (!/^pipeline-[0-9a-f-]+\.json$/.test(name)) continue;
      const id = name.slice("pipeline-".length, -".json".length);
      const cached = this.records.get(id);
      if (cached && cached.workspaceId === w.book.workspaceId) {
        records.push(structuredClone(this.volatileFailures.get(id) ?? cached));
        continue;
      }
      const r = pipelineRecordSchema.parse(
        JSON.parse(await fs.readFile(path.join(w.root, "tasks", name), "utf8")),
      );
      if (name !== "pipeline-" + r.pipelineId + ".json")
        throw new PipelineError("INVALID_PIPELINE", "任务文件身份不一致");
      this.ordered(w, r.request.chapterIds);
      if (r.workspaceId !== w.book.workspaceId) continue;
      pipelineStartSchema.parse(r.request);
      this.records.set(r.pipelineId, r);
      if (
        (r.state === "running" || r.state === "queued") &&
        this.active?.record.pipelineId !== r.pipelineId &&
        this.preparingId !== r.pipelineId
      ) {
        r.state = "interrupted";
        for (const s of r.stages)
          if (s.state === "running") s.state = "interrupted";
        await this.save(w, r);
      }
      records.push(this.volatileFailures.get(r.pipelineId) ?? r);
    }
    return records;
  }
  async resume(raw: unknown) {
    if (this.preparing) throw new PipelineError("TASK_BUSY", "正在准备任务");
    this.preparing = true;
    try {
      return await this.resumePrepared(raw);
    } finally {
      this.preparing = false;
      this.preparingId = null;
    }
  }
  private async resumePrepared(raw: unknown) {
    const req = pipelineResumeSchema.parse(raw);
    this.releaseFinishedActive();
    if (this.active) throw new PipelineError("TASK_BUSY", "已有组合任务运行");
    const w = this.current();
    const r = (await this.list()).find((x) => x.pipelineId === req.pipelineId);
    if (!r) throw new PipelineError("TASK_NOT_FOUND", "组合任务不存在");
    if (r.state === "completed") return r;
    if (
      r.stages.some((s) => s.kind === "export" && s.state !== "completed") &&
      r.stages.some((s) => s.kind === "format" && s.state === "completed") &&
      !r.previewToken
    ) {
      throw new PipelineError("STALE_PREVIEW", "请重新排版后导出");
    }
    const review = r.stages.find(
      (s) => s.kind === "review" && s.state !== "completed",
    );
    if (
      review &&
      r.stages.find((s) => s.kind === "proofread")?.state === "completed"
    ) {
      const summary = await this.proofread.summary();
      const pending = summary.chapters
        .filter((c) => r.request.chapterIds.includes(c.chapterId))
        .some((c) => c.pending > 0);
      if (pending && !req.continueWithPending)
        throw new PipelineError(
          "REVIEW_REQUIRED",
          "仍有待审意见，可审阅完成或明确基于当前正文继续",
        );
      review.state = "completed";
      r.inputHashes = await this.hashes(w, r.request.chapterIds);
    }
    this.assertCurrent(w);
    this.launch(w, r);
    return structuredClone(r);
  }
  async cancel(raw: unknown) {
    const { pipelineId } = pipelineIdSchema.parse(raw);
    const active = this.active;
    if (!active || active.record.pipelineId !== pipelineId)
      throw new PipelineError("TASK_NOT_FOUND", "组合任务未运行");
    active.cancelled = true;
    const stage = active.record.stages.find((s) => s.state === "running");
    if (stage?.taskId) {
      try {
        if (stage.kind === "proofread") this.proofread.cancel(stage.taskId);
        else this.generate.cancel(stage.taskId);
      } catch {}
    }
    await active.done;
    return null;
  }
  async stop() {
    this.releaseFinishedActive();
    if (this.active)
      await this.cancel({ pipelineId: this.active.record.pipelineId });
  }
  private launch(w: Workspace, r: PipelineRecord) {
    const active = {
      record: r,
      workspace: w,
      cancelled: false,
      done: Promise.resolve(),
    };
    this.active = active;
    active.done = this.execute(w, r, () => active.cancelled)
      .catch((error) => {
        r.state = "failed";
        r.error = `任务状态落盘失败：${error instanceof Error ? error.message : "无法保存"}`;
        this.volatileFailures.set(r.pipelineId, structuredClone(r));
      })
      .finally(() => {
        if (this.active === active) this.active = null;
      });
  }
  private async hashes(w: Workspace, ids: string[]) {
    const entries = await Promise.all(
      ids.map(async (id) => [
        id,
        (await readChapterFile(w.root, w.book, id)).bodyHash,
      ]),
    );
    return Object.fromEntries(entries) as Record<string, string>;
  }
  private async execute(
    w: Workspace,
    r: PipelineRecord,
    cancelled: () => boolean,
  ) {
    try {
      r.state = "running";
      await this.save(w, r);
      for (const stage of r.stages) {
        if (stage.state === "completed") continue;
        this.assertCurrent(w);
        if (cancelled())
          throw new PipelineError("CANCELLED", "任务已取消，已提交结果保留");
        if (r.inputHashes) {
          const hashes = await this.hashes(w, r.request.chapterIds);
          if (JSON.stringify(hashes) !== JSON.stringify(r.inputHashes))
            throw new PipelineError(
              "SOURCE_CHANGED",
              "后续阶段的正文快照已变化，请新建任务",
            );
        }
        if (stage.kind === "review") {
          const summary = await this.proofread.summary();
          const pending = summary.chapters.some(
            (c) => r.request.chapterIds.includes(c.chapterId) && c.pending > 0,
          );
          if (!pending) {
            stage.state = "completed";
            r.inputHashes = await this.hashes(w, r.request.chapterIds);
            await this.save(w, r);
            continue;
          }
          stage.state = "waiting-review";
          r.state = "waiting-review";
          await this.save(w, r);
          return;
        }
        if (
          stage.kind === "title" &&
          stage.taskId &&
          r.request.chapterIds.length > 1
        ) {
          const result = await this.generate.taskResult(stage.taskId);
          if (["completed", "failed"].includes(result.state)) {
            if (result.decision === "pending") {
              stage.state = "waiting-title";
              r.state = "waiting-title";
              await this.save(w, r);
              return;
            }
            if (result.state === "completed") {
              stage.state = "completed";
              await this.save(w, r);
              continue;
            }
          }
        }
        stage.state = "running";
        await this.save(w, r);
        if (
          stage.kind === "proofread" ||
          stage.kind === "title" ||
          stage.kind === "summary"
        ) {
          if (stage.taskId) {
            const spec = await loadTaskSpec(w.root, stage.taskId);
            if (
              spec.workspaceId !== r.workspaceId ||
              JSON.stringify(spec.chapterIds) !==
                JSON.stringify(r.request.chapterIds) ||
              spec.type !==
                (stage.kind === "proofread"
                  ? "proofread"
                  : stage.kind === "title"
                    ? "generate_title"
                    : "generate_summary")
            )
              throw new PipelineError(
                "INVALID_PIPELINE",
                "阶段任务身份或范围不一致",
              );
            this.outcomes.delete(stage.taskId);
            if (stage.kind === "proofread")
              await this.proofread.resume(stage.taskId);
            else await this.generate.resume(stage.taskId);
          } else {
            const result =
              stage.kind === "proofread"
                ? await this.proofread.start({
                    chapterIds: r.request.chapterIds,
                    options: r.request.proofread!,
                  })
                : stage.kind === "title"
                  ? await this.generate.start({
                      kind: "title",
                      chapterIds: r.request.chapterIds,
                      options: r.request.title!,
                    })
                  : await this.generate.start({
                      kind: "summary",
                      chapterIds: r.request.chapterIds,
                      options: r.request.summary!,
                    });
            stage.taskId = result.taskId;
            await this.save(w, r);
          }
          // Existing services own model loops and snapshot recovery. The pipeline only observes persisted checkpoints.
          for (;;) {
            const outcome = this.outcomes.get(stage.taskId);
            if (
              outcome &&
              ["failed", "cancelled", "interrupted"].includes(outcome.state)
            )
              throw new PipelineError("STAGE_FAILED", outcome.message);
            if (cancelled()) {
              try {
                if (stage.kind === "proofread")
                  this.proofread.cancel(stage.taskId);
                else this.generate.cancel(stage.taskId);
              } catch {}
            }
            if (!outcome) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              continue;
            }
            const store = await TaskStore.open(w.root, stage.taskId);
            const states = Object.values(store.snapshot.chapters).map(
              (c) => c.status,
            );
            if (
              outcome &&
              !states.some((s) => s === "running" || s === "queued")
            ) {
              if (
                states.some((s) =>
                  ["failed", "cancelled", "interrupted"].includes(s),
                )
              )
                throw new PipelineError(
                  "STAGE_FAILED",
                  `${stage.kind} 阶段未完成`,
                );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        } else if (stage.kind === "format") {
          const p = await this.format.preview({
            ...r.request.format!,
            chapterIds: r.request.chapterIds,
          });
          r.previewToken = p.token;
          r.formatFingerprint = p.inputFingerprint;
        } else if (stage.kind === "export") {
          if (
            !r.previewToken ||
            (
              await this.format
                .status(r.previewToken)
                .catch(() => ({ stale: true }))
            ).stale
          ) {
            const p = await this.format.preview({
              ...r.request.format!,
              chapterIds: r.request.chapterIds,
            });
            if (p.inputFingerprint !== r.formatFingerprint)
              throw new PipelineError(
                "STALE_PREVIEW",
                "排版输入已变化，请新建排版任务",
              );
            r.previewToken = p.token;
            await this.save(w, r);
          }
          const out = await this.format.export(r.previewToken, this.parent());
          if (out.cancelled)
            throw new PipelineError("CANCELLED", "已取消导出，已有结果保留");
          r.outputPath = out.path;
        }
        if (
          stage.kind === "title" &&
          stage.taskId &&
          r.request.chapterIds.length > 1 &&
          !cancelled()
        ) {
          const result = await this.generate.taskResult(stage.taskId);
          if (result.decision === "pending") {
            stage.state = "waiting-title";
            r.state = "waiting-title";
            await this.save(w, r);
            return;
          }
        }
        if (cancelled())
          throw new PipelineError("CANCELLED", "任务已取消，已提交结果保留");
        stage.state = "completed";
        delete stage.error;
        await this.save(w, r);
      }
      r.state = "completed";
      delete r.error;
      await this.save(w, r);
    } catch (error) {
      const message = error instanceof Error ? error.message : "任务失败";
      r.state =
        cancelled() ||
        (error instanceof PipelineError && error.code === "CANCELLED")
          ? "cancelled"
          : "failed";
      r.error = message;
      const stage = r.stages.find((s) => s.state === "running");
      if (stage) {
        stage.state = r.state;
        stage.error = message;
      }
      await this.save(w, r);
    }
  }
}
