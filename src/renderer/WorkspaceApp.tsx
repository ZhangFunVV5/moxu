import { useGenerateWorkspace } from "./GenerateWorkspace";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlignLeft,
  BookOpen,
  CheckCheck,
  ChevronDown,
  FileText,
  FolderOpen,
  Save,
  Upload,
  X,
} from "lucide-react";
import type {
  ChapterDetail,
  ChapterSummary,
  WorkspaceInfo,
} from "../shared/book";
import { countCodePoints } from "../shared/book";
import { chapterOffsetToParagraphOffset } from "../shared/text-offsets";
import { deriveBlocks } from "../core/text/structure";
import type { SourceSelection } from "../shared/workspace-contracts";
import { useFormatWorkspace } from "./FormatWorkspace";
import { useProofreadWorkspace } from "./ProofreadWorkspace";
import { BodyEditor } from "./BodyEditor";
import { ImportDialog } from "./ImportDialog";
import { ModelSettings } from "./ModelSettings";
import { PipelinePanel, cancelWorkspaceTasks } from "./PipelinePanel";

type Scope = "current" | "range" | "all";

const CHAPTER_STATE_LABELS: Record<string, string> = {
  unchecked: "未检查",
  queued: "排队中",
  running: "检查中",
  "waiting-review": "待审",
  completed: "已完成",
  failed: "检查失败",
  interrupted: "已中断",
  cancelled: "已取消",
};

type PendingAction =
  | { kind: "switch-chapter"; chapterId: string }
  | { kind: "open" }
  | { kind: "import" }
  | { kind: "quit" }
  | { kind: "close" };

function pendingLabel(
  action: PendingAction,
  chapters: ChapterSummary[],
): string {
  if (action.kind === "switch-chapter") {
    const index = chapters.findIndex((c) => c.chapterId === action.chapterId);
    return `切换到第 ${index + 1} 章`;
  }
  if (action.kind === "open") return "打开另一个工作区";
  if (action.kind === "import") return "导入新的书籍";
  if (action.kind === "quit") return "退出应用";
  return "关闭当前工作区";
}

