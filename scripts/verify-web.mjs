import { readdir, readFile, realpath } from "node:fs/promises";
const seen = new Set(),
  packages = new Set(),
  forbidden = [];
async function walk(path) {
  const resolved = await realpath(path);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  const items = await readdir(path, { withFileTypes: true });
  for (const item of items) {
    const target = path + "/" + item.name;
    if (item.isDirectory() || item.isSymbolicLink()) {
      await walk(target);
    } else if (item.name === "package.json") {
      const data = JSON.parse(await readFile(target, "utf8"));
      if (data.name) {
        packages.add(data.name);
        if (
          /^(expo|react-native|typescript|tsx|vitest|esbuild|node-forge|braces|sprintf-js|@expo\/|@playwright\/)/.test(
            data.name,
          )
        )
          forbidden.push(data.name);
      }
    }
  }
}
await walk("/app");
if (process.getuid() === 0 || forbidden.length)
  throw new Error("Web runtime isolation failed: " + JSON.stringify(forbidden));
console.log(
  JSON.stringify({
    uid: process.getuid(),
    packageNames: packages.size,
    forbiddenPackages: forbidden,
  }),
);
