import { z } from "zod";
import { proofreadOptionsSchema } from "./proofreading";
import { titleOptionsSchema, summaryOptionsSchema } from "./generate";
import { formatOptionsSchema } from "./format-options";
import { bookMetadataSchema, EXPORT_FORMATS } from "./book";
import type { Result } from "./contracts";
export const pipelineStartSchema = z
  .object({
    chapterIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/))
      .min(1)
      .max(2000),
    proofread: proofreadOptionsSchema.optional(),
    title: titleOptionsSchema.optional(),
    summary: summaryOptionsSchema.optional(),
    format: z
      .object({
        options: formatOptionsSchema,
        outputFormat: z.enum(EXPORT_FORMATS),
        metadata: bookMetadataSchema.optional(),
      })
      .strict()
      .optional(),
    export: z.boolean().optional(),
  })
  .strict()
  .refine(
    (x) => !!(x.proofread || x.title || x.summary || x.format),
    "请选择至少一个任务",
  )
  .refine((x) => !x.export || !!x.format, "导出需要排版阶段");
export type PipelineStartRequest = z.infer<typeof pipelineStartSchema>;
export const pipelineResumeSchema = z
  .object({
    pipelineId: z.string().uuid(),
    continueWithPending: z.boolean().optional(),
  })
  .strict();
export const pipelineIdSchema = z
  .object({ pipelineId: z.string().uuid() })
  .strict();
export const pipelineProposeSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    chapterIds: pipelineStartSchema.shape.chapterIds,
  })
  .strict();
export type PipelineStage =
  | "proofread"
  | "review"
  | "title"
  | "summary"
  | "format"
  | "export";
export type PipelineState =
  | "queued"
  | "running"
  | "waiting-title"
  | "waiting-review"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface PipelineRecord {
  schemaVersion: 1;
  pipelineId: string;
  workspaceId: string;
  request: PipelineStartRequest;
  state: PipelineState;
  stages: Array<{
    kind: PipelineStage;
    state: PipelineState;
    taskId?: string;
    error?: string;
  }>;
  updatedAt: string;
  inputHashes?: Record<string, string>;
  formatFingerprint?: string;
  previewToken?: string;
  outputPath?: string;
  error?: string;
}
export type TaskProposal =
  | { kind: "ready"; request: PipelineStartRequest; notes: string[] }
  | { kind: "clarification"; message: string };
export interface DesktopPipelineApi {
  start(request: PipelineStartRequest): Promise<Result<PipelineRecord>>;
  list(): Promise<Result<PipelineRecord[]>>;
  resume(
    request: z.infer<typeof pipelineResumeSchema>,
  ): Promise<Result<PipelineRecord>>;
  cancel(request: { pipelineId: string }): Promise<Result<null>>;
  propose(
    request: z.infer<typeof pipelineProposeSchema>,
  ): Promise<Result<TaskProposal>>;
}
export interface DesktopLifecycleApi {
  onCloseRequested(listener: () => void): () => void;
  confirmClose(request: { action: "close" | "cancel" }): Promise<Result<null>>;
}

export const pipelineRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    pipelineId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    request: pipelineStartSchema,
    state: z.enum([
      "queued",
      "running",
      "waiting-title",
      "waiting-review",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ]),
    stages: z.array(
      z
        .object({
          kind: z.enum([
            "proofread",
            "review",
            "title",
            "summary",
            "format",
            "export",
          ]),
          state: z.enum([
            "queued",
            "running",
            "waiting-title",
            "waiting-review",
            "completed",
            "failed",
            "cancelled",
            "interrupted",
          ]),
          taskId: z.string().uuid().optional(),
          error: z.string().optional(),
        })
        .strict(),
    ),
    updatedAt: z.string(),
    inputHashes: z
      .record(z.string(), z.string().regex(/^[0-9a-f]{64}$/))
      .optional(),
    formatFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    previewToken: z.string().uuid().optional(),
    outputPath: z.string().optional(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const expected: string[] = [];
    if (r.request.proofread) expected.push("proofread", "review");
    if (r.request.title) expected.push("title");
    if (r.request.summary) expected.push("summary");
    if (r.request.format) expected.push("format");
    if (r.request.export) expected.push("export");
    if (expected.join(",") !== r.stages.map((s) => s.kind).join(","))
      ctx.addIssue({ code: "custom", message: "组合阶段顺序无效" });
  });
