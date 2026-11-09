import type { ChapterFile } from "../../shared/book";
import {
  CATEGORY_LABELS,
  type ChapterProofreadBatch,
} from "../../shared/proofreading";
import type { ChapterReviewState } from "../../shared/review-state";
import { buildIssueViews } from "./review-service";

export interface ReportChapterInput {
  chapter: ChapterFile;
  batch: ChapterProofreadBatch;
}

export interface ReportInput {
  bookTitle: string;
  chapters: readonly ReportChapterInput[];
  generatedAt: string;
}

const OPERATION_LABELS: Record<string, string> = {
  accept: "采纳",
  ignore: "忽略",
  restore: "恢复待审",
  withdraw: "撤回修改",
  "batch-accept": "按类别采纳",
  "batch-ignore": "按类别忽略",
  "auto-apply": "已授权自动应用",
};

function reviewOf(
  chapter: ChapterFile,
  batch: ChapterProofreadBatch,
): ChapterReviewState | null {
  if (chapter.review?.batchId === batch.batchId) return chapter.review;
  return batch.archivedReview ?? null;
}

/**
 * PF-08 修改报告：只把当前 accepted 集合列为“最终有效修改”；
 * 忽略、撤回和待审项单列，绝不出现在成稿修改里。不含密钥、内部推理和本机路径。
 */
export function buildProofreadReport(input: ReportInput): string {
  const lines: string[] = [
    "# 精校修改报告",
    "",
    `作品：${input.bookTitle}`,
    `生成时间：${input.generatedAt}`,
    "说明：本报告只由工作区章节权威文件与精校批次派生；不含 API Key、模型内部推理或本机路径。",
    "",
  ];
  for (const [index, { chapter, batch }] of input.chapters.entries()) {
    const review = reviewOf(chapter, batch);
    lines.push(`## 第 ${index + 1} 章 ${chapter.title.current}`);
    lines.push("");
    lines.push(`- 章节 ID：${chapter.chapterId}`);
    lines.push(`- 批次：${batch.batchId}`);
    lines.push(`- 基础正文 hash：${batch.baseBodyHash}`);
    lines.push(`- 最终正文 hash：${chapter.bodyHash}`);
    lines.push(`- 审阅修订：${review?.reviewRevision ?? 0}`);
    if (!review) {
      lines.push("- 审阅状态：批次未绑定到当前章节，报告只列候选。");
    }
    const stale = Boolean(
      review && chapter.bodyHash !== review.expectedHeadHash,
    );
    if (stale)
      lines.push("- 注意：正文在批次外被修改，以下意见不再直接可套用。");
    const views = buildIssueViews(
      batch.candidates,
      review?.decisions ?? {},
      review?.acceptedPatchIds ?? [],
      stale,
    );
    const effective = views.filter((issue) => issue.decision === "accepted");
    lines.push("");
    lines.push("### 最终有效修改");
    if (effective.length === 0) {
      lines.push("（无）");
    } else {
      effective.forEach((issue, order) => {
        lines.push(
          `${order + 1}. [${CATEGORY_LABELS[issue.category]}] 段落 ${issue.paragraphId} 基础区间 [${issue.start}, ${issue.end})`,
        );
        lines.push(`   - 原文：${issue.before}`);
        lines.push(
          `   - 建议：${issue.after === "" ? "（删除）" : issue.after}`,
        );
        lines.push(`   - 理由：${issue.reason}`);
        lines.push(
          `   - 来源：${issue.sources.includes("rule") ? "规则" : "模型"}${issue.sources.length > 1 ? "＋模型" : ""}`,
        );
      });
    }
    const inactive = views.filter((issue) => issue.decision !== "accepted");
    lines.push("");
    lines.push("### 未生效意见（不进入成稿修改）");
    if (inactive.length === 0) {
      lines.push("（无）");
    } else {
      for (const issue of inactive) {
        const status =
          issue.decision === "ignored"
            ? "已忽略"
            : issue.validity === "stale"
              ? "已过期"
              : issue.validity === "conflict"
                ? "冲突"
                : issue.validity === "invalid"
                  ? "无效"
                  : "待审";
        lines.push(
          `- [${status}] [${CATEGORY_LABELS[issue.category]}] ${issue.paragraphId} [${issue.start}, ${issue.end}) ${issue.before} → ${issue.after === "" ? "（删除）" : issue.after}`,
        );
      }
    }
    lines.push("");
    lines.push("### 审阅操作记录");
    if (!review || review.operations.length === 0) lines.push("（无）");
    else {
      for (const operation of review.operations) {
        lines.push(
          `- ${operation.createdAt} ${OPERATION_LABELS[operation.kind] ?? operation.kind}：${operation.patchIds.join(", ")} · 结果 hash ${operation.resultHeadHash.slice(0, 12)}… · 修订 ${operation.resultReviewRevision}`,
        );
      }
    }
    if (review?.undos.length) {
      lines.push("");
      lines.push("### 撤回操作记录");
      for (const undo of review.undos) {
        lines.push(
          `- ${undo.createdAt} 撤回上次操作 · 操作 ID ${undo.operationId} · 原操作 ID ${undo.undoneOperationId} · 修订 ${undo.restoredReviewRevision}`,
        );
        if (undo.undoneOperation) {
          const original = undo.undoneOperation;
          lines.push(
            `  - 原操作：${original.createdAt} ${OPERATION_LABELS[original.kind] ?? original.kind}：${original.patchIds.join(", ")}`,
          );
        }
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
