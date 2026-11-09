import { z } from "zod";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  TASK_SCHEMA_VERSION,
  TASK_TYPES,
  canonicalJson,
  taskOptionsSchema,
  taskSpecSchema,
  type TaskInputFingerprintParts,
  type TaskSpec,
  type TaskType,
} from "../../shared/task";
import { sha256Hex } from "../../core/text/hash";
import { writeFileAtomic } from "../../core/workspace/atomic-file";

export type {
  TaskPermissions,
  TaskSpec,
  TaskType,
  TaskOptions,
} from "../../shared/task";
export { TASK_TYPES, TASK_SCHEMA_VERSION, canonicalJson } from "../../shared/task";

export class TaskSpecError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "IMMUTABLE_TASK_SPEC"
    | "INVALID_STORED_SPEC";
  constructor(code: TaskSpecError["code"], message: string) {
    super(message);
    this.name = "TaskSpecError";
    this.code = code;
  }
}

/** 输入指纹：覆盖作品、类型、排序后的章节范围、正文 hash、选项、Profile 与模型标识。 */
export function taskInputFingerprint(parts: TaskInputFingerprintParts): string {
  const chapterIds = [...new Set(parts.chapterIds)].sort();
  const inputHashes = Object.fromEntries(
    chapterIds.map((id) => [id, parts.inputHashes[id] ?? ""]),
  );
  const options = Object.fromEntries(
    Object.entries(parts.options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return sha256Hex(
    canonicalJson({
      schemaVersion: TASK_SCHEMA_VERSION,
      workspaceId: parts.workspaceId,
      type: parts.type,
      chapterIds,
      inputHashes,
      options,
      profileVersion: parts.profileVersion,
      modelConfigId: parts.modelConfigId ?? null,
    }),
  );
}

const createTaskSpecSchema = z
  .object({
    workspaceId: z.string().uuid(),
    type: z.enum(TASK_TYPES),
    chapterIds: z.array(z.string().min(1)).min(1).max(2000),
    inputHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    options: taskOptionsSchema,
    profileVersion: z.string().min(1).max(120),
    modelConfigId: z.string().min(1).max(200).optional(),
  })
  .strict();

export interface CreateTaskSpecInput {
  workspaceId: string;
  type: TaskType;
  chapterIds: string[];
  inputHashes: Record<string, string>;
  options: Record<string, string | number | boolean | string[]>;
  profileVersion: string;
  modelConfigId?: string;
  /** 仅应用层根据用户显式设置传入；模型／GUI 请求体不能直接写入权限。 */
  autoApplyCategories?: readonly string[];
  now?: () => Date;
}

/**
 * 创建不可变 TaskSpec。权限字段由应用层生成，调用方（包括模型／GUI 参数）无法传入；
 * 额外字段（例如伪造的 permissions）在严格 schema 处直接拒绝。
 */
export function buildTaskSpec(input: CreateTaskSpecInput): TaskSpec {
  const { now, autoApplyCategories, ...rest } = input;
  const parsed = createTaskSpecSchema.safeParse(rest);
  if (!parsed.success)
    throw new TaskSpecError(
      "INVALID_INPUT",
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("；"),
    );
  const data = parsed.data;
  const chapterIds = [...new Set(data.chapterIds)];
  if (chapterIds.length !== data.chapterIds.length)
    throw new TaskSpecError("INVALID_INPUT", "章节范围包含重复 ID");
  const missing = chapterIds.filter((id) => !(id in data.inputHashes));
  if (missing.length)
    throw new TaskSpecError(
      "INVALID_INPUT",
      `缺少正文 hash：${missing.join(",")}`,
    );
  const extra = Object.keys(data.inputHashes).filter((id) => !chapterIds.includes(id));
  if (extra.length)
    throw new TaskSpecError(
      "INVALID_INPUT",
      `inputHashes 包含范围外章节：${extra.join(",")}`,
    );
  const spec: TaskSpec = {
    schemaVersion: TASK_SCHEMA_VERSION,
    taskId: randomUUID(),
    workspaceId: data.workspaceId,
    type: data.type,
    chapterIds,
    inputHashes: Object.fromEntries(chapterIds.map((id) => [id, data.inputHashes[id]])),
    options: data.options,
    permissions: {
      source: "application",
      canWriteBody: false,
      autoApplyCategories: [...new Set(autoApplyCategories ?? [])],
    },
    profileVersion: data.profileVersion,
    modelConfigId: data.modelConfigId,
    inputFingerprint: taskInputFingerprint({
      workspaceId: data.workspaceId,
      type: data.type,
      chapterIds,
      inputHashes: data.inputHashes,
      options: data.options,
      profileVersion: data.profileVersion,
      modelConfigId: data.modelConfigId,
    }),
    createdAt: (now?.() ?? new Date()).toISOString(),
  };
  const validated = taskSpecSchema.safeParse(spec);
  if (!validated.success)
    throw new TaskSpecError("INVALID_INPUT", "TaskSpec 未通过最终校验");
  return validated.data;
}

export function taskSpecPath(workspaceRoot: string, taskId: string): string {
  return path.join(workspaceRoot, "tasks", taskId, "task-spec.json");
}

/**
 * 持久化 TaskSpec。同一 taskId 的相同内容重放返回原文件；内容不同则拒绝覆盖，
 * 保证任务输入快照不可变。
 */
export async function persistTaskSpec(
  workspaceRoot: string,
  spec: TaskSpec,
): Promise<string> {
  const file = taskSpecPath(workspaceRoot, spec.taskId);
  try {
    const existing = taskSpecSchema.safeParse(
      JSON.parse(await fsp.readFile(file, "utf8")),
    );
    if (existing.success) {
      if (canonicalJson(existing.data) === canonicalJson(spec)) return file;
      throw new TaskSpecError("IMMUTABLE_TASK_SPEC", "同一任务 ID 的 TaskSpec 不可修改");
    }
    throw new TaskSpecError("INVALID_STORED_SPEC", "已存在的 TaskSpec 结构非法");
  } catch (error) {
    if (error instanceof TaskSpecError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT")
      throw new TaskSpecError("INVALID_STORED_SPEC", "TaskSpec 读取失败");
  }
  await writeFileAtomic(file, JSON.stringify(spec, null, 2));
  return file;
}

export async function loadTaskSpec(
  workspaceRoot: string,
  taskId: string,
): Promise<TaskSpec> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(taskSpecPath(workspaceRoot, taskId), "utf8"));
  } catch {
    throw new TaskSpecError("INVALID_STORED_SPEC", "TaskSpec 不存在或无法解析");
  }
  const parsed = taskSpecSchema.safeParse(raw);
  if (!parsed.success)
    throw new TaskSpecError("INVALID_STORED_SPEC", "TaskSpec 结构非法");
  return parsed.data;
}
