import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此发布入口要求 Windows x64');
const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// A fresh output avoids accidentally retaining files from an earlier release.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `BookWorkbench-${pkg.version}-win-x64`;
const release = path.join(root, 'release', stamp);
const folder = path.join(release, name);
await mkdir(release, { recursive: true });
await cp(path.join(root, 'node_modules/electron/dist'), folder, { recursive: true });
await rename(path.join(folder, 'electron.exe'), path.join(folder, 'BookWorkbench.exe'));
const appRoot = path.join(folder, 'resources', 'app');
await mkdir(appRoot, { recursive: true });
// Explicit source allowlist: no repository, credentials, tests, books or userData.
for (const entry of ['dist', 'dist-electron']) {
  await cp(path.join(root, entry), path.join(appRoot, entry), { recursive: true });
}
await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version,
  type: 'module', main: pkg.main, description: 'TXT / Markdown 书籍工作台',
}, null, 2));
await cp(path.join(root, 'docs/user-guide.md'), path.join(folder, '使用说明.md'));
await writeFile(path.join(folder, 'README.md'), `# 书籍工作台 ${pkg.version}\n\n完整解压后运行 BookWorkbench.exe；无需 Node、npm 或开发服务器。\n\n操作步骤、工作区位置、模型配置与恢复说明见 [使用说明](使用说明.md)。\n`);
const zip = path.join(release, `${name}.zip`);
const ps = '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:BW_PACKAGE_FOLDER, $env:BW_PACKAGE_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)';
await new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, BW_PACKAGE_FOLDER: folder, BW_PACKAGE_ZIP: zip },
  });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ZIP failed: ${code}`)));
});
// A sandboxed build workspace may tag generated files Low mandatory level; Chromium's
// sandbox then fails when the exe is started in place. ACLs are not stored in the ZIP,
// but normalize the unpacked folder so double-clicking BookWorkbench.exe also works.
await new Promise(resolve => {
  const child = spawn('icacls', [folder, '/setintegritylevel', '(OI)(CI)Medium', '/T', '/C'], { windowsHide: true, stdio: 'ignore' });
  child.on('error', resolve);
  child.on('exit', () => resolve());
});
const bytes = await readFile(zip);
const manifest = { version: pkg.version, platform: 'win32-x64', folder, zip, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
await writeFile(path.join(release, 'manifest.json'), JSON.stringify(manifest, null, 2));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
await writeFile(path.join(root, 'artifacts/package-win.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
