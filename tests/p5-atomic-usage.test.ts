import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  nodeFs,
  renameWithRetry,
  writeFileAtomic,
} from "../src/core/workspace/atomic-file";
import { run } from "../src/agent/runtime/loop";
import { profile } from "../src/agent/tools/dispatcher";
test("P5 Windows replacement retries transient sharing errors without losing old content", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "rename-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "chapter.json");
  await writeFile(file, "old");
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    let attempts = 0;
    await writeFileAtomic(file, "new-" + code, {
      fs: {
        ...nodeFs,
        rename: (from, to) =>
          renameWithRetry(
            from,
            to,
            async (a, b) => {
              attempts++;
              if (attempts < 3) {
                assert.equal(await readFile(file, "utf8"), "old");
                throw Object.assign(Error("busy"), { code });
              }
              await nodeFs.rename(a, b);
            },
            "win32",
          ),
      },
    });
    assert.equal(attempts, 3);
    assert.equal(await readFile(file, "utf8"), "new-" + code);
    await writeFile(file, "old");
  }
  let attempts = 0;
  await assert.rejects(
    writeFileAtomic(file, "lost", {
      fs: {
        ...nodeFs,
        rename: (from, to) =>
          renameWithRetry(
            from,
            to,
            async () => {
              attempts++;
              throw Object.assign(Error("busy"), { code: "EBUSY" });
            },
            "win32",
          ),
      },
    }),
    { code: "RENAME_FAILED" },
  );
  assert.equal(attempts, 6);
  assert.equal(await readFile(file, "utf8"), "old");
  assert.deepEqual(await readdir(dir), ["chapter.json"]);
  for (const [platform, code] of [
    ["win32", "ENOENT"],
    ["linux", "EBUSY"],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      renameWithRetry(
        "a",
        "b",
        async () => {
          calls++;
          throw Object.assign(Error("permanent"), { code });
        },
        platform,
      ),
      { code },
    );
    assert.equal(calls, 1);
  }
});
test("P5 usage has its own event and never changes exact streamed text", async () => {
  const events: Array<{ type: string; message: string }> = [];
  await assert.rejects(
    run(
      {
        async complete(_messages, _tools, _signal, onText) {
          onText?.("片");
          onText?.("段");
          return {
            content: "片段",
            calls: [],
            finishReason: "stop",
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          };
        },
      },
      profile,
      {
        workspaceId: "sample-book",
        chapterIds: ["c1"],
        source: "agent",
        allowWrite: false,
        version: 1,
      },
      "test",
      new AbortController().signal,
      (type, message) => events.push({ type, message }),
    ),
    { code: "NO_ARTIFACT" },
  );
  assert.equal(
    events
      .filter((x) => x.type === "text")
      .map((x) => x.message)
      .join(""),
    "片段",
  );
  assert.deepEqual(
    events.filter((x) => x.type === "usage").map((x) => x.message),
    [
      '模型实际 usage：{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}',
    ],
  );
});
