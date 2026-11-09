import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultFormatOptions as defaults,formatOptionsSchema} from '../src/shared/format-options';
import {formatTxtBody} from '../src/core/format/txt-formatter';
import {formatMarkdownBody} from '../src/core/format/markdown-formatter';
import {formatBook,encodeFormatted} from '../src/core/format/format-book';
import {dispatch,formatRulesProfile,type Context,visibleTools} from '../src/agent/tools/dispatcher';
import {run} from '../src/agent/runtime/loop';
import type {ChapterFile} from '../src/shared/book';
import {mkdtemp,mkdir,symlink,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {canonicalExportPath,isProtectedWorkspacePath} from '../src/core/format/export-path';
test('规则拒绝未知能力、路径、危险前缀与模板',()=>{
 for(const options of [{...defaults,path:'C:/x'},{...defaults,headingTemplate:'{unknown}'},{...defaults,paragraphBlankLines:1.5},{...defaults,customPrefix:'沈'},{...defaults,customPrefix:'1. '}])assert.equal(formatOptionsSchema.safeParse(options).success,false);
 assert.equal(formatOptionsSchema.safeParse(defaults).success,true);
});
test('TXT 保留诗歌硬换行、分隔符、标点与emoji；幂等不累加缩进',()=>{
 const o={...defaults,paragraphMode:'blank' as const};
 const source='诗句一😀\n诗句二！\n\n***\n\n　　人物说：“别改标点。”  ';
 const text=formatTxtBody(source,o);
 assert.ok(text.includes('诗句一😀\n诗句二！'));assert.ok(text.includes('\n\n***\n\n'));assert.ok(text.includes('人物说：“别改标点。”'));
 assert.equal(formatTxtBody(text,o),text);
});
test('Markdown 特殊块、引用定义、硬换行与内联语法保真并幂等',()=>{
 const source='开头 [链接][ref]  \n次行 \n\n```js\nconst x = 1;  \n```\n\n- 列表  \n  续行\n\n> 引用  \n\n<div>HTML  </div>\n\n[ref]: https://example.com/path\n';
 const text=formatMarkdownBody(source,defaults);
 for(const value of ['[链接][ref]  \n','```js\nconst x = 1;  \n```','- 列表  \n  续行','> 引用  ','<div>HTML  </div>','[ref]: https://example.com/path'])assert.ok(text.includes(value),value);
 assert.ok(text.includes('次行\n'));assert.equal(formatMarkdownBody(text,defaults),text);
});
test('输出字节按BOM/CRLF；标题特殊替换字符保持原文，事实源不改',()=>{
 const chapter={chapterId:'c1',order:0,kind:'chapter',title:{current:'$& {number} 序章',source:'原题'},body:'正文😀'} as ChapterFile;
 const before=structuredClone(chapter);const o={...defaults,eol:'crlf' as const,encoding:'utf8-bom' as const,headingTemplate:'第{number}章 {title}'};
 const text=formatBook([chapter],'txt','txt',o);
 assert.ok(text.startsWith('第1章 $& {number} 序章\r\n'));assert.ok(!/(?<!\r)\n/.test(text));assert.deepEqual([...encodeFormatted(text,o).slice(0,3)],[239,187,191]);assert.deepEqual(chapter,before);
});
function context():Context{return {workspaceId:'workspace',chapterIds:['c1'],source:'agent',allowWrite:false,version:1,format:{validate:async()=>true,execute:async()=>({pending:true})}};}
test('Dispatcher 拒绝模型写入、路径、范围扩张与过期输入',async()=>{
 const c=context();
 assert.equal((await dispatch('propose_format_rules',{options:defaults,path:'x'},c,formatRulesProfile)).ok,false);
 assert.equal((await dispatch('propose_format_rules',{options:defaults,chapterIds:['c2']},c,formatRulesProfile)).ok,false);
 assert.equal((await dispatch('export_book',{},c,{...formatRulesProfile,tools:['export_book']})).ok,false);
 c.format!.validate=async()=>false;
 const stale=await dispatch('propose_format_rules',{options:defaults},c,formatRulesProfile);assert.ok(!stale.ok && stale.error.code==='VERSION_MISMATCH');
 assert.equal(visibleTools(formatRulesProfile).length,1);
});
test('规则 Profile 复用 Runtime：缺产物不能完成，有候选仍只待确认',async()=>{
 await assert.rejects(run({complete:async()=>({content:'已完成',calls:[],finishReason:'stop'})},formatRulesProfile,context(),'需求',new AbortController().signal,()=>{}),/未提交有效规则/);
 let round=0,submitted=0;const c=context();c.format!.execute=async()=>{submitted++;return {status:'pending-review'};};
 const result=await run({complete:async(messages)=>{if(round++){assert.equal(messages.at(-1)?.role,'tool');return {content:'请确认候选规则',calls:[],finishReason:'stop'};}return {content:'',calls:[{id:'proposal',type:'function',function:{name:'propose_format_rules',arguments:JSON.stringify({options:defaults})}}],finishReason:'tool_calls'};}},formatRulesProfile,c,'首行空两格',new AbortController().signal,()=>{});
 assert.equal(submitted,1);assert.equal(result.feedback,'请确认候选规则');
});
test('未知能力与澄清回复保持NO_ARTIFACT并展示模型解释',async()=>{
 for(const content of ['暂不支持标点转换。','标题需要使用哪种模板？']) {
  await assert.rejects(run({complete:async()=>({content,calls:[],finishReason:'stop'})},formatRulesProfile,context(),'需求',new AbortController().signal,()=>{}),error=>error instanceof Error && 'code' in error && error.code==='NO_ARTIFACT' && error.message.includes(content));
 }
});
test('自定义半角缩进可用于TXT，Markdown全部核心入口明确拒绝',()=>{
 const options={...defaults,indent:'custom' as const,customPrefix:'  '};
 assert.equal(formatTxtBody('正文',options),'  正文');
 assert.throws(()=>formatMarkdownBody('正文',options),/半角缩进会改变代码块语义/);
 assert.throws(()=>formatBook([{order:0,kind:'chapter',title:{current:'章'},body:'正文'} as ChapterFile],'markdown','markdown',options),/半角缩进会改变代码块语义/);
 assert.throws(()=>formatBook([{order:0,kind:'chapter',title:{current:'章'},body:'正文'} as ChapterFile],'txt','markdown',options),/半角缩进会改变代码块语义/);
});

test('混合半全角自定义TXT缩进保持幂等',()=>{
 for(const customPrefix of ['　 ',' 　','　　 ']) {
  const options={...defaults,indent:'custom' as const,customPrefix};
  const once=formatTxtBody('正文',options);
  assert.equal(formatTxtBody(once,options),once);
 }
});

test('TXT转Markdown仍保留独立段落和章节边界',()=>{
 const chapters=[{order:0,kind:'chapter',title:{current:'一'},body:'段一\n段二'},{order:1,kind:'chapter',title:{current:'二'},body:'段三'}] as ChapterFile[];
 const text=formatBook(chapters,'txt','markdown',{...defaults,paragraphBlankLines:0,headingBlankLinesBefore:0});
 assert.ok(text.includes('段一\n\n　　段二'));
 assert.ok(text.includes('段二\n\n# 二'));
});

test('导出路径保护解析不存在目标的symlink祖先，并允许output',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'format-export-'));
 try {
  const chapters=path.join(root,'chapters');await mkdir(chapters);
  const alias=path.join(root,'alias');await symlink(chapters,alias,process.platform==='win32'?'junction':'dir');
  const target=await canonicalExportPath(path.join(alias,'new','book.md'));
  assert.equal(target,path.join(await canonicalExportPath(chapters),'new','book.md'));
  assert.equal(isProtectedWorkspacePath(root,target),true);
  assert.equal(isProtectedWorkspacePath(root,path.join(root,'..hidden','book.md')),true);
  assert.equal(isProtectedWorkspacePath(root,path.join(root,'output','book.md')),false);
  assert.equal(isProtectedWorkspacePath(root,path.join(root,'..','book.md')),false);
 } finally {await rm(root,{recursive:true,force:true});}
});
