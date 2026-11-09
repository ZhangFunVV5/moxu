import { z } from "zod";
import type { Profile } from "./dispatcher";
import { PROOFREAD_SYSTEM_PROMPT } from "../prompts/proofread";
import {
  modelEditCandidateSchema,
  type ProofreadBlockTarget,
} from "../../shared/proofreading";

const hexHash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * 模型可见的精校工具。submit_edits 的外层 schema 有意放宽 candidates，
 * 由业务层逐项校验并返回具体错误；模型可见的 JSON schema 仍是严格候选结构。
 */
export const proofreadToolSchemas = {
  list_chapters: z.object({}).strict(),
  read_chapter: z
    .object({ chapterId: z.string().min(1).max(80) })
    .strict(),
  scan_text_rules: z.object({}).strict(),
  submit_edits: z
    .object({
      chapterId: z.string().min(1).max(80),
      blockId: z.string().regex(/^b[1-9][0-9]*$/),
      inputHash: hexHash,
      candidates: z.array(z.unknown()).max(500),
    })
    .strict(),
} as const;

export type ProofreadToolName = keyof typeof proofreadToolSchemas;

const submitVisibleSchema = z
  .object({
    chapterId: z.string().min(1),
    blockId: z.string().regex(/^b[1-9][0-9]*$/),
    inputHash: hexHash,
    candidates: z.array(modelEditCandidateSchema).max(500),
  })
  .strict();

export interface ProofreadToolEntry {
  schema: z.ZodType;
  description: string;
  parameters: Record<string, unknown>;
}

export const proofreadToolEntries: Record<ProofreadToolName, ProofreadToolEntry> = {
  list_chapters: {
    schema: proofreadToolSchemas.list_chapters,
    description: "列出本次任务授权章节的编号、标题与字数；不返回其他作品。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  read_chapter: {
    schema: proofreadToolSchemas.read_chapter,
    description:
      "读取授权章节的冻结段落快照（只读）；只能读取本次任务范围内的章节。",
    parameters: {
      type: "object",
      properties: { chapterId: { type: "string" } },
      required: ["chapterId"],
      additionalProperties: false,
    },
  },
  scan_text_rules: {
    schema: proofreadToolSchemas.scan_text_rules,
    description:
      "对当前目标块运行确定性广告规则，返回候选线索；不修改正文，是否采纳由审阅决定。",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  submit_edits: {
    schema: proofreadToolSchemas.submit_edits,
    description:
      "提交当前目标块的完整候选列表；无问题提交空数组。任一项非法则整批拒绝。",
    parameters: z.toJSONSchema(submitVisibleSchema) as Record<string, unknown>,
  },
};

export const PROOFREAD_PROFILE: Profile = {
  systemPrompt: PROOFREAD_SYSTEM_PROMPT,
  tools: ["list_chapters", "read_chapter", "scan_text_rules", "submit_edits"],
  maxRounds: 6,
  maxOutputTokens: 8192,
  timeoutMs: 180_000,
  output: "proofread-edits",
};

export interface ProofreadRuleCandidateView {
  paragraphId: string;
  start: number;
  end: number;
  before: string;
  after: string;
  reason: string;
}

/** 供 runner 组装规则参考；拦截函数在工具处理器里。 */
export function ruleCandidatesForPrompt(
  target: ProofreadBlockTarget,
  hits: ReadonlyArray<{
    candidate: {
      paragraphId: string;
      start?: number;
      end?: number;
      before: string;
      after: string;
      reason: string;
    };
  }>,
): ProofreadRuleCandidateView[] {
  return hits
    .map((hit) => ({
      paragraphId: hit.candidate.paragraphId,
      start: hit.candidate.start ?? 0,
      end: hit.candidate.end ?? (hit.candidate.start ?? 0) + hit.candidate.before.length,
      before: hit.candidate.before,
      after: hit.candidate.after,
      reason: hit.candidate.reason,
    }))
    .filter((candidate) =>
      target.targets.some(
        (range) =>
          range.paragraphId === candidate.paragraphId &&
          candidate.start >= range.start &&
          candidate.end <= range.end,
      ),
    );
}
