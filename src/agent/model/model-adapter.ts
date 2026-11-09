export type Call = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type Message = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Call[];
  tool_call_id?: string;
};
export type Response = {
  content: string;
  calls: Call[];
  finishReason: string;
  usage?: unknown;
};
export interface Adapter {
  complete(
    messages: Message[],
    tools: unknown[],
    signal: AbortSignal,
    onText?: (text: string) => void,
    maxOutputTokens?: number,
  ): Promise<Response>;
}
export class ModelError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
