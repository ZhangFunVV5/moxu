import { randomUUID } from "node:crypto";
import type { Adapter } from "../../agent/model/model-adapter";
import { run } from "../../agent/runtime/loop";
import { titleProfile } from "../../agent/prompts/title";
import { summaryProfile } from "../../agent/prompts/summary";
import { TaskStore } from "../../agent/tasks/task-store";
import type { TaskSpec } from "../../shared/task";
import {
  GENERATE_PROFILE_VERSION,
  GenerateError,
  type GenerateArtifact,
  type TitleOptions,
  type SummaryOptions,
} from "../../shared/generate";
import type { GenerateEventDto } from "../../shared/generate-contracts";
import { readChapterFile, type Workspace } from "../workspace/book-store";
import { chunkBody, validateText, validateTitles } from "./validate";
import { saveArtifact } from "./store";
export async function runGenerateTask(input: {
  workspace: Workspace;
  spec: TaskSpec;
  taskStore: TaskStore;
  adapter: Adapter;
  signal: AbortSignal;
  emit?: (event: Omit<GenerateEventDto, "workspaceId" | "taskId">) => void;
}) {
  const { workspace, spec, taskStore, adapter, signal } = input;
  let failed = false;
  for (const chapterId of spec.chapterIds) {
    const cp = taskStore.getCheckpoint(chapterId);
    if (cp.status === "completed") continue;
    if (signal.aborted) {
      await taskStore.cancelChapter(chapterId);
      continue;
    }
    await taskStore.setState(chapterId, "running");
    try {
      const chapter = await readChapterFile(
        workspace.root,
        workspace.book,
        chapterId,
      );
      if (
        chapter.bodyHash !== spec.inputHashes[chapterId] ||
        chapter.title.source !== spec.options[`sourceTitle:${chapterId}`]
      )
        throw new GenerateError(
          "SOURCE_CHANGED",
          "正文或来源标题已变化，请创建新任务",
        );
      const kind = spec.type === "generate_title" ? "title" : "summary";
      const options = JSON.parse(String(spec.options.generateOptions)) as
        | TitleOptions
        | SummaryOptions;
      const invoke = async (
        mode: "notes" | "final",
        body: string,
      ): Promise<{ titles?: string[]; summary?: string }> => {
        let submitted: { titles?: string[]; summary?: string } | undefined;
        const isTitle = kind === "title" && mode === "final";
        const profile = isTitle ? titleProfile : summaryProfile;
        await run(
          adapter,
          profile,
          {
            workspaceId: spec.workspaceId,
            chapterIds: [chapterId],
            source: "agent",
            allowWrite: false,
            version: 1,
            generate: {
              chapterId,
              inputHash: chapter.bodyHash,
              execute: async (name, raw) => {
                const args = raw as { titles: string[]; summary: string };
                if (
                  (isTitle && name !== "submit_titles") ||
                  (!isTitle && name !== "submit_summary")
                )
                  throw new GenerateError("PROFILE_DENIED", "本阶段工具不符");
                submitted = isTitle
                  ? {
                      titles: validateTitles(
                        args.titles,
                        options as TitleOptions,
                      ),
                    }
                  : {
                      summary: validateText(
                        args.summary,
                        mode === "notes"
                          ? { minLength: 1, maxLength: 1000 }
                          : options,
                      ),
                    };
                return { ok: true, data: { submitted: true } };
              },
            },
          },
          JSON.stringify({
            chapterId,
            inputHash: chapter.bodyHash,
            sourceTitle: chapter.title.source,
            mode:
              mode === "notes"
                ? "仅提取本块局部要点，稍后还需整章汇总"
                : "基于全部原文或全部分块要点生成完整章节产物",
            options,
            body,
          }),
          signal,
          (type, message) => input.emit?.({ type, message, chapterId }),
        );
        if (!submitted)
          throw new GenerateError("MISSING_ARTIFACT", "模型未提交产物");
        return submitted;
      };
      const chunks = chunkBody(chapter.body);
      if (chunks.length > 60)
        throw new GenerateError(
          "INPUT_LIMIT",
          "本章超过 60 个分块，请缩小章节后重试",
        );
      let content = chapter.body;
      if (chunks.length > 1) {
        const notes: string[] = [];
        for (let i = 0; i < chunks.length; i++) {
          if (signal.aborted) throw new GenerateError("CANCELLED", "已取消");
          const local = await invoke("notes", chunks[i]);
          notes.push(`块 ${i + 1}/${chunks.length}：${local.summary}`);
        }
        content = notes.join("\n");
        if ([...content].length > 30000)
          throw new GenerateError(
            "INPUT_LIMIT",
            "全部局部要点超过汇总容量，未保存为最终产物",
          );
      }
      const final = await invoke("final", content);
      if (signal.aborted) throw new GenerateError("CANCELLED", "已取消");
      const current = await readChapterFile(
        workspace.root,
        workspace.book,
        chapterId,
      );
      if (current.bodyHash !== chapter.bodyHash)
        throw new GenerateError("SOURCE_CHANGED", "生成期间正文变化");
      const artifact: GenerateArtifact = {
        schemaVersion: 1,
        artifactId: randomUUID(),
        taskId: spec.taskId,
        workspaceId: spec.workspaceId,
        chapterId,
        kind,
        sourceBodyHash: chapter.bodyHash,
        inputFingerprint: spec.inputFingerprint,
        sourceTitle: chapter.title.source,
        profileVersion: GENERATE_PROFILE_VERSION,
        modelConfigId: spec.modelConfigId,
        options,
        ...final,
        createdAt: new Date().toISOString(),
      };
      await saveArtifact(workspace.root, artifact);
      await taskStore.writeArtifact(chapterId, {
        kind: `generate-${kind}`,
        completedBlockIds: chunks.map((_, i) => `block-${i + 1}`),
        payload: artifact,
      });
      await taskStore.completeChapter(chapterId);
      input.emit?.({
        type: "chapterUpdated",
        chapterId,
        state: "completed",
        message: "生成产物已保存",
      });
    } catch (error) {
      const code = signal.aborted
        ? "CANCELLED"
        : ((error as { code?: string }).code ?? "GENERATE_FAILED");
      if (signal.aborted) await taskStore.cancelChapter(chapterId);
      else {
        failed = true;
        await taskStore.failChapter(chapterId, code);
      }
      input.emit?.({
        type: "chapterUpdated",
        chapterId,
        state: signal.aborted ? "cancelled" : "failed",
        message: `${code}：${error instanceof Error ? error.message : "生成失败"}`,
      });
    }
  }
  return {
    status: signal.aborted ? "cancelled" : failed ? "failed" : "completed",
  } as const;
}
