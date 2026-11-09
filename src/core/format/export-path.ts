import path from 'node:path';
import {realpath} from 'node:fs/promises';

/** Resolve existing ancestors too: a new output file may sit beneath a symlink. */
export async function canonicalExportPath(target:string):Promise<string> {
 try { return await realpath(target); }
 catch(error) {
  if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  const parent=path.dirname(target);
  if(parent===target) throw error;
  return path.join(await canonicalExportPath(parent),path.basename(target));
 }
}

export function isProtectedWorkspacePath(root:string,target:string):boolean {
 const relative=path.relative(root,target);
 const outside=relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative);
 return !outside && !relative.startsWith(`output${path.sep}`);
}
