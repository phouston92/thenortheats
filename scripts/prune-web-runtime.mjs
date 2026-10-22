import { lstat, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
// Next traces optional config.ts compiler support into its global server trace even
// with route exclusions. This app has JavaScript config and precompiled routes.
// Remove only that build compiler AFTER Next's TypeScript checks/build succeed.
const root = resolve(process.argv[2] || "apps/customer-web/.next/standalone");
let removed = 0;
async function walk(path) {
  for (const name of await readdir(path)) {
    const file = path + "/" + name,
      stat = await lstat(file);
    if (
      (path.endsWith("/node_modules/.pnpm") &&
        name.startsWith("typescript@")) ||
      (path.endsWith("/node_modules") && name === "typescript")
    ) {
      await rm(file, { recursive: true, force: true });
      removed++;
      continue;
    }
    if (stat.isDirectory()) await walk(file);
  }
}
await walk(root);
console.log(
  "Removed optional build-compiler paths from standalone runtime:",
  removed,
);
