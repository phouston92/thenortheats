import { build } from "esbuild";
// Bundle local TypeScript only. Runtime packages are installed from the API importer.
await build({
  entryPoints: {
    api: "apps/api/src/server.ts",
    worker: "apps/worker/src/index.ts",
  },
  outdir: "dist/backend",
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node24",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  metafile: true,
}).then(async (result) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    "dist/backend/metafile.json",
    JSON.stringify(result.metafile, null, 2),
  );
});
