import { promises as fsp } from "node:fs";
import path from "node:path";
import { dialog, type BrowserWindow } from "electron";
import type { Adapter } from "../../agent/model/model-adapter";
import { TaskStore } from "../../agent/tasks/task-store";
import { loadTaskSpec } from "../../agent/tasks/task-types";
import {
  ProofreadError,
  proofreadOptionsFromTaskOptions,
  proofreadOptionsToTaskOptions,
  type ProofreadOptions,
} from "../../shared/proofreading";
import type {
  ChapterProofreadView,
  ProofreadBatchesDto,
  ProofreadEventDto,
  ProofreadReportResult,
  ProofreadStartRequest,
  ProofreadStartResult,
  ProofreadSummaryDto,
} from "../../shared/proofread-contracts";
import type { PrepareTaskRequest } from "../../shared/workspace-contracts";
import type { ChapterFile } from "../../shared/book";
import {
  readBookFile,
  readChapterFile,
  type Workspace,
} from "../../core/workspace/book-store";
import { writeFileAtomic } from "../../core/workspace/atomic-file";
import {
  listBatchesForChapter,
  loadBatch,
} from "../../core/proofread/batch-store";
import {
  applyReviewOperation,
  undoLastReviewOperation,
} from "../../core/proofread/chapter-commit";
import { buildChapterView } from "../../core/proofread/chapter-view";
import {
  chapterProofreadSummary,
  listProofreadTasks,
  recoverProofreadTasks,
  resumeProofreadTask,
  runProofreadTask,
} from "../../core/proofread/proofread-engine";
import { parseProofreadRequest } from "../../core/proofread/request-parser";
import { buildProofreadReport } from "../../core/proofread/report";
import {
  canonicalExportPath,
  isProtectedWorkspacePath,
} from "../../core/format/export-path";
import { sha256Hex } from "../../core/text/hash";
import type { WorkspaceService } from "./workspace-service";
import { TaskService } from "./task-service";

interface ActiveRun {
  taskId: string;
  controller: AbortController;
  root: string;
  workspaceId: string;
}

/**
 * 精校应用服务：GUI／自然语言入口都走到同一个 ProofreadOptions 和 Core；
 * 模型只能提交候选，正式正文写入由审阅动作经章节写队列执行。
 */
export class ProofreadService {
  private active: ActiveRun | null = null;
  private preparing = false;

