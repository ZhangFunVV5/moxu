import { promises as fsp } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TaskSpec } from "../../shared/task";
import { WriteQueue, writeFileAtomic } from "../../core/workspace/atomic-file";
import { persistTaskSpec } from "./task-types";

export const TASK_STATES = [
  "queued",
  "running",
  "waiting-review",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const chapterCheckpointSchema = z
  .object({
    chapterId: z.string().min(1),
    status: z.enum(TASK_STATES),
    attempt: z.number().int().nonnegative(),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    completedBlockIds: z.array(z.string().min(1)),
    artifactRefs: z.array(z.string().min(1)),
    errorCode: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type ChapterCheckpoint = z.infer<typeof chapterCheckpointSchema>;

export const taskRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    chapters: z.record(z.string(), chapterCheckpointSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type TaskRecord = z.infer<typeof taskRecordSchema>;

export const taskArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().uuid(),
    chapterId: z.string().min(1),
    kind: z.string().min(1).max(80),
    completedBlockIds: z.array(z.string().min(1)),
    payload: z.unknown(),
    createdAt: z.string().min(1),
  })
  .strict();
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;

const ALLOWED_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "cancelled", "interrupted", "failed"],
  running: ["waiting-review", "completed", "failed", "cancelled", "interrupted"],
  "waiting-review": ["completed", "cancelled", "interrupted"],
  completed: ["waiting-review"],
  failed: ["running", "cancelled"],
  cancelled: ["running"],
  interrupted: ["running", "cancelled"],
};

const checkpointWrites = new WriteQueue();

export class TaskStoreError extends Error {
  readonly code:
    | "TASK_NOT_FOUND"
    | "INVALID_TASK_RECORD"
    | "INVALID_TRANSITION"
    | "UNKNOWN_CHAPTER"
    | "ARTIFACT_MISSING"
    | "ARTIFACT_INVALID";
  constructor(code: TaskStoreError["code"], message: string) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

export interface RecoveryReport {
  repaired: string[];
  interrupted: string[];
  missingArtifacts: string[];
}

function taskDir(workspaceRoot: string, taskId: string): string {
  return path.join(workspaceRoot, "tasks", taskId);
}

function recordFile(workspaceRoot: string, taskId: string): string {
  return path.join(taskDir(workspaceRoot, taskId), "checkpoints.json");
}

export function artifactRelativePath(chapterId: string): string {
  return path.join("artifacts", `${chapterId}.json`);
}

/**
 * 章级检查点存储。单章状态与产物引用写入 checkpoints.json；真实产物先写入
 * artifacts/<chapterId>.json，再推进完成检查点。恢复时可据产物补齐“产物已提交、
 * 进度未写”的情况，不重复执行写入。
 */
export class TaskStore {
  readonly workspaceRoot: string;
  readonly taskId: string;
  private record: TaskRecord;

  private constructor(workspaceRoot: string, record: TaskRecord) {
    this.workspaceRoot = workspaceRoot;
    this.taskId = record.taskId;
    this.record = record;
  }

  static async create(
    workspaceRoot: string,
    spec: TaskSpec,
    now: () => Date = () => new Date(),
  ): Promise<TaskStore> {
    await persistTaskSpec(workspaceRoot, spec);
    const iso = now().toISOString();
    const chapters: Record<string, ChapterCheckpoint> = {};
    for (const chapterId of spec.chapterIds)
      chapters[chapterId] = {
        chapterId,
        status: "queued",
        attempt: 0,
        inputFingerprint: spec.inputFingerprint,
        completedBlockIds: [],
        artifactRefs: [],
        updatedAt: iso,
      };
    const record: TaskRecord = {
      schemaVersion: 1,
      taskId: spec.taskId,
      workspaceId: spec.workspaceId,
      inputFingerprint: spec.inputFingerprint,
      chapters,
      createdAt: iso,
      updatedAt: iso,
    };
    await writeFileAtomic(recordFile(workspaceRoot, spec.taskId), JSON.stringify(record, null, 2));
    return new TaskStore(workspaceRoot, record);
  }

