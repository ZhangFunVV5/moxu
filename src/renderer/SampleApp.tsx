import React, { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCheck,
  AlignLeft,
  FileText,
  Play,
  Square,
  ChevronDown,
  FolderOpen,
  Upload,
} from "lucide-react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chapters } from "../core/sample";
import { type TaskEvent } from "../shared/contracts";
import type { WorkspaceInfo } from "../shared/book";
import type { SourceSelection } from "../shared/workspace-contracts";
import { ImportDialog } from "./ImportDialog";
import { ModelSettings } from "./ModelSettings";

function Editor({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
        ],
      }),
      parent: ref.current!,
    });
    return () => view.destroy();
  }, [text]);
  return <div ref={ref} aria-label="只读示例正文" />;
}

export function SampleApp({
  onOpened,
  startupError,
}: {
  onOpened: (info: WorkspaceInfo) => void;
  startupError?: string;
}) {
  const [mode, setMode] = useState("精校"),
    [chapter, setChapter] = useState(0),
    [status, setStatus] = useState("尚未开始"),
    [events, setEvents] = useState<TaskEvent[]>([]),
    [task, setTask] = useState(""),
    [running, setRunning] = useState(false),
    [message, setMessage] = useState("示例书 · 只读演示，尚未导入真实作品"),
    [prompt, setPrompt] = useState("读取当前章节，并用一句话说明场景。"),
    [importSource, setImportSource] = useState<SourceSelection | null>(null);
  const active = useRef<{ requestId: string; taskId: string } | null>(null);
  useEffect(
    () =>
      window.desktop.onEvent((e) => {
        if (
          e.workspaceId !== "sample-book" ||
          e.requestId !== active.current?.requestId ||
          (active.current.taskId !== "" && e.taskId !== active.current.taskId)
        )
          return;
        active.current!.taskId = e.taskId;
        setTask(e.taskId);
        setEvents((v) => {
          const last = v[v.length - 1];
          if (e.type === "text" && last?.type === "text")
            return [
              ...v.slice(0, -1),
              { ...last, message: last.message + e.message },
            ];
          return [...v, e];
        });
        if (e.state) {
          setStatus(e.state);
          setRunning(e.state === "running");
        }
        setMessage(e.message);
      }),
    [],
  );
  async function chooseImport() {
    const result = await window.desktop.workspace.chooseSource();
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    if (result.data) setImportSource(result.data);
  }
  async function openWorkspace() {
    const result = await window.desktop.workspace.open();
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    if (result.data) onOpened(result.data);
  }
  async function start() {
    setRunning(true);
    setStatus("启动中");
    setEvents([]);
    const requestId = crypto.randomUUID();
    active.current = { requestId, taskId: "" };
    const r = await window.desktop.start({
      requestId,
      workspaceId: "sample-book",
      chapterId: chapters[chapter].id,
      prompt,
    });
    if (r.ok) {
      active.current.taskId = r.data.taskId;
      setTask(r.data.taskId);
    } else {
      setRunning(false);
      setStatus("未启动");
      setMessage(r.error.message);
    }
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
          <span className="bb-sub">让每一章，清晰如初</span>
          <span className="bb-preview-badge">P0 · 只读示例</span>
          <span className="bb-grow" />
          <button className="bb-button" onClick={() => void chooseImport()}>
            <Upload size={15} />
            导入书籍
          </button>
          <button className="bb-button" onClick={() => void openWorkspace()}>
            <FolderOpen size={15} />
            打开工作区
          </button>
          <ModelSettings onMessage={setMessage} />
        </header>
        <div className="bb-toolbar">
          <nav className="bb-modes" aria-label="工作模式">
            {["精校", "排版", "标题与摘要"].map((m, i) => (
              <button
                key={m}
                className="bb-mode"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {i === 0 ? (
                  <CheckCheck size={15} />
                ) : i === 1 ? (
                  <AlignLeft size={15} />
                ) : (
                  <FileText size={15} />
                )}{" "}
                {m}
              </button>
            ))}
          </nav>
          <span className="bb-grow" />
          <select className="bb-select" aria-label="任务范围">
            <option>当前章节</option>
          </select>
          <button className="bb-button" disabled>
            导出
          </button>
          <button
            className="bb-button primary"
            disabled={running}
            onClick={() => void start()}
          >
            <Play size={14} />
            运行只读样例
          </button>
        </div>
        {startupError ? (
          <div className="bb-save-error bb-startup-error" role="alert" data-testid="startup-error">
            {startupError}
          </div>
        ) : null}
        <div className="bb-layout">
          <aside className="bb-sidebar">
            <div className="bb-book">
              <strong>长街听雨</strong>
              <span className="bb-sub">示例书 · 3 章 · 只读</span>
            </div>
            <div className="bb-sectionlabel">
              章节目录 <span>03</span>
            </div>
            {chapters.map((c, i) => (
              <button
                key={c.id}
                className="bb-chapter"
                aria-pressed={chapter === i}
                onClick={() => setChapter(i)}
              >
                <span className="bb-chapnum">0{i + 1}</span>
                <span>
                  <strong>{c.title}</strong>
                  <small>示例正文 · 无审阅数据</small>
                </span>
              </button>
            ))}
          </aside>
          <main className="bb-main">
            <div className="bb-readingbar">
              <span className="bb-breadcrumb">长街听雨 / 第{chapter + 1}章</span>
              <div className="bb-viewmodes">
                <button aria-pressed="true">工作正文</button>
                <button disabled>修改对照</button>
              </div>
            </div>
            <article className="bb-paper">
              <div className="bb-chaplabel">CHAPTER 0{chapter + 1}</div>
              <h2>{chapters[chapter].title}</h2>
              <div className="bb-paper-meta">
                只读示例 · 正文 {chapters[chapter].body.length} 字 · P0 不修改作品
              </div>
              <Editor text={chapters[chapter].body} />
              <div className="bb-paper-footer">
                <span>当前章节 · 原始示例正文</span>
                <span>16px · 中文衬线</span>
              </div>
            </article>
          </main>
          <aside className="bb-right">
            <div className="bb-paneltitle">
              <h3>
                {mode === "精校"
                  ? "精校意见"
                  : mode === "排版"
                    ? "排版规则"
                    : "标题与摘要"}
              </h3>
              <span className="bb-count">P0</span>
            </div>
            {mode === "精校" ? (
              <>
                <div className="bb-filter">
                  {["待处理 0", "已处理 0", "全部 0"].map((s, i) => (
                    <button key={s} aria-pressed={i === 0} disabled>
                      {s}
                    </button>
                  ))}
                </div>
                <div className="bb-empty">
                  <CheckCheck size={28} />
                  <strong>尚无精校意见</strong>示例书只读，仅验证 Agent 与只读工具。
                  <br />
                  精校审阅请导入书籍后使用。
                </div>
              </>
            ) : mode === "排版" ? (
              <>
                <label className="bb-field">
                  <span>首行缩进</span>
                  <select disabled>
                    <option>两个全角空格</option>
                  </select>
                </label>
                <label className="bb-field">
                  <span>段间空行</span>
                  <select disabled>
                    <option>一行</option>
                  </select>
                </label>
                <div className="bb-note">P0 布局预览 · P2 接入本地排版</div>
              </>
            ) : (
              <div className="bb-empty">
                <strong>尚无生成产物</strong>标题与摘要将在 P4 接入。
              </div>
            )}
            <div className="bb-paneltitle">
              <h3>任务进展</h3>
              <span className="bb-count" data-testid="status">
                {status}
              </span>
            </div>
            {running && (
              <button
                className="bb-button"
                onClick={() =>
                  void window.desktop.cancel({
                    requestId: active.current!.requestId,
                    workspaceId: "sample-book",
                    taskId: task,
                  })
                }
              >
                <Square size={12} />
                取消任务
              </button>
            )}
            <div className="bb-log" aria-live="polite">
              {events.map((e, i) => (
                <div key={i}>
                  {e.type === "text" ? e.message : <p>{e.message}</p>}
                </div>
              ))}
            </div>
            <details className="bb-agent">
              <summary>
                Agent 任务 <ChevronDown size={14} />
              </summary>
              <div className="bb-agent-content">
                <label htmlFor="prompt">只读范围：当前章节；不会修改正文</label>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <div className="bb-row">
                  <button
                    className="bb-button primary"
                    disabled={running || !prompt.trim()}
                    onClick={() => void start()}
                  >
                    发送只读任务
                  </button>
                </div>
              </div>
            </details>
          </aside>
        </div>
        <footer className="bb-foot">
          <span className="bb-message" role="status">
            {message}
          </span>
          <button className="bb-ghost" disabled>
            撤回上次操作
          </button>
        </footer>
      </section>
      {importSource ? (
        <ImportDialog
          source={importSource}
          onClose={() => {
            setImportSource(null);
            setMessage("已取消导入，未写入任何文件");
          }}
          onOpened={onOpened}
        />
      ) : null}
    </div>
  );
}
