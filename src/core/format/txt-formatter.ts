import type { FormatOptions } from "../../shared/format-options";
import { deriveBlocks } from "../text/structure";
export function indentParagraph(text:string,o:FormatOptions):string {
 const prefix=o.indent==='fullwidth'?'　　':o.indent==='custom'?o.customPrefix:'';
 let value=text.replace(o.indent==='custom'?/^[ 　]+/:/^　+/, '');
 if(o.indent==='custom' && o.customPrefix) while(value.startsWith(o.customPrefix)) value=value.slice(o.customPrefix.length);
 if(o.trimTrailingWhitespace) value=value.split('\n').map(l=>l.replace(/[ \t　]+$/,'')).join('\n');
 return prefix+value;
}
export function formatTxtBody(body:string,o:FormatOptions):string {
 return deriveBlocks('txt',body,o.paragraphMode).map(b=>b.kind==='paragraph'?indentParagraph(body.slice(b.start,b.end),o):body.slice(b.start,b.end)).join('\n'.repeat(o.paragraphBlankLines+1));
}
