import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
if (process.env.DATABASE_URL_FILE) {
  if (process.env.DATABASE_URL)
    throw new Error("Conflicting migration database settings");
  const path = process.env.DATABASE_URL_FILE;
  if (!path.startsWith("/run/secrets/") || path.includes(".."))
    throw new Error("Migration secret must be in /run/secrets");
  process.env.DATABASE_URL = (await readFile(path, "utf8")).trim();
}
if (!process.env.DATABASE_URL) throw new Error("Migration database required");
const child = spawn(process.execPath, ["/app/bin/migrate.mjs"], {
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
process.exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", (code) => resolve(code ?? 1));
});
