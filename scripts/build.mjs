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
