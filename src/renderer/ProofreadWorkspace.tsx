import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileDown,
  History,
  Loader2,
  MapPin,
  Play,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  PROOFREAD_CATEGORIES,
  defaultProofreadOptions,
  type ProofreadCategory,
  type ProofreadOptions,
} from "../shared/proofreading";
import type {
  ChapterProofreadView,
  ProofreadBatchesDto,
  ProofreadEventDto,
  ProofreadIssueDto,
  ProofreadSummaryDto,
} from "../shared/proofread-contracts";
import type { ReviewDecoration, ScrollRequest } from "./BodyEditor";

const ISSUE_FILTERS = ["pending", "done", "all"] as const;
type IssueFilter = (typeof ISSUE_FILTERS)[number];

const STATE_LABELS: Record<string, string> = {
  unchecked: "未检查",
  queued: "排队中",
  running: "检查中",
  "waiting-review": "待审",
  completed: "已完成",
  failed: "检查失败",
  interrupted: "已中断",
  cancelled: "已取消",
};

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random()}`;
}

function sourceLabel(issue: ProofreadIssueDto): string {
  if (issue.sources.includes("rule") && issue.sources.includes("model"))
    return "规则＋模型";
  return issue.sources.includes("rule") ? "规则" : "模型";
}

function glossaryOf(text: string): string[] {
  return [...new Set(text.split(/\n+/).map((item) => item.trim()).filter(Boolean))];
}

export interface UseProofreadInput {
  workspaceId: string;
  chapterId: string;
  scopeIds: string[];
  sourceVersion: string;
  dirty: boolean;
  enabled: boolean;
  onMessage: (text: string) => void;
  onChapterUpdated: (view: ChapterProofreadView) => void;
}

export interface UseProofreadResult {
  panel: ReactNode;
  agent: ReactNode;
  diffPaper: ReactNode;
  decorations: ReviewDecoration[];
  scrollRequest: ScrollRequest | null;
  undoLast: () => void;
  canUndo: boolean;
  busy: string;
  contrast: boolean;
  setContrast: (value: boolean) => void;
  pendingFor: (chapterId: string) => number;
  stateFor: (chapterId: string) => string;
  refresh: () => void;
  view: ChapterProofreadView | null;
}

export function useProofreadWorkspace(input: UseProofreadInput): UseProofreadResult {
  const {
    workspaceId,
    chapterId,
    scopeIds,
    sourceVersion,
    dirty,
    enabled,
    onMessage,
    onChapterUpdated,
  } = input;
  const [options, setOptions] = useState<ProofreadOptions>(defaultProofreadOptions);
  const [summary, setSummary] = useState<ProofreadSummaryDto | null>(null);
  const [loadedView, setView] = useState<ChapterProofreadView | null>(null);
  const view = loadedView?.chapterId === chapterId ? loadedView : null;
  const [batches, setBatches] = useState<ProofreadBatchesDto["batches"]>([]);
  const [historyBatchId, setHistoryBatchId] = useState<string | null>(null);
  const [filter, setFilter] = useState<IssueFilter>("pending");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");
  const [run, setRun] = useState<{
    taskId: string;
    state: string;
    message: string;
    blockIndex?: number;
    blockTotal?: number;
  } | null>(null);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const [contrast, setContrast] = useState(false);
  const [naturalLanguage, setNaturalLanguage] = useState("");
  const [autoApply, setAutoApply] = useState<ProofreadCategory[]>([]);
  const [glossaryText, setGlossaryText] = useState("");
  const generation = useRef(0);
  const runTaskId = useRef<string | null>(null);
  const latestInput = useRef(input);
  latestInput.current = input;
  const context = useRef({ workspaceId, chapterId, version: 0 });
  if (context.current.workspaceId !== workspaceId || context.current.chapterId !== chapterId)
    context.current = { workspaceId, chapterId, version: context.current.version + 1 };
  const contextVersion = context.current.version;

  function isCurrentContext(): boolean {
    return context.current.version === contextVersion && latestInput.current.workspaceId === workspaceId &&
      latestInput.current.chapterId === chapterId;
  }

  useEffect(() => {
    setOptions(defaultProofreadOptions);
    setSummary(null);
    setView(null);
    setBatches([]);
    setHistoryBatchId(null);
    setSelected(null);
    setFilter("pending");
    setError("");
    setStatus("");
    setRun(null);
    setScrollRequest(null);
    setContrast(false);
    setAutoApply([]);
    setGlossaryText("");
    runTaskId.current = null;
  }, [workspaceId]);

  async function loadSummary(): Promise<ProofreadSummaryDto | null> {
    const result = await window.desktop.proofread.summary();
    if (!isCurrentContext()) return null;
    if (!result.ok) {
      setError(result.error.message);
      return null;
    }
    setSummary(result.data);
    const running = result.data.tasks.find((task) => task.status === "running");
    if (running && !runTaskId.current) {
      runTaskId.current = running.taskId;
      setRun({
        taskId: running.taskId,
        state: "running",
        message: "精校任务正在运行",
      });
    }
    return result.data;
  }

  async function loadView(batchId: string | null = historyBatchId): Promise<ChapterProofreadView | null> {
    const request = ++generation.current;
    const result = await window.desktop.proofread.chapter({
      chapterId,
      ...(batchId ? { batchId } : {}),
    });
    if (generation.current !== request || !isCurrentContext()) return null;
    if (!result.ok) {
      setError(result.error.message);
      setView(null);
      return null;
    }
    setView(result.data);
    setError("");
    if (!result.data.readOnly && !latestInput.current.dirty)
      latestInput.current.onChapterUpdated(result.data);
    if (!batchId) {
      setOptions(result.data.options);
      setGlossaryText(result.data.options.glossary.join("\n"));
      setAutoApply(result.data.options.autoApplyCategories);
    }
    return result.data;
  }

  async function loadBatches(): Promise<void> {
    const result = await window.desktop.proofread.batches({ chapterId });
    if (!isCurrentContext()) return;
    if (result.ok) setBatches(result.data.batches);
  }

  async function refresh(): Promise<void> {
    await Promise.all([loadSummary(), enabled ? loadView() : Promise.resolve(null), loadBatches()]);
  }

  useEffect(() => {
    if (!workspaceId || !chapterId) return;
    setView(null);
    setHistoryBatchId(null);
    setSelected(null);
    setScrollRequest(null);
    setBusy("");
    void window.desktop.proofread.recover().catch(() => undefined);
    void loadSummary();
    void loadBatches();
    if (enabled) void loadView(null);
    return () => {
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, chapterId]);

  useEffect(() => {
    if (!enabled) return;
    void loadView(historyBatchId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sourceVersion, historyBatchId]);

  useEffect(() => {
    const dispose = window.desktop.proofread.onEvent((event: ProofreadEventDto) => {
      if (event.workspaceId !== workspaceId) return;
      if (!runTaskId.current && event.type === "taskStarted")
        runTaskId.current = event.taskId;
      if (runTaskId.current !== event.taskId) return;
      if (event.type === "blockStarted") {
        setRun((current) =>
          current
            ? {
                ...current,
                state: "running",
                message: event.message,
                blockIndex: event.blockIndex,
                blockTotal: event.blockTotal,
              }
            : {
                taskId: event.taskId,
                state: "running",
                message: event.message,
                blockIndex: event.blockIndex,
                blockTotal: event.blockTotal,
              },
        );
      } else if (event.type === "chapterStateChanged" || event.type === "taskStarted") {
        setRun((current) => ({
          taskId: event.taskId,
          state: "running",
          message: event.message,
          blockIndex: current?.blockIndex,
          blockTotal: current?.blockTotal,
        }));
      } else if (event.type === "taskStateChanged") {
        setRun({
          taskId: event.taskId,
          state: event.state ?? "completed",
          message: event.message,
        });
        setStatus(event.message);
        onMessage(event.message);
        runTaskId.current = null;
        void refresh();
      }
      if (event.chapterId === chapterId && event.type === "chapterStateChanged")
        void loadView();
    });
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, chapterId, enabled, historyBatchId]);

  function updateCategory(category: ProofreadCategory, checked: boolean): void {
    setOptions((current) => {
      const categories = checked
        ? [...current.categories, category]
        : current.categories.filter((item) => item !== category);
      return {
        ...current,
        categories: categories.length ? categories : [category],
        autoApplyCategories: current.autoApplyCategories.filter((item) =>
          categories.includes(item),
        ),
      };
    });
    if (!checked) setAutoApply((current) => current.filter((item) => item !== category));
  }

  function updateAutoApply(category: ProofreadCategory, checked: boolean): void {
    setAutoApply((current) =>
      checked ? [...new Set([...current, category])] : current.filter((item) => item !== category),
    );
  }

  function resolvedOptions(): ProofreadOptions {
    return {
      ...options,
      glossary: glossaryOf(glossaryText),
      autoApplyCategories: autoApply.filter((category) => options.categories.includes(category)),
    };
  }

  async function start(naturalLanguageText?: string): Promise<void> {
    if (dirty) {
      setError("正文有未保存修改，请先保存正文再开始精校。");
      return;
    }
    if (!scopeIds.length) {
      setError("请先选择至少一章。");
      return;
    }
    setBusy("start");
    setError("");
    setStatus("正在创建精校任务…");
    const result = await window.desktop.proofread.start({
      chapterIds: scopeIds,
      options: resolvedOptions(),
      ...(naturalLanguageText?.trim() ? { naturalLanguage: naturalLanguageText } : {}),
    });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      setError(result.error.message);
      onMessage(result.error.message);
      return;
    }
    runTaskId.current = result.data.taskId;
    setRun({
      taskId: result.data.taskId,
      state: "running",
      message: naturalLanguageText ? "自然语言精校任务已启动" : "精校任务已启动",
    });
    setHistoryBatchId(null);
    setOptions(result.data.options);
    setAutoApply(result.data.options.autoApplyCategories);
    const note = result.data.notes.length
      ? result.data.notes.join("；")
      : "精校任务已启动，完成后意见进入待审。";
    setStatus(note);
    onMessage(note);
    setNaturalLanguage("");
    await refresh();
  }

  async function cancel(): Promise<void> {
    if (!run?.taskId) return;
    setBusy("cancel");
    const result = await window.desktop.proofread.cancel({ taskId: run.taskId });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setStatus("已请求取消；已保存的候选与正文保持不变。");
  }

  async function resume(): Promise<void> {
    const candidate = summary?.tasks.find(
      (task) =>
        ["interrupted", "failed", "cancelled", "queued"].includes(task.status) &&
        task.chapters.some((chapter) => chapter.chapterId === chapterId),
    );
    if (!candidate) {
      setError("没有可继续的精校任务，请重新开始精校。");
      return;
    }
    setBusy("resume");
    const result = await window.desktop.proofread.resume({ taskId: candidate.taskId });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    runTaskId.current = candidate.taskId;
    setHistoryBatchId(null);
    setRun({ taskId: candidate.taskId, state: "running", message: "正在继续精校任务…" });
    await refresh();
  }

  async function apply(patchId: string, action: "accept" | "ignore" | "restore" | "withdraw"): Promise<void> {
    if (!view?.batchId) return;
    if (!view.reviewReady) {
      setError("本章检查尚未完成全部目标块，候选可查看但暂不能正式采纳。");
      return;
    }
    if (dirty) {
      setError("正文有未保存修改，请先保存正文，避免审阅写入覆盖草稿。");
      return;
    }
    setBusy(`${action}:${patchId}`);
    setError("");
    const result = await window.desktop.proofread.apply({
      chapterId,
      batchId: view.batchId,
      operationId: newId(),
      kind: action,
      commands: [{ patchId, action }],
      reviewRevision: view.reviewRevision,
      expectedHeadHash: view.expectedHeadHash,
    });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      setError(result.error.message);
      onMessage(result.error.message);
      return;
    }
    setSelected(patchId);
    onChapterUpdated(result.data);
    setView(result.data);
    const label =
      action === "accept"
        ? "已采纳并写回工作正文"
        : action === "ignore"
          ? "已忽略，原句保留"
          : action === "restore"
            ? "已恢复待审"
            : "已撤回该条修改，其他已采纳意见保留";
    setStatus(label);
    onMessage(label);
    await Promise.all([loadSummary(), loadBatches()]);
  }

  async function batchApply(category: ProofreadCategory, action: "accept" | "ignore"): Promise<void> {
    if (!view?.batchId) return;
    if (!view.reviewReady) {
      setError("本章检查尚未完成全部目标块，暂不能批量处理。");
      return;
    }
    if (dirty) {
      setError("正文有未保存修改，请先保存正文再按类别处理。");
      return;
    }
    setBusy(`batch:${category}:${action}`);
    setError("");
    const result = await window.desktop.proofread.batch({
      chapterId,
      batchId: view.batchId,
      operationId: newId(),
      category,
      action,
      reviewRevision: view.reviewRevision,
      expectedHeadHash: view.expectedHeadHash,
    });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      // 冲突等组合问题整次不应用，保留原状态并说明原因。
      setError(result.error.message);
      onMessage(result.error.message);
      return;
    }
    onChapterUpdated(result.data);
    setView(result.data);
    setStatus(
      action === "accept"
        ? `已按类别采纳${CATEGORY_LABELS[category]}意见`
        : `已按类别忽略${CATEGORY_LABELS[category]}意见`,
    );
    await Promise.all([loadSummary(), loadBatches()]);
  }

  async function undoLast(): Promise<void> {
    if (dirty) {
      setError("正文有未保存修改，请先保存正文再撤回。");
      return;
    }
    if (!view?.batchId || !view.lastOperationId) {
      setError("没有可撤回的审阅操作。");
      return;
    }
    setBusy("undo");
    setError("");
    const result = await window.desktop.proofread.undo({
      chapterId,
      batchId: view.batchId,
      operationId: newId(),
      undoneOperationId: view.lastOperationId,
      reviewRevision: view.reviewRevision,
      expectedHeadHash: view.expectedHeadHash,
    });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      setError(result.error.message);
      onMessage(result.error.message);
      return;
    }
    onChapterUpdated(result.data);
    setView(result.data);
    setStatus("已撤回上次审阅操作");
    onMessage("已撤回上次审阅操作");
    await Promise.all([loadSummary(), loadBatches()]);
  }

  async function locate(patchId: string): Promise<void> {
    if (!view?.batchId) return;
    setSelected(patchId);
    if (view.stale) {
      setError("正文已变更，旧坐标不能直接定位；请重新检查本章。");
      return;
    }
    const issue = view.issues.find((item) => item.patchId === patchId);
    if (!issue?.locate) {
      setError("该意见没有可定位范围（可能是整段删除或版本已过期）。");
      return;
    }
    const result = await window.desktop.proofread.locate({
      chapterId,
      batchId: view.batchId,
      patchId,
      reviewRevision: view.reviewRevision,
      expectedHeadHash: view.expectedHeadHash,
    });
    if (!isCurrentContext()) return;
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (result.data.stale || !result.data.locate) {
      setError("正文已变化，请刷新后再定位。");
      await loadView();
      return;
    }
    setContrast(false);
    setScrollRequest({
      from: result.data.locate.from,
      to: result.data.locate.to,
      key: newId(),
    });
  }

  async function exportReport(): Promise<void> {
    if (!view) return;
    setBusy("report");
    const chapterIds = scopeIds.length ? scopeIds : [chapterId];
    const result = await window.desktop.proofread.exportReport({ chapterIds });
    if (!isCurrentContext()) return;
    setBusy("");
    if (!result.ok) {
      setError(result.error.message);
      onMessage(result.error.message);
      return;
    }
    const message = result.data.cancelled
      ? "已取消导出报告，未写入文件"
      : `已导出精校报告 · ${result.data.path}`;
    setStatus(message);
    onMessage(message);
  }

  const issues = view?.issues ?? [];
  const pendingIssues = issues.filter((issue) => issue.decision === "pending");
  const doneIssues = issues.filter((issue) => issue.decision !== "pending");
  const visibleIssues =
    filter === "pending" ? pendingIssues : filter === "done" ? doneIssues : issues;
  const pendingByCategory = useMemo(() => {
    const counts = new Map<ProofreadCategory, number>();
    for (const issue of pendingIssues)
      counts.set(issue.category, (counts.get(issue.category) ?? 0) + 1);
    return counts;
  }, [pendingIssues]);
  const batchCategory = useMemo<ProofreadCategory | null>(() => {
    const available = PROOFREAD_CATEGORIES.filter((category) => pendingByCategory.has(category));
    return available[0] ?? null;
  }, [pendingByCategory]);
  const [selectedCategory, setSelectedCategory] = useState<ProofreadCategory | null>(null);
  useEffect(() => {
    if (selectedCategory && pendingByCategory.has(selectedCategory)) return;
    setSelectedCategory(batchCategory);
  }, [batchCategory, pendingByCategory, selectedCategory]);

  const decorations = useMemo<ReviewDecoration[]>(() => {
    if (!view || view.readOnly || view.stale) return [];
    const result: ReviewDecoration[] = [];
    for (const issue of view.issues) {
      if (!issue.locate) continue;
      if (issue.validity === "stale" || issue.validity === "invalid") continue;
      if (issue.patchId === selected) {
        result.push({
          from: issue.locate.from,
          to: issue.locate.to,
          kind: "selected",
          anchor: issue.locate.anchor,
          label: "已删除段落",
        });
      } else if (issue.decision === "accepted") {
        result.push({
          from: issue.locate.from,
          to: issue.locate.to,
          kind: "accepted",
          anchor: issue.locate.anchor,
          label: "已删除段落（可撤回）",
        });
      } else if (issue.decision === "pending") {
        result.push({
          from: issue.locate.from,
          to: issue.locate.to,
          kind: "pending",
          anchor: issue.locate.anchor,
          label: "待审插入位置",
        });
      }
    }
    return result;
  }, [view, selected]);

  const panel = (
    <>
      <div className="bb-paneltitle">
        <h3>精校意见</h3>
        <span className="bb-count" data-testid="proofread-total">
          {view ? view.counts.total : 0}
        </span>
      </div>

      {batches.length > 1 ? (
        <label className="bb-field bb-history">
          <span>批次</span>
          <select
            aria-label="精校批次"
            value={historyBatchId ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              setHistoryBatchId(value || null);
              setSelected(null);
            }}
          >
            <option value="">当前批次</option>
            {batches.map((batch) => (
              <option key={batch.batchId} value={batch.batchId}>
                {batch.active ? "当前 · " : "历史 · "}
                {new Date(batch.createdAt).toLocaleString()} · {batch.candidateCount} 条
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {view?.readOnly ? (
        <p className="bb-stale" role="status">
          正在查看历史批次，只读。切回“当前批次”才能继续审阅。
        </p>
      ) : null}

      {view && !view.reviewReady ? (
        <p className="bb-stale" role="status" data-testid="proofread-incomplete">
          本章检查尚未完成全部目标块，候选可查看但暂不能正式采纳。
        </p>
      ) : null}

      {view?.stale ? (
        <p className="bb-stale" role="status" data-testid="proofread-stale">
          <AlertTriangle size={13} /> 正文已在批次外变更，旧意见不能直接套用，请重新检查本章。
        </p>
      ) : null}

      {run ? (
        <div className="bb-progress" data-testid="proofread-progress">
          <div className="bb-progress-info">
            <span>{run.message}</span>
            {run.blockIndex && run.blockTotal ? (
              <span>
                {run.blockIndex}/{run.blockTotal}
              </span>
            ) : null}
          </div>
          <div className="bb-track">
            <span
              style={{
                width: run.blockTotal
                  ? `${Math.round(((run.blockIndex ?? 0) / run.blockTotal) * 100)}%`
                  : "15%",
              }}
            />
          </div>
          {run.state === "running" ? (
            <div className="bb-row">
              <button className="bb-button" disabled={busy === "cancel"} onClick={() => void cancel()}>
                {busy === "cancel" ? "取消中…" : "取消精校"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {view ? (
        <>
          <div className="bb-proofread-state" data-testid="proofread-state">
            <span className={`bb-state ${view.state}`}>{STATE_LABELS[view.state] ?? view.state}</span>
            {view.stale ? <span className="bb-state stale">正文已变更</span> : null}
            {view.counts.conflict ? (
              <span className="bb-state conflict">{view.counts.conflict} 条冲突</span>
            ) : null}
            {view.counts.stale ? (
              <span className="bb-state stale">{view.counts.stale} 条过期</span>
            ) : null}
          </div>

          <div className="bb-filter" role="tablist" aria-label="意见过滤">
            {(
              [
                ["pending", `待处理 ${view.counts.pending}`],
                ["done", `已处理 ${view.counts.accepted + view.counts.ignored}`],
                ["all", `全部 ${view.counts.total}`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                aria-selected={filter === value}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {view.state === "completed" && view.counts.total === 0 ? (
            <div className="bb-empty" data-testid="proofread-zero">
              <Check size={24} />
              <strong>检查完成，未发现需修改项</strong>
              这是有效结果，不是请求失败。
            </div>
          ) : null}

          {view.state === "failed" ? (
            <div className="bb-empty">
              <AlertTriangle size={24} />
              <strong>检查失败{view.errorCode ? `：${view.errorCode}` : ""}</strong>
              已保存的候选与已完成章不受影响，可继续或重新检查。
              <div className="bb-row" style={{ justifyContent: "center" }}>
                <button className="bb-button" onClick={() => void resume()}>
                  继续任务
                </button>
              </div>
            </div>
          ) : null}

          {view.state === "interrupted" ? (
            <div className="bb-empty">
              <AlertTriangle size={24} />
              <strong>任务已中断</strong>
              继续后只补未完成的目标块，不重复已提交候选。
              <div className="bb-row" style={{ justifyContent: "center" }}>
                <button className="bb-button" onClick={() => void resume()}>
                  继续任务
                </button>
              </div>
            </div>
          ) : null}

          {pendingIssues.length > 0 && selectedCategory ? (
            <div className="bb-batch" data-testid="proofread-batch">
              <label className="bb-field">
                <span>按类别处理（{pendingByCategory.get(selectedCategory) ?? 0} 条）</span>
                <select
                  aria-label="按类别处理"
                  value={selectedCategory}
                  onChange={(event) =>
                    setSelectedCategory(event.target.value as ProofreadCategory)
                  }
                >
                  {PROOFREAD_CATEGORIES.filter((category) =>
                    pendingByCategory.has(category),
                  ).map((category) => (
                    <option key={category} value={category}>
                      {CATEGORY_LABELS[category]} · {pendingByCategory.get(category)} 条
                    </option>
                  ))}
                </select>
              </label>
              <div className="bb-row">
                <button
                  className="bb-button"
                  disabled={Boolean(busy) || view.readOnly || view.stale}
                  onClick={() => void batchApply(selectedCategory, "accept")}
                >
                  采纳该类别
                </button>
                <button
                  className="bb-button"
                  disabled={Boolean(busy) || view.readOnly || view.stale}
                  onClick={() => void batchApply(selectedCategory, "ignore")}
                >
                  忽略该类别
                </button>
              </div>
            </div>
          ) : null}

          <div className="bb-issues" role="list">
            {visibleIssues.length === 0 && view.counts.total > 0 ? (
              <div className="bb-empty">
                <strong>{filter === "pending" ? "没有待处理意见" : "没有已处理意见"}</strong>
                切换过滤或继续检查其他章。
              </div>
            ) : null}
            {visibleIssues.map((issue) => (
              <IssueCard
                key={issue.patchId}
                issue={issue}
                selected={selected === issue.patchId}
                busy={Boolean(busy)}
                readOnly={view.readOnly}
                stale={view.stale}
                reviewReady={view.reviewReady}
                onSelect={() => setSelected(issue.patchId)}
                onApply={apply}
                onLocate={locate}
              />
            ))}
          </div>

          <div className="bb-row bb-report-row">
            <button
              className="bb-button"
              disabled={Boolean(busy) || !view.batchId}
              onClick={() => void exportReport()}
            >
              <FileDown size={14} /> 导出精校报告
            </button>
            <button
              className="bb-button"
              disabled={Boolean(busy)}
              onClick={() => void refresh()}
            >
              <RotateCcw size={14} /> 刷新
            </button>
          </div>

          {view.stale || view.state === "failed" ? (
            <div className="bb-row">
              <button
                className="bb-button primary"
                disabled={Boolean(busy) || dirty}
                onClick={() => void start()}
              >
                <Play size={14} /> 基于当前正文重新检查
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="bb-empty" data-testid="proofread-empty">
          <Check size={26} />
          <strong>尚未检查本章</strong>
          选择检查类别后开始；不使用模型时也可以只运行广告规则扫描。
        </div>
      )}

      <details className="bb-proofread-settings" open={!view || !view.batchId}>
        <summary>精校设置</summary>
        <div className="bb-proofread-settings-body">
          <p className="bb-note">
            范围：{scopeIds.length} 章 · 默认保守纠错，保留专名、方言与口癖。
          </p>
          <fieldset className="bb-checkgroup" aria-label="检查类别">
            <legend>检查类别</legend>
            {PROOFREAD_CATEGORIES.map((category) => (
              <label key={category} className="bb-format-check">
                <input
                  type="checkbox"
                  checked={options.categories.includes(category)}
                  disabled={options.categories.length === 1 && options.categories.includes(category)}
                  onChange={(event) => updateCategory(category, event.target.checked)}
                />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
          </fieldset>
          <label className="bb-field">
            <span>专名／特殊词表（每行一个）</span>
            <textarea
              aria-label="专名词表"
              rows={3}
              value={glossaryText}
              onChange={(event) => setGlossaryText(event.target.value)}
              placeholder={"沈舟\n阿箬"}
            />
          </label>
          <label className="bb-field">
            <span>额外精校要求</span>
            <textarea
              aria-label="精校要求"
              rows={2}
              value={options.userRequest}
              onChange={(event) =>
                setOptions((current) => ({ ...current, userRequest: event.target.value }))
              }
              placeholder="只纠正确有问题的地方，保留人物口癖。"
            />
          </label>
          <fieldset className="bb-checkgroup" aria-label="自动应用类别">
            <legend>自动应用（默认关闭）</legend>
            {options.categories.map((category) => (
              <label key={category} className="bb-format-check">
                <input
                  type="checkbox"
                  checked={autoApply.includes(category)}
                  onChange={(event) => updateAutoApply(category, event.target.checked)}
                />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
          </fieldset>
          <p className="bb-note">
            自动应用只对已授权类别生效；出现冲突组合时整次不应用，不会替你挑一条。
          </p>
          <button
            className="bb-button primary"
            data-testid="proofread-start"
            disabled={Boolean(busy) || dirty || !scopeIds.length || view?.state === "running"}
            onClick={() => void start()}
          >
            {busy === "start" ? (
              <>
                <Loader2 size={14} className="bb-spin" /> 创建任务…
              </>
            ) : (
              <>
                <Play size={14} /> 开始精校
              </>
            )}
          </button>
          {dirty ? <p className="bb-error">请先保存正文，精校需要冻结当前章节正文。</p> : null}
        </div>
      </details>

      {error ? (
        <p className="bb-error" role="alert" data-testid="proofread-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="bb-status-line" role="status" data-testid="proofread-status">
          {status}
        </p>
      ) : null}
    </>
  );

  const agent = (
    <details className="bb-agent">
      <summary>
        Agent 精校任务 <ChevronDown size={14} />
      </summary>
      <div className="bb-agent-content">
        <label>自然语言精校要求</label>
        <textarea
          aria-label="自然语言精校要求"
          value={naturalLanguage}
          onChange={(event) => setNaturalLanguage(event.target.value)}
          placeholder="检查本章的错字和广告，保留人名和口癖"
        />
        <div className="bb-row">
          <button
            className="bb-button"
            disabled={Boolean(busy) || dirty || !naturalLanguage.trim() || !scopeIds.length || view?.state === "running"}
            onClick={() => void start(naturalLanguage)}
          >
            发送精校请求
          </button>
        </div>
        <p className="bb-note">
          自然语言只表达检查类别与要求；不会扩大章节范围，也不会增加自动应用或正文写入权限。
        </p>
      </div>
    </details>
  );

  const diffPaper = (
    <article className="bb-paper bb-diff-paper">
      <div className="bb-title-row">
        <h2>修改对照</h2>
        <span className="bb-sub">
          已采纳 {view?.counts.accepted ?? 0} · 待审 {view?.counts.pending ?? 0}
        </span>
      </div>
      <p className="bb-paper-meta">
        对照基于批次基础正文；删除标记只存在于界面，不写入正文或导出。
      </p>
      {view ? (
        <div className="bb-prose bb-diff-body" data-testid="proofread-diff">
          {renderDiff(view)}
        </div>
      ) : (
        <p className="bb-empty">尚未检查本章，没有可对照的修改。</p>
      )}
    </article>
  );

  return {
    panel,
    agent,
    diffPaper,
    decorations,
    scrollRequest,
    undoLast: () => void undoLast(),
    canUndo: Boolean(view?.canUndo && !view.readOnly),
    busy,
    contrast,
    setContrast,
    pendingFor: (id: string) =>
      summary?.chapters.find((chapter) => chapter.chapterId === id)?.pending ?? 0,
    stateFor: (id: string) =>
      summary?.chapters.find((chapter) => chapter.chapterId === id)?.state ?? "unchecked",
    refresh: () => void refresh(),
    view,
  };
}

function IssueCard({
  issue,
  selected,
  busy,
  readOnly,
  stale,
  reviewReady,
  onSelect,
  onApply,
  onLocate,
}: {
  issue: ProofreadIssueDto;
  selected: boolean;
  busy: boolean;
  readOnly: boolean;
  stale: boolean;
  reviewReady: boolean;
  onSelect: () => void;
  onApply: (
    patchId: string,
    action: "accept" | "ignore" | "restore" | "withdraw",
  ) => Promise<void>;
  onLocate: (patchId: string) => Promise<void>;
}) {
  const blocked = readOnly || stale || !reviewReady;
  const canAccept = issue.decision === "pending" && issue.validity === "valid" && !blocked;
  const canIgnore = issue.decision === "pending" && issue.validity === "valid" && !blocked;
  return (
    <article
      className={`bb-issue ${selected ? "selected" : ""}`}
      role="listitem"
      data-testid={`proofread-issue-${issue.patchId}`}
      onClick={onSelect}
    >
      <div className="bb-issue-head">
        <span className={`bb-kind ${issue.category === "advertisement" ? "ad" : ""}`}>
          {CATEGORY_LABELS[issue.category]}
        </span>
        <span className="bb-status">
          {issue.decision === "accepted"
            ? "已采纳"
            : issue.decision === "ignored"
              ? "已忽略"
              : "待处理"}
        </span>
        {issue.validity === "conflict" ? <span className="bb-badge conflict">冲突</span> : null}
        {issue.validity === "stale" ? <span className="bb-badge stale">过期</span> : null}
        {issue.validity === "invalid" ? <span className="bb-badge stale">无效</span> : null}
        <span className="bb-source-tag">{sourceLabel(issue)}</span>
      </div>
      <div className="bb-change">
        <div className="bb-change-row">
          <span>原句</span>
          <span className="bb-change-before">{issue.before || "（插入位置）"}</span>
        </div>
        <div className="bb-change-row">
          <span>建议</span>
          <span className="bb-change-after">
            {issue.after === "" ? "删除" : issue.after}
          </span>
        </div>
      </div>
      <p className="bb-reason">{issue.reason}</p>
      {issue.validity === "conflict" ? (
        <p className="bb-issue-note">
          与已采纳意见互斥；撤回其中一条后可重新采纳。
        </p>
      ) : null}
      {issue.validity === "stale" ? (
        <p className="bb-issue-note caution">正文已变更，旧坐标不能套用。</p>
      ) : null}
      <div className="bb-row">
        {issue.decision === "pending" ? (
          <>
            <button
              className="bb-button primary"
              disabled={!canAccept || busy}
              onClick={(event) => {
                event.stopPropagation();
                void onApply(issue.patchId, "accept");
              }}
            >
              采纳
            </button>
            <button
              className="bb-button"
              disabled={!canIgnore || busy}
              onClick={(event) => {
                event.stopPropagation();
                void onApply(issue.patchId, "ignore");
              }}
            >
              忽略
            </button>
          </>
        ) : issue.decision === "accepted" ? (
          <button
            className="bb-button"
            disabled={blocked || busy}
            onClick={(event) => {
              event.stopPropagation();
              void onApply(issue.patchId, "withdraw");
            }}
          >
            <Undo2 size={13} /> 撤回修改
          </button>
        ) : (
          <button
            className="bb-button"
            disabled={blocked || busy}
            onClick={(event) => {
              event.stopPropagation();
              void onApply(issue.patchId, "restore");
            }}
          >
            恢复待审
          </button>
        )}
        <button
          className="bb-ghost"
          disabled={blocked || !issue.locate}
          onClick={(event) => {
            event.stopPropagation();
            void onLocate(issue.patchId);
          }}
        >
          <MapPin size={13} /> 定位原文
        </button>
      </div>
    </article>
  );
}

interface DiffSegment {
  text: string;
  kind: "plain" | "deleted" | "inserted" | "pending";
}

function paragraphSegments(
  view: ChapterProofreadView,
  paragraphId: string,
  text: string,
): DiffSegment[] {
  const relevant = view.issues
    .filter(
      (issue) =>
        issue.paragraphId === paragraphId &&
        (issue.decision === "accepted" ||
          (issue.decision === "pending" && issue.validity === "valid")),
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const accepted = relevant.filter((issue) => issue.decision === "accepted");
  const occupied = accepted.map((issue) => ({ start: issue.start, end: issue.end }));
  const segments: DiffSegment[] = [];
  let cursor = 0;
  for (const issue of relevant) {
    if (issue.decision === "pending") {
      const overlap = occupied.some(
        (range) => issue.start < range.end && range.start < issue.end,
      );
      if (overlap || issue.start < cursor) continue;
      if (issue.start > cursor)
        segments.push({ text: text.slice(cursor, issue.start), kind: "plain" });
      segments.push({ text: text.slice(issue.start, issue.end), kind: "pending" });
      cursor = issue.end;
      continue;
    }
    if (issue.start < cursor) continue;
    if (issue.start > cursor)
      segments.push({ text: text.slice(cursor, issue.start), kind: "plain" });
    if (issue.before) segments.push({ text: issue.before, kind: "deleted" });
    if (issue.after) segments.push({ text: issue.after, kind: "inserted" });
    cursor = issue.end;
  }
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), kind: "plain" });
  return segments;
}

function renderDiff(view: ChapterProofreadView): ReactNode {
  return view.baseBlocks.map((block) => {
    const text = view.baseBody.slice(block.start, block.end);
    if (block.kind !== "paragraph")
      return (
        <p key={block.id} className="bb-diff-raw">
          {text}
        </p>
      );
    const segments = paragraphSegments(view, block.id, text);
    return (
      <p key={block.id} data-paragraph={block.id}>
        {segments.map((segment, index) => {
          if (segment.kind === "deleted")
            return <del key={index}>{segment.text}</del>;
          if (segment.kind === "inserted")
            return <ins key={index}>{segment.text}</ins>;
          if (segment.kind === "pending")
            return (
              <mark key={index} className="bb-mark">
                {segment.text}
              </mark>
            );
          return <Fragment key={index}>{segment.text}</Fragment>;
        })}
        {view.issues.some(
          (issue) =>
            issue.paragraphId === block.id &&
            issue.decision === "accepted" &&
            issue.after === "",
        ) ? (
          <span className="bb-deleted">
            <span>已删除段落（界面标记，可撤回）</span>
            <History size={12} />
          </span>
        ) : null}
      </p>
    );
  });
}
