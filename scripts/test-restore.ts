import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../packages/database/src/index";
const source = process.env.TEST_DATABASE_URL;
if (
  !source ||
  !/^[A-Za-z0-9_]+_test$/.test(new URL(source).pathname.slice(1)) ||
  !["localhost", "127.0.0.1"].includes(new URL(source).hostname)
)
  throw new Error("Loopback dedicated *_test database required");
const url = new URL(source),
  db = connect(source),
  name = "north_" + randomBytes(8).toString("hex") + "_restore_test",
  dir = await mkdtemp(join(tmpdir(), "north-restore-"));
const env = {
  ...process.env,
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
};
function command(
  script: "backup" | "restore",
  service: string,
  confirmed: boolean,
  expected = 0,
) {
  const r = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network=host",
      "--entrypoint",
      "bash",
      "-e",
      "PGUSER",
      "-e",
      "PGPASSWORD",
      "-e",
      "PGSERVICE=" + service,
      "-e",
      "PGSERVICEFILE=/backup/services.conf",
      ...(confirmed
        ? ["-e", "RESTORE_CONFIRMATION=restore-into-empty-database"]
        : []),
      "-v",
      dir + ":/backup",
      "-v",
      process.cwd() + "/scripts/operations:/ops:ro",
      "postgres:17.7-alpine",
      "/ops/" + script + ".sh",
      "/backup/financial.dump",
    ],
    { env, stdio: "inherit" },
  );
  if (r.status !== expected)
    throw new Error("Backup/restore or safety guard failed");
}
async function inventory(conn: ReturnType<typeof connect>) {
  const [row] =
    await conn`SELECT (SELECT count(*)::int FROM schema_migrations) AS migrations,(SELECT count(*)::int FROM orders) AS orders,(SELECT count(*)::int FROM refunds) AS refunds,(SELECT count(*)::int FROM provider_events) AS events,(SELECT count(*)::int FROM provider_balances) AS balances,(SELECT md5(string_agg(reference||':'||amount::text,',' ORDER BY reference)) FROM ledger_entries) AS ledger_digest,(SELECT md5(string_agg(name||checksum,',' ORDER BY name)) FROM schema_migrations) AS migration_digest`;
  return row;
}
let created = false;
try {
  await writeFile(
    join(dir, "services.conf"),
    `[source]\nhost=127.0.0.1\nport=${url.port || 5432}\ndbname=${url.pathname.slice(1)}\n[restore]\nhost=127.0.0.1\nport=${url.port || 5432}\ndbname=${name}\n`,
    { mode: 0o600 },
  );
  const before = await inventory(db);
  command("backup", "source", false);
  command("backup", "source", false, 2);
  await db.unsafe(`CREATE DATABASE ${name}`);
  created = true;
  command("restore", "restore", false, 2);
  command("restore", "source", true, 2);
  command("restore", "restore", true);
  const restoredUrl = new URL(source);
  restoredUrl.pathname = "/" + name;
  const restored = connect(restoredUrl.toString());
  try {
    if (JSON.stringify(await inventory(restored)) !== JSON.stringify(before))
      throw new Error("Restored inventory or immutable ledger digest mismatch");
  } finally {
    await restored.end();
  }
  command("restore", "restore", true, 2);
  console.log(
    "PostgreSQL 17 backup/restore scripts passed: checksums, financial inventory and ledger digest match; overwrite, confirmation, target-name and nonempty-target guards passed.",
  );
} finally {
  if (created) await db.unsafe(`DROP DATABASE ${name}`);
  await db.end();
  await rm(dir, { recursive: true, force: true });
}
