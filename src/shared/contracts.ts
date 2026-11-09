import type { DesktopGenerateApi } from "./generate-contracts";
import { z } from "zod";
import type { DesktopFormatApi } from "./format-contracts";
import type { DesktopProofreadApi } from "./proofread-contracts";
import type {
  DesktopChapterApi,
  DesktopTaskApi,
  DesktopWorkspaceApi,
} from "./workspace-contracts";
export const identity = z
  .object({
    requestId: z.string().uuid(),
    workspaceId: z.literal("sample-book"),
  })
  .strict();
export const startSchema = identity
  .extend({
    chapterId: z.enum(["c1", "c2", "c3"]),
    prompt: z.string().min(1).max(4000),
  })
  .strict();
export const configSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine(
        (v) => ["http:", "https:"].includes(new URL(v).protocol),
        "仅支持 HTTP(S)",
      ),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().max(2000).optional(),
    temperature: z.number().min(0).max(2),
    stream: z.boolean(),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type PublicConfig = Omit<Config, "apiKey"> & { hasKey: boolean };
export type Result<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        detail?: string;
        data?: Record<string, unknown>;
      };
    };
export const failure = (code: string, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});
export type TaskEvent = {
  requestId: string;
  workspaceId: string;
  taskId: string;
  type:
    | "taskStarted"
    | "toolStarted"
    | "toolFinished"
    | "usage"
    | "chapterUpdated"
    | "taskStateChanged"
    | "text";
  message: string;
  state?: "running" | "completed" | "failed" | "cancelled";
};
export interface DesktopApi {
  pipeline: import('./pipeline-contracts').DesktopPipelineApi;
  lifecycle: import('./pipeline-contracts').DesktopLifecycleApi;
  getConfig(): Promise<Result<PublicConfig>>;
  saveConfig(value: Config): Promise<Result<PublicConfig>>;
  start(
    value: z.infer<typeof startSchema>,
  ): Promise<Result<{ taskId: string }>>;
  cancel(value: {
    taskId: string;
    requestId: string;
    workspaceId: "sample-book";
  }): Promise<Result>;
  onEvent(callback: (event: TaskEvent) => void): () => void;
  workspace: DesktopWorkspaceApi;
  chapters: DesktopChapterApi;
  tasks: DesktopTaskApi;
  format: DesktopFormatApi;
  proofread: DesktopProofreadApi;
  generate: DesktopGenerateApi;
}
declare global {
  interface Window {
    desktop: DesktopApi;
  }
}


