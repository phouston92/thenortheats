import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { connect, type Database } from "./index";
export async function migrate(db: Database) {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(874123)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(`${dir}/${name}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const [old] =
        await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
      if (old) {
        if (old.checksum !== checksum)
          throw new Error("Migration checksum mismatch: " + name);
        continue;
      }
      await tx.unsafe(sql);
      await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${checksum})`;
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = connect();
  try {
    await migrate(db);
    console.log("Migrations applied");
  } finally {
    await db.end();
  }
}
