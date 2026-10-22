import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Secret, TOTP } from "otpauth";
import { connect } from "../packages/database/src/index";
import { encryptMfa } from "../apps/api/src/mfa";
// Explicit operator provisioning, never an HTTP route. No shared-secret fallback.
const [email, outputFile] = process.argv.slice(2);
if (!email || !outputFile)
  throw new Error(
    "Usage: admin-mfa.ts admin-email private-output-file (requires MFA_ENCRYPTION_KEY)",
  );
const db = connect();
try {
  const secret = new Secret({ size: 20 });
  const [user] =
    await db`SELECT id,email FROM users WHERE email=${email.toLowerCase()} AND role='admin' AND NOT disabled`;
  if (!user) throw new Error("Active administrator required");
  // Exclusive file creation prevents overwriting an existing credential export.
  await writeFile(
    outputFile,
    JSON.stringify(
      {
        email: user.email,
        secret: secret.base32,
        uri: new TOTP({
          issuer: "The North Eats",
          label: user.email,
          secret,
        }).toString(),
        nonce: randomBytes(8).toString("hex"),
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  await db.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id=${user.id} FOR UPDATE`;
    const [old] =
      await tx`SELECT user_id FROM admin_mfa WHERE user_id=${user.id}`;
    if (old)
      throw new Error(
        "Already enrolled; use authenticated rotation (offline reset requires explicit incident recovery)",
      );
    await tx`INSERT INTO admin_mfa(user_id,secret_ciphertext) VALUES(${user.id},${encryptMfa(secret.base32, user.id)})`;
    await tx`DELETE FROM sessions WHERE user_id=${user.id}`;
    await tx`INSERT INTO audit_logs(actor_id,action,subject) VALUES(${user.id},'auth.mfa.provisioned',${user.id})`;
  });
  console.log(
    "Per-user MFA provisioned. Import the private file into an authenticator, then securely delete it.",
  );
} finally {
  await db.end();
}
