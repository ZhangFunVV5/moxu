import { useRef, useState } from "react";
import { Settings } from "lucide-react";
import { configSchema, type Config } from "../shared/contracts";

/**
 * 模型设置入口。P0 起要求在任意工作模式下可配置；P1 打开真实工作区后
 * 仍保留同一入口，不对 Renderer 回传明文 Key。
 */
export function ModelSettings({
  onMessage,
}: {
  onMessage?: (message: string) => void;
}) {
  const [config, setConfig] = useState<Config>({
    baseUrl: "https://api.openai.com/v1",
    model: "",
    temperature: 0.2,
    stream: true,
  });
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDialogElement>(null);

  async function open() {
    const result = await window.desktop.getConfig();
    if (result.ok) {
      const { hasKey: stored, ...rest } = result.data;
      setConfig(rest);
      setHasKey(stored);
      setErrors({});
    } else {
      setErrors({ form: result.error.message });
    }
    if (!dialog.current?.open) dialog.current?.showModal();
  }

  async function save() {
    if (saveInFlight.current) return;
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path[0], issue.message]),
        ),
      );
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    setErrors({});
    try {
      const result = await window.desktop.saveConfig(config);
      if (result.ok) {
        setHasKey(result.data.hasKey);
        setConfig({ ...config, apiKey: undefined });
        dialog.current?.close();
        onMessage?.("模型配置已保存；正在运行任务使用启动时的配置");
      } else {
        setErrors({ form: result.error.message });
      }
    } catch {
      setErrors({ form: "模型配置保存失败，请重试。" });
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <>
      <button className="bb-ghost" onClick={() => void open()}>
        <Settings size={16} />
        模型设置
      </button>
      <dialog
        ref={dialog}
        className="bb-config"
        aria-labelledby="model-settings-title"
        aria-busy={saving}
        onCancel={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <h2 id="model-settings-title">模型设置</h2>
        <p>OpenAI-compatible Chat Completions</p>
        {(["baseUrl", "model", "apiKey"] as const).map((key) => (
          <label key={key}>
            {key === "baseUrl"
              ? "Base URL"
              : key === "model"
                ? "模型名"
                : "API Key"}
            <input
              type={key === "apiKey" ? "password" : "text"}
              autoComplete="off"
              disabled={saving}
              value={config[key] ?? ""}
              placeholder={
                key === "apiKey" && hasKey ? "••••••••（留空保留）" : ""
              }
              onChange={(event) =>
                setConfig({
                  ...config,
                  [key]:
                    event.target.value || (key === "apiKey" ? undefined : ""),
                })
              }
            />
            <small className="bb-error">{errors[key]}</small>
          </label>
        ))}
        <label>
          温度
          <input
            type="number"
            disabled={saving}
            min="0"
            max="2"
            step="0.1"
            value={config.temperature}
            onChange={(event) =>
              setConfig({ ...config, temperature: Number(event.target.value) })
            }
          />
          <small className="bb-error">{errors.temperature}</small>
        </label>
        <label>
          <input
            type="checkbox"
            disabled={saving}
            checked={config.stream}
            onChange={(event) =>
              setConfig({ ...config, stream: event.target.checked })
            }
          />{" "}
          流式响应
        </label>
        <p className="bb-error">{errors.form}</p>
        {saving && (
          <p role="status">
            正在安全保存设置…首次保存可能需要约 10 秒，请稍候。
          </p>
        )}
        <div className="bb-row">
          <button disabled={saving} onClick={() => void save()}>
            {saving ? "保存中…" : "保存设置"}
          </button>
          <button disabled={saving} onClick={() => dialog.current?.close()}>
            关闭
          </button>
        </div>
      </dialog>
    </>
  );
}
