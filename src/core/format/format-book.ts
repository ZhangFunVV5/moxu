import type { ChapterFile, BodyFormat } from "../../shared/book";
import { formatOptionsSchema, type FormatOptions } from "../../shared/format-options";
import { formatTxtBody } from "./txt-formatter";
import { formatMarkdownBody } from "./markdown-formatter";
/** 文本导出：正文表示决定如何派生段落；EPUB 导出走独立构建器，不经本函数。 */
export function formatBook(chapters:readonly ChapterFile[],sourceFormat:BodyFormat,outputFormat:BodyFormat,options:FormatOptions):string {
 const o=formatOptionsSchema.parse(options);
 if(outputFormat==='markdown' && o.indent==='custom' && /^[ \t]/.test(o.customPrefix)) throw new Error('Markdown 自定义缩进请使用全角空格，半角缩进会改变代码块语义');
 const parts=chapters.map(c=>{
  const title=o.headingTemplate.replace(/\{(title|number)\}/g,(_match,key:string)=>key==='title'?c.title.current:String(c.order+1));
  const heading=outputFormat==='markdown'?`# ${title.replace(/^#+\s*/, '')}`:title;
  const body=sourceFormat==='markdown'?formatMarkdownBody(c.body,o):formatTxtBody(c.body,outputFormat==='markdown'?{...o,paragraphBlankLines:Math.max(1,o.paragraphBlankLines)}:o);
  return (c.kind==='frontmatter'?'':heading+'\n'.repeat(o.headingBlankLinesAfter+1))+body;
 });
 const text=parts.join('\n'.repeat((outputFormat==='markdown'?Math.max(1,o.headingBlankLinesBefore):o.headingBlankLinesBefore)+1)).replace(/\n+$/,'')+'\n';
 return o.eol==='crlf'?text.replace(/\r?\n/g,'\r\n'):text;
}
export function encodeFormatted(text:string,o:FormatOptions):Uint8Array {return Buffer.from((o.encoding==='utf8-bom'?'\uFEFF':'')+text,'utf8');}
