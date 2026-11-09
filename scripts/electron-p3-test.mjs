import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const base = path.join(process.cwd(), ".tmp-p3-electron");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const fixture = path.join(root, "精校原书.txt");
const booksRoot = path.join(root, "books");
const original = [
  "第一章 雨夜",
  "沈舟回家，发现桌上有错宁。",
  "门开着，屋里没有人。",
  "",
  "第二章 旧信",
  "信封泛黄，上面写着沈舟的名字。",
  "最新地址：https://promo.example.com/txt 请收藏本站",
].join("\r\n");
await writeFile(fixture, original);

const env = {
  ...process.env,
  BOOK_WORKBENCH_ROOT: booksRoot,
  BOOK_WORKBENCH_TEST_SOURCE: fixture,
};
delete env.ELECTRON_RUN_AS_NODE;

let requests = 0;
function sse(response, delta, finishReason) {
  response.setHeader("Content-Type", "text/event-stream");
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n` +
      "data: [DONE]\n\n",
  );
}
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const input = JSON.parse(body);
    requests += 1;
    const prompt =
      input.messages.filter((message) => message.role === "user").at(-1)?.content ??
      "";
    const hasToolResult = input.messages.some((message) => message.role === "tool");
    if (hasToolResult) {
      sse(response, { content: "本块完成" }, "stop");
      return;
    }
    const chapterId = /chapterId=([A-Za-z0-9_-]+)/.exec(prompt)?.[1];
    const blockId = /blockId=(b[1-9][0-9]*)/.exec(prompt)?.[1];
    const inputHash = /inputHash=([0-9a-f]{64})/.exec(prompt)?.[1];
    const candidates = prompt.includes("错宁")
      ? [
          {
            paragraphId: "p1",
            before: "沈舟回家",
            after: "沈舟回到家中",
            category: "wording",
            reason: "用词更自然",
          },
          {
            paragraphId: "p1",
            before: "错宁",
            after: "错字",
            category: "typo",
            reason: "错别字",
          },
        ]
      : [];
    sse(
      response,
      {
        tool_calls: [
          {
            index: 0,
            id: `call-${blockId}`,
            type: "function",
            function: {
              name: "submit_edits",
              arguments: JSON.stringify({ chapterId, blockId, inputHash, candidates }),
            },
          },
        ],
      },
      "tool_calls",
    );
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const evidence = {
  passed: false,
  modelEvidence: "fixed local HTTP/SSE fixture; not a real-model quality evaluation",
  widths: [375, 768, 1024, 1440],
};

let app = null;
async function launch() {
  app = await electron.launch({
    args: [".", "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`],
    env,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".bb-shell");
  return page;
}

async function workspaceChapterIds(page) {
  return page.evaluate(async () => {
    const state = await window.desktop.workspace.state();
    return state.ok ? state.data.chapters.map((chapter) => chapter.chapterId) : [];
  });
}

async function chapterView(page, chapterId) {
  return page.evaluate(async (id) => {
    const result = await window.desktop.proofread.chapter({ chapterId: id });
    return result;
  }, chapterId);
}

async function saveModelSettings(page) {
  await page.getByRole("button", { name: "模型设置" }).click();
  await page
    .getByText("Base URL", { exact: true })
    .locator("input")
    .fill(`http://127.0.0.1:${port}/v1`);
  await page
    .getByText("模型名", { exact: true })
    .locator("input")
    .fill("fixture-p3");
  await page
    .getByText("API Key", { exact: true })
    .locator("input")
    .fill("fixture-not-a-real-key");
  await page.getByRole("button", { name: "保存设置" }).click();
}

async function startProofread(page) {
  const startButton = page.getByTestId("proofread-start");
  if (!(await startButton.isVisible()))
    await page.getByText("精校设置", { exact: true }).click();
  await startButton.click();
}

async function waitForIssues(page, minimum = 1) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-testid^="proofread-issue-"]').length >= count,
    minimum,
    { timeout: 30_000 },
  );
}

