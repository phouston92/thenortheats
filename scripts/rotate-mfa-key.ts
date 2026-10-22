import { connect, type Database } from "../packages/database/src/index";
import { decryptMfa, encryptMfa } from "../apps/api/src/mfa";
import { mfaKeys } from "../packages/config/src/mfa-keys";
import { fileURLToPath } from "node:url";
export async function rotateMfaKey(db: Database) {
  const { active } = mfaKeys();
  if (!active) throw new Error("A named active MFA key is required");
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(874126)`;
    const rows = await tx`SELECT * FROM admin_mfa FOR UPDATE`;
    let count = 0;
    for (const row of rows) {
      if (row.secret_ciphertext.startsWith("v1:" + active + ":")) continue;
      await tx`UPDATE admin_mfa SET secret_ciphertext=${encryptMfa(decryptMfa(row.secret_ciphertext, row.user_id), row.user_id)},updated_at=now() WHERE user_id=${row.user_id}`;
      count++;
    }
    await tx`DELETE FROM mfa_rotations`;
    await tx`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='admin')`;
    await tx`INSERT INTO audit_logs(action,subject) VALUES('auth.mfa.encryption_key_rotated',${JSON.stringify({ keyId: active, rows: count })})`;
    return count;
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = connect();
  try {
    console.log("Re-encrypted administrator records:", await rotateMfaKey(db));
  } finally {
    await db.end();
  }
}
