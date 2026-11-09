import { z } from "zod";
import type { Result } from "./contracts";
import { formatOptionsSchema, type FormatOptions } from "./format-options";
export const formatPreviewSchema = z.object({ chapterIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)).min(1).max(2000), options: formatOptionsSchema, outputFormat: z.enum(["txt", "markdown"]) }).strict();
export const formatTokenSchema = z.object({ token: z.string().uuid() }).strict();
export const formatPresetSchema = z.object({options: formatOptionsSchema}).strict();
export const formatProposeSchema = z.object({chapterIds: formatPreviewSchema.shape.chapterIds, prompt: z.string().trim().min(1).max(4000), options: formatOptionsSchema}).strict();
export type FormatPreviewRequest = z.infer<typeof formatPreviewSchema>;
export interface FormatPreview extends FormatPreviewRequest {token:string; text:string; inputFingerprint:string;}
export interface DesktopFormatApi {
 getPreset():Promise<Result<FormatOptions>>;
 savePreset(request:z.infer<typeof formatPresetSchema>):Promise<Result<FormatOptions>>;
 preview(request:FormatPreviewRequest):Promise<Result<FormatPreview>>;
 status(request:{token:string}):Promise<Result<{stale:boolean}>>;
 export(request:{token:string}):Promise<Result<{cancelled:boolean;path?:string}>>;
 propose(request:z.infer<typeof formatProposeSchema>):Promise<Result<{options:FormatOptions;feedback:string}>>;
}
