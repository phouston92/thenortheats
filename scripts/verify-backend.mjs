import { readdir, stat } from "node:fs/promises";
const packages = await readdir("/app/node_modules/.pnpm");
const forbidden = packages.filter((name) =>
  /expo|react-native|node-forge|braces|sprintf-js|metro|babel|playwright|typescript|tsx@/.test(
    name,
  ),
);
if (process.getuid() === 0 || forbidden.length)
  throw new Error("Runtime isolation failed: " + JSON.stringify(forbidden));
for (const file of [
  "/app/.env",
  "/app/bin/migrate.mjs",
  "/app/migrations",
  "/app/apps/customer-mobile",
  "/app/node_modules/.bin/tsx",
]) {
  try {
    await stat(file);
    throw new Error("Unexpected runtime file: " + file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
console.log(
  JSON.stringify({
    uid: process.getuid(),
    packageStoreEntries: packages.length,
    forbiddenPackages: forbidden,
  }),
);