  private assertWorkspace(workspace: Workspace): void {
    const current = this.workspace.currentWorkspace();
    if (current?.root !== workspace.root || current.book.workspaceId !== workspace.book.workspaceId)
      throw new ProofreadError("STALE_BATCH", "准备任务期间作品已切换，请重新开始");
  }
  private readonly listeners = new Set<(event: ProofreadEventDto) => void>();

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly taskService: TaskService,
    private readonly adapterProvider: () => Promise<Adapter>,
    private readonly modelIdProvider?: () => Promise<string | undefined>,
  ) {}

  onEvent(listener: (event: ProofreadEventDto) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ProofreadEventDto): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不能中断任务落盘。
      }
    }
  }

  private requireWorkspace(): Workspace {
    const workspace = this.workspace.currentWorkspace();
    if (!workspace)
      throw new ProofreadError("NO_ACTIVE_BATCH", "尚未打开作品，不能精校");
    return workspace;
  }

  private assertChapter(workspace: Workspace, chapterId: string): void {
    if (!workspace.book.chapterOrder.includes(chapterId))
      throw new ProofreadError("FORBIDDEN_RANGE", "章节不属于当前作品", chapterId);
  }

  private async adapter(): Promise<Adapter> {
    try {
      return await this.adapterProvider();
    } catch (error) {
      throw new ProofreadError(
        "MODEL_CONFIG_REQUIRED",
        error instanceof Error ? error.message : "请先配置模型",
      );
    }
  }

  /** 审阅决议后同步任务检查点：无待审则 completed，撤回后又出现待审则回 waiting-review。 */
  private async syncCheckpoint(chapterId: string): Promise<void> {
    const workspace = this.workspace.currentWorkspace();
    if (!workspace) return;
    const chapter = await readChapterFile(
      workspace.root,
      workspace.book,
      chapterId,
    ).catch(() => null);
    if (!chapter?.review) return;
    const batch = await loadBatch(workspace.root, chapter.review.batchId).catch(
      () => null,
    );
    if (!batch) return;
    const store = await TaskStore.open(workspace.root, batch.taskId).catch(
      () => null,
    );
    if (!store) return;
    const checkpoint = store.getCheckpoint(chapterId);
    const pending = batch.candidates.filter(
      (candidate) => !chapter.review!.decisions[candidate.patchId],
    ).length;
    if (pending === 0 && checkpoint.status === "waiting-review")
      await store.completeChapter(chapterId).catch(() => undefined);
    else if (pending > 0 && checkpoint.status === "completed")
      await store.setState(chapterId, "waiting-review").catch(() => undefined);
  }

  private async taskStoreForChapter(
    root: string,
    chapter: ChapterFile,
    batchId?: string,
  ): Promise<TaskStore | null> {
    const id = batchId ?? chapter.review?.batchId;
    if (!id) return null;
    try {
      const batch = await loadBatch(root, id);
      return await TaskStore.open(root, batch.taskId);
    } catch {
      return null;
    }
  }

  private resolveOptions(
    request: ProofreadStartRequest,
  ): { options: ProofreadOptions; notes: string[] } {
    let options = request.options;
    let notes: string[] = [];
    if (request.naturalLanguage?.trim()) {
      const parsed = parseProofreadRequest(request.naturalLanguage, options);
      options = parsed.options;
      notes = parsed.notes;
    }
    for (const category of options.autoApplyCategories) {
      if (!options.categories.includes(category))
        throw new ProofreadError(
          "SCHEMA_INVALID",
          "自动应用类别必须包含在已选检查类别中",
          category,
        );
    }
    return { options, notes };
  }

  async start(request: ProofreadStartRequest): Promise<ProofreadStartResult> {
    if (this.active || this.preparing)
      throw new ProofreadError("TASK_BUSY", "已有精校任务正在运行，请等待或取消");
    this.preparing = true;
    try {
      const workspace = this.requireWorkspace();
      const unique = [...new Set(request.chapterIds)];
      if (unique.length !== request.chapterIds.length)
        throw new ProofreadError("SCHEMA_INVALID", "精校范围包含重复章节");
      const chapterIds = workspace.book.chapterOrder.filter((chapterId) =>
        unique.includes(chapterId),
      );
      if (chapterIds.length !== unique.length)
        throw new ProofreadError("FORBIDDEN_RANGE", "精校范围包含不存在章节");
      const resolved = this.resolveOptions(request);
      const modelConfigId = await this.modelIdProvider?.().catch(() => undefined);
      const options: ProofreadOptions = modelConfigId
        ? { ...resolved.options, modelConfigId }
        : resolved.options;
      const notes = resolved.notes;
      const adapter = await this.adapter();
      const prepare: PrepareTaskRequest = {
        type: "proofread",
        chapterIds,
        options: proofreadOptionsToTaskOptions(options),
        profileVersion: options.profileVersion,
        modelConfigId: options.modelConfigId,
      };
      this.assertWorkspace(workspace);
      const { spec } = await this.taskService.createSpec(prepare, {
        autoApplyCategories: options.autoApplyCategories,
      });
      this.assertWorkspace(workspace);
      const store = await TaskStore.create(workspace.root, spec);
      this.assertWorkspace(workspace);
      this.launch({
        workspace,
        spec,
        store,
        adapter,
        options,
        signal: new AbortController().signal,
        resume: false,
        message: "精校任务开始",
      });
      return { taskId: spec.taskId, options, notes };
    } finally {
      this.preparing = false;
    }
  }

  async resume(taskId: string): Promise<{ taskId: string }> {
    if (this.active || this.preparing)
      throw new ProofreadError("TASK_BUSY", "已有精校任务正在运行，请等待或取消");
    this.preparing = true;
    try {
      const workspace = this.requireWorkspace();
      let spec;
      try {
        spec = await loadTaskSpec(workspace.root, taskId);
      } catch {
        throw new ProofreadError("TASK_NOT_FOUND", "精校任务不存在", taskId);
      }
      if (spec.type !== "proofread" || spec.workspaceId !== workspace.book.workspaceId)
        throw new ProofreadError("TASK_NOT_FOUND", "任务不属于当前作品", taskId);
      const store = await TaskStore.open(workspace.root, taskId);
      const options = proofreadOptionsFromTaskOptions(spec.options);
      const adapter = await this.adapter();
      this.assertWorkspace(workspace);
      this.launch({
        workspace,
        spec,
        store,
        adapter,
        options,
        signal: new AbortController().signal,
        resume: true,
        message: "继续精校任务",
      });
      return { taskId };
    } finally {
      this.preparing = false;
    }
  }

  private launch(input: {
    workspace: Workspace;
    spec: import("../../shared/task").TaskSpec;
    store: TaskStore;
    adapter: Adapter;
    options: ProofreadOptions;
    signal: AbortSignal;
    resume: boolean;
    message: string;
  }): void {
    const linked = new AbortController();
    input.signal.addEventListener("abort", () => linked.abort(), { once: true });
    this.active = {
      taskId: input.spec.taskId,
      controller: linked,
      root: input.workspace.root,
      workspaceId: input.workspace.book.workspaceId,
    };
    this.emit({
      taskId: input.spec.taskId,
      workspaceId: input.workspace.book.workspaceId,
      type: "taskStarted",
      message: input.message,
      state: "running",
    });
    const emit = (event: Omit<ProofreadEventDto, "taskId" | "workspaceId">) =>
      this.emit({ taskId: input.spec.taskId, workspaceId: input.workspace.book.workspaceId, ...event });
    void (async () => {
      try {
        const result = input.resume
          ? await resumeProofreadTask({
              workspace: input.workspace,
              taskStore: input.store,
              spec: input.spec,
              adapter: input.adapter,
              signal: linked.signal,
              emit,
            })
          : await runProofreadTask({
              workspace: input.workspace,
              taskStore: input.store,
              spec: input.spec,
              options: input.options,
              adapter: input.adapter,
              signal: linked.signal,
              emit,
            });
        const current = this.workspace.currentWorkspace();
        if (current?.root === input.workspace.root && current.book.workspaceId === input.workspace.book.workspaceId) {
          for (const chapterId of input.spec.chapterIds) {
            const chapter = await readChapterFile(input.workspace.root, input.workspace.book, chapterId).catch(() => null);
            if (chapter && this.workspace.currentWorkspace()?.book.workspaceId === input.workspace.book.workspaceId)
              this.workspace.updateChapterCache(chapter);
          }
        }
        emit({
          type: "taskStateChanged",
          message:
            result.status === "cancelled"
              ? "精校已取消，已保存的候选与正文保持不变"
              : result.autoApplyErrors.length
                ? `精校结束：${result.status}；${result.autoApplyErrors.join("；")}`
                : `精校结束：${result.status}`,
          state: result.status,
        });
      } catch (error) {
        emit({
          type: "taskStateChanged",
          message:
            error instanceof ProofreadError
              ? `${error.code}：${error.message}`
              : error instanceof Error
                ? error.message
                : "精校任务失败",
          state: linked.signal.aborted ? "cancelled" : "failed",
        });
      } finally {
        if (this.active?.taskId === input.spec.taskId) this.active = null;
      }
    })();
  }

  cancel(taskId: string): null {
    if (!this.active || this.active.taskId !== taskId)
      throw new ProofreadError("TASK_NOT_FOUND", "没有正在运行的该精校任务", taskId);
    this.active.controller.abort();
    return null;
  }

  async chapter(request: {
    chapterId: string;
    batchId?: string;
  }): Promise<ChapterProofreadView> {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, request.chapterId);
    const chapter = await readChapterFile(
      workspace.root,
      workspace.book,
      request.chapterId,
    );
    if (this.workspace.currentWorkspace()?.root === workspace.root &&
        this.workspace.currentWorkspace()?.book.workspaceId === workspace.book.workspaceId)
      this.workspace.updateChapterCache(chapter);
    const store = await this.taskStoreForChapter(
      workspace.root,
      chapter,
      request.batchId,
    );
    return buildChapterView({
      root: workspace.root,
      book: workspace.book,
      chapter,
      batchId: request.batchId,
      taskStore: store,
    });
  }

  async batches(chapterId: string): Promise<ProofreadBatchesDto> {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, chapterId);
    const chapter = await readChapterFile(workspace.root, workspace.book, chapterId);
    const batches = await listBatchesForChapter(workspace.root, chapterId);
    return {
      batches: batches.map((batch) => ({
        batchId: batch.batchId,
        taskId: batch.taskId,
        createdAt: batch.createdAt,
        active: chapter.review?.batchId === batch.batchId,
        candidateCount: batch.candidates.length,
      })),
    };
  }

  async summary(): Promise<ProofreadSummaryDto> {
    const workspace = this.requireWorkspace();
    const book = await readBookFile(workspace.root);
    const chapters = [];
    for (const chapterId of book.chapterOrder) {
      const chapter = await readChapterFile(workspace.root, book, chapterId);
      const store = await this.taskStoreForChapter(workspace.root, chapter);
      chapters.push(
        await chapterProofreadSummary(workspace.root, book, chapter, store),
      );
    }
    return {
      chapters,
      tasks: await listProofreadTasks(workspace.root),
    };
  }

  async apply(request: {
    chapterId: string;
    batchId: string;
    operationId: string;
    kind: "accept" | "ignore" | "restore" | "withdraw";
    commands: Array<{
      patchId: string;
      action: "accept" | "ignore" | "restore" | "withdraw";
    }>;
    reviewRevision: number;
    expectedHeadHash: string;
  }): Promise<ChapterProofreadView> {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, request.chapterId);
    const result = await applyReviewOperation(workspace.root, request);
    this.workspace.updateChapterCache(result.chapter);
    await this.syncCheckpoint(request.chapterId);
    return this.chapter({ chapterId: request.chapterId });
  }

  async batchApply(request: {
    chapterId: string;
    batchId: string;
    operationId: string;
    category: "typo" | "wording" | "grammar" | "advertisement";
    action: "accept" | "ignore";
    reviewRevision: number;
    expectedHeadHash: string;
  }): Promise<ChapterProofreadView> {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, request.chapterId);
    const result = await applyReviewOperation(workspace.root, {
      chapterId: request.chapterId,
      operationId: request.operationId,
      kind: request.action === "accept" ? "batch-accept" : "batch-ignore",
      batchId: request.batchId,
      batchCategory: request.category,
      commands: [],
      reviewRevision: request.reviewRevision,
      expectedHeadHash: request.expectedHeadHash,
    });
    this.workspace.updateChapterCache(result.chapter);
    await this.syncCheckpoint(request.chapterId);
    return this.chapter({ chapterId: request.chapterId });
  }

  async undo(request: {
    chapterId: string;
    batchId: string;
    operationId: string;
    undoneOperationId?: string;
    reviewRevision: number;
    expectedHeadHash: string;
  }): Promise<ChapterProofreadView> {
    const workspace = this.requireWorkspace();
    this.assertChapter(workspace, request.chapterId);
    const result = await undoLastReviewOperation(workspace.root, request);
    this.workspace.updateChapterCache(result.chapter);
    await this.syncCheckpoint(request.chapterId);
    return this.chapter({ chapterId: request.chapterId });
  }

  async locate(request: {
    chapterId: string;
    batchId: string;
    patchId: string;
    reviewRevision: number;
    expectedHeadHash: string;
  }): Promise<{ locate: ChapterProofreadView["issues"][number]["locate"]; stale: boolean }> {
    const view = await this.chapter({ chapterId: request.chapterId });
    const stale =
      view.batchId !== request.batchId ||
      view.reviewRevision !== request.reviewRevision ||
      view.expectedHeadHash !== request.expectedHeadHash ||
      view.stale;
    const issue = view.issues.find((item) => item.patchId === request.patchId);
    return { locate: stale ? null : (issue?.locate ?? null), stale };
  }

  async exportReport(
    chapterIds: readonly string[],
    parent: BrowserWindow | null,
  ): Promise<ProofreadReportResult> {
    const workspace = this.requireWorkspace();
    const ordered = workspace.book.chapterOrder.filter((chapterId) =>
      chapterIds.includes(chapterId),
    );
    if (ordered.length === 0)
      throw new ProofreadError("INVALID_REVIEW_STATE", "没有可导出的精校范围");
    const chapters = [];
    for (const chapterId of ordered) {
      const chapter = await readChapterFile(workspace.root, workspace.book, chapterId);
      if (!chapter.review) continue;
      const batch = await loadBatch(workspace.root, chapter.review.batchId).catch(
        () => null,
      );
      if (!batch) continue;
      chapters.push({ chapter, batch });
    }
    if (chapters.length === 0)
      throw new ProofreadError("NO_ACTIVE_BATCH", "所选章节没有可导出的精校批次");
    const text = buildProofreadReport({
      bookTitle: workspace.book.bookTitle,
      chapters,
      generatedAt: new Date().toISOString(),
    });
    const options = {
      title: "导出精校修改报告",
      defaultPath: `${workspace.book.bookTitle}-精校报告.txt`,
      filters: [{ name: "文本报告", extensions: ["txt"] }],
    };
    const chosen = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    const target = path.resolve(chosen.filePath);
    const canonical = await canonicalExportPath(target);
    const root = await fsp.realpath(workspace.root);
    if (isProtectedWorkspacePath(root, canonical))
      throw new ProofreadError(
        "EXPORT_FAILED",
        "不能覆盖工作区源文件、正文或配置，请另存报告",
      );
    const existing = await fsp.readFile(target).catch(() => null);
    if (existing && sha256Hex(existing) === workspace.book.source.sha256)
      throw new ProofreadError("EXPORT_FAILED", "不能覆盖原输入文件，请另存报告");
    await writeFileAtomic(target, text);
    return { cancelled: false, path: target };
  }

  async recover(): Promise<{ interrupted: string[] }> {
    const workspace = this.requireWorkspace();
    if (this.active || this.preparing) return { interrupted: [] };
    const report = await recoverProofreadTasks(workspace.root, workspace.book);
    return { interrupted: report.interrupted };
  }
}
