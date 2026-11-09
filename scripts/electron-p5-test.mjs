import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = await mkdtemp(path.join(process.cwd(), ".tmp-p5-"));
let slow = false,
  requests = 0;
const seenSummary = [];
function sse(r, delta, finish) {
  r.setHeader("Content-Type", "text/event-stream");
  r.end(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
  );
}
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    requests++;
    console.log("fixture request", requests);
    if (slow) {
      setTimeout(() => {
        if (!res.destroyed) sse(res, { content: "cancel" }, "stop");
      }, 1500);
      return;
    }
    const input = JSON.parse(raw);
    if (input.messages.some((m) => m.role === "tool"))
      return sse(res, { content: "已提交" }, "stop");
    const text = input.messages.findLast((m) => m.role === "user").content;
    let name, args;
    if (input.tools.some((t) => t.function.name === "submit_edits")) {
      name = "submit_edits";
      args = {
        chapterId: /chapterId=([\w-]+)/.exec(text)[1],
        blockId: /blockId=(b\d+)/.exec(text)[1],
        inputHash: /inputHash=([a-f0-9]{64})/.exec(text)[1],
        candidates: text.includes("错宁")
          ? [
              {
                paragraphId: "p1",
                before: "错宁",
                after: "错字",
                category: "typo",
                reason: "修正错字",
              },
            ]
          : [],
      };
    } else {
      const p = JSON.parse(text);
      if (input.tools.some((t) => t.function.name === "submit_titles")) {
        name = "submit_titles";
        args = {
          chapterId: p.chapterId,
          inputHash: p.inputHash,
          titles: ["雨夜归家", "旧信线索", "空屋来信"],
        };
      } else {
        name = "submit_summary";
        seenSummary.push(text);
        args = {
          chapterId: p.chapterId,
          inputHash: p.inputHash,
          summary:
            "沈舟回到家中，发现桌上放着一封旧信，屋门虽然开着，房间里却没有其他人。他留意到信封上的字迹，并读到有关故乡与钥匙的消息。这封信使他重新关注屋内的情形，也为接下来的寻找留下了线索。他仍需要了解寄信的人以及钥匙的去向，眼前的发现成为本章叙述的中心。",
        };
      }
    }
    sse(
      res,
      {
        tool_calls: [
          {
            index: 0,
            id: "fixture-call",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
      "tool_calls",
    );
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const evidence = {
  passed: false,
  fixture:
    "Deterministic local HTTP/SSE in actual Electron; no model quality claim",
  packaged: !!process.env.BW_PACKAGED_EXE,
  cases: [],
};
let app;
const hash = (s) => createHash("sha256").update(s).digest("hex");
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw Error("condition timeout");
}
async function launch(fixture, tag) {
  const env = {
    ...process.env,
    BOOK_WORKBENCH_ROOT: path.join(root, tag, "books"),
    BOOK_WORKBENCH_TEST_SOURCE: fixture,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.BW_PACKAGED_EXE) {
    // Run the copied application without access to the development Node/npm PATH.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
  }
  app = await electron.launch({
    ...(process.env.BW_PACKAGED_EXE
      ? { executablePath: process.env.BW_PACKAGED_EXE }
      : {}),
    args: [
      ...(process.env.BW_PACKAGED_EXE ? [] : ["."]),
      ...(process.env.BW_PACKAGED_EXE ? [] : ["--no-sandbox"]),
      `--user-data-dir=${path.join(root, tag, "user-data")}`,
    ],
    ...(process.env.BW_PACKAGED_EXE ? { cwd: root } : {}),
    env,
  });
  return app.firstWindow();
}
async function records(page) {
  const r = await page.evaluate(() => window.desktop.pipeline.list());
  assert.ok(r.ok);
  return r.data;
}
async function waitState(page, id, state) {
  return until(async () => {
    const r = (await records(page)).find((x) => x.pipelineId === id);
    if (r?.state === "failed") throw Error(r.error);
    return r?.state === state ? r : false;
  });
}
try {
  for (const format of ["txt", "markdown"]) {
    const source = path.join(root, `原书.${format === "txt" ? "txt" : "md"}`),
      text =
        format === "txt"
          ? "第一章 雨夜\n沈舟回家，发现稿纸上的错宁。\n\n第二章 旧信\n信封泛黄，沈舟读到了故乡的消息。"
          : "# 第一章 雨夜\n\n沈舟回家，发现稿纸上的错宁。\n\n# 第二章 旧信\n\n信封泛黄，沈舟读到了故乡的消息。";
    await writeFile(source, text);
    const sourceHash = hash(await readFile(source));
    let page = await launch(source, format);
    await page.getByRole("button", { name: "导入书籍", exact: true }).click();
    await page.getByRole("button", { name: "创建作品", exact: true }).click();
    await page.waitForSelector(".bb-book-name").catch(async error=>{
      console.error("Import errors:",await page.locator(".bb-error").allTextContents());
      throw error;
    });
    const w = await page.evaluate(() => window.desktop.workspace.state());
    assert.ok(w.ok);
    const ids = w.data.chapterOrder;
    assert.equal(ids.length, 2);
    await page.evaluate(
      (port) =>
        window.desktop.saveConfig({
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "p5-fixture",
          apiKey: "fixture-only",
          temperature: 0.2,
          stream: true,
        }),
      port,
    );
    const proposal = await page.evaluate(
      (id) =>
        window.desktop.pipeline.propose({
          prompt: "为这些章节生成标题和摘要",
          chapterIds: [id],
        }),
      ids[0],
    );
    assert.ok(proposal.ok);
    assert.equal(proposal.data.kind, "ready");
    assert.deepEqual(proposal.data.request.chapterIds, [ids[0]]);
    const started = await page.evaluate(async (ids) => {
      const p = await window.desktop.pipeline.start({
        chapterIds: [ids[0]],
        proofread: {
          categories: ["typo"],
          glossary: [],
          userRequest: "",
          ruleVersion: "proofread-rules-v1",
          profileVersion: "proofread-profile-v1",
          blockBudget: {
            maxChars: 6000,
            maxParagraphs: 80,
            contextParagraphs: 1,
          },
          autoApplyCategories: [],
        },
      });
      return p;
    }, ids);
    assert.ok(started.ok, JSON.stringify(started));
    await waitState(page, started.data.pipelineId, "waiting-review");
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.proofread.chapter({ chapterId: id }),
        ids[0],
      );
      return r.ok && r.data.issues?.length ? r : false;
    });
    await page
      .getByRole("button", { name: "采纳", exact: true })
      .first()
      .click();
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.chapters.get({ chapterId: id }),
        ids[0],
      );
      return r.ok && r.data.body.includes("错字");
    });
    await page.getByRole("tab", { name: /^已处理/ }).click();
    await page.getByRole("button", { name: "撤回修改", exact: true }).click();
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.chapters.get({ chapterId: id }),
        ids[0],
      );
      return r.ok && r.data.body.includes("错宁");
    });
    await page.getByRole("tab", { name: /^待处理/ }).click();
    await page.getByRole("button", { name: "采纳", exact: true }).click();
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.chapters.get({ chapterId: id }),
        ids[0],
      );
      return (
        r.ok && r.data.body.includes("错字") && !r.data.body.includes("错字字")
      );
    });
    assert.ok(
      (
        await page.evaluate(
          (id) => window.desktop.pipeline.resume({ pipelineId: id }),
          started.data.pipelineId,
        )
      ).ok,
    );
    await waitState(page, started.data.pipelineId, "completed");
    // Native window close must preserve a dirty editor when cancelled.
    const editor = page.getByTestId("body-editor").locator(".cm-content");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("保存关闭验收");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await page.getByRole("heading", { name: "未保存的修改" }).waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.ok(await editor.innerText().then((t) => t.includes("保存关闭验收")));
    await editor.click();
    await page.keyboard.press("Control+s");
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.chapters.get({ chapterId: id }),
        ids[0],
      );
      return r.ok && r.data.body.includes("保存关闭验收");
    });
    const output = path.join(
      root,
      `成稿-${format}.${format === "txt" ? "txt" : "md"}`,
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    const run = await page.evaluate(
      async ({ ids, format }) => {
        const preset = await window.desktop.format.getPreset();
        return window.desktop.pipeline.start({
          chapterIds: [ids[0]],
          title: {
            minLength: 2,
            maxLength: 12,
            candidateCount: 3,
            style: "贴合原文",
            allowSpoilers: false,
          },
          summary: { minLength: 100, maxLength: 200 },
          format: {
            options: preset.data,
            outputFormat: format === "txt" ? "txt" : "markdown",
          },
          export: true,
        });
      },
      { ids, format },
    );
    assert.ok(run.ok);
    await waitState(page, run.data.pipelineId, "completed");
    const out = await readFile(output, "utf8");
    assert.match(out, /错字/);
    assert.doesNotMatch(out, /错宁|第二章|故乡的消息/);
    assert.ok(seenSummary.some((t) => t.includes("错字")));
    assert.equal(hash(await readFile(source)), sourceHash);
    const title = await page.evaluate(
      (id) => window.desktop.generate.chapter({ chapterId: id }),
      ids[0],
    );
    assert.ok(title.ok);
    assert.equal(
      title.data.artifacts.filter((a) => a.kind === "title").length,
      1,
    );
    const beforeSelect = await page.evaluate(
      (id) => window.desktop.chapters.get({ chapterId: id }),
      ids[0],
    );
    await page.getByRole("button", { name: "标题与摘要", exact: true }).click();
    const choose = page.getByRole("button", {
      name: "选用候选 1",
      exact: true,
    });
    await choose.focus();
    await page.keyboard.press("Enter");
    await until(async () => {
      const r = await page.evaluate(
        (id) => window.desktop.chapters.get({ chapterId: id }),
        ids[0],
      );
      return r.ok && r.data.title === "第一章 雨夜归家";
    });
    const afterSelect = await page.evaluate(
      (id) => window.desktop.chapters.get({ chapterId: id }),
      ids[0],
    );
    assert.equal(afterSelect.data.bodyHash, beforeSelect.data.bodyHash);
    const selectedOutput = path.join(root, `选定标题-${format}.txt`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, selectedOutput);
    const selectedRun = await page.evaluate(async (id) => {
      const p = await window.desktop.format.getPreset();
      return window.desktop.pipeline.start({
        chapterIds: [id],
        format: { options: p.data, outputFormat: "txt" },
        export: true,
      });
    }, ids[0]);
    assert.ok(selectedRun.ok, JSON.stringify(selectedRun));
    await waitState(page, selectedRun.data.pipelineId, "completed");
    assert.match(await readFile(selectedOutput, "utf8"), /雨夜归家/);
    await page.getByRole("button", { name: "精校", exact: true }).click();
    const report = path.join(root, `报告-${format}.txt`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, report);
    const exported = await page.evaluate(
      (id) => window.desktop.proofread.exportReport({ chapterIds: [id] }),
      ids[0],
    );
    if (!exported.ok) throw Error(JSON.stringify(exported.error));
    assert.match(await readFile(report, "utf8"), /错宁|错字/);
    if (format === "txt") {
      const beforeLocal = requests;
      await app.evaluate(({ dialog }) => {
        dialog.showSaveDialog = async () => ({ canceled: true });
      });
      const local = await page.evaluate(async (id) => {
        const p = await window.desktop.format.getPreset();
        return window.desktop.pipeline.start({
          chapterIds: [id],
          format: { options: p.data, outputFormat: "txt" },
          export: true,
        });
      }, ids[0]);
      assert.ok(local.ok, JSON.stringify(local));
      await waitState(page, local.data.pipelineId, "cancelled");
      const localOutput = path.join(root, "仅排版恢复.txt");
      await app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: file,
        });
      }, localOutput);
      assert.ok(
        (
          await page.evaluate(
            (id) => window.desktop.pipeline.resume({ pipelineId: id }),
            local.data.pipelineId,
          )
        ).ok,
      );
      await waitState(page, local.data.pipelineId, "completed");
      assert.equal(requests, beforeLocal);
      assert.equal(
        await readFile(localOutput, "utf8"),
        await readFile(selectedOutput, "utf8"),
      );
      evidence.localOnlyAndExportResume = true;
      for (const width of [375, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.waitForTimeout(150);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        );
        await mkdir("artifacts", { recursive: true });
        await page.screenshot({
          path: `artifacts/electron-p5-${width}.png`,
          fullPage: true,
        });
      }
      slow = true;
      const c = await page.evaluate(
        (id) =>
          window.desktop.pipeline.start({
            chapterIds: [id],
            summary: { minLength: 100, maxLength: 200 },
          }),
        ids[1],
      );
      assert.ok(c.ok);
      await page.waitForTimeout(250);
      assert.ok(
        (
          await page.evaluate(
            (id) => window.desktop.pipeline.cancel({ pipelineId: id }),
            c.data.pipelineId,
          )
        ).ok,
      );
      assert.equal(
        (await records(page)).find((x) => x.pipelineId === c.data.pipelineId)
          .state,
        "cancelled",
      );
      slow = false;
      // Recover a forcibly interrupted model request without changing completed output.
      slow = true;
      const interrupted = await page.evaluate(
        (id) =>
          window.desktop.pipeline.start({
            chapterIds: [id],
            summary: { minLength: 100, maxLength: 200 },
          }),
        ids[1],
      );
      assert.ok(interrupted.ok);
      await page.waitForTimeout(200);
      const configBeforeExit = await readFile(
        path.join(root, format, "user-data", "model-config.json"),
      );
      const localStateBeforeExit = await readFile(
        path.join(root, format, "user-data", "Local State"),
      ).catch(() => null);
      evidence.beforeForceExitConfiguration = {
        bytes: configBeforeExit.length,
        hash: hash(configBeforeExit),
        localStatePresent: !!localStateBeforeExit,
        localStateHash: localStateBeforeExit
          ? hash(localStateBeforeExit)
          : null,
        ok: (await page.evaluate(() => window.desktop.getConfig())).ok,
      };
      const processExited = new Promise((resolve) =>
        app.process().once("exit", resolve),
      );
      if (process.platform === "win32") execFileSync("taskkill",["/pid",String(app.process().pid),"/T","/F"],{stdio:"ignore"});
      else app.process().kill("SIGKILL");
      await processExited;
      app = null;
      slow = false;
      page = await launch(source, format);
      await page.waitForSelector(".bb-book-name");
      const configBytes = await readFile(
        path.join(root, format, "user-data", "model-config.json"),
      );
      const reopenedConfig = await page.evaluate(() =>
        window.desktop.getConfig(),
      );
      evidence.reopenedConfiguration = {
        bytes: configBytes.length,
        hash: hash(configBytes),
        ok: reopenedConfig.ok,
      };
      assert.ok(reopenedConfig.ok, JSON.stringify(reopenedConfig));
      assert.equal(
        (await records(page)).find(
          (r) => r.pipelineId === interrupted.data.pipelineId,
        ).state,
        "interrupted",
      );
      assert.ok(
        (
          await page.evaluate(
            (id) => window.desktop.pipeline.resume({ pipelineId: id }),
            interrupted.data.pipelineId,
          )
        ).ok,
      );
      await waitState(page, interrupted.data.pipelineId, "completed");
      assert.equal(await readFile(output, "utf8"), out);
      evidence.forceExitRecovery = true;
    }
    evidence.cases.push({
      format,
      sourceHash,
      scope: 1,
      outputHash: hash(out),
      pipeline: run.data.pipelineId,
      report: true,
      withdrawReacceptAndTitleSelected: true,
      nativeCancelClosePreservedDraft: true,
      reviewedBeforeContinuation: true,
    });
    const closeEditor = page.getByTestId("body-editor").locator(".cm-content");
    await closeEditor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("关闭保存持久化");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await page.getByRole("heading", { name: "未保存的修改" }).waitFor();
    const closed = app.waitForEvent("close");
    await page.getByRole("button", { name: "保存并继续", exact: true }).click();
    await closed;
    app = null;
    page = await launch(source, format);
    await page.waitForSelector(".bb-book-name");
    assert.match(
      await page.getByTestId("body-editor").innerText(),
      /关闭保存持久化/,
    );
    assert.equal(
      (await records(page)).find((x) => x.pipelineId === run.data.pipelineId)
        .state,
      "completed",
    );
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    });
    await app.close();
    app = null;
  }
  evidence.passed = true;
} finally {
  if (app) {
    await app
      .evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      })
      .catch(() => {});
    await app.close();
  }
  server.close();
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    process.env.BW_PACKAGED_EXE ? "artifacts/electron-p5-packaged-test.json" : "artifacts/electron-p5-test.json",
    JSON.stringify({ ...evidence, requests }, null, 2),
  );
}
console.log(JSON.stringify(evidence, null, 2));
// A deliberately killed Electron connection can retain Playwright pipe handles.
// Every assertion and artifact write above has completed before this success exit.
process.exit(0);
