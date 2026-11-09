import type { Adapter, Message } from "../model/model-adapter";
import { ModelError } from "../model/model-adapter";
import {
  dispatch,
  visibleTools,
  type Profile,
  type Context,
} from "../tools/dispatcher";
export async function run(
  adapter: Adapter,
  p: Profile,
  context: Context,
  prompt: string,
  signal: AbortSignal,
  emit: (
    type: "toolStarted" | "toolFinished" | "text" | "usage",
    message: string,
  ) => void,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, p.timeoutMs);
  let read = false;
  let proposed = false;
  let submittedEdits = false;
  let generated = false;
  const messages: Message[] = [
    {
      role: "system",
      content: p.systemPrompt,
    },
    { role: "user", content: prompt },
  ];
  try {
    for (let round = 0; round < p.maxRounds; round++) {
      if (controller.signal.aborted)
        throw new ModelError(
          signal.aborted ? "CANCELLED" : "TIMEOUT",
          "任务已取消或超时",
        );
      const response = await adapter.complete(
        messages,
        visibleTools(p),
        controller.signal,
        (t) => emit("text", t),
        p.maxOutputTokens,
      );
      const usage = response.usage;
      if (usage && typeof usage === "object") {
        const fields = Object.entries(usage as Record<string, unknown>).filter(
          ([key, value]) =>
            ["prompt_tokens", "completion_tokens", "total_tokens"].includes(
              key,
            ) &&
            typeof value === "number" &&
            Number.isFinite(value),
        );
        emit(
          "usage",
          fields.length
            ? `模型实际 usage：${JSON.stringify(Object.fromEntries(fields))}`
            : "模型未提供可识别的 usage",
        );
      } else emit("usage", "模型未提供 usage");
      if (controller.signal.aborted)
        throw new ModelError(
          signal.aborted ? "CANCELLED" : "TIMEOUT",
          "任务已取消或超时",
        );
      if (response.finishReason === "length")
        throw new ModelError("TRUNCATED", "模型输出被截断");
      messages.push({
        role: "assistant",
        content: response.content || null,
        ...(response.calls.length ? { tool_calls: response.calls } : {}),
      });
      if (!response.calls.length) {
        if (p.output === "generate" && !generated)
          throw new ModelError("NO_ARTIFACT", "未提交有效生成产物");
        if (p.output === "format-proposal" && !proposed)
          throw new ModelError(
            "NO_ARTIFACT",
            `模型未提交有效规则提案${response.content.trim() ? `：${response.content.trim()}` : ""}`,
          );
        if (p.output === "proofread-edits" && !submittedEdits)
          throw new ModelError(
            "NO_ARTIFACT",
            `模型未提交本块候选（空数组合法）${response.content.trim() ? `：${response.content.trim()}` : ""}`,
          );
        if (p.output === "read-feedback" && (!read || !response.content.trim()))
          throw new ModelError(
            "NO_ARTIFACT",
            "未取得只读工具结果和最终反馈，不能完成",
          );
        return { messages, feedback: response.content };
      }
      for (const call of response.calls) {
        if (controller.signal.aborted)
          throw new ModelError("CANCELLED", "任务已取消");
        emit("toolStarted", call.function.name);
        let result;
        try {
          result = await dispatch(
            call.function.name,
            JSON.parse(call.function.arguments),
            context,
            p,
          );
        } catch {
          result = {
            ok: false,
            error: { code: "INVALID_JSON", message: "工具参数不是有效 JSON" },
          };
        }
        if (result.ok) read = true;
        if (result.ok && call.function.name === "propose_format_rules")
          proposed = true;
        if (
          result.ok &&
          ["submit_titles", "submit_summary"].includes(call.function.name)
        )
          generated = true;
        if (result.ok && call.function.name === "submit_edits")
          submittedEdits = true;
        emit(
          "toolFinished",
          result.ok ? "只读工具执行成功" : result.error.code,
        );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
    }
    throw new ModelError("ROUND_LIMIT", "达到最大模型轮数");
  } catch (error) {
    if (controller.signal.aborted)
      throw new ModelError(
        signal.aborted ? "CANCELLED" : "TIMEOUT",
        signal.aborted ? "任务已取消" : "任务超时",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
