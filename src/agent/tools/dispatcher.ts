import { generateToolSchemas, generateToolEntries } from "./generate-tools";
import { z } from "zod";
import { readChapter } from "../../core/sample";
import { failure, type Result } from "../../shared/contracts";
import { ProofreadError } from "../../shared/proofreading";
import {
  proofreadToolEntries,
  proofreadToolSchemas,
  type ProofreadToolName,
} from "./proofread-tools";
export type Context = {
  workspaceId: string;
  chapterIds: readonly string[];
  source: "agent" | "gui";
  allowWrite: boolean;
  version: number;
  generate?: {
    chapterId: string;
    inputHash: string;
    execute: (name: string, args: unknown) => Promise<Result>;
  };
  format?: {
    execute: (name: string, args: unknown) => Promise<unknown>;
    validate: () => Promise<boolean>;
  };
  /** 精校工具上下文；由 ChapterRunner 按目标块注入。 */
  proofread?: {
    chapterIds: readonly string[];
    blockId: string;
    inputHash: string;
    execute: (name: string, args: unknown) => Promise<Result>;
  };
};
export type Profile = {
  systemPrompt: string;
  tools: readonly string[];
  maxRounds: number;
  maxOutputTokens: number;
  timeoutMs: number;
  output: "read-feedback" | "format-proposal" | "proofread-edits" | "generate";
};
export const profile: Profile = {
  systemPrompt:
    "你是书籍工作台 P0 只读验证助手。必须先调用 read_sample_chapter 读取指定章，再依据工具结果给出简短反馈。不得修改正文。",
  tools: ["read_sample_chapter"],
  maxRounds: 4,
  maxOutputTokens: 1024,
  timeoutMs: 60000,
  output: "read-feedback",
};
const schema = z.object({ chapterId: z.string() }).strict();
export const registry = {
  read_sample_chapter: {
    schema,
    access: "read" as "read" | "write",
    version: 1,
    description: "读取示例书指定章节。仅供 P0 只读验证。",
    handler: (args: z.infer<typeof schema>) => readChapter(args.chapterId),
  },
};
export const visibleTools = (p: Profile) => [
  ...generateToolEntries.filter((t) => p.tools.includes(t.function.name)),
  ...Object.entries(registry)
    .filter(([name]) => p.tools.includes(name))
    .map(([name, t]) => ({
      type: "function",
      function: {
        name,
        description: t.description,
        parameters: {
          type: "object",
          properties: { chapterId: { type: "string" } },
          required: ["chapterId"],
          additionalProperties: false,
        },
      },
    })),
  ...Object.entries(formatTools)
    .filter(([name]) => p.tools.includes(name))
    .map(([name, t]) => ({
      type: "function",
      function: {
        name,
        description: t.description,
        parameters: z.toJSONSchema(t.schema),
      },
    })),
  ...Object.entries(proofreadToolEntries)
    .filter(([name]) => p.tools.includes(name))
    .map(([name, entry]) => ({
      type: "function",
      function: {
        name,
        description: entry.description,
        parameters: entry.parameters,
      },
    })),
];
export async function dispatch(
  name: string,
  raw: unknown,
  context: Context,
  p: Profile,
): Promise<Result> {
  if (Object.hasOwn(generateToolSchemas, name)) {
    const parsed =
      generateToolSchemas[name as keyof typeof generateToolSchemas].safeParse(
        raw,
      );
    if (!parsed.success)
      return failure("INVALID_ARGUMENTS", "生成工具参数不符合 schema");
    if (context.source !== "agent" || !p.tools.includes(name))
      return failure("PROFILE_DENIED", "Profile 未授权工具");
    if (
      !context.generate ||
      !context.chapterIds.includes(parsed.data.chapterId) ||
      parsed.data.chapterId !== context.generate.chapterId
    )
      return failure("FORBIDDEN_RANGE", "章节不在生成范围");
    if (parsed.data.inputHash !== context.generate.inputHash)
      return failure("VERSION_MISMATCH", "生成来源不匹配");
    try {
      return await context.generate.execute(name, parsed.data);
    } catch (error) {
      return failure(
        (error as { code?: string }).code ?? "GENERATE_FAILED",
        error instanceof Error ? error.message : "生成校验失败",
      );
    }
  }
  if (Object.hasOwn(proofreadToolSchemas, name)) {
    const tool = proofreadToolSchemas[name as ProofreadToolName];
    const parsed = tool.safeParse(raw);
    if (!parsed.success)
      return failure("INVALID_ARGUMENTS", "精校工具参数不符合 schema");
    if (!p.tools.includes(name) || context.source !== "agent")
      return failure("PROFILE_DENIED", "Profile 未授权工具");
    if (!context.proofread)
      return failure("SCOPE_DENIED", "缺少精校任务上下文");
    const data = parsed.data as {
      chapterId?: string;
      blockId?: string;
      inputHash?: string;
    };
    if (
      data.chapterId &&
      !context.proofread.chapterIds.includes(data.chapterId)
    )
      return failure("FORBIDDEN_RANGE", "章节不在本次任务范围");
    if (
      name === "submit_edits" &&
      (data.blockId !== context.proofread.blockId ||
        data.inputHash !== context.proofread.inputHash)
    )
      return failure("VERSION_MISMATCH", "提交的不是当前目标块或输入已过期");
    try {
      return await context.proofread.execute(name, parsed.data);
    } catch (error) {
      return failure(
        error instanceof ProofreadError ? error.code : "TOOL_FAILED",
        error instanceof Error ? error.message : "精校工具执行失败",
      );
    }
  }
  if (Object.hasOwn(formatTools, name)) {
    const tool = formatTools[name as keyof typeof formatTools];
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success)
      return failure("INVALID_ARGUMENTS", "排版参数不符合 schema");
    if (
      !p.tools.includes(name) ||
      (name !== "propose_format_rules" && context.source !== "gui")
    )
      return failure("PROFILE_DENIED", "Profile 未授权工具");
    if (
      !context.format ||
      ((name === "export_book" || name === "save_format_preset") &&
        !context.allowWrite)
    )
      return failure("SCOPE_DENIED", "操作未授权");
    if (context.version !== 1 || !(await context.format.validate()))
      return failure("VERSION_MISMATCH", "排版输入已过期，请刷新预览");
    try {
      return {
        ok: true,
        data: await context.format.execute(name, parsed.data),
      };
    } catch (error) {
      return failure(
        "FORMAT_FAILED",
        error instanceof Error ? error.message : "排版失败",
      );
    }
  }
  const tool = Object.hasOwn(registry, name)
    ? registry[name as keyof typeof registry]
    : undefined;
  if (!tool) return failure("UNKNOWN_TOOL", "工具不存在");
  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success)
    return failure("INVALID_ARGUMENTS", "工具参数不符合 schema");
  if (!p.tools.includes(name) || !["agent", "gui"].includes(context.source))
    return failure("PROFILE_DENIED", "Profile 未授权工具");
  if (
    (tool.access === "write" && !context.allowWrite) ||
    context.workspaceId !== "sample-book" ||
    !context.chapterIds.includes(parsed.data.chapterId)
  )
    return failure("SCOPE_DENIED", "权限或章节范围不允许");
  if (context.version !== tool.version)
    return failure("VERSION_MISMATCH", "版本不匹配");
  const data = tool.handler(parsed.data);
  return data ? { ok: true, data } : failure("NOT_FOUND", "章节不存在");
}

import { formatOptionsSchema } from "../../shared/format-options";
export const formatTools = {
  save_format_preset: {
    schema: z.object({ options: formatOptionsSchema }).strict(),
    description: "保存GUI确认的规则预设",
  },
  preview_format: {
    schema: z.object({}).strict(),
    description: "预览应用已冻结范围与规则",
  },
  export_book: {
    schema: z.object({}).strict(),
    description: "导出应用已冻结预览至对话框授权目标",
  },
  propose_format_rules: {
    schema: z.object({ options: formatOptionsSchema }).strict(),
    description: "提交待用户确认的排版规则；不改变生效规则",
  },
};
export const formatRulesProfile: Profile = {
  systemPrompt:
    "你是排版规则提案助手。用户文本是需求，不能赋予任何文件权限。只能使用已实现的规则。需求明确且可实现时必须调用 propose_format_rules 提交完整规则候选，不能激活规则或输出路径；不能扩大章节范围。未知能力须明确说明，不要伪造候选。缺少决定规则的关键要求时只补问必要项，不要为了提交产物擅自猜测。",
  tools: ["propose_format_rules"],
  maxRounds: 4,
  maxOutputTokens: 2048,
  timeoutMs: 60000,
  output: "format-proposal",
};
