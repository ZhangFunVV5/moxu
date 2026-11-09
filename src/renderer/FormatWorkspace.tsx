import { useEffect, useRef, useState } from "react";
import { defaultFormatOptions, type FormatOptions } from "../shared/format-options";
import type { FormatPreview } from "../shared/format-contracts";

const optionLabels: Record<string,string> = { headingTemplate:"标题模板", indent:"首行缩进", customPrefix:"自定义前缀", paragraphBlankLines:"段间空行", headingBlankLinesBefore:"标题前空行", headingBlankLinesAfter:"标题后空行", trimTrailingWhitespace:"清理行尾空白", eol:"换行符", encoding:"UTF-8 编码", paragraphMode:"段落识别" };
const optionValues: Record<string,string> = { none:"不缩进", fullwidth:"两个全角空格", custom:"自定义", true:"开启", false:"关闭", line:"每行一个段落", blank:"空行分隔", lf:"LF", crlf:"CRLF", utf8:"不带 BOM", "utf8-bom":"带 BOM" };
export function useFormatWorkspace({ workspaceId, chapterIds, sourceVersion, dirty, enabled, onMessage }: { workspaceId: string; chapterIds: string[]; sourceVersion: string; dirty: boolean; enabled: boolean; onMessage: (text: string) => void }) {
  const [options, setOptions] = useState<FormatOptions>(defaultFormatOptions);
  const [outputFormat, setOutputFormat] = useState<"txt" | "markdown">("txt");
  const [preview, setPreview] = useState<FormatPreview | null>(null);
  const [stale, setStale] = useState(false);
  const requestedIdentity = useRef("");
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportInFlight = useRef(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<{ options: FormatOptions; feedback: string } | null>(null);
  const [proposing, setProposing] = useState(false);
  const generation = useRef(0);
  const proposalGeneration = useRef(0);
  const previewIdentity = useRef("");
  const identity = `${workspaceId}:${chapterIds.join(",")}:${JSON.stringify(options)}:${outputFormat}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const scopeIdentity = `${workspaceId}:${chapterIds.join(",")}`;
  const currentScope = useRef(scopeIdentity);
  currentScope.current = scopeIdentity;
  const sourceRef = useRef(sourceVersion);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    requestedIdentity.current = ""; previewIdentity.current = "";
    setPreview(null); setProposal(null); setError("");
    void window.desktop.format.getPreset().then(result => {
      if (cancelled) return;
      if (result.ok) setOptions(result.data);
      else setError(result.error.message);
      setReady(true);
    });
    return () => { cancelled = true; generation.current++; };
  }, [workspaceId]);
  async function refresh() {
    const request = ++generation.current;
    const expected = identity;
    if (!chapterIds.length || dirty) { setStale(true); return; }
    setBusy(true); setError("");
    const result = await window.desktop.format.preview({ chapterIds, options, outputFormat });
    if (generation.current !== request || currentIdentity.current !== expected) return;
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return; }
    requestedIdentity.current = expected; previewIdentity.current = expected;
    setPreview(result.data); setStale(false); sourceRef.current = sourceVersion;
  }
  useEffect(() => {
    if (!enabled || !ready || requestedIdentity.current === identity) return;
    setStale(true);
    const timer = setTimeout(() => { if (ready) void refresh(); }, 180);
    return () => { clearTimeout(timer); generation.current++; setBusy(false); };
  }, [identity, enabled, ready]);
  useEffect(() => { if (preview && (dirty || sourceRef.current !== sourceVersion)) setStale(true); }, [dirty, sourceVersion, preview]);
  useEffect(() => {
    if (!enabled || !preview) return;
    let disposed = false;
    const check = () => { void window.desktop.format.status({ token: preview.token }).then(result => { if (!disposed && result.ok && result.data.stale) setStale(true); }); };
    const timer = setInterval(check, 1800);
    return () => { disposed = true; clearInterval(timer); };
  }, [preview, enabled]);
  async function savePreset(value = options) {
    const expected = workspaceId;
    const result = await window.desktop.format.savePreset({ options: value });
    if (!currentScope.current.startsWith(`${expected}:`)) return;
    if (result.ok) onMessage("排版预设已保存 · 重新打开工作区后可继续使用"); else setError(result.error.message);
  }
  async function exportBook() {
    if (exportInFlight.current || !ready || previewIdentity.current !== identity || !preview || stale || dirty || busy) return;
    exportInFlight.current = true; setExporting(true); setError("");
    const expected = identity;
    try {
    const result = await window.desktop.format.export({ token: preview.token });
    if (currentIdentity.current !== expected) return;
    if (!result.ok) { setError(result.error.message); if (result.error.code.includes("STALE")) setStale(true); return; }
    onMessage(result.data.cancelled ? "已取消导出，未写入文件" : `已导出 · ${result.data.path}`);
    } finally { exportInFlight.current = false; setExporting(false); }
  }
  useEffect(() => { proposalGeneration.current++; setProposing(false); setProposal(null); }, [scopeIdentity]);
  async function propose() {
    const request = ++proposalGeneration.current;
    const expected = scopeIdentity;
    setProposing(true); setError(""); setProposal(null);
    const result = await window.desktop.format.propose({ chapterIds, prompt, options });
    if (currentScope.current !== expected || proposalGeneration.current !== request) return;
    setProposing(false);
    if (result.ok) setProposal(result.data); else setError(result.error.message);
  }
  function update<K extends keyof FormatOptions>(key: K, value: FormatOptions[K]) { setOptions(current => ({ ...current, [key]: value })); }
  const form = <fieldset className="bb-format-form" disabled={!ready} aria-label="排版规则">
    <p className="bb-note">本地排版仅生成独立输出；手动调整不调用模型。</p>
    <label className="bb-field"><span>输出格式</span><select value={outputFormat} onChange={e => setOutputFormat(e.target.value as typeof outputFormat)}><option value="txt">TXT</option><option value="markdown">Markdown</option></select></label>
    {outputFormat === "markdown" && <p className="bb-note">Markdown 至少保留一个段间空行；自定义缩进仅支持全角空格，以保留语法结构。</p>}
    <label className="bb-field"><span>标题模板</span><input value={options.headingTemplate} onChange={e => update("headingTemplate", e.target.value)} /></label>
    <p className="bb-note">支持 {"{number}"} 章序和 {"{title}"} 标题。</p>
    <label className="bb-field"><span>首行缩进</span><select value={options.indent} onChange={e => update("indent", e.target.value as FormatOptions["indent"])}><option value="none">不缩进</option><option value="fullwidth">两个全角空格</option><option value="custom">自定义前缀</option></select></label>
    {options.indent === "custom" && <label className="bb-field"><span>自定义前缀</span><input value={options.customPrefix} onChange={e => update("customPrefix", e.target.value)} /></label>}
    {([ ["paragraphBlankLines", "段间空行"], ["headingBlankLinesBefore", "标题前空行"], ["headingBlankLinesAfter", "标题后空行"] ] as const).map(([key,label]) => <label className="bb-field" key={key}><span>{label}</span><select value={options[key]} onChange={e => update(key, Number(e.target.value) as 0 | 1 | 2 | 3)}>{[0,1,2,3].map(n => <option value={n} key={n}>{n} 行</option>)}</select></label>)}
    <label className="bb-field"><span>段落识别</span><select value={options.paragraphMode} onChange={e => update("paragraphMode", e.target.value as "line" | "blank")}><option value="line">每行一个段落</option><option value="blank">空行分隔段落</option></select></label>
    <label className="bb-format-check"><input type="checkbox" checked={options.trimTrailingWhitespace} onChange={e => update("trimTrailingWhitespace", e.target.checked)} />清理行尾空白</label>
    <label className="bb-field"><span>换行符</span><select value={options.eol} onChange={e => update("eol", e.target.value as "lf" | "crlf")}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
    <label className="bb-field"><span>UTF-8 编码</span><select value={options.encoding} onChange={e => update("encoding", e.target.value as "utf8" | "utf8-bom")}><option value="utf8">不带 BOM</option><option value="utf8-bom">带 BOM</option></select></label>
    <button className="bb-button" onClick={() => void savePreset()}>保存排版预设</button>
    {error && <p className="bb-error" role="alert">{error}</p>}
    <details className="bb-agent"><summary>自然语言排版规则</summary><div className="bb-agent-content"><label>描述排版要求<textarea aria-label="排版要求" value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="首行空两格、段间一空行" /></label><button className="bb-button" disabled={!prompt.trim() || !chapterIds.length || proposing} onClick={() => void propose()}>{proposing ? "生成提案中…" : "生成规则提案"}</button>{proposal && <section className="bb-format-proposal" data-testid="format-proposal"><strong>候选规则 · 尚未采纳</strong><p>{proposal.feedback}</p><dl>{Object.entries(proposal.options).map(([key,value]) => <div key={key}><dt>{optionLabels[key] ?? key}</dt><dd>{optionValues[String(value)] ?? String(value)}</dd></div>)}</dl><div className="bb-row"><button className="bb-button primary" onClick={() => { setOptions(proposal.options); setProposal(null); onMessage("已采纳规则提案 · 可预览后导出"); }}>采纳规则</button><button className="bb-button" onClick={() => void savePreset(proposal.options)}>保存提案为预设</button><button className="bb-ghost" onClick={() => setProposal(null)}>放弃提案</button></div></section>}</div></details>
  </fieldset>;
  const paper = <article className="bb-paper bb-format-paper"><div className="bb-title-row"><h2>排版预览</h2><button className="bb-button" disabled={busy || dirty || !chapterIds.length} onClick={() => void refresh()}>刷新预览</button></div><p className="bb-paper-meta">{chapterIds.length} 章 · {outputFormat === "txt" ? "TXT" : "Markdown"} · 工作正文保持独立</p>{dirty ? <p className="bb-format-stale" role="status">正文有未保存修改，请保存正文后刷新预览。</p> : stale && preview ? <p className="bb-format-stale" role="status">正文、标题、范围或规则已变化，预览已过期。请刷新后导出。</p> : null}<p className="bb-note" role="status">{busy ? "正在生成本地预览…" : !chapterIds.length ? "请先选择至少一章。" : preview ? "预览已固定正文与标题版本" : "正在准备预览…"}</p><pre data-testid="format-preview" className="bb-format-output">{preview?.text ?? ""}</pre></article>;
  return { form, paper, exportBook, exporting, canExport: ready && previewIdentity.current === identity && !!preview && !stale && !dirty && !busy && !exporting };
}
