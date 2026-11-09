import type { Block } from "../../shared/book";
import { ProofreadError } from "../../shared/proofreading";
import type { ProjectablePatch } from "./body-projector";

export interface DisplayLocation {
  patchId: string;
  /** 当前工作正文中的显示区间，左闭右开。 */
  from: number;
  to: number;
  /** 删除或零长度插入没有可显示范围，返回锚点。 */
  anchor: boolean;
  kind: "replacement" | "insertion" | "deletion" | "pending";
}

interface Span {
  patchId: string;
  baseStart: number;
  baseEnd: number;
  afterLength: number;
}

export interface PositionMap {
  /** 基础正文坐标 → 当前工作正文坐标。 */
  mapOffset(baseOffset: number): number;
  /** 单条候选在当前正文中的显示位置。 */
  locate(patch: ProjectablePatch, accepted: boolean): DisplayLocation;
}

function spansFor(
  baseBlocks: readonly Block[],
  patches: readonly ProjectablePatch[],
): Span[] {
  const blocks = new Map(baseBlocks.map((block) => [block.id, block]));
  return patches
    .map((patch) => {
      const block = blocks.get(patch.paragraphId);
      if (!block)
        throw new ProofreadError(
          "FORBIDDEN_RANGE",
          "补丁段落不属于批次基础正文",
          patch.patchId,
        );
      return {
        patchId: patch.patchId,
        baseStart: block.start + patch.start,
        baseEnd: block.start + patch.end,
        afterLength: patch.after.length,
      };
    })
    .sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd);
}

/**
 * PF-02 单批次位置映射：只服务「基础正文 + 本批次已采纳补丁」，
 * 不建设任意编辑历史的通用重定位系统。
 */
export function buildPositionMap(
  baseBlocks: readonly Block[],
  accepted: readonly ProjectablePatch[],
): PositionMap {
  const spans = spansFor(baseBlocks, accepted);

  function mapBaseOffset(baseOffset: number, excludePatchId?: string): number {
    let delta = 0;
    for (const span of spans) {
      if (span.patchId === excludePatchId) continue;
      if (span.baseEnd <= baseOffset) {
        delta += span.afterLength - (span.baseEnd - span.baseStart);
        continue;
      }
      if (span.baseStart < baseOffset) {
        // 落在已替换片段内部：指向 after 的对应位置，不猜测更多语义。
        return (
          span.baseStart +
          delta +
          Math.min(span.afterLength, baseOffset - span.baseStart)
        );
      }
      break;
    }
    return baseOffset + delta;
  }

  return {
    mapOffset: (baseOffset) => mapBaseOffset(baseOffset),
    locate(patch, acceptedFlag) {
      const from = mapBaseOffset(
        (() => {
          // 用 span 的全局起点；找不到时按段落块反查。
          const span = spans.find((item) => item.patchId === patch.patchId);
          if (span) return span.baseStart;
          const block = baseBlocks.find((item) => item.id === patch.paragraphId);
          if (!block)
            throw new ProofreadError(
              "FORBIDDEN_RANGE",
              "补丁段落不属于批次基础正文",
              patch.patchId,
            );
          return block.start + patch.start;
        })(),
        acceptedFlag ? patch.patchId : undefined,
      );
      if (acceptedFlag) {
        if (patch.after === "")
          return { patchId: patch.patchId, from, to: from, anchor: true, kind: "deletion" };
        return {
          patchId: patch.patchId,
          from,
          to: from + patch.after.length,
          anchor: false,
          kind: patch.before === "" ? "insertion" : "replacement",
        };
      }
      if (patch.before === "")
        return { patchId: patch.patchId, from, to: from, anchor: true, kind: "insertion" };
      return {
        patchId: patch.patchId,
        from,
        to: from + patch.before.length,
        anchor: false,
        kind: "pending",
      };
    },
  };
}
