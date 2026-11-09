import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, readChapterFile } from '../src/core/workspace/book-store';
import { GenerateService } from '../src/main/services/generate-service';
import { TaskService } from '../src/main/services/task-service';
import type { WorkspaceService } from '../src/main/services/workspace-service';
import { OpenAICompatible } from '../src/agent/model/openai-compatible';
import type { Adapter } from '../src/agent/model/model-adapter';
import { DEFAULT_TITLE_OPTIONS, DEFAULT_SUMMARY_OPTIONS } from '../src/shared/generate';
import type { GenerateStartRequest, GenerateEventDto } from '../src/shared/generate-contracts';
import { titleProfile } from '../src/agent/prompts/title';
import { summaryProfile } from '../src/agent/prompts/summary';

// This script records actual outputs. Semantic review is written separately after inspection.
const csvText=await fs.readFile('docs/deepseek official api.csv','utf8');
const csv=Object.fromEntries(csvText.replace(/^\uFEFF/,'').trim().split(/\r?\n/).slice(1).map(line=>{
  const cells=(line.match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g)??[]).filter(Boolean).map(cell=>cell.replace(/,$/,'').replace(/^"|"$/g,'').replace(/""/g,'"').trim());
  return [cells[0],cells[1]];
}));
if(!csv.apiKey||!csv.openAiCompatible||!csv.model) throw new Error('缺少真实模型配置');
const previous=JSON.parse(await fs.readFile('artifacts/proofread-eval.json','utf8')) as {inputs:Array<{id:string;body:string}>};
const reused=previous.inputs.filter(sample=>['S02','S06','S08','S10'].includes(sample.id));
const reveal='沈舟收到一封没有署名的信，信里约他傍晚到旧车站。他把信放进衣袋，沿着河边步行，经过关门的茶铺和正在修理的木桥。阿箬在桥头等他，只说旧车站有人留下了东西。两人没有交谈，继续往车站走。候车室的钟停在三点，长椅上摆着一只旧木盒。沈舟先查看盒盖上的划痕，阿箬则站在门口留意来路。沈舟打开木盒，里面没有钱，只有一张父亲年轻时的合照。照片背面写着当天的日期。阿箬这才承认，信是她写的，木盒也是她从沈舟父亲的旧屋里找到的。沈舟把照片收好，没有追问，两人带着木盒离开车站。';
const longBody='开头：沈舟在车站找到一把铜钥匙，决定交给失主。\n'+('沈舟沿河寻找失主，经过石桥、茶铺和码头。他向路人打听铜钥匙的来历，没有得到确切回答。\n'.repeat(75))+'中段：茶铺老板认出钥匙属于旧仓库，建议他去找守门人。\n'+('沈舟走到旧仓库外，耐心等候守门人回来。他没有进入仓库，也没有使用钥匙。\n'.repeat(75))+'结尾：守门人回来，确认钥匙是自己的，向沈舟道谢并收回铜钥匙。';
const samples=[...reused.map(x=>({...x,summaryOptions:{minLength:15,maxLength:100}})),{id:'reveal',body:reveal,summaryOptions:DEFAULT_SUMMARY_OPTIONS},{id:'long',body:longBody,summaryOptions:DEFAULT_SUMMARY_OPTIONS}];
const root=await fs.mkdtemp(path.join(os.tmpdir(),'generate-eval-'));
const results:unknown[]=[];
for(const sample of samples){
  const workspace=await createWorkspace({root:path.join(root,sample.id),bookTitle:`生成评估 ${sample.id}`,format:'txt',source:{fileName:`${sample.id}.txt`,bytes:new TextEncoder().encode(sample.body),encoding:'utf-8',eol:'lf'},importSettings:{splitMode:'single',paragraphMode:'line',headingLevel:0,boundaries:[0]},chapters:[{title:'第一章 原标题',body:sample.body,kind:'chapter'}]});
  const chapter=workspace.chapterFiles[0];
  const workspaceService={currentWorkspace:()=>workspace,updateChapterCache:(next:typeof chapter)=>{workspace.chapterFiles[0]=next;}} as unknown as WorkspaceService;
  const usages:unknown[]=[];
  const base=new OpenAICompatible({baseUrl:csv.openAiCompatible,model:csv.model,apiKey:csv.apiKey,temperature:0.2,stream:true});
  const adapter:Adapter={async complete(...args){const response=await base.complete(...args);if(response.usage) usages.push(response.usage);return response;}};
  const service=new GenerateService(workspaceService,new TaskService(workspaceService),async()=>adapter,async()=>csv.model);
  const requests:GenerateStartRequest[]=[{kind:'title',chapterIds:[chapter.chapterId],options:DEFAULT_TITLE_OPTIONS},{kind:'summary',chapterIds:[chapter.chapterId],options:sample.summaryOptions}];
  if(sample.id==='reveal') requests.push({kind:'title',chapterIds:[chapter.chapterId],options:{...DEFAULT_TITLE_OPTIONS,allowSpoilers:true,style:'直白纪实'}});
  for(const request of requests){
    const started=Date.now();
    const events:GenerateEventDto[]=[];
    let done!:(event:GenerateEventDto)=>void;
    const completion=new Promise<GenerateEventDto>(resolve=>{done=resolve;});
    const off=service.onEvent(event=>{events.push(event);if(event.type==='taskStateChanged'&&['completed','failed','cancelled'].includes(event.state??'')) done(event);});
    let state='failed';let error:string|undefined;
    try{await service.start(request);const end=await completion;state=end.state??'failed';if(state!=='completed')error=end.message;}catch(caught){error=caught instanceof Error?caught.message:String(caught);}finally{off();}
    const view=await service.chapter({chapterId:chapter.chapterId});
    const current=await readChapterFile(workspace.root,workspace.book,chapter.chapterId);
    results.push({sampleId:sample.id,kind:request.kind,options:request.options,state,error,durationMs:Date.now()-started,bodyUnchanged:current.bodyHash===chapter.bodyHash,artifacts:view.artifacts.filter(item=>item.kind===request.kind),events:events.filter(item=>item.type!=='text'),usage:usages.splice(0)});
    console.log(`${sample.id} ${request.kind} ${'allowSpoilers' in request.options?request.options.allowSpoilers:''}: ${state}`);
  }
  await fs.mkdir('artifacts',{recursive:true});
  await fs.writeFile('artifacts/generate-eval.json',JSON.stringify({generatedAt:new Date().toISOString(),model:csv.model,temperature:0.2,profiles:{title:titleProfile,summary:summaryProfile},inputs:samples,results,review:'参见 generate-eval.md 中基于实际输出的人工语义审查；结构校验不等于语义正确'},null,2));
}
if((results as Array<{state:string}>).some(result=>result.state!=='completed')) process.exitCode=1;