try {
  let page = await launch();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.getByRole("button", { name: "导入书籍" }).click();
  await page.getByRole("button", { name: "创建作品" }).click();
  await page.waitForSelector(".bb-book-name");
  const chapters = await workspaceChapterIds(page);
  assert.equal(chapters.length, 2);
  const workspaceDir = path.join(booksRoot, (await readdir(booksRoot))[0]);

  await saveModelSettings(page);
  await page.getByLabel("任务范围").selectOption("all");
  await startProofread(page);
  await waitForIssues(page, 2);
  await page.getByRole("tab", { name: /^全部/ }).click();
  evidence.started = true;
  evidence.issueCountCh1 = await page.locator('[data-testid^="proofread-issue-"]').count();
  assert.equal(evidence.issueCountCh1, 2);

  const cards = page.locator('[data-testid^="proofread-issue-"]');
  // A / B 都采纳，再单独撤回 A，B 必须保留。
  await cards
    .filter({ hasText: "沈舟回到家中" })
    .getByRole("button", { name: "采纳" })
    .click();
  await page.getByTestId("message").filter({ hasText: "已采纳" }).waitFor();
  await cards.filter({ hasText: "错宁" }).getByRole("button", { name: "采纳" }).click();
  await page.getByTestId("message").filter({ hasText: "已采纳" }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent?.includes("错字"),
  );
  await cards
    .filter({ hasText: "沈舟回到家中" })
    .getByRole("button", { name: "撤回修改" })
    .click();
  await page.getByTestId("message").filter({ hasText: "已撤回" }).waitFor();
  let viewCh1 = await chapterView(page, chapters[0]);
  assert.ok(viewCh1.ok);
  assert.ok(viewCh1.data.body.includes("沈舟回家"));
  assert.ok(!viewCh1.data.body.includes("沈舟回到家中"));
  assert.ok(viewCh1.data.body.includes("错字"));
  assert.equal(viewCh1.data.counts.accepted, 1);
  evidence.acceptWithdrawKeepsOther = true;

  // 重新采纳 A 并定位。
  await cards
    .filter({ hasText: "沈舟回到家中" })
    .getByRole("button", { name: "采纳" })
    .click();
  await page.getByTestId("message").filter({ hasText: "已采纳" }).waitFor();
  await cards
    .filter({ hasText: "错宁" })
    .getByRole("button", { name: "定位原文" })
    .click();
  await page.waitForTimeout(120);
  viewCh1 = await chapterView(page, chapters[0]);
  assert.equal(viewCh1.data.counts.accepted, 2);
  assert.ok(viewCh1.data.issues.every((issue) => issue.locate));
  evidence.locateVisible = true;

  // 第二章：规则广告候选删除、定位、撤回与忽略恢复。
  await page.getByRole("button", { name: /第二章 旧信/ }).click();
  await waitForIssues(page, 1);
  await page.getByRole("tab", { name: /^全部/ }).click();
  const adCard = page.locator('[data-testid^="proofread-issue-"]').first();
  assert.match(await adCard.innerText(), /广告/);
  await adCard.getByRole("button", { name: "采纳" }).click();
  await page.getByTestId("message").filter({ hasText: "已采纳" }).waitFor();
  let viewCh2 = await chapterView(page, chapters[1]);
  assert.ok(viewCh2.ok);
  assert.ok(!viewCh2.data.body.includes("promo.example.com"));
  const bodyBeforeDiff = viewCh2.data.body;
  await page.getByRole("button", { name: "修改对照" }).click();
  await page.getByTestId("proofread-diff").waitFor();
  const diffText = await page.getByTestId("proofread-diff").innerText();
  assert.match(diffText, /已删除段落/);
  await page.getByRole("button", { name: "工作正文" }).click();
  await page.locator(".cm-deletion-anchor").waitFor();
  const bodyAfterDiff = (await chapterView(page, chapters[1])).data.body;
  assert.equal(bodyAfterDiff, bodyBeforeDiff, "切换对照不得改数据");
  await adCard.getByRole("button", { name: "定位原文" }).click();
  await page.waitForTimeout(120);
  await adCard.getByRole("button", { name: "撤回修改" }).click();
  await page.getByTestId("message").filter({ hasText: "已撤回" }).waitFor();
  viewCh2 = await chapterView(page, chapters[1]);
  assert.ok(viewCh2.data.body.includes("promo.example.com"));
  await adCard.getByRole("button", { name: "忽略" }).click();
  await page.getByTestId("message").filter({ hasText: "已忽略" }).waitFor();
  viewCh2 = await chapterView(page, chapters[1]);
  assert.equal(viewCh2.data.counts.ignored, 1);
  await adCard.getByRole("button", { name: "恢复待审" }).click();
  await page.getByTestId("message").filter({ hasText: "已恢复待审" }).waitFor();
  viewCh2 = await chapterView(page, chapters[1]);
  assert.equal(viewCh2.data.counts.pending, 1);
  evidence.adDeleteLocateRestoreIgnore = true;

  // 手工编辑使旧批次过期；旧意见保留可查看，但不能直接套用。
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n手工补写。");
  await page.getByRole("button", { name: "保存正文" }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="save-state"]')?.textContent === "已保存",
  );
  await page.getByTestId("proofread-stale").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "采纳", exact: true }).first().isDisabled(),
    true,
  );
  evidence.manualEditStale = true;

  // 写失败：只读章文件使审阅提交失败，旧正文与决议保持。
  await page.getByRole("button", { name: /第一章 雨夜/ }).click();
  await waitForIssues(page, 2);
  await page.getByRole("tab", { name: /^全部/ }).click();
  const chapter1File = path.join(workspaceDir, "chapters", `${chapters[0]}.json`);
  const beforeFailure = await chapterView(page, chapters[0]);
  await chmod(chapter1File, 0o444);
  try {
    await page
      .locator('[data-testid^="proofread-issue-"]')
      .filter({ hasText: "沈舟回到家中" })
      .getByRole("button", { name: "撤回修改" })
      .click();
    await page.getByTestId("proofread-error").waitFor({ timeout: 15_000 });
  } finally {
    await chmod(chapter1File, 0o666);
  }
  const afterFailure = await chapterView(page, chapters[0]);
  assert.equal(afterFailure.data.body, beforeFailure.data.body);
  assert.equal(afterFailure.data.counts.accepted, beforeFailure.data.counts.accepted);
  evidence.writeFailureKeepsState = true;

  for (const width of evidence.widths) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `overflow ${width}`,
    );
    await page.screenshot({
      path: `artifacts/electron-p3-${width}.png`,
      fullPage: true,
    });
  }
  evidence.diffAndDeletionAnchor = true;
  evidence.responsive = true;

  // 导出精校报告：写入所选文件；取消时不写文件。
  const reportFile = path.join(root, "精校报告.txt");
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, reportFile);
  await page.getByRole("button", { name: /导出精校报告/ }).click();
  await page.getByTestId("message").filter({ hasText: "已导出精校报告" }).waitFor();
  const reportText = await readFile(reportFile, "utf8");
  assert.ok(reportText.includes("# 精校修改报告"));
  assert.ok(reportText.includes("最终有效修改"));
  assert.ok(!reportText.includes(workspaceDir));
  const reportBefore = await readdir(root);
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await page.getByRole("button", { name: /导出精校报告/ }).click();
  await page.getByTestId("message").filter({ hasText: "已取消导出报告" }).waitFor();
  assert.deepEqual((await readdir(root)).sort(), reportBefore.sort());
  evidence.reportExportAndCancel = true;

  // 键盘焦点：原生控件可连续 Tab，焦点不丢失到 body。
  await page.getByRole("tab", { name: /^全部/ }).focus();
  const focusTrail = [];
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      return {
        tag: element?.tagName ?? "",
        text: (element?.getAttribute("aria-label") || element?.textContent || "")
          .trim()
          .slice(0, 24),
      };
    });
    assert.notEqual(focused.tag, "BODY", `Tab ${index + 1} 焦点丢失`);
    focusTrail.push(focused);
  }
  evidence.keyboardFocusTrail = focusTrail;

  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));

  await app.close();
  app = null;
  page = await launch();
  await page.waitForSelector(".bb-book-name");
  await page.getByRole("tab", { name: /^全部/ }).click();
  await waitForIssues(page, 2);
  const reopened = await chapterView(page, chapters[0]);
  assert.ok(reopened.ok);
  assert.equal(reopened.data.counts.accepted, 2);
  await page.getByRole("button", { name: "撤回上次操作" }).click();
  await page.getByTestId("message").filter({ hasText: "已撤回上次审阅操作" }).waitFor();
  const undone = await chapterView(page, chapters[0]);
  assert.ok(undone.ok);
  assert.equal(undone.data.counts.accepted, 1);
  evidence.reopenPersisted = true;

  evidence.passed = true;
  await writeFile(
    "artifacts/electron-p3-test.json",
    JSON.stringify(
      { ...evidence, fixedModelRequests: requests, checkedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(
    "Electron P3: proofread start/accept/withdraw/ignore/restore/locate/stale/write-failure/reopen passed",
  );
} finally {
  if (app) await app.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
