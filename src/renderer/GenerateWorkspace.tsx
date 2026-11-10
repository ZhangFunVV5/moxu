import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_TITLE_OPTIONS,
  DEFAULT_SUMMARY_OPTIONS,
  type TitleOptions,
  type SummaryOptions,
} from "../shared/generate";
import type {
  ChapterGenerateView,
  GenerateSummaryDto,
  GenerateTaskResult,
} from "../shared/generate-contracts";

export function useGenerateWorkspace(input: {
  workspaceId: string;
  chapterId: string;
  scopeIds: string[];
  sourceVersion: string;
  dirty: boolean;
  enabled: boolean;
  beforeGenerate: () => Promise<boolean>;
  onMessage: (text: string) => void;
  onTitleUpdated: (view: ChapterGenerateView) => void;
}) {
  const [batch, setBatch] = useState<GenerateTaskResult | null>(null);
  const [progress, setProgress] = useState<GenerateTaskResult | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [appliedIds, setAppliedIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const batchRef = useRef<GenerateTaskResult | null>(null);
  const trackedTaskId = useRef<string | null>(null);
  const batchTasks = useRef<GenerateSummaryDto["tasks"]>([]);
  const shown = useRef(new Set<string>());
  const dialogRef = useRef<HTMLDialogElement>(null);
  const batchReturnFocus = useRef<HTMLElement | null>(null);
  batchRef.current = batch;
  const [view, setView] = useState<ChapterGenerateView | null>(null);
  const [overview, setOverview] = useState<GenerateSummaryDto | null>(null);
  const [titleOptions, setTitleOptions] = useState<TitleOptions>(
    DEFAULT_TITLE_OPTIONS,
  );
  const [summaryOptions, setSummaryOptions] = useState<SummaryOptions>(
    DEFAULT_SUMMARY_OPTIONS,
  );
  const [edits, setEdits] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activity, setActivity] = useState("");
  const latest = useRef(input);
  latest.current = input;
  const refreshVersion = useRef(0);
  const refresh = async () => {
    const current = latest.current;
    const version = ++refreshVersion.current;
    if (!current.enabled || !current.chapterId) return;
    setLoading(true);
    const [chapter, summary] = await Promise.all([
      window.desktop.generate.chapter({ chapterId: current.chapterId }),
      window.desktop.generate.summary(),
    ]);
    if (
      version !== refreshVersion.current ||
      latest.current.workspaceId !== current.workspaceId ||
      latest.current.chapterId !== current.chapterId
    )
      return;
    if (chapter.ok) setView(chapter.data);
    else setError(`${chapter.error.code}：${chapter.error.message}`);
    if (summary.ok) {
      setOverview(summary.data);
      batchTasks.current = summary.data.tasks;
    }
    setLoading(false);
  };
  useEffect(() => {
    setView(null);
    setError("");
    void refresh();
  }, [input.workspaceId, input.chapterId, input.sourceVersion, input.enabled]);
  useEffect(() => {
    void window.desktop.generate.recover().then(() => refresh());
    return window.desktop.generate.onEvent((event) => {
      if (event.workspaceId !== latest.current.workspaceId) return;
      if (event.type === "taskStarted") {
        shown.current.delete(event.taskId);
      }
      if (event.type === "taskStarted")
        void window.desktop.generate.summary().then((r) => {
          if (r.ok && event.workspaceId === latest.current.workspaceId) {
            batchTasks.current = r.data.tasks;
            if (
              r.data.tasks.some(
                (t) => t.taskId === event.taskId && t.batchConfirmation,
              )
            )
              trackedTaskId.current = event.taskId;
          }
        });
      const states: Record<string, string> = {
        completed: "已完成",
        failed: "失败",
        cancelled: "已取消",
        running: "进行中",
        interrupted: "已中断",
        queued: "排队中",
      };
      setActivity(
        event.type === "taskStateChanged" && event.state
          ? "生成任务" + (states[event.state] ?? event.state)
          : event.message,
      );
      if (event.type === "taskStateChanged") void refresh();
      if (
        event.type === "chapterUpdated" &&
        event.state !== "running" &&
        event.chapterId === latest.current.chapterId &&
        latest.current.enabled
      ) {
        const workspaceId = event.workspaceId;
        void window.desktop.generate
          .chapter({ chapterId: event.chapterId })
          .then((r) => {
            if (
              r.ok &&
              latest.current.workspaceId === workspaceId &&
              latest.current.chapterId === event.chapterId
            )
              setView(r.data);
          });
      }
      if (event.type === "taskStateChanged" && event.state === "failed")
        setError(event.message);
    });
  }, [input.workspaceId]);
  useEffect(() => {
    shown.current.clear();
    setBatch(null);
    setProgress(null);
    batchTasks.current = [];
    trackedTaskId.current = null;
    let stopped = false;
    void window.desktop.generate.summary().then((r) => {
      if (!stopped && r.ok) batchTasks.current = r.data.tasks;
    });
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const workspaceId = latest.current.workspaceId;
        if (stopped) return;
        const tasks = batchTasks.current
          .filter(
            (t) =>
              t.kind === "title" &&
              t.batchConfirmation &&
              t.chapterIds.length > 1,
          )
          .sort((a, b) =>
            (b.activityAt ?? b.createdAt ?? "").localeCompare(
              a.activityAt ?? a.createdAt ?? "",
            ),
          )
          .filter(
            (t) => !trackedTaskId.current || t.taskId === trackedTaskId.current,
          )
          .slice(0, 1);
        for (const task of tasks) {
          const result = await window.desktop.generate.taskResult({
            taskId: task.taskId,
          });
          if (
            stopped ||
            latest.current.workspaceId !== workspaceId ||
            !result.ok
          )
            continue;
          const data = result.data;
          if (
            data.workspaceId !== workspaceId ||
            (trackedTaskId.current && trackedTaskId.current !== data.taskId)
          )
            continue;
          setProgress(data);
          if (
            ["completed", "failed"].includes(data.state) &&
            data.decision === "pending" &&
            !shown.current.has(data.taskId) &&
            !batchRef.current
          ) {
            shown.current.add(data.taskId);
            setAppliedIds([]);
            batchReturnFocus.current = document.activeElement as HTMLElement;
            setChecked(
              data.rows
                .filter((r) => r.state === "completed" && r.title && !r.stale)
                .map((r) => r.chapterId),
            );
            batchRef.current = data;
            setBatch(data);
          }
        }
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 350);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [input.workspaceId]);
  useEffect(() => {
    if (batch && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!batch && dialogRef.current?.open) {
      dialogRef.current.close();
      batchReturnFocus.current?.focus();
    }
  }, [batch]);
  async function resolveBatch(action: "confirm" | "cancel") {
    if (!batch || batchBusy) return;
    const context = batch;
    setBatchBusy(true);
    setError("");
    const result = await window.desktop.generate.applyBatch({
      workspaceId: context.workspaceId,
      taskId: context.taskId,
      action,
      selections:
        action === "cancel"
          ? []
          : context.rows
              .filter((r) => checked.includes(r.chapterId))
              .map((r) => ({
                chapterId: r.chapterId,
                artifactId: r.artifactId!,
                candidateIndex: 0,
                expectedBodyHash: r.bodyHash,
                expectedTitleRevision: r.titleRevision,
              })),
    });
    if (latest.current.workspaceId !== context.workspaceId) {
      setBatchBusy(false);
      return;
    }
    if (result.ok) {
      for (const row of result.data.results)
        if (row.view) latest.current.onTitleUpdated(row.view);
      if (result.data.resolved) {
        setBatch(null);
        batchRef.current = null;
        const pipelines = await window.desktop.pipeline.list();
        if (pipelines.ok)
          for (const p of pipelines.data)
            if (
              p.state === "waiting-title" &&
              p.stages.some((s) => s.taskId === context.taskId)
            ) {
              const resumed = await window.desktop.pipeline.resume({
                pipelineId: p.pipelineId,
              });
              if (!resumed.ok)
                setError(
                  `标题决议已保存；请在组合流程继续：${resumed.error.message}`,
                );
            }
      } else {
        setAppliedIds((previous) => [
          ...previous,
          ...result.data.results
            .filter((r) => r.applied)
            .map((r) => r.chapterId),
        ]);
        setChecked((previous) =>
          previous.filter(
            (id) =>
              !result.data.results.some((r) => r.chapterId === id && r.applied),
          ),
        );
        setError(
          result.data.results
            .filter((r) => !r.applied)
            .map((r) => r.error)
            .join("；"),
        );
      }
      await refresh();
    } else setError(result.error.message);
    setBatchBusy(false);
  }
  const batchDialog = (
    <dialog
      ref={dialogRef}
      className="bb-batch-dialog"
      data-task-id={batch?.taskId}
      aria-labelledby="batch-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!batchBusy) void resolveBatch("cancel");
      }}
    >
      <h3 id="batch-title">确认批量标题</h3>
      <p className="bb-note">
        {appliedIds.length
          ? "已应用项保留；取消仅放弃剩余项。"
          : "仅应用勾选标题；取消保留当前标题。"}
      </p>
      {error && (
        <p className="bb-error" role="alert">
          {error}
        </p>
      )}
      <div className="bb-batch-list">
        {batch?.rows.map((row) => (
          <label key={row.chapterId} className="bb-batch-row">
            <input
              type="checkbox"
              disabled={
                batchBusy ||
                appliedIds.includes(row.chapterId) ||
                row.state !== "completed" ||
                !row.title ||
                row.stale
              }
              checked={checked.includes(row.chapterId)}
              onChange={(event) =>
                setChecked((previous) =>
                  event.target.checked
                    ? [...previous, row.chapterId]
                    : previous.filter((id) => id !== row.chapterId),
                )
              }
            />
            <span>
              第 {row.order} 章
              {appliedIds.includes(row.chapterId) ? " · 已应用" : ""}
            </span>
            <span>
              {row.state === "completed"
                ? row.stale
                  ? "候选已过期"
                  : row.title
                : `生成失败：${row.error ?? row.state}`}
            </span>
          </label>
        ))}
      </div>
      <div className="bb-row bb-batch-actions">
        <button
          className="bb-button primary"
          disabled={batchBusy}
          onClick={() => void resolveBatch("confirm")}
        >
          确认
        </button>
        <button
          className="bb-button"
          disabled={batchBusy}
          onClick={() => void resolveBatch("cancel")}
        >
          取消
        </button>
      </div>
    </dialog>
  );
  const current = view?.chapterId === input.chapterId ? view : null;
  const titles = current?.artifacts.find((a) => a.kind === "title");
  const summary = current?.artifacts.find((a) => a.kind === "summary");
  useEffect(() => setEdits(titles?.titles ?? []), [titles?.artifactId]);
  const titleSettingsChanged =
    !!titles &&
    JSON.stringify(titles.options) !==
      JSON.stringify({
        ...titleOptions,
        candidateCount: (titles.options as TitleOptions).candidateCount,
      });
  const summarySettingsChanged =
    !!summary &&
    JSON.stringify(summary.options) !== JSON.stringify(summaryOptions);
  const running = overview?.tasks.find(
    (t) => t.state === "running" || t.state === "queued",
  );
  async function start(kind: "title" | "summary") {
    const context = latest.current;
    setBusy(true);
    setError("");
    try {
      if (!(await context.beforeGenerate())) return;
      if (
        latest.current.workspaceId !== context.workspaceId ||
        latest.current.chapterId !== context.chapterId
      )
        return;
      const result = await window.desktop.generate.start(
        kind === "title"
          ? { kind, chapterIds: input.scopeIds, options: titleOptions }
          : { kind, chapterIds: input.scopeIds, options: summaryOptions },
      );
      if (!result.ok) {
        setError(`${result.error.code}：${result.error.message}`);
        input.onMessage(result.error.message);
      } else {
        setActivity("生成任务已开始");
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  }
  async function select(index: number) {
    if (!current || !titles) return;
    const context = latest.current;
    setBusy(true);
    setError("");
    const result = await window.desktop.generate.selectTitle({
      chapterId: current.chapterId,
      artifactId: titles.artifactId,
      candidateIndex: index,
      editedTitle: index >= 0 ? edits[index] : undefined,
      expectedBodyHash: current.bodyHash,
      expectedTitleRevision: current.titleRevision,
    });
    if (
      latest.current.workspaceId !== context.workspaceId ||
      latest.current.chapterId !== context.chapterId
    ) {
      setBusy(false);
      return;
    }
    if (result.ok) {
      setView(result.data);
      input.onTitleUpdated(result.data);
      input.onMessage(
        index < 0 ? "已明确保留原标题" : "标题已选用 · 目录与正文标题已同步",
      );
    } else setError(`${result.error.code}：${result.error.message}`);
    setBusy(false);
  }
  async function exportSummaries() {
    setBusy(true);
    setError("");
    const result = await window.desktop.generate.exportSummaries({
      chapterIds: input.scopeIds,
    });
    if (!result.ok) setError(`${result.error.code}：${result.error.message}`);
    else
      input.onMessage(
        result.data.cancelled ? "已取消摘要导出" : "摘要已独立导出",
      );
    setBusy(false);
  }
  const disabled = busy || !!running || !input.scopeIds.length;
  const panel = (
    <>
      <div className="bb-paneltitle">
        <h3>标题与摘要</h3>
        <span className="bb-count">{input.scopeIds.length} 章</span>
      </div>
      <div className="bb-generate">
        {error ? (
          <p className="bb-error" role="alert" data-testid="generate-error">
            {error}
          </p>
        ) : null}
        {input.dirty ? (
          <p className="bb-note">正文尚未保存；开始生成时将先保存当前修改。</p>
        ) : null}
        <section aria-labelledby="titles-heading">
          <h4 id="titles-heading">候选标题</h4>
          {loading ? <p role="status">正在载入生成产物…</p> : null}
          {titles ? (
            <>
              <p
                className={
                  titles.stale || input.dirty
                    ? "bb-generate-stale"
                    : "bb-status-line"
                }
                data-testid="title-source"
              >
                {titles.stale || input.dirty
                  ? "来源已过期 · 请重新生成"
                  : titleSettingsChanged
                    ? "生成要求已变化 · 请重新生成"
                    : "基于当前正文"}{" "}
                · {titles.sourceBodyHash.slice(0, 10)}…
              </p>
              <p className="bb-note">
                当前标题：{current?.currentTitle}
                {current?.selectedArtifactId ? " · 已明确选择" : ""}
              </p>
              <div className="bb-generate-candidates">
                {(titles.titles ?? []).map((_, index) => (
                  <form
                    key={`${titles.artifactId}:${index}`}
                    data-testid={`title-candidate-${index}`}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void select(index);
                    }}
                  >
                    <label htmlFor={`candidate-${index}`}>
                      候选 {index + 1}
                    </label>
                    <input
                      id={`candidate-${index}`}
                      value={edits[index] ?? ""}
                      onChange={(e) =>
                        setEdits((previous) =>
                          previous.map((text, i) =>
                            i === index ? e.target.value : text,
                          ),
                        )
                      }
                    />
                    <button
                      className="bb-button"
                      disabled={
                        busy ||
                        !!running ||
                        titles.stale ||
                        input.dirty ||
                        !edits[index]?.trim()
                      }
                    >
                      选用候选 {index + 1}
                    </button>
                  </form>
                ))}
              </div>
              <button
                className="bb-button"
                disabled={busy || !!running || input.dirty || titles.stale}
                onClick={() => void select(-1)}
              >
                保留原标题
              </button>
            </>
          ) : !loading ? (
            <p className="bb-empty">
              尚无候选标题。生成后由你编辑并选择，默认保留现有标题。
            </p>
          ) : null}
          <details className="bb-proofread-settings">
            <summary>标题生成设置</summary>
            <div className="bb-proofread-settings-body">
              <label className="bb-field">
                标题风格
                <input
                  value={titleOptions.style}
                  onChange={(e) =>
                    setTitleOptions({ ...titleOptions, style: e.target.value })
                  }
                />
              </label>
              <label className="bb-field">
                最少字符
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={titleOptions.minLength}
                  onChange={(e) =>
                    setTitleOptions({
                      ...titleOptions,
                      minLength: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="bb-field">
                最多字符
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={titleOptions.maxLength}
                  onChange={(e) =>
                    setTitleOptions({
                      ...titleOptions,
                      maxLength: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={titleOptions.allowSpoilers}
                  onChange={(e) =>
                    setTitleOptions({
                      ...titleOptions,
                      allowSpoilers: e.target.checked,
                    })
                  }
                />
                允许剧透
              </label>
            </div>
          </details>
          <button
            className="bb-button primary"
            data-testid="generate-title"
            disabled={disabled}
            onClick={() => void start("title")}
          >
            {busy
              ? "处理中…"
              : input.scopeIds.length > 1
                ? "批量生成标题"
                : titles
                  ? "重新生成标题"
                  : "生成三个标题"}
          </button>
        </section>
        <section aria-labelledby="summary-heading">
          <h4 id="summary-heading">本章摘要</h4>
          {summary ? (
            <>
              <p
                className={
                  summary.stale || input.dirty
                    ? "bb-generate-stale"
                    : "bb-status-line"
                }
                data-testid="summary-source"
              >
                {summary.stale || input.dirty
                  ? "来源已过期 · 请重新生成"
                  : summarySettingsChanged
                    ? "生成要求已变化 · 请重新生成"
                    : "基于当前正文"}{" "}
                · {summary.sourceBodyHash.slice(0, 10)}…
              </p>
              <p
                className="bb-generated-summary"
                data-testid="generated-summary"
              >
                {summary.summary}
              </p>
            </>
          ) : (
            <p className="bb-empty">尚无摘要。摘要单独保存，不插入小说正文。</p>
          )}
          <details className="bb-proofread-settings">
            <summary>摘要长度设置</summary>
            <div className="bb-proofread-settings-body">
              <label className="bb-field">
                摘要最少字符
                <input
                  type="number"
                  min="1"
                  max="2000"
                  value={summaryOptions.minLength}
                  onChange={(e) =>
                    setSummaryOptions({
                      ...summaryOptions,
                      minLength: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label className="bb-field">
                摘要最多字符
                <input
                  type="number"
                  min="1"
                  max="2000"
                  value={summaryOptions.maxLength}
                  onChange={(e) =>
                    setSummaryOptions({
                      ...summaryOptions,
                      maxLength: Number(e.target.value),
                    })
                  }
                />
              </label>
            </div>
          </details>
          <div className="bb-row">
            <button
              className="bb-button primary"
              data-testid="generate-summary"
              disabled={disabled}
              onClick={() => void start("summary")}
            >
              {summary ? "重新生成摘要" : "生成摘要"}
            </button>
            <button
              className="bb-button"
              disabled={busy || !input.scopeIds.length}
              onClick={() => void exportSummaries()}
            >
              独立导出摘要
            </button>
          </div>
        </section>
        <div
          className="bb-status-line"
          role="status"
          data-testid="generate-activity"
        >
          {activity || "生成范围沿用顶部选择；标题与摘要分别运行。"}
        </div>
        {progress && (
          <div className="bb-batch-progress" role="status">
            <progress
              max={progress.total}
              value={progress.succeeded + progress.failed}
              aria-label="标题生成进度"
            />
            <p>
              已完成 {progress.succeeded + progress.failed} / {progress.total}{" "}
              章 · 成功 {progress.succeeded} 章
              {progress.failed ? ` · 失败 ${progress.failed} 章` : ""}
              {progress.currentChapterId
                ? ` · 正在生成第 ${progress.rows.find((r) => r.chapterId === progress.currentChapterId)?.order} 章`
                : progress.state === "cancelled"
                  ? " · 已取消"
                  : ""}
            </p>
          </div>
        )}
        {running ? (
          <button
            className="bb-button"
            onClick={() =>
              void window.desktop.generate
                .cancel({ taskId: running.taskId })
                .then(() => refresh())
            }
          >
            取消生成
          </button>
        ) : null}
        {overview?.tasks
          .filter((t) =>
            ["failed", "interrupted", "cancelled"].includes(t.state),
          )
          .slice(-1)
          .map((t) => (
            <div className="bb-note" key={t.taskId}>
              任务
              {t.state === "failed"
                ? "失败"
                : t.state === "cancelled"
                  ? "已取消"
                  : "已中断"}
              <button
                className="bb-button"
                disabled={busy || !!running || input.dirty}
                onClick={() =>
                  void window.desktop.generate
                    .resume({ taskId: t.taskId })
                    .then((r) => {
                      if (!r.ok)
                        setError(`${r.error.code}：${r.error.message}`);
                      void refresh();
                    })
                }
              >
                继续未完成章节
              </button>
            </div>
          ))}
      </div>
    </>
  );
  return { panel, batchDialog, exportSummaries };
}
