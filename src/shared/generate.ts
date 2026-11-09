import { z } from "zod";
export const GENERATE_PROFILE_VERSION = "generate-v1.1";
const lengths = {
  minLength: z.number().int().min(1).max(2000),
  maxLength: z.number().int().min(1).max(2000),
};
export const titleOptionsSchema = z
  .object({
    ...lengths,
    maxLength: z.number().int().min(1).max(100),
    minLength: z.number().int().min(1).max(100),
    candidateCount: z.number().int().min(1).max(5),
    style: z.string().max(300),
    allowSpoilers: z.boolean(),
  })
  .strict()
  .refine((x) => x.minLength <= x.maxLength, "最小长度不能超过最大长度");
export const summaryOptionsSchema = z
  .object({ ...lengths })
  .strict()
  .refine((x) => x.minLength <= x.maxLength, "最小长度不能超过最大长度");
export type TitleOptions = z.infer<typeof titleOptionsSchema>;
export type SummaryOptions = z.infer<typeof summaryOptionsSchema>;
export const DEFAULT_TITLE_OPTIONS: TitleOptions = {
  minLength: 2,
  maxLength: 12,
  candidateCount: 3,
  style: "贴合原文",
  allowSpoilers: false,
};
export const DEFAULT_SUMMARY_OPTIONS: SummaryOptions = {
  minLength: 100,
  maxLength: 200,
};
export class GenerateError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GenerateError";
  }
}
export const generateArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    taskId: z.string().uuid(),
    chapterId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    kind: z.enum(["title", "summary"]),
    sourceBodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    sourceTitle: z.string(),
    profileVersion: z.string(),
    modelConfigId: z.string().optional(),
    options: z.union([titleOptionsSchema, summaryOptionsSchema]),
    titles: z.array(z.string()).optional(),
    summary: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();
export type GenerateArtifact = z.infer<typeof generateArtifactSchema>;
export type GenerateArtifactView = GenerateArtifact & { stale: boolean };

