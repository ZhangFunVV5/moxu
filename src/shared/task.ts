import { z } from "zod";

export const TASK_SCHEMA_VERSION = 1 as const;

/** 产品任务类型；P1 只建立不可变容器，具体选项随 P2–P4 接入。 */
export const TASK_TYPES = [
  "proofread",
  "generate_title",
  "generate_summary",
  "format",
  "export",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * P1 的选项快照是有界 JSON 基元值；具体业务选项 schema 在 P2–P4 的任务模块中定义，
 * 不允许把任意对象／路径／权限字段塞进任务。
 */
export const taskOptionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);
export type TaskOptionValue = z.infer<typeof taskOptionValueSchema>;
export const taskOptionsSchema = z.record(z.string(), taskOptionValueSchema);
export type TaskOptions = z.infer<typeof taskOptionsSchema>;

export const taskPermissionsSchema = z
  .object({
    source: z.literal("application"),
    canWriteBody: z.boolean(),
    autoApplyCategories: z.array(z.string()),
  })
  .strict();
export type TaskPermissions = z.infer<typeof taskPermissionsSchema>;

export const taskSpecSchema = z
  .object({
    schemaVersion: z.literal(TASK_SCHEMA_VERSION),
    taskId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    type: z.enum(TASK_TYPES),
    chapterIds: z.array(z.string().min(1)).min(1),
    inputHashes: z.record(
      z.string(),
      z.string().regex(/^[0-9a-f]{64}$/),
    ),
    options: taskOptionsSchema,
    permissions: taskPermissionsSchema,
    profileVersion: z.string().min(1).max(120),
    modelConfigId: z.string().min(1).max(200).optional(),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string().min(1),
  })
  .strict();
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/** 稳定序列化：对象键排序、数组顺序保留，避免 JSON.stringify 键序影响指纹。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface TaskInputFingerprintParts {
  workspaceId: string;
  type: TaskType;
  chapterIds: readonly string[];
  inputHashes: Readonly<Record<string, string>>;
  options: TaskOptions;
  profileVersion: string;
  modelConfigId?: string;
}

