import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "../../src/renderer/WorkspaceApp";
import { defaultProofreadOptions } from "../../src/shared/proofreading";
import { defaultFormatOptions } from "../../src/shared/format-options";
import { deriveBlocks } from "../../src/core/text/structure";
import "../../src/renderer/styles.css";

// Isolated bridge fixture: the actual workspace, hook and CodeMirror still render in Electron.
const host = window as any;
const ok = (data: unknown) => ({ ok: true, data });
const details: Record<string, any> = Object.fromEntries(["a", "b"].map((id, order) => [id, {
  chapterId: id, order, kind: "chapter", title: `章节${id}`, sourceTitle: `章节${id}`,
  charCount: 5, bodyRevision: 1, bodyHash: `hash-${id}-1`, titleRevision: 1,
  pendingReview: 1, taskState: "waiting-review", body: `${id}章错字。`,
  blocks: deriveBlocks("txt", `${id}章错字。`, "line"),
}]));
const info = () => ({
  workspaceId: "fixture-workspace", root: "fixture", bookTitle: "P3状态回归", format: "txt",
  chapterOrder: ["a", "b"], chapters: Object.values(details),
  source: { fileName: "test.txt", byteLength: 0, sha256: "0".repeat(64), encoding: "utf-8", eol: "lf", copy: "source/test.txt" },
  importSettings: { splitMode: "auto", paragraphMode: "line", headingLevel: 0, boundaries: [0, 1] },
  createdAt: "2026-11-09", updatedAt: "2026-11-09",
});
const listeners = new Set<(event: any) => void>();
const accepted = new Set<string>();
let releaseApply: (() => void) | null = null;
let delayApply = false;
let applyReturned = false;

function view(id: string, historical = false) {
  const detail = details[id];
  return {
    ...detail, state: "waiting-review", stale: historical, reviewReady: true, readOnly: historical,
    batchId: `${id}${historical ? "-old" : "-batch"}`, taskId: "task", reviewRevision: accepted.has(id) ? 1 : 0,
    expectedHeadHash: detail.bodyHash, chapterBodyHash: detail.bodyHash,
    baseBody: `${id}章错字。`, baseBlocks: deriveBlocks("txt", `${id}章错字。`, "line"),
    options: defaultProofreadOptions,
    counts: { pending: accepted.has(id) ? 0 : 1, accepted: accepted.has(id) ? 1 : 0, ignored: 0, total: 1, conflict: 0, stale: 0 },
    issues: [{ patchId: `${id}-patch`, paragraphId: "p1", start: 2, end: 4,
      before: "错字", after: "正字", category: "typo", reason: `${id}章意见`, source: "model", sources: ["model"],
      decision: accepted.has(id) ? "accepted" : "pending", validity: "valid", conflictWith: [],
      locate: { from: 2, to: 4, anchor: false, kind: "pending" } }],
    canUndo: false,
  };
}

function changeBody(id: string) {
  accepted.add(id);
  details[id] = { ...details[id], body: `${id}章正字。`, bodyRevision: 2,
    bodyHash: `hash-${id}-2`, blocks: deriveBlocks("txt", `${id}章正字。`, "line") };
}

host.desktop = {
  pipeline: { list: async () => ok([]) },
  lifecycle: { onCloseRequested: () => () => {}, confirmClose: async () => ok(null) },
  generate: {
    summary: async () => ok({ chapters: [], tasks: [] }),
    recover: async () => ok({ interrupted: [] }),
    onEvent: () => () => {},
  },
  format: { getPreset: async () => ok(defaultFormatOptions) },
  workspace: { state: async () => ok(info()) },
  chapters: { get: async ({ chapterId }: any) => ok(structuredClone(details[chapterId])) },
  proofread: {
    recover: async () => ok({ interrupted: [] }),
    summary: async () => ok({ chapters: [], tasks: [] }),
    batches: async ({ chapterId }: any) => ok({ batches: [false, true].map(old => ({
      batchId: `${chapterId}${old ? "-old" : "-batch"}`, taskId: "task", createdAt: "2026-11-09", active: !old, candidateCount: 1,
    })) }),
    chapter: async ({ chapterId, batchId }: any) => ok(structuredClone(view(chapterId, batchId?.endsWith("-old")))),
    onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
    apply: async ({ chapterId }: any) => {
      if (delayApply) await new Promise<void>(resolve => { releaseApply = resolve; });
      changeBody(chapterId);
      applyReturned = true;
      return ok(structuredClone(view(chapterId)));
    },
  },
};

host.fixture = {
  autoApply(id = "a") {
    changeBody(id);
    for (const event of [
      { type: "taskStarted", state: "running" },
      { type: "taskStateChanged", state: "completed" },
    ]) for (const listener of listeners) listener({ ...event, workspaceId: "fixture-workspace", taskId: "auto-task", chapterId: id, message: "自动应用完成" });
  },
  delayApply() { delayApply = true; },
  releaseApply() { releaseApply?.(); },
  hasPendingApply() { return releaseApply !== null; },
  applyReturned() { return applyReturned; },
};

createRoot(document.getElementById("root")!).render(<WorkspaceApp initial={info() as any} onClosed={() => undefined} />);
