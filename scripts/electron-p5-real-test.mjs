import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

// Local, explicitly configured compatible service. Never print or persist credentials.
const csv = (await readFile('docs/deepseek official api.csv', 'utf8')).replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1);
const config = Object.fromEntries(csv.map(line => {
  const cells = (line.match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g) ?? []).filter(Boolean)
    .map(cell => cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  return [cells[0], cells[1]];
}));
if (!config.apiKey || !config.openAiCompatible || !config.model) throw new Error('真实模型配置缺失');
await mkdir('.tmp-p5-electron', { recursive: true });
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.join(path.resolve('.tmp-p5-electron'), 'real-'));
const source = path.join(root, '真实链路样本.txt');
const long = '沈舟在码头捡到一本旧账册。他没有翻动账册，而是坐在茶棚旁等候失主。茶棚老板递给他一杯温水，告诉他船工们天亮以后才会回来。\n'.repeat(105);
const original = `第一章 错字\n沈舟指着稿纸上的错宁，皱了皱眉。\n最新地址：https://promo.example.com/txt 请收藏本站\n\n第二章 归还\n阿箬把钥匙交还给守门人。守门人道谢后关上门，两人沿河回家。\n\n第三章 账册\n${long}天亮以后，一位老船工来找账册。沈舟问清了账册的颜色和封皮上的名字，把它交还给老船工。`;
await writeFile(source, original);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { ...process.env, BOOK_WORKBENCH_ROOT: path.join(root, 'books'), BOOK_WORKBENCH_TEST_SOURCE: source };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', '--no-sandbox', `--user-data-dir=${path.join(root, 'userdata')}`], env });
const started = Date.now();
const evidence = { passed: false, model: config.model, temperature: 0.2, stream: false, sourceChars: [...original].length, longChapterChars: [...long].length, modelEvidence: 'Actual configured compatible service in Electron, synthetic public fixture', outputs: [], usage: [] };
function unwrap(r) { if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`); return r.data; }
try {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '导入书籍' }).click();
  await page.getByRole('button', { name: '创建作品' }).click();
  await page.waitForSelector('.bb-book-name');
  unwrap(await page.evaluate(value => window.desktop.saveConfig(value), { baseUrl: config.openAiCompatible, model: config.model, apiKey: config.apiKey, temperature: 0.2, stream: false }));
  const workspace = unwrap(await page.evaluate(() => window.desktop.workspace.state()));
  assert.equal(workspace.chapterOrder.length, 3);
  await page.evaluate(() => {
    window.__p5Usage = [];
    const collect = event => { if (event.message?.startsWith('模型实际 usage：')) window.__p5Usage.push(JSON.parse(event.message.slice('模型实际 usage：'.length))); };
    window.desktop.proofread.onEvent(collect);
    window.desktop.generate.onEvent(collect);
  });
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path.join(root, '成稿.txt'));
  const record = unwrap(await page.evaluate(chapterIds => window.desktop.pipeline.start({
    chapterIds,
    proofread: { categories: ['typo', 'advertisement'], glossary: ['沈舟', '阿箬'], userRequest: '只纠正确定的错字，保留故事文字和重复叙述。', ruleVersion: 'proofread-rules-v1', profileVersion: 'proofread-profile-v1', blockBudget: { maxChars: 6000, maxParagraphs: 200, contextParagraphs: 1 }, autoApplyCategories: [] },
    title: { minLength: 2, maxLength: 12, candidateCount: 3, style: '贴合原文', allowSpoilers: false },
    summary: { minLength: 15, maxLength: 120 },
    format: { outputFormat: 'txt', options: { headingTemplate: '{title}', indent: 'fullwidth', customPrefix: '', paragraphBlankLines: 1, headingBlankLinesBefore: 1, headingBlankLinesAfter: 1, trimTrailingWhitespace: true, eol: 'lf', encoding: 'utf8', paragraphMode: 'line' } }, export: true,
  }), workspace.chapterOrder));
  async function waitState(target) {
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const records = unwrap(await page.evaluate(() => window.desktop.pipeline.list()));
      const current = records.find(item => item.pipelineId === record.pipelineId);
      if (current?.state === target) return current;
      if (['failed', 'cancelled'].includes(current?.state)) throw new Error(current.error || current.state);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`等待 ${target} 超时`);
  }
  await waitState('waiting-review');
  for (const chapterId of workspace.chapterOrder) {
    let view = unwrap(await page.evaluate(chapterId => window.desktop.proofread.chapter({ chapterId }), chapterId));
    const decisions = [];
    for (const issue of view.issues.filter(issue => issue.decision === 'pending' && issue.validity === 'valid')) {
      const knownTypo = issue.before.includes('错宁') || (issue.category === 'typo' && issue.before === '宁' && issue.after === '字');
      const action = issue.category === 'advertisement' || knownTypo ? 'accept' : 'ignore';
      decisions.push({ before: issue.before, after: issue.after, category: issue.category, action });
      view = unwrap(await page.evaluate(request => window.desktop.proofread.apply(request), { chapterId, batchId: view.batchId, operationId: crypto.randomUUID(), kind: action, commands: [{ patchId: issue.patchId, action }], reviewRevision: view.reviewRevision, expectedHeadHash: view.expectedHeadHash }));
    }
    evidence.outputs.push({ chapterId, decisions, reviewedBodyHash: view.expectedHeadHash });
  }
  unwrap(await page.evaluate(pipelineId => window.desktop.pipeline.resume({ pipelineId, continueWithPending: true }), record.pipelineId));
  evidence.pipeline = await waitState('completed');
  const output = await readFile(path.join(root, '成稿.txt'), 'utf8');
  assert.ok(!output.includes('错宁'));
  assert.ok(!output.includes('promo.example.com'));
  for (const chapterId of workspace.chapterOrder) {
    const view = unwrap(await page.evaluate(chapterId => window.desktop.generate.chapter({ chapterId }), chapterId));
    const result = evidence.outputs.find(item => item.chapterId === chapterId);
    result.artifacts = view.artifacts;
    assert.ok(view.artifacts.some(item => item.kind === 'summary'));
    assert.ok(view.artifacts.some(item => item.kind === 'title'));
    assert.ok(view.artifacts.every(item => !item.stale && item.sourceBodyHash === result.reviewedBodyHash));
  }
  const checkpointFiles = evidence.pipeline.stages.filter(stage => stage.taskId);
  for (const stage of checkpointFiles) {
    const spec = JSON.parse(await readFile(path.join(workspace.root, 'tasks', stage.taskId, 'task-spec.json'), 'utf8'));
    evidence[`${stage.kind}Profile`] = spec.profileVersion;
  }
  await app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, path.join(root, '精校报告.txt'));
  unwrap(await page.evaluate(chapterIds => window.desktop.proofread.exportReport({ chapterIds }), workspace.chapterOrder));
  const report = await readFile(path.join(root, '精校报告.txt'), 'utf8');
  assert.ok(report.includes('错宁'));
  assert.equal(sha(await readFile(source)), sha(Buffer.from(original)));
  evidence.sourceUnchanged = true;
  evidence.usage = await page.evaluate(() => window.__p5Usage);
  evidence.exportSha256 = sha(Buffer.from(output));
  evidence.reportSha256 = sha(Buffer.from(report));
  // Measure renderer responsiveness on a sizeable local editing/format operation.
  evidence.rendererHeartbeat = await page.evaluate(async () => {
    const t = performance.now(); let frames = 0;
    await new Promise(resolve => { function tick() { frames++; if (performance.now() - t < 350) requestAnimationFrame(tick); else resolve(); } requestAnimationFrame(tick); });
    return { frames, elapsedMs: performance.now() - t };
  });
  await page.screenshot({ path: 'artifacts/electron-p5-real-model.png', fullPage: true });
  evidence.passed = true;
} finally {
  evidence.durationMs = Date.now() - started;
  await writeFile('artifacts/electron-p5-real-model.json', JSON.stringify(evidence, null, 2));
  await app.close();
}
console.log(JSON.stringify({ passed: evidence.passed, model: evidence.model, durationMs: evidence.durationMs, sourceChars: evidence.sourceChars }));
