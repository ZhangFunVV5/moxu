import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
const base = path.join(process.cwd(), ".tmp-p2-electron");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
const fixture = path.join(root, "排版原书.txt"), booksRoot = path.join(root, "books");
const original = "第一章 雨夜\r\n沈舟回家。  \r\n\r\n灯还亮着。\r\n\r\n第二章 旧信\r\n信封泛黄。\r\n\r\n第三章 清晨\r\n天亮了。";
await writeFile(fixture, original);
const env = { ...process.env, BOOK_WORKBENCH_ROOT: booksRoot, BOOK_WORKBENCH_TEST_SOURCE: fixture }; delete env.ELECTRON_RUN_AS_NODE;
let requests = 0;
let proposedOptions;
const server = createServer((req,res) => { let body=""; req.on("data",c => body+=c); req.on("end",()=> { const input=JSON.parse(body); requests++; const tool = input.tools?.find(t => t.function.name === "propose_format_rules"); const hasTool = input.messages.some(m => m.role === "tool"); const delta = hasTool ? { content: "固定服务：候选已提交，等待用户采纳。" } : { tool_calls: [{ index: 0, id: "format-fixture", type: "function", function: { name: tool?.function.name ?? "propose_format_rules", arguments: JSON.stringify({ options: proposedOptions }) } }] }; res.setHeader("Content-Type","text/event-stream"); res.end("data: "+JSON.stringify({choices:[{delta,finish_reason:null}]})+"\n\ndata: "+JSON.stringify({choices:[{delta:{},finish_reason:hasTool?"stop":"tool_calls"}]})+"\n\ndata: [DONE]\n\n"); }); });
await new Promise(r=>server.listen(0,"127.0.0.1",r));
let app;
async function launch(){app=await electron.launch({args:[".","--no-sandbox",`--user-data-dir=${path.join(root,"user-data")}`],env}); const page=await app.firstWindow(); await page.waitForSelector(".bb-shell"); return page;}
async function ready(page){await page.getByRole("button",{name:"导出",exact:true}).waitFor(); await page.waitForFunction(()=>[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="导出"&&!b.disabled));}
async function hashChapters(workspace){const names=(await readdir(path.join(workspace,"chapters"))).sort();return Promise.all(names.map(async name=>createHash("sha256").update(await readFile(path.join(workspace,"chapters",name))).digest("hex")));}
const evidence={passed:false,modelEvidence:"fixed local HTTP/SSE fixture; not a real-model quality evaluation",widths:[375,768,1024,1440]};
try {
 let page=await launch(); const errors=[]; page.on("pageerror",e=>errors.push(e.message));
 await page.getByRole("button",{name:"导入书籍"}).click(); await page.getByRole("button",{name:"创建作品"}).click(); await page.waitForSelector(".bb-book-name");
 const workspace=path.join(booksRoot,(await readdir(booksRoot))[0]); const hashes=await hashChapters(workspace);
 await page.getByLabel("任务范围").selectOption("range"); await page.getByLabel("选择第 3 章").check();
 await page.getByRole("button",{name:"排版",exact:true}).click(); await ready(page);
 await page.getByLabel("首行缩进").selectOption("none"); await page.getByLabel("标题模板").fill("第{number}节 {title}"); await ready(page);
 const preview=await page.getByTestId("format-preview").innerText(); assert.ok(preview.indexOf("第一章")<preview.indexOf("第三章"));assert.ok(!preview.includes("第二章")); evidence.rangeOrder=true;
 await page.getByRole("button",{name:"精校",exact:true}).click(); await page.getByRole("button",{name:"排版",exact:true}).click(); assert.equal(await page.getByLabel("首行缩进").inputValue(),"none"); await ready(page); evidence.modeRetained=true;
 await page.getByRole("button",{name:"保存排版预设"}).click();
 const output=path.join(root,"排版导出.txt"); await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);
 await page.getByRole("button",{name:"导出",exact:true}).click(); await page.getByTestId("message").filter({hasText:"已导出"}).waitFor(); assert.equal((await readFile(output,"utf8")).trim(),preview.trim());evidence.exportMatchesPreview=true;
 await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true});});const before=(await readdir(root)).sort();await page.getByRole("button",{name:"导出",exact:true}).click();await page.getByTestId("message").filter({hasText:"已取消导出"}).waitFor();assert.deepEqual((await readdir(root)).sort(),before);evidence.cancelWroteNothing=true;
 assert.deepEqual(await hashChapters(workspace),hashes); assert.equal(await readFile(fixture,"utf8"),original);evidence.originalHashesUnchanged=true;
 // 标题独立修改使已展示快照过期。
 await page.getByRole("button",{name:"精校",exact:true}).click(); await page.getByRole("button",{name:"重命名"}).click();await page.locator("dialog[open] input").fill("第一章 新标题");await page.getByRole("button",{name:"保存标题"}).click();await page.getByRole("button",{name:"排版",exact:true}).click();await page.getByText("正文、标题、范围或规则已变化",{exact:false}).waitFor();evidence.titleStale=true; await page.getByRole("button",{name:"刷新预览"}).click();await ready(page);
 // 手工配置未触发模型；固定服务提案只有显式采纳才进入表单。
 assert.equal(requests,0); await page.getByRole("button",{name:"模型设置"}).click();await page.getByText("Base URL",{exact:true}).locator("input").fill(`http://127.0.0.1:${server.address().port}/v1`);await page.getByText("模型名",{exact:true}).locator("input").fill("fixture-format");await page.getByText("API Key",{exact:true}).locator("input").fill("fixture-not-a-real-key");await page.getByRole("button",{name:"保存设置"}).click();
 proposedOptions=await page.evaluate(async()=> (await window.desktop.format.getPreset()).data);proposedOptions={...proposedOptions,indent:"fullwidth",paragraphBlankLines:1};await page.getByText("自然语言排版规则",{exact:true}).click();await page.getByLabel("排版要求").fill("首行空两格、段间一空行");await page.getByRole("button",{name:"生成规则提案"}).click();await page.getByTestId("format-proposal").waitFor();assert.equal(await page.getByLabel("首行缩进").inputValue(),"none");await page.getByRole("button",{name:"采纳规则",exact:true}).click();assert.equal(await page.getByLabel("首行缩进").inputValue(),"fullwidth");await page.getByRole("button",{name:"保存排版预设"}).click();await ready(page);evidence.explicitProposalAdoption=true;
 for(const width of evidence.widths){await page.setViewportSize({width,height:960});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width}`);await page.screenshot({path:`artifacts/electron-p2-${width}.png`,fullPage:true});}
 // 导出对话框期间编辑正文：拒绝过期快照，刷新后再输出。
 const frozen=await page.getByTestId("format-preview").innerText(); const frozenFile=path.join(root,"冻结快照.txt");
 await app.evaluate(({dialog})=>{dialog.showSaveDialog=()=>new Promise(resolve=>{globalThis.p2ResolveSave=resolve;globalThis.p2DialogOpen=true;});});
 await page.getByRole("button",{name:"导出",exact:true}).click(); await app.evaluate(async()=>{while(!globalThis.p2DialogOpen)await new Promise(r=>setTimeout(r,10));});
 assert.equal(await page.getByRole("button",{name:"导出中…",exact:true}).isDisabled(),true);evidence.exportPendingDisabled=true;
 await page.getByRole("button",{name:"精校",exact:true}).click();await page.locator(".cm-content").click();await page.keyboard.press("Control+End");await page.keyboard.type("对话框期间新增正文");await page.getByRole("button",{name:"保存正文"}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="save-state"]')?.textContent==="已保存");
 await app.evaluate((_,file)=>globalThis.p2ResolveSave({canceled:false,filePath:file}),frozenFile);await page.getByRole("button",{name:"排版",exact:true}).click();await page.locator(".bb-format-form [role=alert]").waitFor();await assert.rejects(readFile(frozenFile));await page.getByRole("button",{name:"刷新预览"}).click();await ready(page);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},frozenFile);await page.getByRole("button",{name:"导出",exact:true}).click();await page.getByTestId("message").filter({hasText:"已导出"}).waitFor();assert.match(await readFile(frozenFile,"utf8"),/对话框期间新增正文/);evidence.dialogChangeRejectedThenRefreshed=true;
 assert.equal(errors.length,0,errors.join("\n"));await app.close();app=null;page=await launch();await page.waitForSelector(".bb-book-name");await page.getByRole("button",{name:"排版",exact:true}).click();await ready(page);assert.equal(await page.getByLabel("首行缩进").inputValue(),"fullwidth");assert.equal(await page.getByLabel("标题模板").inputValue(),"第{number}节 {title}");evidence.presetReopened=true;

 // 真实 Markdown 导入→预览→带 BOM/CRLF 字节导出，特殊结构保留。
 await app.close();app=null;
 const markdownFixture=path.join(root,"结构保留.md");const markdownSource=["# 第一章 结构","","普通段落。  ","下一行保留硬换行。","","- 列表条目","","[链接](https://example.com)","","[引用][ref]","",'[ref]: https://example.org "来源"',"","\`\`\`js","const value = 1;  ","\`\`\`"].join("\n");
 await writeFile(markdownFixture,markdownSource);env.BOOK_WORKBENCH_TEST_SOURCE=markdownFixture;page=await launch();await page.waitForSelector(".bb-book-name");await page.getByRole("button",{name:"导入",exact:true}).click();await page.getByRole("button",{name:"创建作品"}).click();await page.getByRole("button",{name:"排版",exact:true}).click();await page.getByLabel("输出格式").selectOption("markdown");await page.getByLabel("换行符").selectOption("crlf");await page.getByLabel("UTF-8 编码").selectOption("utf8-bom");await ready(page);
 const mdPreview=await page.getByTestId("format-preview").innerText();const mdFile=path.join(root,"结构输出.md");await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},mdFile);await page.getByRole("button",{name:"导出",exact:true}).click();await page.getByTestId("message").filter({hasText:"已导出"}).waitFor();const mdBytes=await readFile(mdFile);assert.deepEqual([...mdBytes.subarray(0,3)],[239,187,191]);const mdText=mdBytes.subarray(3).toString("utf8");assert.ok(mdText.includes("\r\n"));assert.ok(!mdText.replaceAll("\r\n","").includes("\n"));for(const fragment of ["- 列表条目","[链接](https://example.com)","[引用][ref]",'[ref]: https://example.org "来源"',"\`\`\`js","const value = 1;  ","普通段落。  "]){assert.ok(mdText.includes(fragment),fragment);}assert.equal(mdText.replaceAll("\r\n","\n").trim(),mdPreview.replaceAll("\r\n","\n").trim());assert.equal(await readFile(markdownFixture,"utf8"),markdownSource);evidence.markdownImportedExported=true;evidence.markdownBomCrLf=true;evidence.markdownSpecialStructuresPreserved=true;
 evidence.passed=true;await writeFile("artifacts/electron-p2-test.json",JSON.stringify({...evidence,fixedModelRequests:requests,checkedAt:new Date().toISOString()},null,2));console.log("Electron P2: import/range/preview/export/cancel/stale/preset/proposal passed");
} finally {if(app)await app.close().catch(()=>{});await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}

