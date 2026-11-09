import { _electron as electron } from "playwright";
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(".tmp-build", "p3-ui-state");
await mkdir(root, { recursive: true });
await build({ entryPoints: ["tests/fixtures/p3-ui-state.tsx"], bundle: true, outfile: path.join(root, "renderer.js"), jsx: "automatic" });
await writeFile(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
await writeFile(path.join(root, "main.cjs"), `const {app,BrowserWindow}=require('electron'); app.whenReady().then(()=>{ const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}}); win.loadFile(require('node:path').join(__dirname,'index.html')); });`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: [path.join(root, "main.cjs"), "--no-sandbox", `--user-data-dir=${path.join(root, "user-data")}`], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const editor = page.getByTestId("body-editor");
  await page.getByText("a章意见", { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.autoApply());
  await page.waitForFunction(() => document.querySelector('[data-testid="body-editor"]')?.textContent?.includes("a章正字。"));
  assert.match(await page.getByTestId("save-state").textContent(), /已保存/);

  await page.reload();
  await page.getByText("a章意见", { exact: true }).waitFor();
  await editor.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type("草稿");
  await page.evaluate(() => window.fixture.autoApply());
  await page.getByTestId("proofread-progress").waitFor();
  assert.match(await editor.textContent(), /草稿/);
  assert.match(await page.getByTestId("save-state").textContent(), /未保存/);

  await page.reload();
  await page.getByText("a章意见", { exact: true }).waitFor();
  await page.getByLabel("精校批次", { exact: true }).selectOption("a-old");
  await page.getByText("正在查看历史批次", { exact: false }).waitFor();
  await page.getByRole("button", { name: /章节b/ }).click();
  await page.getByText("b章意见", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("精校批次", { exact: true }).inputValue(), "");
  assert.equal(await page.getByText("a章意见", { exact: true }).count(), 0);

  await page.reload();
  await page.getByText("a章意见", { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.delayApply());
  await page.getByRole("button", { name: "采纳", exact: true }).click();
  await page.waitForFunction(() => window.fixture.hasPendingApply());
  await page.getByRole("button", { name: /章节b/ }).click();
  await page.getByText("b章意见", { exact: true }).waitFor();
  await page.evaluate(() => window.fixture.releaseApply());
  await page.waitForFunction(() => window.fixture.applyReturned());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await editor.textContent(), /b章错字/);
  assert.equal(await page.getByText("a章意见", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("P3 UI 状态回归通过：自动应用同步、保留草稿、切章清除历史批次、丢弃旧章回执");
} finally {
  await app.close();
}
