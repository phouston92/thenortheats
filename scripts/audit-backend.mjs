import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const path = await mkdtemp(join(tmpdir(), "north-runtime-audit-"));
function run(args, cwd) {
  const result = spawnSync("pnpm", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
try {
  const deploy = run(
    ["--filter", "@north/api", "deploy", "--prod", path],
    process.cwd(),
  );
  process.exitCode =
    deploy || run(["audit", "--prod", "--audit-level", "high"], path);
} finally {
  await rm(path, { recursive: true, force: true });
}
