import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { defaultProofreadOptions } from "../shared/proofreading";
import {
  DEFAULT_TITLE_OPTIONS,
  DEFAULT_SUMMARY_OPTIONS,
} from "../shared/generate";
import { defaultFormatOptions } from "../shared/format-options";
import type {
  PipelineRecord,
  PipelineStartRequest,
} from "../shared/pipeline-contracts";

const labels: Record<string, string> = {
  proofread: "精校",
  review: "审阅",
  title: "标题",
  summary: "摘要",
  format: "排版",
  export: "导出",
  queued: "排队中",
  running: "运行中",
  "waiting-title": "等待标题确认",
  "waiting-review": "等待审阅",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
export async function cancelWorkspaceTasks() {
  const stoppedProofread = new Set<string>(),
    stoppedGenerate = new Set<string>();
  function checked(
    result: { ok: boolean; error?: { code: string; message: string } },
    taskId: string,
    tracked: Set<string>,
  ) {
    if (result.ok) tracked.add(taskId);
    else if (
      result.error?.code !== "TASK_NOT_FOUND" &&
      result.error?.code !== "NOT_FOUND"
    )
      throw new Error(result.error?.message ?? "任务取消失败");
  }
  const pipelines = await window.desktop.pipeline.list();
  if (pipelines.ok)
    for (const p of pipelines.data)
      if (["running", "queued"].includes(p.state))
        checked(
          await window.desktop.pipeline.cancel({ pipelineId: p.pipelineId }),
          p.pipelineId,
          new Set(),
        );
  const p = await window.desktop.proofread.summary();
  if (p.ok)
    for (const t of p.data.tasks)
      if (["running", "queued"].includes(t.status))
        checked(
          await window.desktop.proofread.cancel({ taskId: t.taskId }),
          t.taskId,
          stoppedProofread,
        );
  const g = await window.desktop.generate.summary();
  if (g.ok)
    for (const t of g.data.tasks)
      if (["running", "queued"].includes(t.state))
        checked(
          await window.desktop.generate.cancel({ taskId: t.taskId }),
          t.taskId,
          stoppedGenerate,
        );
  // Wait for terminal checkpoints before releasing the old workspace context.
  for (let attempt = 0; attempt < 100; attempt++) {
    const [proofread, generate] = await Promise.all([
      window.desktop.proofread.summary(),
      window.desktop.generate.summary(),
    ]);
    const running =
      (proofread.ok &&
        proofread.data.tasks.some(
          (t) =>
            stoppedProofread.has(t.taskId) &&
            ["running", "queued"].includes(t.status),
        )) ||
      (generate.ok &&
        generate.data.tasks.some(
          (t) =>
            stoppedGenerate.has(t.taskId) &&
            ["running", "queued"].includes(t.state),
        ));
    if (!running) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("任务仍在保存取消检查点，请稍后重试关闭或切换作品。");
}
export function PipelinePanel({
  workspaceId,
  chapterIds,
  dirty,
  onMessage,
  onUpdated,
}: {
  workspaceId: string;
  chapterIds: string[];
  dirty: boolean;
  onMessage: (s: string) => void;
  onUpdated: () => void;
}) {
  const [records, setRecords] = useState<PipelineRecord[]>([]),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [steps, setSteps] = useState({
    proofread: true,
    title: false,
    summary: false,
    format: true,
    export: true,
  });
  const [outputFormat, setOutputFormat] = useState<"txt" | "markdown">("txt");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [activity, setActivity] = useState<
    Array<{ taskId: string; message: string }>
  >([]);
  const current = useRef(workspaceId);
  current.current = workspaceId;
  const signature = useRef("");
  useEffect(() => {
    setActivity([]);
    const receive = (event: {
      workspaceId: string;
      taskId: string;
      chapterId?: string;
      message: string;
    }) => {
      if (event.workspaceId !== current.current) return;
      const message = `${event.chapterId ? `章节 ${event.chapterId} · ` : ""}${event.message}`;
      setActivity((values) =>
        [...values, { taskId: event.taskId, message }].slice(-30),
      );
    };
    const p = window.desktop.proofread.onEvent(receive),
      g = window.desktop.generate.onEvent(receive);
    return () => {
      p();
      g();
    };
  }, [workspaceId]);
  async function refresh() {
    const expected = workspaceId;
    const r = await window.desktop.pipeline.list();
    if (current.current !== expected) return;
    if (r.ok) {
      setRecords(r.data);
      const next = JSON.stringify(r.data);
      if (signature.current !== next) {
        signature.current = next;
        onUpdated();
      }
    } else setError(r.error.message);
  }
  useEffect(() => {
    setRecords([]);
    void refresh();
    const timer = setInterval(() => void refresh(), 600);
    return () => clearInterval(timer);
  }, [workspaceId]);
  async function execute(
    action: () => Promise<{ ok: boolean; error?: { message: string } }>,
  ) {
    setBusy(true);
    setError("");
    try {
      const r = await action();
      if (!r.ok) {
        setError(r.error?.message ?? "任务失败");
        onMessage(r.error?.message ?? "任务失败");
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function start(request: PipelineStartRequest) {
    await execute(() => window.desktop.pipeline.start(request));
  }
  async function send() {
    await execute(async () => {
      const r = await window.desktop.pipeline.propose({ prompt, chapterIds });
      if (!r.ok) return r;
      if (r.data.kind === "clarification") {
        setError(r.data.message);
        return { ok: true };
      }
      onMessage(r.data.notes.join(" · ") || "按当前范围开始任务");
      return window.desktop.pipeline.start(r.data.request);
    });
  }
  const request: PipelineStartRequest = {
    chapterIds,
    ...(steps.proofread ? { proofread: defaultProofreadOptions } : {}),
    ...(steps.title ? { title: DEFAULT_TITLE_OPTIONS } : {}),
    ...(steps.summary ? { summary: DEFAULT_SUMMARY_OPTIONS } : {}),
    ...(steps.format
      ? {
          format: { options: defaultFormatOptions, outputFormat },
          export: steps.export,
        }
      : {}),
  };
  return (
    <>
      <section className="bb-pipeline" aria-label="组合流程">
        <details>
          <summary>组合流程 · 当前范围 {chapterIds.length} 章</summary>
          <div className="bb-agent-content">
            <p className="bb-note">
              精校后暂停审阅；明确继续后，生成和排版使用最新已保存正文。标题只生成候选。
            </p>
            {(
              ["proofread", "title", "summary", "format", "export"] as const
            ).map((key) => (
              <label className="bb-format-check" key={key}>
                <input
                  type="checkbox"
                  checked={steps[key]}
                  disabled={key === "export" && !steps.format}
                  onChange={(e) =>
                    setSteps({ ...steps, [key]: e.target.checked })
                  }
                />
                {labels[key]}
              </label>
            ))}
            <label className="bb-field">
              成稿格式
              <select
                value={outputFormat}
                onChange={(e) =>
                  setOutputFormat(e.target.value as "txt" | "markdown")
                }
              >
                <option value="txt">TXT</option>
                <option value="markdown">Markdown</option>
              </select>
            </label>
            <button
              data-testid="pipeline-start"
              className="bb-button primary"
              disabled={
                busy ||
                dirty ||
                !chapterIds.length ||
                !Object.entries(steps).some(([k, v]) => k !== "export" && v)
              }
              onClick={() => void start(request)}
            >
              开始组合流程
            </button>
          </div>
        </details>
        {dirty && (
          <p className="bb-note">有未保存的修改，请先保存正文再开始任务。</p>
        )}
        {error && (
          <p className="bb-error" role="alert">
            {error}
          </p>
        )}
        {records
          .slice()
          .reverse()
          .map((r) => (
            <section
              className="bb-pipeline-record"
              key={r.pipelineId}
              data-testid="pipeline-record"
            >
              <strong>
                {labels[r.state]} · {r.request.chapterIds.length} 章
              </strong>
              <ol>
                {r.stages.map((s) => (
                  <li key={s.kind}>
                    {labels[s.kind]} · {labels[s.state]}
                    {s.error && <span className="bb-error"> · {s.error}</span>}
                  </li>
                ))}
              </ol>
              {r.error && <p className="bb-error">{r.error}</p>}
              {r.outputPath && (
                <p className="bb-note">成稿已导出：{r.outputPath}</p>
              )}
              {r.state === "waiting-review" && (
                <label className="bb-format-check">
                  <input
                    type="checkbox"
                    checked={!!pending[r.pipelineId]}
                    onChange={(e) =>
                      setPending({
                        ...pending,
                        [r.pipelineId]: e.target.checked,
                      })
                    }
                  />
                  即使仍有待审意见，也基于当前已保存正文继续
                </label>
              )}
              {[
                "waiting-title",
                "waiting-review",
                "failed",
                "interrupted",
                "cancelled",
              ].includes(r.state) && (
                <button
                  className="bb-button"
                  disabled={busy || dirty}
                  onClick={() =>
                    void execute(() =>
                      window.desktop.pipeline.resume({
                        pipelineId: r.pipelineId,
                        continueWithPending: !!pending[r.pipelineId],
                      }),
                    )
                  }
                >
                  {r.state === "waiting-title"
                    ? "标题决议后继续流程"
                    : r.state === "waiting-review"
                      ? "审阅完成，继续流程"
                      : "恢复未完成阶段"}
                </button>
              )}
              {["running", "queued"].includes(r.state) && (
                <button
                  className="bb-button"
                  disabled={busy}
                  onClick={() =>
                    void execute(() =>
                      window.desktop.pipeline.cancel({
                        pipelineId: r.pipelineId,
                      }),
                    )
                  }
                >
                  取消组合任务
                </button>
              )}
            </section>
          ))}
      </section>
      <details className="bb-agent">
        <summary>
          Agent 任务 <ChevronDown size={14} />
        </summary>
        <div className="bb-agent-content">
          <label>
            描述任务
            <textarea
              aria-label="统一任务要求"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="精校这些章节，审阅后生成摘要并排版导出"
            />
          </label>
          <p className="bb-note">
            只处理当前选定的 {chapterIds.length}{" "}
            章；明确要求直接执行，歧义只补问必要信息。
          </p>
          <button
            className="bb-button primary"
            disabled={busy || dirty || !prompt.trim() || !chapterIds.length}
            onClick={() => void send()}
          >
            {busy ? "处理中…" : "发送任务"}
          </button>
          <div aria-label="任务活动" className="bb-task-activity">
            <p className="bb-note">
              最近 30 条活动；仅显示服务实际返回的 usage，未返回时不估算。
            </p>
            <ol>
              {activity.map((event, index) => (
                <li key={index}>
                  <span className="bb-sub">
                    任务 {event.taskId.slice(0, 8)} ·{" "}
                  </span>
                  {event.message}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </details>
    </>
  );
}
