import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * 测试入口：先用 esbuild CLI 把每个 .test.ts 打包成单个 ESM 文件，再直接 node 运行。
 * 这样不依赖测试运行器的子进程管道（受限环境下 spawn 管道会被拒绝），
 * 每个测试文件仍在独立进程中运行。
 */
const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, ".tmp-test");
const esbuild = path.join(root, "node_modules", "esbuild", "bin", "esbuild");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entries = (await readdir(path.join(root, "tests")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
if (entries.length === 0) {
  console.error("没有找到测试文件");
  process.exit(1);
}

let failed = 0;
for (const name of entries) {
  const bundle = path.join(outDir, name.replace(/\.ts$/, ".mjs"));
  const built = await run(process.execPath, [
    esbuild,
    path.join("tests", name),
    "--bundle",
    "--platform=node",
    "--alias:electron=./tests/electron-stub.ts",
    "--format=esm",
    "--log-level=error",
    `--outfile=${path.relative(root, bundle)}`,
  ]);
  if (built.code !== 0) {
    failed += 1;
    continue;
  }
  const result = await run(process.execPath, [bundle]);
  if (result.code !== 0) failed += 1;
}

if (failed) {
  console.error(`\n${failed} 个测试文件失败`);
  process.exit(1);
}
console.log(`\n${entries.length} 个测试文件全部通过`);
