import { promises as fs } from "node:fs";
import path from "node:path";
import { dialog, type BrowserWindow } from "electron";
import type { Adapter } from "../../agent/model/model-adapter";
import { TaskStore } from "../../agent/tasks/task-store";
import { loadTaskSpec } from "../../agent/tasks/task-types";
import { GENERATE_PROFILE_VERSION, GenerateError } from "../../shared/generate";
import {
  generateStartRequestSchema,
  generateSelectTitleRequestSchema,
  type GenerateStartRequest,
  type GenerateSelectTitleRequest,
  type GenerateEventDto,
  type ChapterGenerateView,
  type GenerateSummaryDto,
} from "../../shared/generate-contracts";
import {
  readChapterFile,
  readBookFile,
  withChapterWriteLock,
  writeChapterFile,
  type Workspace,
} from "../../core/workspace/book-store";
import { writeFileAtomic } from "../../core/workspace/atomic-file";
import {
  canonicalExportPath,
  isProtectedWorkspacePath,
} from "../../core/format/export-path";
import { sha256Hex } from "../../core/text/hash";
import { runGenerateTask } from "../../core/generate/engine";
import { listArtifacts } from "../../core/generate/store";
import { validateTitle, chapterPrefix } from "../../core/generate/validate";
import type { WorkspaceService } from "./workspace-service";
import type { TaskService } from "./task-service";
export class GenerateService {
  private active: { taskId: string; controller: AbortController } | null = null;
  private preparing = false;
  private listeners = new Set<(event: GenerateEventDto) => void>();
  constructor(
    private workspace: WorkspaceService,
    private taskService: TaskService,
    private adapterProvider: () => Promise<Adapter>,
    private modelIdProvider?: () => Promise<string | undefined>,
  ) {}
  onEvent(listener: (event: GenerateEventDto) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: GenerateEventDto) {
    for (const listener of this.listeners)
      try {
        listener(event);
      } catch {}
  }
  private current() {
    const workspace = this.workspace.currentWorkspace();
    if (!workspace) throw new GenerateError("NO_WORKSPACE", "尚未打开作品");
    return workspace;
  }
  private assertCurrent(workspace: Workspace) {
    if (
      this.workspace.currentWorkspace()?.book.workspaceId !==
      workspace.book.workspaceId
    )
      throw new GenerateError("SOURCE_CHANGED", "作品已切换");
  }
  async start(raw: GenerateStartRequest) {
    if (this.active || this.preparing)
      throw new GenerateError("TASK_BUSY", "已有生成任务正在运行");
    this.preparing = true;
    try {
      const request = generateStartRequestSchema.parse(raw);
      const workspace = this.current();
      const adapter = await this.adapterProvider();
      const modelConfigId = await this.modelIdProvider?.();
      const sourceTitles: Record<string, string> = {};
      for (const id of request.chapterIds) {
        const c = await readChapterFile(workspace.root, workspace.book, id);
        sourceTitles[`sourceTitle:${id}`] = c.title.source;
      }
      this.assertCurrent(workspace);
      const { spec } = await this.taskService.createSpec({
        type: request.kind === "title" ? "generate_title" : "generate_summary",
        chapterIds: request.chapterIds,
        options: {
          generateOptions: JSON.stringify(request.options),
          ...sourceTitles,
        },
        profileVersion: GENERATE_PROFILE_VERSION,
        modelConfigId,
      });
      const store = await TaskStore.create(workspace.root, spec);
      this.assertCurrent(workspace);
      this.launch(workspace, spec, store, adapter);
      return { taskId: spec.taskId };
    } finally {
      this.preparing = false;
    }
  }
  private launch(
    workspace: Workspace,
    spec: import("../../shared/task").TaskSpec,
    store: TaskStore,
    adapter: Adapter,
  ) {
    const controller = new AbortController();
    this.active = { taskId: spec.taskId, controller };
    let lastError = "";
    const emit = (event: Omit<GenerateEventDto, "workspaceId" | "taskId">) => {
      if (event.state === "failed") lastError = event.message;
      this.emit({
        ...event,
        workspaceId: spec.workspaceId,
        taskId: spec.taskId,
      });
    };
    emit({ type: "taskStarted", state: "running", message: "生成任务开始" });
    void runGenerateTask({
      workspace,
      spec,
      taskStore: store,
      adapter,
      signal: controller.signal,
      emit,
    })
      .then((result) => {
        if (this.active?.taskId === spec.taskId) this.active = null;
        emit({
          type: "taskStateChanged",
          state: result.status,
          message:
            result.status === "failed"
              ? lastError
              : `生成任务 ${result.status}`,
        });
      })
      .catch((error) => {
        if (this.active?.taskId === spec.taskId) this.active = null;
        emit({
          type: "taskStateChanged",
          state: "failed",
          message: error instanceof Error ? error.message : "生成失败",
        });
      })
      .finally(() => {
        if (this.active?.taskId === spec.taskId) this.active = null;
      });
  }
  async resume(taskId: string) {
    if (this.active || this.preparing)
      throw new GenerateError("TASK_BUSY", "已有生成任务正在运行");
    this.preparing = true;
    try {
      const workspace = this.current();
      const spec = await loadTaskSpec(workspace.root, taskId);
      if (
        !["generate_title", "generate_summary"].includes(spec.type) ||
        spec.workspaceId !== workspace.book.workspaceId
      )
        throw new GenerateError("TASK_NOT_FOUND", "任务不属于本作品");
      if (spec.profileVersion !== GENERATE_PROFILE_VERSION)
        throw new GenerateError(
          "PROFILE_CHANGED",
          "生成 Profile 已更新，请新建任务",
        );
      if (this.modelIdProvider) {
        const currentModelId = await this.modelIdProvider();
        if (currentModelId !== spec.modelConfigId)
          throw new GenerateError(
            "MODEL_CHANGED",
            "模型配置已变化，请新建任务",
          );
      }
      const store = await TaskStore.open(workspace.root, taskId);
      await store.recover();
      const adapter = await this.adapterProvider();
      this.assertCurrent(workspace);
      this.launch(workspace, spec, store, adapter);
      return { taskId };
    } finally {
      this.preparing = false;
    }
  }
  cancel(taskId: string): null {
    if (this.active?.taskId !== taskId)
      throw new GenerateError("TASK_NOT_FOUND", "没有正在运行的该任务");
    this.active.controller.abort();
    return null;
  }
  async chapter({
    chapterId,
  }: {
    chapterId: string;
  }): Promise<ChapterGenerateView> {
    const w = this.current();
    if (!w.book.chapterOrder.includes(chapterId))
      throw new GenerateError("FORBIDDEN_RANGE", "章节不属于当前作品");
    const c = await readChapterFile(w.root, w.book, chapterId);
    const artifacts = await listArtifacts(w.root, chapterId);
    const selection = await fs
      .readFile(
        path.join(w.root, "generated", `selection-${chapterId}.json`),
        "utf8",
      )
      .then((s) => JSON.parse(s) as { artifactId: string; title: string })
      .catch(() => null);
    return {
      chapterId,
      currentTitle: c.title.current,
      titleRevision: c.titleRevision,
      bodyHash: c.bodyHash,
      artifacts: artifacts.map((a) => ({
        ...a,
        stale:
          a.sourceBodyHash !== c.bodyHash || a.sourceTitle !== c.title.source,
      })),
      selectedArtifactId:
        selection?.title === c.title.current ? selection.artifactId : undefined,
      selectedTitle:
        selection?.title === c.title.current ? selection.title : undefined,
    };
  }
  async selectTitle(raw: GenerateSelectTitleRequest) {
    const r = generateSelectTitleRequestSchema.parse(raw);
    const w = this.current();
    const artifact = (await listArtifacts(w.root, r.chapterId)).find(
      (a) => a.artifactId === r.artifactId && a.kind === "title",
    );
    if (!artifact) throw new GenerateError("ARTIFACT_MISSING", "候选不存在");
    await withChapterWriteLock(w.root, r.chapterId, async () => {
      const c = await readChapterFile(w.root, w.book, r.chapterId);
      if (
        c.bodyHash !== r.expectedBodyHash ||
        c.titleRevision !== r.expectedTitleRevision
      )
        throw new GenerateError("SOURCE_CHANGED", "正文或标题已变化");
      if (
        r.candidateIndex !== -1 &&
        (artifact.sourceBodyHash !== c.bodyHash ||
          artifact.sourceTitle !== c.title.source)
      )
        throw new GenerateError("STALE_ARTIFACT", "候选来源已过期");
      const candidate =
        r.candidateIndex === -1
          ? c.title.source
          : artifact.titles?.[r.candidateIndex];
      if (!candidate) throw new GenerateError("INVALID_TITLE", "候选不存在");
      const title =
        r.candidateIndex === -1 && !r.editedTitle
          ? candidate
          : validateTitle(r.editedTitle ?? candidate, artifact.options);
      const prefix = c.title.source.match(chapterPrefix)?.[0];
      const complete =
        r.candidateIndex === -1 && !r.editedTitle
          ? title
          : prefix
            ? `${prefix} ${title}`
            : title;
      const next = {
        ...c,
        title: { ...c.title, current: complete },
        titleRevision: c.titleRevision + (complete === c.title.current ? 0 : 1),
        updatedAt: new Date().toISOString(),
      };
      await writeChapterFile(w.root, next);
      await writeFileAtomic(
        path.join(w.root, "generated", `selection-${r.chapterId}.json`),
        JSON.stringify({ artifactId: r.artifactId, title: complete }),
      );
      this.workspace.updateChapterCache(next);
    });
    return this.chapter({ chapterId: r.chapterId });
  }
  async summary(): Promise<GenerateSummaryDto> {
    const w = this.current();
    const chapters = [];
    for (const id of w.book.chapterOrder) {
      const view = await this.chapter({ chapterId: id });
      chapters.push({
        chapterId: id,
        titleCount: view.artifacts.filter((a) => a.kind === "title").length,
        hasSummary: view.artifacts.some((a) => a.kind === "summary"),
        stale: view.artifacts.some((a) => a.stale),
      });
    }
    const tasks: GenerateSummaryDto["tasks"] = [];
    for (const id of await fs
      .readdir(path.join(w.root, "tasks"))
      .catch(() => [])) {
      try {
        const spec = await loadTaskSpec(w.root, id);
        if (!["generate_title", "generate_summary"].includes(spec.type))
          continue;
        const store = await TaskStore.open(w.root, id);
        const states = Object.values(store.snapshot.chapters).map(
          (c) => c.status,
        );
        const state = states.includes("running")
          ? "running"
          : states.includes("failed")
            ? "failed"
            : states.includes("cancelled")
              ? "cancelled"
              : states.includes("interrupted")
                ? "interrupted"
                : states.includes("queued")
                  ? "queued"
                  : "completed";
        tasks.push({
          taskId: id,
          kind: spec.type === "generate_title" ? "title" : "summary",
          state,
          chapterIds: spec.chapterIds,
        });
      } catch {}
    }
    return { chapters, tasks };
  }
  async recover() {
    if (this.active || this.preparing) return { interrupted: [] };
    const w = this.current();
    const interrupted: string[] = [];
    for (const task of (await this.summary()).tasks) {
      const store = await TaskStore.open(w.root, task.taskId);
      const report = await store.recover();
      if (report.interrupted.length) interrupted.push(task.taskId);
    }
    return { interrupted };
  }
  async exportSummaries(
    chapterIds: readonly string[],
    parent: BrowserWindow | null,
  ) {
    const w = this.current();
    if (chapterIds.some((id) => !w.book.chapterOrder.includes(id)))
      throw new GenerateError("FORBIDDEN_RANGE", "导出范围无效");
    const sections: string[] = [];
    for (const id of w.book.chapterOrder.filter((id) =>
      chapterIds.includes(id),
    )) {
      const view = await this.chapter({ chapterId: id });
      const summary = view.artifacts.find((a) => a.kind === "summary");
      if (summary)
        sections.push(
          `${view.currentTitle}${summary.stale ? "（来源已过期）" : ""}\n${summary.summary}`,
        );
    }
    if (!sections.length)
      throw new GenerateError("ARTIFACT_MISSING", "所选范围没有摘要");
    const text = sections.join("\n\n");
    const options = {
      title: "独立导出摘要",
      defaultPath: `${w.book.bookTitle}-摘要.txt`,
      filters: [{ name: "文本", extensions: ["txt"] }],
    };
    const chosen = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const target = path.resolve(chosen.filePath);
    if (
      isProtectedWorkspacePath(
        await fs.realpath(w.root),
        await canonicalExportPath(target),
      )
    )
      throw new GenerateError("EXPORT_FAILED", "不能覆盖工作区事实源");
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && sha256Hex(existing) === w.book.source.sha256)
      throw new GenerateError("EXPORT_FAILED", "不能覆盖原输入文件");
    await writeFileAtomic(target, text);
    return { cancelled: false, path: target };
  }
}
