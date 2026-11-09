import path from "node:path";
import type {
  PreparedTask,
  PrepareTaskRequest,
} from "../../shared/workspace-contracts";
import {
  buildTaskSpec,
  TaskSpecError,
  taskSpecPath,
  type TaskSpec,
} from "../../agent/tasks/task-types";
import { TaskStore } from "../../agent/tasks/task-store";
import {
  readChapterFile,
  WorkspaceError,
  type Workspace,
} from "../../core/workspace/book-store";
import {
  WorkspaceService,
  WorkspaceServiceError,
} from "./workspace-service";

export interface TaskSpecPermissions {
  /** 仅应用层在用户显式开启后传入。 */
  autoApplyCategories?: readonly string[];
}

/**
 * 任务创建的应用服务：范围与正文 hash 来自当前工作区的权威文件，
 * 权限与 taskId 由应用生成，Renderer／模型不能声明。
 */
export class TaskService {
  constructor(private readonly workspaceService: WorkspaceService) {}

  /**
   * 建立不可变 TaskSpec，但不落盘。精校应用服务需要在同一任务下先建批次，
   * 因此与 prepare 共用这段范围／hash／权限构造。
   */
  async createSpec(
    request: PrepareTaskRequest,
    permissions: TaskSpecPermissions = {},
  ): Promise<{ spec: TaskSpec; workspace: Workspace }> {
    const workspace = this.workspaceService.currentWorkspace();
    if (!workspace)
      throw new WorkspaceServiceError("NO_WORKSPACE", "尚未打开作品，不能创建任务");
    const unique = [...new Set(request.chapterIds)];
    if (unique.length !== request.chapterIds.length)
      throw new TaskSpecError("INVALID_INPUT", "任务范围包含重复章节");
    const outside = unique.filter(
      (chapterId) => !workspace.book.chapterOrder.includes(chapterId),
    );
    if (outside.length)
      throw new WorkspaceError(
        "CHAPTER_NOT_FOUND",
        "任务范围包含不属于当前作品的章节",
        outside.join(","),
      );
    // 章序始终由 book.json 决定，调用方传入的顺序不能改变任务覆盖顺序。
    const chapterIds = workspace.book.chapterOrder.filter((chapterId) =>
      unique.includes(chapterId),
    );
    const inputHashes = Object.fromEntries(
      await Promise.all(chapterIds.map(async (chapterId) => {
        const chapter = await readChapterFile(workspace.root, workspace.book, chapterId);
        return [chapterId, chapter.bodyHash];
      })),
    );
    const spec = buildTaskSpec({
      workspaceId: workspace.book.workspaceId,
      type: request.type,
      chapterIds,
      inputHashes,
      options: request.options,
      profileVersion: request.profileVersion,
      modelConfigId: request.modelConfigId,
      autoApplyCategories: permissions.autoApplyCategories,
    });
    return { spec, workspace };
  }

  async prepare(request: PrepareTaskRequest): Promise<PreparedTask> {
    const { spec, workspace } = await this.createSpec(request);
    const store = await TaskStore.create(workspace.root, spec);
    const record = store.snapshot;
    return {
      taskId: spec.taskId,
      type: spec.type,
      chapterIds: spec.chapterIds,
      inputFingerprint: spec.inputFingerprint,
      specPath: path.relative(workspace.root, taskSpecPath(workspace.root, spec.taskId)),
      states: Object.fromEntries(
        Object.entries(record.chapters).map(([chapterId, checkpoint]) => [
          chapterId,
          checkpoint.status,
        ]),
      ),
    };
  }
}