  static async open(workspaceRoot: string, taskId: string): Promise<TaskStore> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(recordFile(workspaceRoot, taskId), "utf8"));
    } catch {
      throw new TaskStoreError("TASK_NOT_FOUND", "任务检查点不存在或无法解析");
    }
    const parsed = taskRecordSchema.safeParse(raw);
    if (!parsed.success)
      throw new TaskStoreError("INVALID_TASK_RECORD", "任务检查点结构非法");
    return new TaskStore(workspaceRoot, parsed.data);
  }

  get snapshot(): TaskRecord {
    return structuredClone(this.record);
  }

  getCheckpoint(chapterId: string): ChapterCheckpoint {
    const checkpoint = this.record.chapters[chapterId];
    if (!checkpoint)
      throw new TaskStoreError("UNKNOWN_CHAPTER", `任务不包含章节 ${chapterId}`);
    return checkpoint;
  }

  private async persist(): Promise<void> {
    this.record.updatedAt = new Date().toISOString();
    await writeFileAtomic(
      recordFile(this.workspaceRoot, this.taskId),
      JSON.stringify(this.record, null, 2),
    );
  }

  /** Runner 与审阅服务可持有不同实例；每次提交都在任务队列内读取最新检查点。 */
  private async update<T>(change: () => Promise<T>): Promise<T> {
    return checkpointWrites.run(recordFile(this.workspaceRoot, this.taskId), async () => {
      const latest = await TaskStore.open(this.workspaceRoot, this.taskId);
      this.record = structuredClone(latest.record);
      try {
        const result = await change();
        await this.persist();
        return result;
      } catch (error) {
        this.record = latest.record;
        throw error;
      }
    });
  }

  private assertTransition(from: TaskState, to: TaskState): void {
    if (from === to) return;
    if (!ALLOWED_TRANSITIONS[from].includes(to))
      throw new TaskStoreError(
        "INVALID_TRANSITION",
        `任务状态不能从 ${from} 变为 ${to}`,
      );
  }

  async setState(
    chapterId: string,
    state: TaskState,
    options: { errorCode?: string; now?: () => Date } = {},
  ): Promise<ChapterCheckpoint> {
    return this.update(async () => {
      const checkpoint = this.getCheckpoint(chapterId);
      this.assertTransition(checkpoint.status, state);
      if (checkpoint.status === state) return checkpoint;
      const iso = (options.now?.() ?? new Date()).toISOString();
      const next: ChapterCheckpoint = {
        ...checkpoint,
        status: state,
        attempt:
          state === "running" && checkpoint.status !== "running"
            ? checkpoint.attempt + 1
            : checkpoint.attempt,
        errorCode: options.errorCode,
        updatedAt: iso,
      };
      this.record.chapters[chapterId] = next;
      return next;
    });
  }

  /**
   * 先写产物，再允许推进完成检查点。产物文件是“已提交”的事实依据；
   * 这里只写 artifacts/<chapterId>.json，不擅自把章标为 completed。
   */
  async writeArtifact(
    chapterId: string,
    artifact: Omit<TaskArtifact, "schemaVersion" | "taskId" | "chapterId" | "createdAt">,
  ): Promise<string> {
    this.getCheckpoint(chapterId);
    const payload: TaskArtifact = {
      schemaVersion: 1,
      taskId: this.taskId,
      chapterId,
      kind: artifact.kind,
      completedBlockIds: artifact.completedBlockIds,
      payload: artifact.payload,
      createdAt: new Date().toISOString(),
    };
    const parsed = taskArtifactSchema.safeParse(payload);
    if (!parsed.success)
      throw new TaskStoreError("ARTIFACT_INVALID", "产物结构非法");
    const relative = artifactRelativePath(chapterId);
    await writeFileAtomic(
      path.join(taskDir(this.workspaceRoot, this.taskId), relative),
      JSON.stringify(parsed.data, null, 2),
    );
    return relative;
  }

  async readArtifact(chapterId: string): Promise<TaskArtifact | null> {
    try {
      const raw = JSON.parse(
        await fsp.readFile(
          path.join(taskDir(this.workspaceRoot, this.taskId), artifactRelativePath(chapterId)),
          "utf8",
        ),
      );
      const parsed = taskArtifactSchema.safeParse(raw);
      if (!parsed.success) return null;
      if (parsed.data.taskId !== this.taskId || parsed.data.chapterId !== chapterId)
        return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  async completeChapter(chapterId: string): Promise<ChapterCheckpoint> {
    return this.update(async () => {
      const checkpoint = this.getCheckpoint(chapterId);
      const artifact = await this.readArtifact(chapterId);
      if (!artifact)
        throw new TaskStoreError(
          "ARTIFACT_MISSING",
          "产物未落盘，不能把章节标记为完成",
        );
      const next: ChapterCheckpoint = {
        ...checkpoint,
        status: "completed",
        completedBlockIds: artifact.completedBlockIds,
        artifactRefs: [artifactRelativePath(chapterId)],
        errorCode: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.assertTransition(checkpoint.status, "completed");
      this.record.chapters[chapterId] = next;
      return next;
    });
  }

  async enterWaitingReview(chapterId: string): Promise<ChapterCheckpoint> {
    return this.setState(chapterId, "waiting-review");
  }

  /**
   * 精校候选完整后的等待审阅：产物必须先落盘，检查点同时记录已完成块。
   * 与 enterWaitingReview 分开，避免把“未提交产物”的旧调用悄悄标成完整。
   */
  async markReviewReady(chapterId: string): Promise<ChapterCheckpoint> {
    return this.update(async () => {
      const checkpoint = this.getCheckpoint(chapterId);
      const artifact = await this.readArtifact(chapterId);
      if (!artifact)
        throw new TaskStoreError(
          "ARTIFACT_MISSING",
          "产物未落盘，不能进入等待审阅",
        );
      this.assertTransition(checkpoint.status, "waiting-review");
      const next: ChapterCheckpoint = {
        ...checkpoint,
        status: "waiting-review",
        completedBlockIds: artifact.completedBlockIds,
        artifactRefs: [artifactRelativePath(chapterId)],
        errorCode: undefined,
        updatedAt: new Date().toISOString(),
      };
      this.record.chapters[chapterId] = next;
      return next;
    });
  }

  async failChapter(chapterId: string, errorCode: string): Promise<ChapterCheckpoint> {
    return this.setState(chapterId, "failed", { errorCode });
  }

  async cancelChapter(chapterId: string): Promise<ChapterCheckpoint> {
    return this.setState(chapterId, "cancelled", { errorCode: "CANCELLED" });
  }

  /**
   * 重启恢复：
   * - running 且有有效产物 → 直接补成 completed（产物已提交、进度未写）；
   * - running 且无产物 → interrupted；
   * - completed 但产物缺失 → failed/ARTIFACT_MISSING，不把缺失引用当作完成。
   */
  async recover(now: () => Date = () => new Date()): Promise<RecoveryReport> {
    return this.update(async () => {
      const report: RecoveryReport = { repaired: [], interrupted: [], missingArtifacts: [] };
      for (const [chapterId, checkpoint] of Object.entries(this.record.chapters)) {
        const artifact = await this.readArtifact(chapterId);
        const iso = now().toISOString();
        if (checkpoint.status === "running") {
          if (artifact) {
            this.record.chapters[chapterId] = {
              ...checkpoint,
              status: "completed",
              completedBlockIds: artifact.completedBlockIds,
              artifactRefs: [artifactRelativePath(chapterId)],
              errorCode: undefined,
              updatedAt: iso,
            };
            report.repaired.push(chapterId);
          } else {
            this.record.chapters[chapterId] = {
              ...checkpoint,
              status: "interrupted",
              errorCode: "INTERRUPTED",
              updatedAt: iso,
            };
            report.interrupted.push(chapterId);
          }
        } else if (checkpoint.status === "completed") {
          if (!artifact) {
            this.record.chapters[chapterId] = {
              ...checkpoint,
              status: "failed",
              errorCode: "ARTIFACT_MISSING",
              artifactRefs: checkpoint.artifactRefs,
              updatedAt: iso,
            };
            report.missingArtifacts.push(chapterId);
          }
        }
      }
      return report;
    });
  }

  /** 完成状态引用的产物必须真实存在；空产物（零意见）与失败由状态区分。 */
  async verifyCompletedArtifacts(): Promise<{ missing: string[]; completed: string[] }> {
    const missing: string[] = [];
    const completed: string[] = [];
    for (const [chapterId, checkpoint] of Object.entries(this.record.chapters)) {
      if (checkpoint.status !== "completed") continue;
      const artifact = await this.readArtifact(chapterId);
      if (artifact) completed.push(chapterId);
      else missing.push(chapterId);
    }
    return { missing, completed };
  }
}
