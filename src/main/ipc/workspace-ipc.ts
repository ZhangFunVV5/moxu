import { GenerateService } from "../services/generate-service";
import { GenerateError } from "../../shared/generate";
import {
  generateBatchRequestSchema,
  generateStartRequestSchema,
  generateChapterRequestSchema,
  generateTaskRequestSchema,
  generateSelectTitleRequestSchema,
  generateExportRequestSchema,
} from "../../shared/generate-contracts";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import { failure, type Result } from "../../shared/contracts";
import {
  chapterRequestSchema,
  createWorkspaceRequestSchema,
  prepareTaskRequestSchema,
  previewRequestSchema,
  renameChapterRequestSchema,
  saveChapterRequestSchema,
} from "../../shared/workspace-contracts";
import { ImportError } from "../../core/import/import-pipeline";
import { DecodeError } from "../../core/import/encoding";
import { WorkspaceError } from "../../core/workspace/book-store";
import { TaskSpecError } from "../../agent/tasks/task-types";
import {
  WorkspaceService,
  WorkspaceServiceError,
} from "../services/workspace-service";
import { TaskService } from "../services/task-service";
import { FormatService, FormatServiceError } from "../services/format-service";
import {
  formatPreviewSchema,
  formatTokenSchema,
  formatPresetSchema,
  formatProposeSchema,
} from "../../shared/format-contracts";
import { ModelError } from "../../agent/model/model-adapter";
import { ProofreadService } from "../services/proofread-service";
import { ProofreadError } from "../../shared/proofreading";
import {
  proofreadStartRequestSchema,
  proofreadChapterRequestSchema,
  proofreadApplyRequestSchema,
  proofreadBatchRequestSchema,
  proofreadUndoRequestSchema,
  proofreadLocateRequestSchema,
  proofreadBatchesRequestSchema,
  proofreadTaskRequestSchema,
  proofreadReportRequestSchema,
} from "../../shared/proofread-contracts";

function toFailure(error: unknown): Result<never> {
  if (
    error instanceof WorkspaceError ||
    error instanceof ImportError ||
    error instanceof DecodeError ||
    error instanceof WorkspaceServiceError ||
    error instanceof TaskSpecError ||
    error instanceof FormatServiceError ||
    error instanceof ModelError ||
    error instanceof ProofreadError ||
    error instanceof GenerateError
  ) {
    const detail =
      "detail" in error && error.detail ? `（${error.detail}）` : "";
    return failure(error.code, `${error.message}${detail}`);
  }
  return failure(
    "INTERNAL",
    error instanceof Error ? error.message : "未知错误",
  );
}

