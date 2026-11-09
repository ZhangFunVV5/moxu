import { z } from "zod";
import { blockSchema } from "./book";
import type { Block } from "./book";
import { chapterReviewStateSchema } from "./review-state";

/**
 * 精校数据契约（PF-01）。
 *
 * 坐标口径：候选的 start / end 是「基础段落内」的 UTF-16 code unit，左闭右开；
 * 不是块内、章内或字节偏移。`before` 必须逐字来自基础段落，不做 trim 或标点规范化。
 * `after` 为空表示删除；`before` 为空且 start === end 表示插入。
 */
export const PROOFREAD_SCHEMA_VERSION = 1 as const;

export const PROOFREAD_CATEGORIES = [
  "typo",
  "wording",
  "grammar",
  "advertisement",
] as const;
export type ProofreadCategory = (typeof PROOFREAD_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ProofreadCategory, string> = {
  typo: "错字",
  wording: "用词",
  grammar: "语法",
  advertisement: "广告",
};

export const PROOFREAD_RULE_VERSION = "proofread-rules-v1" as const;
export const PROOFREAD_PROFILE_VERSION = "proofread-profile-v1" as const;

const uniqueCategories = (values: ProofreadCategory[]): boolean =>
  new Set(values).size === values.length;

export const proofreadChunkBudgetSchema = z
  .object({
    /** 目标文本（不含只读上下文）的字符上限。 */
    maxChars: z.number().int().min(200).max(20000),
    /** 单个目标块包含的段落数上限。 */
    maxParagraphs: z.number().int().min(1).max(200),
    /** 每个目标块前后附带多少只读段落。 */
    contextParagraphs: z.number().int().min(0).max(10),
  })
  .strict();
export type ProofreadChunkBudget = z.infer<typeof proofreadChunkBudgetSchema>;

export const proofreadOptionsSchema = z
  .object({
    categories: z
      .array(z.enum(PROOFREAD_CATEGORIES))
      .min(1)
      .max(4)
      .refine(uniqueCategories, "检查类别不能重复"),
    /** 专名／特殊词表快照；只用于提示模型保守处理，不扩展为人物系统。 */
    glossary: z.array(z.string().trim().min(1).max(80)).max(500),
    userRequest: z.string().max(2000),
    ruleVersion: z.string().min(1).max(120),
    profileVersion: z.string().min(1).max(120),
    /** 模型配置标识（仅模型名／配置名，不含凭据）。 */
    modelConfigId: z.string().min(1).max(200).optional(),
    blockBudget: proofreadChunkBudgetSchema,
    /** 默认空数组：不自动应用任何类别。 */
    autoApplyCategories: z
      .array(z.enum(PROOFREAD_CATEGORIES))
      .max(4)
      .refine(uniqueCategories, "自动应用类别不能重复"),
  })
  .strict();
export type ProofreadOptions = z.infer<typeof proofreadOptionsSchema>;

export const defaultProofreadOptions: ProofreadOptions = {
  categories: [...PROOFREAD_CATEGORIES],
  glossary: [],
  userRequest: "",
  ruleVersion: PROOFREAD_RULE_VERSION,
  profileVersion: PROOFREAD_PROFILE_VERSION,
  blockBudget: { maxChars: 6000, maxParagraphs: 20, contextParagraphs: 1 },
  autoApplyCategories: [],
};

/** 模型工具提交的单个候选。坐标可同时省略，由程序在目标区间内定位唯一引句。 */
export const modelEditCandidateSchema = z
  .object({
    paragraphId: z.string().regex(/^p[1-9][0-9]*$/, "段落 ID 必须形如 p1"),
    before: z.string().max(200_000),
    after: z.string().max(200_000),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    category: z.enum(PROOFREAD_CATEGORIES),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ModelEditCandidate = z.infer<typeof modelEditCandidateSchema>;

export const PROOFREAD_ERROR_CODES = [
  "SCHEMA_INVALID",
  "HASH_MISMATCH",
  "QUOTE_MISMATCH",
  "AMBIGUOUS_QUOTE",
  "OUT_OF_RANGE",
  "INVALID_UNICODE_BOUNDARY",
  "FORBIDDEN_RANGE",
  "PATCH_CONFLICT",
  "BLOCK_ALREADY_COMMITTED",
  "INCOMPLETE_BATCH",
  "INVALID_CANDIDATES",
  "NO_CHANGE",
  "BATCH_NOT_FOUND",
  "NO_ACTIVE_BATCH",
  "STALE_BODY",
  "STALE_BATCH",
  "STALE_REVIEW",
  "OPERATION_CONFLICT",
  "NOTHING_TO_UNDO",
  "INVALID_REVIEW_STATE",
  "PATCH_NOT_FOUND",
  "ALREADY_DECIDED",
  "TASK_INPUT_CHANGED",
  "INVALID_CHUNKS",
  "CANCELLED",
  "TASK_BUSY",
  "TASK_NOT_FOUND",
  "MODEL_CONFIG_REQUIRED",
  "UNSUPPORTED_REQUEST",
  "EXPORT_FAILED",
  "WRITE_FAILED",
] as const;
export type ProofreadErrorCode = (typeof PROOFREAD_ERROR_CODES)[number];

export class ProofreadError extends Error {
  readonly code: ProofreadErrorCode;
  readonly detail: string;
  readonly data?: Record<string, unknown>;
  constructor(
    code: ProofreadErrorCode,
    message: string,
    detail = "",
    data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProofreadError";
    this.code = code;
    this.detail = detail;
    this.data = data;
  }
}

export const candidateSourceSchema = z.enum(["model", "rule"]);
export type CandidateSource = z.infer<typeof candidateSourceSchema>;

/**
 * 已落盘的候选。patchId / fingerprint 由基础 hash、段落、区间、before/after 和类别
 * 生成，不包含理由与来源，因此规则候选与模型候选的相同修改会合并成一条。
 */
export const storedCandidateSchema = z
  .object({
    patchId: z.string().regex(/^pt-[0-9a-f]{16}$/),
    batchId: z.string().uuid(),
    chapterId: z.string().min(1),
    paragraphId: z.string().regex(/^p[1-9][0-9]*$/),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    before: z.string(),
    after: z.string(),
    category: z.enum(PROOFREAD_CATEGORIES),
    reason: z.string().min(1).max(2000),
    source: candidateSourceSchema,
    /** 合并后的来源；规则与模型同时命中时为 ["rule","model"]。 */
    sources: z.array(candidateSourceSchema).min(1).max(2),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    ruleId: z.string().min(1).max(80).optional(),
    /** 静态有效性；与审阅决议分开。conflict / stale 在读取时动态计算。 */
    baseValidity: z.enum(["valid", "invalid", "stale"]),
    invalidCode: z.string().min(1).max(80).optional(),
    createdAt: z.string().min(1),
  })
  .strict();
export type StoredEditCandidate = z.infer<typeof storedCandidateSchema>;

export const readOnlyParagraphSchema = z
  .object({
    paragraphId: z.string().regex(/^p[1-9][0-9]*$/),
    text: z.string(),
  })
  .strict();

/** 目标区间：一个目标块可包含多个段落，或同一超长段落的一个区间。 */
export const proofreadTargetRangeSchema = z
  .object({
    paragraphId: z.string().regex(/^p[1-9][0-9]*$/),
    /** 段落内目标区间，左闭右开。 */
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();
export type ProofreadTargetRange = z.infer<typeof proofreadTargetRangeSchema>;

/** 目标块清单：目标区间互不重叠，只读上下文不能提交补丁。 */
export const proofreadBlockTargetSchema = z
  .object({
    blockId: z.string().regex(/^b[1-9][0-9]*$/),
    targets: z.array(proofreadTargetRangeSchema).min(1).max(200),
    readOnlyBefore: z.array(readOnlyParagraphSchema).max(20),
    readOnlyAfter: z.array(readOnlyParagraphSchema).max(20),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ProofreadBlockTarget = z.infer<typeof proofreadBlockTargetSchema>;

export const proofreadBlockReceiptSchema = z
  .object({
    blockId: z.string().regex(/^b[1-9][0-9]*$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** 规范化后候选的指纹集合；空数组是有效的“无问题”提交。 */
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    patchIds: z.array(z.string().regex(/^pt-[0-9a-f]{16}$/)),
    candidateCount: z.number().int().nonnegative(),
    submittedAt: z.string().min(1),
  })
  .strict();
export type ProofreadBlockReceipt = z.infer<typeof proofreadBlockReceiptSchema>;

export const proofreadPromptSnapshotSchema = z
  .object({
    version: z.string().min(1).max(120),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string().min(1),
  })
  .strict();
export type ProofreadPromptSnapshot = z.infer<
  typeof proofreadPromptSnapshotSchema
>;

/**
 * 单章精校批次：不可变基础正文、选项快照和候选。
 * 注意：审阅决议与操作记录在章节权威文件里，本文件不复制它们，避免双事实源。
 */
export const chapterProofreadBatchSchema = z
  .object({
    schemaVersion: z.literal(PROOFREAD_SCHEMA_VERSION),
    batchId: z.string().uuid(),
    taskId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    chapterId: z.string().min(1),
    baseBodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    baseRevision: z.number().int().positive(),
    baseBody: z.string(),
    baseBlocks: z.array(blockSchema),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    options: proofreadOptionsSchema,
    prompt: proofreadPromptSnapshotSchema,
    blockManifest: z.array(proofreadBlockTargetSchema).max(5000),
    candidates: z.array(storedCandidateSchema).max(20000),
    receipts: z.array(proofreadBlockReceiptSchema).max(5000),
    /**
     * 当本章开始新批次时，旧批次的最后审阅状态归档在这里，保证旧意见仍能
     * 按真实决议查看；活动批次的决议始终以章节权威文件为准。
     */
    archivedReview: chapterReviewStateSchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type ChapterProofreadBatch = z.infer<typeof chapterProofreadBatchSchema>;

export interface CandidateValidationContext {
  /** 批次基础正文 hash。 */
  baseBodyHash: string;
  chapterId: string;
  block: Block;
  /** 目标区间（段落内），只允许在该区间内提补丁。 */
  targetStart: number;
  targetEnd: number;
  paragraphText: string;
  chapterBlocks: readonly Block[];
  enabledCategories: readonly ProofreadCategory[];
}

export interface NormalizedCandidate {
  paragraphId: string;
  start: number;
  end: number;
  before: string;
  after: string;
  category: ProofreadCategory;
  reason: string;
}

export interface CandidateFingerprint {
  patchId: string;
  fingerprint: string;
}

export function isSameCandidate(
  left: Pick<StoredEditCandidate, "fingerprint">,
  right: Pick<StoredEditCandidate, "fingerprint">,
): boolean {
  return left.fingerprint === right.fingerprint;
}

/**
 * TaskSpec 的 options 只允许有界 JSON 基元；这里把完整 ProofreadOptions
 * 投影成可持久化、可参与任务指纹的键值，批次文件仍保存完整快照。
 */
export function proofreadOptionsToTaskOptions(
  options: ProofreadOptions,
): Record<string, string | number | boolean | string[]> {
  return {
    categories: [...options.categories],
    glossary: [...options.glossary],
    userRequest: options.userRequest,
    ruleVersion: options.ruleVersion,
    profileVersion: options.profileVersion,
    autoApplyCategories: [...options.autoApplyCategories],
    ...(options.modelConfigId ? { modelConfigId: options.modelConfigId } : {}),
    chunkMaxChars: options.blockBudget.maxChars,
    chunkMaxParagraphs: options.blockBudget.maxParagraphs,
    chunkContextParagraphs: options.blockBudget.contextParagraphs,
  };
}

export function proofreadOptionsFromTaskOptions(
  options: Readonly<Record<string, string | number | boolean | string[]>>,
): ProofreadOptions {
  const categories = options.categories;
  const glossary = options.glossary;
  const autoApplyCategories = options.autoApplyCategories;
  return proofreadOptionsSchema.parse({
    categories: Array.isArray(categories) ? categories : defaultProofreadOptions.categories,
    glossary: Array.isArray(glossary) ? glossary : [],
    userRequest: typeof options.userRequest === "string" ? options.userRequest : "",
    ruleVersion:
      typeof options.ruleVersion === "string"
        ? options.ruleVersion
        : PROOFREAD_RULE_VERSION,
    profileVersion:
      typeof options.profileVersion === "string"
        ? options.profileVersion
        : PROOFREAD_PROFILE_VERSION,
    ...(typeof options.modelConfigId === "string" && options.modelConfigId
      ? { modelConfigId: options.modelConfigId }
      : {}),
    blockBudget: {
      maxChars:
        typeof options.chunkMaxChars === "number"
          ? options.chunkMaxChars
          : defaultProofreadOptions.blockBudget.maxChars,
      maxParagraphs:
        typeof options.chunkMaxParagraphs === "number"
          ? options.chunkMaxParagraphs
          : defaultProofreadOptions.blockBudget.maxParagraphs,
      contextParagraphs:
        typeof options.chunkContextParagraphs === "number"
          ? options.chunkContextParagraphs
          : defaultProofreadOptions.blockBudget.contextParagraphs,
    },
    autoApplyCategories: Array.isArray(autoApplyCategories)
      ? autoApplyCategories
      : [],
  });
}
