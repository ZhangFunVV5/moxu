import type { FormatOptions } from "../../shared/format-options";
import { deriveBlocks } from "../text/structure";
/** Transform only parser-confirmed ordinary paragraphs; keep all gaps and special syntax. */
export function formatMarkdownBody(body:string,o:FormatOptions):string {
 if(o.indent==='custom' && /^[ \t]/.test(o.customPrefix)) throw new Error('Markdown 自定义缩进请使用全角空格，半角缩进会改变代码块语义');
 const blocks=deriveBlocks('markdown',body); let cursor=0,result='';
 for(const b of blocks){
  let gap=body.slice(cursor,b.start);
  if(cursor && /^\n+$/.test(gap) && b.kind==='paragraph' && !result.endsWith('\n')) gap='\n'.repeat(Math.max(2,o.paragraphBlankLines+1));
  result+=gap;
  let text=body.slice(b.start,b.end);
  if(b.kind==='paragraph') {
   // Two trailing spaces are Markdown hard breaks and cannot be trimmed.
   text=text.replace(/^　+/, '');
   if(o.indent==='custom' && o.customPrefix) while(text.startsWith(o.customPrefix)) text=text.slice(o.customPrefix.length);
   const prefix=o.indent==='fullwidth'?'　　':o.indent==='custom'?o.customPrefix:'';
   // ASCII indent prefixes can turn prose into a code block; retain Markdown semantics.
   if(prefix && !/^[ \t]/.test(prefix)) text=prefix+text;
   if(o.trimTrailingWhitespace) text=text.split('\n').map(line=>/ {2,}$/.test(line)?line:line.replace(/[ \t　]+$/,'')).join('\n');
  }
  result+=text;cursor=b.end;
 }
 return result+body.slice(cursor);
}