/** 只注册一次；所有入参在 main 端重新校验，Renderer 不能传路径或权限字段。 */
export function registerWorkspaceIpc(
  service: WorkspaceService,
  taskService: TaskService,
  formatService: FormatService,
  proofreadService: ProofreadService,
  generateService: GenerateService,
): void {
  const handle = <T, R>(
    channel: string,
    schema: ZodType<T> | null,
    action: (value: T, event: IpcMainInvokeEvent) => Promise<R> | R,
  ) => {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try {
        let value = undefined as T;
        if (schema) {
          const parsed = schema.safeParse(raw);
          if (!parsed.success)
            return failure(
              "INVALID_REQUEST",
              parsed.error.issues
                .map(
                  (issue) =>
                    `${issue.path.join(".") || "<root>"}: ${issue.message}`,
                )
                .join("；"),
            );
          value = parsed.data;
        }
        return { ok: true as const, data: await action(value, event) };
      } catch (error) {
        return toFailure(error);
      }
    });
  };

  handle("generate:start", generateStartRequestSchema, (v) =>
    generateService.start(v),
  );
  handle("generate:resume", generateTaskRequestSchema, (v) =>
    generateService.resume(v.taskId),
  );
  handle("generate:cancel", generateTaskRequestSchema, (v) =>
    generateService.cancel(v.taskId),
  );
  handle("generate:chapter", generateChapterRequestSchema, (v) =>
    generateService.chapter(v),
  );
  handle("generate:task-result", generateTaskRequestSchema, (v) =>
    generateService.taskResult(v.taskId),
  );
  handle("generate:apply-batch", generateBatchRequestSchema, (v) =>
    generateService.applyBatch(v),
  );
  handle("generate:summary", null, () => generateService.summary());
  handle("generate:select-title", generateSelectTitleRequestSchema, (v) =>
    generateService.selectTitle(v),
  );
  handle("generate:export-summaries", generateExportRequestSchema, (v, e) =>
    generateService.exportSummaries(
      v.chapterIds,
      BrowserWindow.fromWebContents(e.sender),
    ),
  );
  handle("generate:recover", null, () => generateService.recover());
  handle("workspace:state", null, () => service.state());
  handle("format:preset", null, () => formatService.getPreset());
  handle("format:save-preset", formatPresetSchema, (v) =>
    formatService.savePreset(v.options),
  );
  handle("format:preview", formatPreviewSchema, (v) =>
    formatService.preview(v),
  );
  handle("format:status", formatTokenSchema, (v) =>
    formatService.status(v.token),
  );
  handle("format:export", formatTokenSchema, (v, e) =>
    formatService.export(v.token, BrowserWindow.fromWebContents(e.sender)),
  );
  handle("format:propose", formatProposeSchema, (v) =>
    formatService.propose(v),
  );
  handle("workspace:choose-source", null, (_value, event) =>
    service.chooseSource(BrowserWindow.fromWebContents(event.sender)),
  );
  handle("workspace:preview", previewRequestSchema, (value) =>
    service.preview(value),
  );
  handle("workspace:create", createWorkspaceRequestSchema, (value) =>
    service.create(value),
  );
  handle("workspace:open", null, (_value, event) =>
    service.open(BrowserWindow.fromWebContents(event.sender)),
  );
  handle("workspace:close", null, () => service.close());
  handle("workspace:recent", null, () => service.recent());

  handle("chapter:get", chapterRequestSchema, (value) =>
    service.getChapter(value.chapterId),
  );
  handle("chapter:save", saveChapterRequestSchema, (value) =>
    service.saveChapter(value),
  );
  handle("chapter:rename", renameChapterRequestSchema, (value) =>
    service.renameChapter(value),
  );
  handle("task:prepare", prepareTaskRequestSchema, (value) =>
    taskService.prepare(value),
  );

  handle("proofread:start", proofreadStartRequestSchema, (value) =>
    proofreadService.start(value),
  );
  handle("proofread:cancel", proofreadTaskRequestSchema, (value) =>
    proofreadService.cancel(value.taskId),
  );
  handle("proofread:resume", proofreadTaskRequestSchema, (value) =>
    proofreadService.resume(value.taskId),
  );
  handle("proofread:chapter", proofreadChapterRequestSchema, (value) =>
    proofreadService.chapter(value),
  );
  handle("proofread:batches", proofreadBatchesRequestSchema, (value) =>
    proofreadService.batches(value.chapterId),
  );
  handle("proofread:summary", null, () => proofreadService.summary());
  handle("proofread:apply", proofreadApplyRequestSchema, (value) =>
    proofreadService.apply(value),
  );
  handle("proofread:batch", proofreadBatchRequestSchema, (value) =>
    proofreadService.batchApply(value),
  );
  handle("proofread:undo", proofreadUndoRequestSchema, (value) =>
    proofreadService.undo(value),
  );
  handle("proofread:locate", proofreadLocateRequestSchema, (value) =>
    proofreadService.locate(value),
  );
  handle(
    "proofread:export-report",
    proofreadReportRequestSchema,
    (value, event) =>
      proofreadService.exportReport(
        value.chapterIds,
        BrowserWindow.fromWebContents(event.sender),
      ),
  );
  handle("proofread:recover", null, () => proofreadService.recover());
}
