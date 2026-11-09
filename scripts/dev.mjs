import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";
import { build } from "esbuild";
await build({
  entryPoints: ["src/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["electron"],
  outfile: "dist-electron/main/index.js",
});
await build({
  entryPoints: ["src/preload/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist-electron/preload/index.cjs",
});
const server = await createServer({
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
await server.listen();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", "--dev"], {
  stdio: "inherit",
  env,
  windowsHide: true,
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
process.on("SIGINT", () => child.kill());
