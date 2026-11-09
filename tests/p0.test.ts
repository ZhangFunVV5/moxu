import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  ToolAccumulator,
  OpenAICompatible,
} from "../src/agent/model/openai-compatible";
import {
  dispatch,
  profile,
  registry,
  visibleTools,
} from "../src/agent/tools/dispatcher";
import { run } from "../src/agent/runtime/loop";
import type {
  Adapter,
  Message,
  Response,
} from "../src/agent/model/model-adapter";
const context = {
  workspaceId: "sample-book",
  chapterIds: ["c1"],
  source: "agent" as const,
  allowWrite: false,
  version: 1,
};
const signal = () => new AbortController().signal;
const call = {
  id: "one",
  type: "function" as const,
  function: { name: "read_sample_chapter", arguments: '{"chapterId":"c1"}' },
};
const tool: Response = {
  content: "",
  calls: [call],
  finishReason: "tool_calls",
};
const final: Response = {
  content: "已读取雨夜场景。",
  calls: [],
  finishReason: "stop",
};
test("累积 Unicode、多工具，拒绝不完整 JSON 与截断", () => {
  const a = new ToolAccumulator();
  a.add([
    {
      index: 0,
      id: "a",
      function: { name: "read_", arguments: '{"chapterId":' },
    },
    {
      index: 1,
      id: "b",
      function: { name: "read_sample_chapter", arguments: '{"chapterId":"中' },
    },
  ]);
  a.add([
    { index: 0, function: { name: "sample_chapter", arguments: '"c1"}' } },
    { index: 1, function: { arguments: '文😀"}' } },
  ]);
  assert.equal(
    a.finish("tool_calls")[1].function.arguments,
    '{"chapterId":"中文😀"}',
  );
  assert.throws(() => a.finish("length"));
  const b = new ToolAccumulator();
  b.add([{ index: 0, id: "x", function: { name: "read", arguments: "{" } }]);
  assert.throws(() => b.finish("tool_calls"));
});
test("Dispatcher 按 schema/Profile/范围/版本与 write 拒绝", async () => {
  for (const [name, args, ctx, p, code] of [
    ["unknown", {}, context, profile, "UNKNOWN_TOOL"],
    ["toString", {}, context, profile, "UNKNOWN_TOOL"],
    ["constructor", {}, context, profile, "UNKNOWN_TOOL"],
    [
      "read_sample_chapter",
      { chapterId: "c1", allowWrite: true },
      context,
      profile,
      "INVALID_ARGUMENTS",
    ],
    [
      "read_sample_chapter",
      { chapterId: "c1" },
      context,
      { ...profile, tools: [] },
      "PROFILE_DENIED",
    ],
    [
      "read_sample_chapter",
      { chapterId: "c2" },
      context,
      profile,
      "SCOPE_DENIED",
    ],
    [
      "read_sample_chapter",
      { chapterId: "c1" },
      { ...context, version: 2 },
      profile,
      "VERSION_MISMATCH",
    ],
  ] as const) {
    const r = await dispatch(name, args, ctx, p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, code);
  }
  registry.read_sample_chapter.access = "write";
  assert.equal(
    (await dispatch(call.function.name, { chapterId: "c1" }, context, profile))
      .ok,
    false,
  );
  registry.read_sample_chapter.access = "read";
  assert.equal(
    (await dispatch(call.function.name, { chapterId: "c1" }, context, profile))
      .ok,
    true,
  );
  assert.equal(visibleTools(profile).length, 1);
});
test("完整 assistant/tool 时序，多工具顺序，失败反馈模型修正", async () => {
  const captured: Message[][] = [];
  let i = 0;
  const a: Adapter = {
    async complete(m) {
      captured.push(structuredClone(m));
      return [
        {
          ...tool,
          calls: [
            { ...call, function: { name: "unknown", arguments: "{}" } },
            { ...call, id: "two" },
          ],
        },
        final,
      ][i++];
    },
  };
  await run(a, profile, context, "读 c1", signal(), () => {});
  assert.deepEqual(
    captured[1].map((m) => m.role),
    ["system", "user", "assistant", "tool", "tool"],
  );
  assert.equal(captured[1][3].tool_call_id, "one");
  assert.match(captured[1][3].content!, /UNKNOWN_TOOL/);
});
test("无产物、轮数耗尽、取消、非法 JSON", async () => {
  await assert.rejects(
    run(
      {
        async complete() {
          return final;
        },
      },
      profile,
      context,
      "",
      signal(),
      () => {},
    ),
    /不能完成/,
  );
  await assert.rejects(
    run(
      {
        async complete() {
          return tool;
        },
      },
      { ...profile, maxRounds: 1 },
      context,
      "",
      signal(),
      () => {},
    ),
    /最大模型轮数/,
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    run(
      {
        async complete() {
          return tool;
        },
      },
      profile,
      context,
      "",
      c.signal,
      () => {},
    ),
    /取消/,
  );
  let n = 0;
  await assert.rejects(
    run(
      {
        async complete() {
          return n++
            ? final
            : {
                ...tool,
                calls: [
                  { ...call, function: { ...call.function, arguments: "{" } },
                ],
              };
        },
      },
      profile,
      context,
      "",
      signal(),
      () => {},
    ),
    /不能完成/,
  );
});
test("HTTP 固定服务：非流/流、usage、401/429、断流与请求取消", async () => {
  let scenario = "normal";
  const server = createServer((req, res) => {
    if (scenario === "hang") return;
    if (scenario === "401" || scenario === "429") {
      res.writeHead(Number(scenario));
      res.end();
      return;
    }
    let body = "";
    req.on("data", (v) => (body += v));
    req.on("end", () => {
      const input = JSON.parse(body);
      assert.equal(input.max_tokens, 1024);
      if (!input.stream) {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { content: "好", tool_calls: [call] },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        "data: " +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content: "中文😀",
                  tool_calls: [{ index: 0, ...call }],
                },
                finish_reason: null,
              },
            ],
          }) +
          "\n\n",
      );
      if (scenario !== "broken")
        res.write(
          "data: " +
            JSON.stringify({
              choices: [{ delta: {}, finish_reason: "tool_calls" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const cfg = {
    baseUrl: `http://127.0.0.1:${port}`,
    model: "fixture",
    temperature: 0,
    stream: false,
  };
  try {
    let response = await new OpenAICompatible(cfg).complete([], [], signal());
    assert.equal(response.calls.length, 1);
    assert.equal(response.usage, undefined);
    response = await new OpenAICompatible({ ...cfg, stream: true }).complete(
      [],
      [],
      signal(),
    );
    assert.equal(response.content, "中文😀");
    for (const code of ["401", "429", "broken"]) {
      scenario = code;
      await assert.rejects(
        new OpenAICompatible({ ...cfg, stream: true }).complete(
          [],
          [],
          signal(),
        ),
        (e) =>
          (e as any).code ===
          (code === "401"
            ? "AUTH"
            : code === "429"
              ? "RATE_LIMIT"
              : "TRUNCATED"),
      );
    }
    scenario = "hang";
    const c = new AbortController();
    const pending = new OpenAICompatible(cfg).complete([], [], c.signal);
    setTimeout(() => c.abort(), 30);
    await assert.rejects(pending, (e) => (e as any).code === "CANCELLED");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
test("Profile 系统提示、输出预算、超时与用户取消分开", async () => {
  const adapter: Adapter = {
    async complete(messages, _tools, abort, _text, budget) {
      assert.equal(messages[0].content, profile.systemPrompt);
      assert.equal(budget, profile.maxOutputTokens);
      await new Promise((_resolve, reject) =>
        abort.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
      throw new Error("unreachable");
    },
  };
  await assert.rejects(
    run(
      adapter,
      { ...profile, timeoutMs: 10 },
      context,
      "",
      signal(),
      () => {},
    ),
    (e) => (e as any).code === "TIMEOUT",
  );
  const controller = new AbortController();
  const pending = run(
    adapter,
    profile,
    context,
    "",
    controller.signal,
    () => {},
  );
  controller.abort();
  await assert.rejects(pending, (e) => (e as any).code === "CANCELLED");
});
