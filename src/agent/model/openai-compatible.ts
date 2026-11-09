import type { Config } from "../../shared/contracts";
import {
  ModelError,
  type Adapter,
  type Message,
  type Response,
  type Call,
} from "./model-adapter";
export class ToolAccumulator {
  private calls = new Map<number, Call>();
  add(d: any) {
    for (const t of d ?? []) {
      if (!Number.isInteger(t.index))
        throw new ModelError("PROTOCOL", "工具 index 缺失");
      const c = this.calls.get(t.index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (t.id) c.id += t.id;
      if (t.function?.name) c.function.name += t.function.name;
      if (t.function?.arguments) c.function.arguments += t.function.arguments;
      this.calls.set(t.index, c);
    }
  }
  finish(reason: string) {
    if (this.calls.size && reason !== "tool_calls")
      throw new ModelError("TRUNCATED", "工具响应未完整结束");
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => {
        if (!c.id || !c.function.name)
          throw new ModelError("PROTOCOL", "工具身份不完整");
        try {
          JSON.parse(c.function.arguments);
        } catch {
          throw new ModelError("INVALID_JSON", "工具 JSON 不完整");
        }
        return c;
      });
  }
}
export class OpenAICompatible implements Adapter {
  constructor(private config: Config) {}
  async complete(
    messages: Message[],
    tools: unknown[],
    signal: AbortSignal,
    onText?: (text: string) => void,
    maxOutputTokens = 1024,
  ): Promise<Response> {
    let r: globalThis.Response;
    try {
      r = await fetch(
        this.config.baseUrl.replace(/\/$/, "") + "/chat/completions",
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(this.config.apiKey
              ? { Authorization: "Bearer " + this.config.apiKey }
              : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            tools,
            temperature: this.config.temperature,
            max_tokens: maxOutputTokens,
            stream: this.config.stream,
          }),
        },
      );
    } catch (e) {
      if (signal.aborted) throw new ModelError("CANCELLED", "请求已取消");
      throw new ModelError("NETWORK", "无法连接模型服务");
    }
    if (!r.ok)
      throw new ModelError(
        r.status === 401 ? "AUTH" : r.status === 429 ? "RATE_LIMIT" : "HTTP",
        "模型服务返回 HTTP " + r.status,
      );
    if (!this.config.stream) {
      const data = await r.json();
      const c = data.choices?.[0];
      if (!c?.finish_reason)
        throw new ModelError("PROTOCOL", "响应缺少结束原因");
      const calls = c.message?.tool_calls ?? [];
      const a = new ToolAccumulator();
      a.add(calls.map((v: any, index: number) => ({ ...v, index })));
      const content = c.message?.content ?? "";
      onText?.(content);
      return {
        content,
        calls: a.finish(c.finish_reason),
        finishReason: c.finish_reason,
        usage: data.usage,
      };
    }
    if (!r.body) throw new ModelError("PROTOCOL", "流响应为空");
    const reader = r.body.getReader(),
      decoder = new TextDecoder(),
      acc = new ToolAccumulator();
    let buffer = "",
      content = "",
      reason = "",
      done = false,
      usage: unknown;
    const line = (s: string) => {
      if (!s.startsWith("data:")) return;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") {
        done = true;
        return;
      }
      if (!payload) return;
      const data = JSON.parse(payload);
      usage = data.usage ?? usage;
      const c = data.choices?.[0];
      if (!c) return;
      if (c.delta?.content) {
        content += c.delta.content;
        onText?.(c.delta.content);
      }
      acc.add(c.delta?.tool_calls);
      if (c.finish_reason) reason = c.finish_reason;
    };
    try {
      while (true) {
        const next = await reader.read();
        buffer += decoder.decode(next.value, { stream: !next.done });
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, i).replace(/\r$/, ""));
          buffer = buffer.slice(i + 1);
        }
        if (next.done) break;
      }
      if (buffer.trim()) line(buffer);
      if (!done || !reason) throw new ModelError("TRUNCATED", "模型流异常中断");
      return {
        content,
        calls: acc.finish(reason),
        finishReason: reason,
        usage,
      };
    } catch (e) {
      if (signal.aborted) throw new ModelError("CANCELLED", "请求已取消");
      if (e instanceof ModelError) throw e;
      throw new ModelError("STREAM", "模型流解析失败");
    } finally {
      reader.releaseLock();
    }
  }
}