export function WorkspaceApp({
  initial,
  onClosed,
}: {
  initial: WorkspaceInfo;
  onClosed: () => void;
}) {
  const [info, setInfo] = useState<WorkspaceInfo>(initial);
  const [activeId, setActiveId] = useState<string>(
    initial.chapterOrder[0] ?? "",
  );
  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("精校");
  const [scope, setScope] = useState<Scope>("current");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial.chapterOrder.slice(0, 1)),
  );
  const [message, setMessage] = useState(
    "工作区已打开 · 编辑后按 Ctrl+S 或“保存正文”写回权威文件",
  );
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState("");
  const [saveError, setSaveError] = useState("");
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingError, setPendingError] = useState("");
  const [importSource, setImportSource] = useState<SourceSelection | null>(
    null,
  );
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const unsavedDialog = useRef<HTMLDialogElement>(null);
  const titleDialog = useRef<HTMLDialogElement>(null);
  const saveInFlight = useRef<Promise<ChapterDetail | null> | null>(null);
  const contextVersion = useRef(0);
  const latest = useRef({ info, activeId, chapter, draft });
  latest.current = { info, activeId, chapter, draft };

  useEffect(
    () => () => {
      contextVersion.current += 1;
    },
    [],
  );

  const dirty = chapter !== null && draft !== chapter.body;
  const activeIndex = info.chapterOrder.indexOf(activeId);
  const formatIds =
    scope === "all"
      ? info.chapterOrder
      : scope === "range"
        ? info.chapterOrder.filter((id) => selected.has(id))
        : activeId
          ? [activeId]
          : [];
  const sourceVersion = JSON.stringify(
    info.chapters.map((c) => [c.chapterId, c.bodyRevision, c.titleRevision]),
  );
  const format = useFormatWorkspace({
    workspaceId: info.workspaceId,
    chapterIds: formatIds,
    sourceVersion,
    dirty,
    enabled: mode === "排版",
    metadata: info.metadata,
    onMessage: setMessage,
  });
  const proofread = useProofreadWorkspace({
    workspaceId: info.workspaceId,
    chapterId: activeId,
    scopeIds: formatIds,
    sourceVersion,
    dirty,
    enabled: mode === "精校",
    onMessage: setMessage,
    onChapterUpdated: (view) => {
      const current = latest.current;
      if (
        current.info.workspaceId !== info.workspaceId ||
        current.activeId !== view.chapterId
      )
        return;
      const workspaceId = current.info.workspaceId;
      void window.desktop.workspace.state().then((result) => {
        if (
          latest.current.info.workspaceId === workspaceId &&
          result.ok &&
          result.data?.workspaceId === workspaceId
        )
          setInfo(result.data);
      });
      if (
        !current.chapter ||
        current.chapter.chapterId !== view.chapterId ||
        current.draft !== current.chapter.body ||
        view.bodyRevision < current.chapter.bodyRevision ||
        (view.chapterBodyHash === current.chapter.bodyHash &&
          view.bodyRevision === current.chapter.bodyRevision)
      )
        return;
      setChapter((current) =>
        current
          ? {
              ...current,
              title: view.title,
              body: view.body,
              blocks: view.blocks,
              bodyRevision: view.bodyRevision,
              bodyHash: view.chapterBodyHash,
            }
          : current,
      );
      latest.current.draft = view.body;
      setDraft(view.body);
      setCursor(0);
      setErrorCode("");
      setSaveError("");
    },
  });

  const generate = useGenerateWorkspace({
    workspaceId: info.workspaceId,
    chapterId: activeId,
    scopeIds: formatIds,
    sourceVersion,
    dirty,
    enabled: mode === "标题与摘要",
    onMessage: setMessage,
    beforeGenerate: async () => {
      const saved = await saveCurrent();
      return !!saved && latest.current.draft === saved.body;
    },
    onTitleUpdated: (view) => {
      if (latest.current.info.workspaceId !== info.workspaceId) return;
      setChapter((current) =>
        current && current.chapterId === view.chapterId
          ? {
              ...current,
              title: view.currentTitle,
              titleRevision: view.titleRevision,
            }
          : current,
      );
      setInfo((current) => ({
        ...current,
        chapters: current.chapters.map((c) =>
          c.chapterId === view.chapterId
            ? {
                ...c,
                title: view.currentTitle,
                titleRevision: view.titleRevision,
              }
            : c,
        ),
      }));
    },
  });
  function applyWorkspace(next: WorkspaceInfo, note: string) {
    contextVersion.current += 1;
    setInfo(next);
    const first = next.chapterOrder[0] ?? "";
    setActiveId(first);
    setSelected(new Set(first ? [first] : []));
    setChapter(null);
    setDraft("");
    setScope("current");
    setMessage(note);
  }

  async function loadChapter(chapterId: string): Promise<ChapterDetail | null> {
    setLoading(true);
    const result = await window.desktop.chapters.get({ chapterId });
    setLoading(false);
    if (!result.ok) {
      setErrorCode(result.error.code);
      setSaveError(result.error.message);
      setMessage(result.error.message);
      return null;
    }
    setChapter(result.data);
    setDraft(result.data.body);
    setCursor(0);
    setErrorCode("");
    setSaveError("");
    return result.data;
  }

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setLoading(true);
    // 立即清空旧章，避免快速切章时在新导航下短暂显示上一章正文。
    setChapter(null);
    setDraft("");
    void window.desktop.chapters.get({ chapterId: activeId }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setErrorCode(result.error.code);
        setMessage(result.error.message);
        return;
      }
      setChapter(result.data);
      setDraft(result.data.body);
      setCursor(0);
      setErrorCode("");
      setSaveError("");
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, info.workspaceId]);

  useEffect(() => {
    const dialog = unsavedDialog.current;
    if (!dialog) return;
    if (pending) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
      setPendingError("");
    }
  }, [pending]);

  useEffect(() => {
    const dialog = titleDialog.current;
    if (!dialog) return;
    if (renaming) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [renaming]);

  function saveCurrent(): Promise<ChapterDetail | null> {
    if (saveInFlight.current) return saveInFlight.current;
    const { chapter, draft, info, activeId } = latest.current;
    if (!chapter) return Promise.resolve(null);
    if (draft === chapter.body) return Promise.resolve(chapter);
    const version = contextVersion.current;
    const isCurrent = () =>
      contextVersion.current === version &&
      latest.current.info.workspaceId === info.workspaceId &&
      latest.current.activeId === activeId;
    setSaving(true);
    const operation = (async () => {
      try {
        const result = await window.desktop.chapters.save({
          chapterId: chapter.chapterId,
          baseRevision: chapter.bodyRevision,
          body: draft,
        });
        if (!isCurrent()) return null;
        if (!result.ok) {
          setErrorCode(result.error.code);
          setSaveError(result.error.message);
          setMessage(result.error.message);
          return null;
        }
        // 回执只推进已保存基线，保存期间输入的草稿仍由编辑器持有。
        latest.current.chapter = result.data;
        setChapter((current) =>
          current
            ? {
                ...result.data,
                title: current.title,
                titleRevision: current.titleRevision,
              }
            : current,
        );
        setErrorCode("");
        setSaveError("");
        setMessage(
          latest.current.draft === result.data.body
            ? `已保存 · 修订 ${result.data.bodyRevision}`
            : `已保存修订 ${result.data.bodyRevision} · 仍有未保存的修改`,
        );
        const state = await window.desktop.workspace.state();
        if (!isCurrent()) return null;
        if (state.ok && state.data?.workspaceId === info.workspaceId)
          setInfo(state.data);
        return result.data;
      } finally {
        saveInFlight.current = null;
        setSaving(false);
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }

  async function runAction(action: PendingAction) {
    if (action.kind === "switch-chapter") {
      if (action.chapterId === latest.current.activeId) return;
      contextVersion.current += 1;
      setActiveId(action.chapterId);
      return;
    }
    try {
      await cancelWorkspaceTasks();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "任务尚未停止，请稍后重试。",
      );
      return;
    }
    if (action.kind === "quit") {
      await window.desktop.lifecycle.confirmClose({ action: "close" });
      return;
    }
    if (action.kind === "open") {
      const result = await window.desktop.workspace.open();
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      if (result.data)
        applyWorkspace(result.data, `已打开工作区 · ${result.data.bookTitle}`);
      return;
    }
    if (action.kind === "import") {
      const result = await window.desktop.workspace.chooseSource();
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      if (result.data) {
        setImportSource(result.data);
        setMessage(
          `已选择 ${result.data.fileName} · 预览确认后再创建作品，预览不写盘`,
        );
      }
      return;
    }
    const result = await window.desktop.workspace.close();
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    contextVersion.current += 1;
    onClosed();
  }

  function requestAction(action: PendingAction) {
    if (dirty) {
      setPendingError("");
      setPending(action);
      return;
    }
    void runAction(action);
  }

  useEffect(
    () =>
      window.desktop.lifecycle.onCloseRequested(() => {
        const value = latest.current;
        if (value.chapter && value.draft !== value.chapter.body)
          setPending({ kind: "quit" });
        else void runAction({ kind: "quit" });
      }),
    [],
  );

  async function resolvePending(choice: "save" | "discard") {
    if (choice === "save") {
      const saved = await saveCurrent();
      if (!saved) {
        setPendingError("保存失败，未继续执行当前操作。");
        return;
      }
      if (latest.current.draft !== saved.body) {
        setPendingError("仍有未保存的修改，请再次保存后继续。");
        return;
      }
    } else {
      setDraft(chapter?.body ?? "");
    }
    const action = pending;
    setPending(null);
    if (action) await runAction(action);
  }

  function scopeLabel(): string {
    if (scope === "all") return `全书 ${info.chapters.length} 章`;
    if (scope === "range") {
      if (selected.size === 0) return "选定范围：未选择";
      return `选定范围 ${selected.size} 章`;
    }
    return `当前章节 · 第 ${activeIndex + 1} 章`;
  }

  const blocks = useMemo(
    () =>
      chapter
        ? deriveBlocks(
            info.bodyFormat,
            draft,
            info.importSettings.paragraphMode,
          )
        : [],
    [chapter, draft, info.bodyFormat, info.importSettings.paragraphMode],
  );
  const paragraph = useMemo(
    () => chapterOffsetToParagraphOffset(blocks, cursor),
    [blocks, cursor],
  );

  async function saveTitle() {
    if (!chapter) return;
    const result = await window.desktop.chapters.rename({
      chapterId: chapter.chapterId,
      title: titleDraft,
    });
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    setChapter({
      ...chapter,
      title: result.data.title,
      titleRevision: result.data.titleRevision,
    });
    setInfo({
      ...info,
      chapters: info.chapters.map((item) =>
        item.chapterId === result.data.chapterId
          ? {
              ...item,
              title: result.data.title,
              titleRevision: result.data.titleRevision,
            }
          : item,
      ),
    });
    setRenaming(false);
    setMessage("标题已更新 · 正文 hash 与修订号保持不变");
  }

  return (
    <div id="book-agent-blue">
      <section className="bb-shell">
        <header className="bb-header">
          <span className="bb-logo">
            <BookOpen size={19} />
          </span>
          <span className="bb-brand">书籍工作台</span>
          <span className="bb-sep" />
          <span className="bb-sub bb-book-name">{info.bookTitle}</span>
          <span className="bb-preview-badge">本地工作区</span>
          <span className="bb-grow" />
          <button
            className="bb-button"
            onClick={() => requestAction({ kind: "import" })}
          >
            <Upload size={15} />
            导入
          </button>
          <button
            className="bb-button"
            onClick={() => requestAction({ kind: "open" })}
          >
            <FolderOpen size={15} />
            打开
          </button>
          <ModelSettings onMessage={setMessage} />
          <button
            className="bb-ghost"
            onClick={() => requestAction({ kind: "close" })}
          >
            <X size={15} />
            关闭工作区
          </button>
        </header>

        <div className="bb-toolbar">
          <nav className="bb-modes" aria-label="工作模式">
            {["精校", "排版", "标题与摘要"].map((item, index) => (
              <button
                key={item}
                className="bb-mode"
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {index === 0 ? (
                  <CheckCheck size={15} />
                ) : index === 1 ? (
                  <AlignLeft size={15} />
                ) : (
                  <FileText size={15} />
                )}{" "}
                {item}
              </button>
            ))}
          </nav>
          <span className="bb-grow" />
          <select
            className="bb-select"
            aria-label="任务范围"
            value={scope}
            onChange={(event) => {
              const next = event.target.value as Scope;
              setScope(next);
              if (next === "range" && selected.size === 0 && activeId)
                setSelected(new Set([activeId]));
            }}
          >
            <option value="current">当前章节</option>
            <option value="range">选定范围</option>
            <option value="all">整书</option>
          </select>
          <span className="bb-range" data-testid="scope-label">
            {scopeLabel()}
          </span>
          <button
            className="bb-button"
            disabled={mode !== "排版" || !format.canExport}
            onClick={() => void format.exportBook()}
          >
            {format.exporting ? "导出中…" : "导出"}
          </button>
          <button
            className="bb-button primary"
            disabled={!dirty || saving || !chapter}
            onClick={() => void saveCurrent()}
          >
            <Save size={14} />
            {saving ? "保存中…" : "保存正文"}
          </button>
        </div>

        <div className="bb-layout">
          <aside className="bb-sidebar">
            <div className="bb-book">
              <strong>{info.bookTitle}</strong>
              <span className="bb-sub">
                {info.format === "epub"
                  ? "EPUB · Markdown 正文"
                  : info.bodyFormat === "markdown"
                    ? "Markdown"
                    : "TXT"}{" "}
                · {info.chapters.length} 章
              </span>
            </div>
            <div className="bb-sectionlabel">
              章节目录{" "}
              <span>{String(info.chapters.length).padStart(2, "0")}</span>
            </div>
            {info.chapters.map((item, index) => (
              <div key={item.chapterId} className="bb-chapter-row">
                {scope === "range" ? (
                  <input
                    type="checkbox"
                    className="bb-chapter-check"
                    aria-label={`选择第 ${index + 1} 章`}
                    checked={selected.has(item.chapterId)}
                    onChange={(event) => {
                      const next = new Set(selected);
                      if (event.target.checked) next.add(item.chapterId);
                      else next.delete(item.chapterId);
                      setSelected(next);
                    }}
                  />
                ) : null}
                <button
                  className="bb-chapter"
                  aria-pressed={item.chapterId === activeId}
                  onClick={() =>
                    requestAction({
                      kind: "switch-chapter",
                      chapterId: item.chapterId,
                    })
                  }
                >
                  <span className="bb-chapnum">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.chapterId === activeId && dirty
                        ? countCodePoints(draft).toLocaleString()
                        : item.charCount.toLocaleString()}{" "}
                      字 · 待审 {item.pendingReview}
                      {item.chapterId === activeId && dirty ? " · 未保存" : ""}
                    </small>
                    <small className="bb-chapter-state">
                      {[
                        item.kind === "volume"
                          ? "卷"
                          : item.kind === "frontmatter"
                            ? "标题前内容"
                            : item.kind === "extra"
                              ? "番外／后记"
                              : "",
                        CHAPTER_STATE_LABELS[
                          proofread.stateFor(item.chapterId)
                        ] ?? "未检查",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                </button>
              </div>
            ))}
            <div className="bb-source" title={info.root}>
              来源：{info.source.fileName}
              <br />
              {info.format === "epub"
                ? `EPUB ${info.importInfo?.version ?? ""} · 原始文件已完整保留 · 语言 ${info.metadata.language}`
                : `编码：${(info.source.encoding ?? "utf-8").toUpperCase()} · ${
                    info.source.eol === "crlf" ? "原 CRLF" : "LF"
                  }`}
            </div>
          </aside>

          <main className="bb-main">
            <div className="bb-readingbar">
              <span className="bb-breadcrumb">
                {info.bookTitle} / 第 {activeIndex + 1} 章
                {chapter ? ` / ${chapter.title}` : ""}
              </span>
              <div className="bb-viewmodes">
                <button
                  aria-pressed={mode === "排版" || !proofread.contrast}
                  disabled={mode === "排版"}
                  onClick={() => proofread.setContrast(false)}
                >
                  {mode === "排版" ? "排版预览" : "工作正文"}
                </button>
                <button
                  aria-pressed={mode === "精校" && proofread.contrast}
                  disabled={mode !== "精校"}
                  title={
                    mode === "精校"
                      ? "显示批次基础正文与已采纳修改的对照"
                      : "仅在精校模式可用"
                  }
                  onClick={() => proofread.setContrast(true)}
                >
                  修改对照
                </button>
              </div>
              <span
                className={`bb-save-state ${dirty ? "dirty" : ""}`}
                data-testid="save-state"
              >
                {saving ? "保存中…" : dirty ? "未保存" : "已保存"}
              </span>
              <span className="bb-para" data-testid="paragraph-status">
                {paragraph
                  ? `段落 ${paragraph.block.id} · 段内 ${paragraph.offsetInParagraph}`
                  : "无段落"}
              </span>
            </div>
            {saveError ? (
              <div
                className="bb-save-error"
                role="alert"
                data-testid="save-error"
              >
                <span>{saveError}</span>
                {errorCode === "VERSION_CONFLICT" ? (
                  <button
                    className="bb-ghost"
                    onClick={() => void loadChapter(activeId)}
                  >
                    重新载入最新正文
                  </button>
                ) : null}
              </div>
            ) : null}
            {mode === "排版" ? (
              format.paper
            ) : mode === "精校" && proofread.contrast ? (
              proofread.diffPaper
            ) : (
              <article className="bb-paper">
                <div className="bb-chaplabel">
                  {chapter?.kind === "volume"
                    ? "VOLUME"
                    : chapter?.kind === "frontmatter"
                      ? "FRONT MATTER"
                      : chapter?.kind === "extra"
                        ? "EXTRA"
                        : `CHAPTER ${String(activeIndex + 1).padStart(2, "0")}`}
                </div>
                <div className="bb-title-row">
                  <h2>{chapter?.title ?? "正在载入…"}</h2>
                  <button
                    className="bb-ghost"
                    disabled={!chapter}
                    onClick={() => {
                      if (!chapter) return;
                      setTitleDraft(chapter.title);
                      setRenaming(true);
                    }}
                  >
                    重命名
                  </button>
                </div>
                <div className="bb-paper-meta">
                  {chapter ? (
                    <>
                      工作正文 · {countCodePoints(draft).toLocaleString()} 字 ·
                      修订 {chapter.bodyRevision} · hash{" "}
                      {chapter.bodyHash.slice(0, 10)}… · 待审 0
                    </>
                  ) : (
                    "正在载入章节…"
                  )}
                </div>
                {chapter ? (
                  <BodyEditor
                    chapterKey={`${info.workspaceId}:${chapter.chapterId}`}
                    value={draft}
                    onChange={(text) => {
                      latest.current.draft = text;
                      setDraft(text);
                    }}
                    onSelectionChange={setCursor}
                    onSave={() => void saveCurrent()}
                    label={`${chapter.title} 正文编辑器`}
                    decorations={
                      mode === "精校" ? proofread.decorations : undefined
                    }
                    scrollRequest={proofread.scrollRequest}
                  />
                ) : (
                  <p className="bb-empty">
                    {loading ? "正在载入章节…" : message}
                  </p>
                )}
                <div className="bb-paper-footer">
                  <span>
                    编辑器只提交文本；main 校验修订号后原子写回单章文件
                  </span>
                  <span>16px · 中文衬线</span>
                </div>
              </article>
            )}
          </main>

          <aside className="bb-right">
            {mode === "精校" ? (
              proofread.panel
            ) : (
              <>
                {mode === "排版" ? (
                  <div className="bb-paneltitle">
                    <h3>排版规则</h3>
                    <span className="bb-count">本地</span>
                  </div>
                ) : null}
                {mode === "排版" ? format.form : generate.panel}
              </>
            )}

            <div className="bb-paneltitle bb-paneltitle-spaced">
              <h3>任务进展</h3>
              <span className="bb-count">{scopeLabel()}</span>
            </div>
            <p className="bb-note">
              {mode === "排版"
                ? "排版在本地执行，不调用模型；自然语言提案需手动采纳。"
                : mode === "精校"
                  ? "精校默认只提候选，采纳或忽略由你决定；自动应用默认关闭。"
                  : "生成基于已保存正文；候选标题由你选择，摘要独立保存。"}
            </p>
            <PipelinePanel
              workspaceId={info.workspaceId}
              chapterIds={formatIds}
              metadata={info.metadata}
              dirty={dirty}
              onMessage={setMessage}
              onUpdated={proofread.refresh}
            />
          </aside>
        </div>

        <footer className="bb-foot">
          <span className="bb-message" role="status" data-testid="message">
            {message}
          </span>
          <button
            className="bb-ghost"
            disabled={
              mode !== "精校" || !proofread.canUndo || Boolean(proofread.busy)
            }
            onClick={proofread.undoLast}
          >
            撤回上次操作
          </button>
        </footer>
      </section>

      {generate.batchDialog}
      <dialog
        ref={unsavedDialog}
        className="bb-config bb-confirm"
        aria-labelledby="unsaved-title"
        onCancel={(event) => {
          event.preventDefault();
          setPending(null);
        }}
      >
        <h2 id="unsaved-title">未保存的修改</h2>
        <p>
          当前章节有未保存的修改。继续
          {pending ? pendingLabel(pending, info.chapters) : ""}
          前，请选择如何处理。
        </p>
        {pendingError ? (
          <p className="bb-error" role="alert">
            {pendingError}
          </p>
        ) : null}
        {errorCode === "VERSION_CONFLICT" ? (
          <button
            className="bb-button"
            onClick={() => {
              void loadChapter(activeId);
              setPendingError("");
            }}
          >
            重新载入最新正文
          </button>
        ) : null}
        <div className="bb-row">
          <button
            className="bb-button primary"
            disabled={saving}
            onClick={() => void resolvePending("save")}
          >
            保存并继续
          </button>
          <button
            className="bb-button"
            disabled={saving}
            onClick={() => void resolvePending("discard")}
          >
            放弃修改
          </button>
          <button className="bb-button" onClick={() => setPending(null)}>
            取消
          </button>
        </div>
      </dialog>

      <dialog
        ref={titleDialog}
        className="bb-config"
        aria-labelledby="rename-title"
        onCancel={(event) => {
          event.preventDefault();
          setRenaming(false);
        }}
      >
        <h2 id="rename-title">重命名章节</h2>
        <p>标题是独立元数据，修改不会改变正文 hash。</p>
        <label>
          标题
          <input
            value={titleDraft}
            maxLength={200}
            onChange={(event) => setTitleDraft(event.target.value)}
          />
        </label>
        <div className="bb-row">
          <button
            className="bb-button primary"
            disabled={!titleDraft.trim()}
            onClick={() => void saveTitle()}
          >
            保存标题
          </button>
          <button className="bb-button" onClick={() => setRenaming(false)}>
            取消
          </button>
        </div>
      </dialog>

      {importSource ? (
        <ImportDialog
          source={importSource}
          onClose={() => {
            setImportSource(null);
            setMessage("已取消导入，未写入任何文件");
          }}
          onOpened={(next) => {
            setImportSource(null);
            applyWorkspace(next, `已创建工作区 · ${next.bookTitle}`);
          }}
        />
      ) : null}
    </div>
  );
}
