import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportPreviewResponse, SourceSelection } from "../shared/workspace-contracts";
import type { WorkspaceInfo } from "../shared/book";
import {
  ENCODING_LABELS,
  SUPPORTED_ENCODINGS,
  type SupportedEncoding,
} from "../shared/encoding";

interface Options {
  encoding: SupportedEncoding | null;
  splitMode: "auto" | "single";
  paragraphMode: "line" | "blank";
  headingLevel: number;
}

const DEFAULTS: Options = {
  encoding: null,
  splitMode: "auto",
  paragraphMode: "line",
  headingLevel: 0,
};

function baseTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim() || "未命名作品";
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function ImportDialog({
  source,
  onClose,
  onOpened,
}: {
  source: SourceSelection;
  onClose: () => void;
  onOpened: (info: WorkspaceInfo) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const [options, setOptions] = useState<Options>(DEFAULTS);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [titles, setTitles] = useState<Record<number, string>>({});
  const [bookTitle, setBookTitle] = useState(baseTitle(source.fileName));
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function runPreview(next: Options, nextBoundaries?: number[]) {
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    const result = await window.desktop.workspace.preview({
      token: source.token,
      encoding: next.encoding,
      splitMode: next.splitMode,
      paragraphMode: next.paragraphMode,
      headingLevel: next.headingLevel,
      ...(nextBoundaries ? { boundaries: nextBoundaries } : {}),
    });
    if (current !== sequence.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      setPreview(null);
      return;
    }
    setPreview(result.data);
    setBoundaries(result.data.groups.map((group) => group.startSegment));
    if (!nextBoundaries) setTitles(
      Object.fromEntries(
        result.data.segments.map((segment) => [segment.index, segment.title]),
      ),
    );
  }

  useEffect(() => {
    void runPreview(DEFAULTS);
    // 只在打开对话框时请求一次默认预览。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.token]);

  function update(next: Partial<Options>) {
    const merged = { ...options, ...next };
    setOptions(merged);
    void runPreview(merged);
  }

  const groups = useMemo(() => {
    if (!preview) return [];
    return preview.groups.map((group) => {
      const start = group.startSegment;
      return {
        start,
        count: group.endSegment - start + 1,
        title: titles[start] ?? group.title,
        kind: group.kind,
        charCount: group.charCount,
        excerpt: group.excerpt,
      };
    });
  }, [preview, titles]);

  const requiresEncodingChoice =
    !!preview?.requiresChoice && options.encoding === null;

  async function create() {
    if (!preview || creating) return;
    setCreating(true);
    setError("");
    const result = await window.desktop.workspace.create({
      previewToken: preview.previewToken,
      bookTitle: bookTitle.trim(),
      boundaries,
      titles,
    });
    setCreating(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onOpened(result.data);
  }

  const totalChars = groups.reduce((total, group) => total + group.charCount, 0);
  const candidates =
    preview && preview.candidates.length
      ? preview.candidates
      : SUPPORTED_ENCODINGS.map((encoding) => ({
          encoding,
          label: ENCODING_LABELS[encoding],
          confidence: "low" as const,
          replacements: 0,
          bom: false,
        }));

  return (
    <dialog
      ref={dialog}
      className="bb-config bb-import"
      aria-labelledby="import-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="bb-import-head">
        <div>
          <h2 id="import-title">导入书籍</h2>
          <p>
            {source.fileName} · {formatBytes(source.byteLength)} ·{" "}
            {source.format === "markdown" ? "Markdown" : "TXT"}
          </p>
        </div>
        <button type="button" className="bb-ghost" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="bb-import-body">
        <section className="bb-import-settings" aria-label="导入设置">
          <label className="bb-field">
            <span>书名</span>
            <input
              value={bookTitle}
              maxLength={200}
              onChange={(event) => setBookTitle(event.target.value)}
            />
          </label>
          <label className="bb-field">
            <span>编码</span>
            <select
              value={options.encoding ?? ""}
              onChange={(event) =>
                update({ encoding: event.target.value as SupportedEncoding })
              }
            >
              <option value="">
                {preview
                  ? `自动：${ENCODING_LABELS[preview.encoding]}${
                      preview.requiresChoice ? "（待确认）" : ""
                    }`
                  : "自动识别"}
              </option>
              {candidates.map((candidate) => (
                <option key={candidate.encoding} value={candidate.encoding}>
                  {candidate.label}
                  {candidate.replacements > 0
                    ? ` · ${candidate.replacements} 个替换字符`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="bb-field">
            <span>分章方式</span>
            <select
              value={options.splitMode}
              onChange={(event) =>
                update({ splitMode: event.target.value as Options["splitMode"] })
              }
            >
              <option value="auto">自动识别章标题</option>
              <option value="single">整篇一章</option>
            </select>
          </label>
          {source.format === "txt" ? (
            <label className="bb-field">
              <span>段落模式</span>
              <select
                value={options.paragraphMode}
                onChange={(event) =>
                  update({
                    paragraphMode: event.target.value as Options["paragraphMode"],
                  })
                }
              >
                <option value="line">每行一段</option>
                <option value="blank">空行分段</option>
              </select>
            </label>
          ) : (
            <label className="bb-field">
              <span>章节标题层级</span>
              <select
                value={options.headingLevel}
                onChange={(event) =>
                  update({ headingLevel: Number(event.target.value) })
                }
              >
                <option value={0}>自动</option>
                {[1, 2, 3, 4, 5, 6].map((level) => (
                  <option key={level} value={level}>
                    H{level}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        {error ? (
          <p className="bb-import-error" role="alert">
            {error}
          </p>
        ) : null}
        {preview && preview.replacements > 0 ? (
          <p className="bb-stale" role="status">
            当前编码产生 {preview.replacements} 个替换字符；请确认编码后重试，
            不会静默覆盖原文。
          </p>
        ) : null}
        {requiresEncodingChoice ? (
          <p className="bb-stale" role="status">
            编码存在歧义或需要确认，请先在上方选择明确编码。
          </p>
        ) : null}

        <div className="bb-import-summary">
          <span>
            共 {groups.length} 章 · 约 {totalChars.toLocaleString()} 字 ·{" "}
            {preview?.eol === "crlf" ? "CRLF 已规范为 LF" : "LF"}
          </span>
          <button
            type="button"
            className="bb-ghost"
            disabled={!preview || loading}
            onClick={() => {
              if (!preview) return;
              void runPreview(options);
            }}
          >
            重置分章
          </button>
        </div>

        <div className="bb-import-list" aria-label="章节预览">
          {loading && !preview ? (
            <p className="bb-empty">正在解析…</p>
          ) : null}
          {groups.map((group, index) => (
            <div className="bb-import-chapter" key={`${group.start}-${index}`}>
              <span className="bb-chapnum">{String(index + 1).padStart(2, "0")}</span>
              <div className="bb-import-chapter-main">
                <input
                  aria-label={`第 ${index + 1} 章标题`}
                  value={group.title}
                  maxLength={200}
                  onChange={(event) =>
                    setTitles((value) => ({
                      ...value,
                      [group.start]: event.target.value,
                    }))
                  }
                />
                <div className="bb-import-meta">
                  {group.kind === "volume"
                    ? "卷"
                    : group.kind === "frontmatter"
                      ? "标题前内容"
                      : group.kind === "extra"
                        ? "番外／后记"
                        : "章节"}{" "}
                  · {group.charCount.toLocaleString()} 字
                  {group.count > 1 ? ` · 合并 ${group.count} 段` : ""}
                </div>
                <p className="bb-snippet">{group.excerpt}</p>
              </div>
              <button
                type="button"
                className="bb-ghost"
                disabled={index === 0 || loading}
                onClick={() => {
                  const next = boundaries.filter((_, i) => i !== index);
                  void runPreview(options, next);
                }}
              >
                并入上一章
              </button>
            </div>
          ))}
        </div>
      </div>

      <footer className="bb-import-foot">
        <span className="bb-sub">
          预览不会写入工作区；创建后原始文件另存副本，章序与标题可再修改。
        </span>
        <div className="bb-row">
          <button type="button" className="bb-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="bb-button primary"
            disabled={
              !preview ||
              loading ||
              creating ||
              groups.length === 0 ||
              bookTitle.trim().length === 0 ||
              requiresEncodingChoice
            }
            onClick={() => void create()}
          >
            {creating ? "创建中…" : "创建作品"}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
