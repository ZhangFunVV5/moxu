import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * 真实模型评估入口：先用 esbuild 打包 TS，再用 node 运行。
 * 需要 docs/deepseek official api.csv 中的兼容服务配置；密钥不写入产物。
 */
const root = process.cwd();
const outDir = path.join(root, ".tmp-test");
await mkdir(outDir, { recursive: true });
const bundle = path.join(outDir, "proofread-eval.mjs");
const esbuild = path.join(root, "node_modules", "esbuild", "bin", "esbuild");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

const built = await run(process.execPath, [
  esbuild,
  path.join("scripts", "proofread-eval.ts"),
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--log-level=error",
  `--outfile=${path.relative(root, bundle)}`,
]);
if (built !== 0) process.exit(built);
const exitCode = await run(process.execPath, [bundle]);
process.exit(exitCode);
