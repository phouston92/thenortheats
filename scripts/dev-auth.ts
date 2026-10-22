import { tmpdir } from "node:os";
import { readdir, readFile } from "node:fs/promises";
import { connect } from "../packages/database/src/index";
import { decryptMfa } from "../apps/api/src/mfa";
import { TOTP, Secret } from "otpauth";
if (process.env.NODE_ENV !== "development")
  throw new Error("Private development helper only");
if (process.argv[2] === "mfa") {
  const db = connect();
  try {
    const [row] =
      await db`SELECT u.id,m.secret_ciphertext FROM users u JOIN admin_mfa m ON m.user_id=u.id WHERE u.email=${process.env.SEED_ADMIN_EMAIL || "admin@example.test"}`;
    if (!row) throw new Error("Administrator not enrolled; see pnpm admin:mfa");
    console.log(
      new TOTP({
        secret: Secret.fromBase32(decryptMfa(row.secret_ciphertext, row.id)),
      }).generate(),
    );
  } finally {
    await db.end();
  }
} else {
  const dir =
    process.env.DEV_MAIL_DIR ||
    `${tmpdir()}/north-mail-${process.getuid?.() ?? "dev"}`;
  const files = await readdir(dir);
  const messages = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"))),
  );
  for (const m of messages)
    console.log(`${m.email} | challenge ${m.challengeId} | code ${m.code}`);
}
