import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { Secret, TOTP } from "otpauth";
import type { FastifyInstance } from "fastify";
import type { Database, Query } from "../../../packages/database/src/index";
import { actor, admin, audit, hash } from "./auth";
import { z } from "zod";
function key() {
  const value = process.env.MFA_ENCRYPTION_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error("MFA encryption key required (32 bytes, hex)");
  return Buffer.from(value, "hex");
}
export function encryptMfa(secret: string, userId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(userId));
  return Buffer.concat([
    iv,
    cipher.update(secret, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
export function decryptMfa(value: string, userId: string) {
  const data = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    cipher.update(data.subarray(12, -16)),
    cipher.final(),
  ]).toString("utf8");
}
export async function verifyMfa(tx: Query, userId: string, token?: string) {
  if (!token) return false;
  const [row] =
    await tx`SELECT secret_ciphertext FROM admin_mfa WHERE user_id=${userId} FOR UPDATE`;
  if (!row) return false;
  const delta = new TOTP({
    secret: Secret.fromBase32(decryptMfa(row.secret_ciphertext, userId)),
  }).validate({ token, window: 1 });
  if (delta === null) return false;
  const counter = Math.floor(Date.now() / 30000) + delta;
  return (
    (
      await tx`INSERT INTO mfa_uses(user_id,counter) VALUES(${userId},${counter}) ON CONFLICT DO NOTHING RETURNING counter`
    ).length > 0
  );
}
export const recoveryHash = (userId: string, code: string) =>
  createHash("sha256")
    .update(userId + ":" + code)
    .digest("hex");
export async function mfaRoutes(app: FastifyInstance, db: Database) {
  app.get("/api/auth/mfa", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const [row] =
      await db`SELECT updated_at FROM admin_mfa WHERE user_id=${a.id}`;
    const [codes] =
      await db`SELECT count(*)::int AS remaining FROM mfa_recovery_codes WHERE user_id=${a.id}`;
    return {
      enrolled: !!row,
      updatedAt: row?.updated_at,
      recoveryCodesRemaining: codes.remaining,
    };
  });
  app.post("/api/auth/mfa/rotate", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const { mfa } = z
      .object({ mfa: z.string().regex(/^\d{6}$/) })
      .parse(req.body);
    const result = await db.begin(async (tx) => {
      if (!(await verifyMfa(tx, a.id, mfa))) return null;
      const secret = new Secret({ size: 20 });
      await tx`INSERT INTO mfa_rotations(user_id,session_hash,secret_ciphertext,expires_at) VALUES(${a.id},${hash(req.cookies.north_session!)},${encryptMfa(secret.base32, a.id)},now()+interval '10 minutes') ON CONFLICT(user_id) DO UPDATE SET session_hash=EXCLUDED.session_hash,secret_ciphertext=EXCLUDED.secret_ciphertext,expires_at=EXCLUDED.expires_at,attempts=0`;
      await audit(tx, a, "auth.mfa.rotation_started", a.id);
      return {
        secret: secret.base32,
        uri: new TOTP({
          issuer: "The North Eats",
          label: a.email,
          secret,
        }).toString(),
      };
    });
    if (!result)
      throw Object.assign(new Error("Fresh MFA required"), { statusCode: 401 });
    return result;
  });
  app.post("/api/auth/mfa/confirm", async (req, reply) => {
    const a = await actor(db, req);
    admin(a);
    const { mfa } = z
      .object({ mfa: z.string().regex(/^\d{6}$/) })
      .parse(req.body);
    const result = await db.begin(async (tx) => {
      const [r] =
        await tx`SELECT * FROM mfa_rotations WHERE user_id=${a.id} AND session_hash=${hash(req.cookies.north_session!)} FOR UPDATE`;
      if (!r || r.attempts >= 5 || new Date(r.expires_at) <= new Date())
        return null;
      await tx`UPDATE mfa_rotations SET attempts=attempts+1 WHERE user_id=${a.id}`;
      const delta = new TOTP({
        secret: Secret.fromBase32(decryptMfa(r.secret_ciphertext, a.id)),
      }).validate({ token: mfa, window: 1 });
      if (delta === null) return null;
      await tx`INSERT INTO admin_mfa(user_id,secret_ciphertext) VALUES(${a.id},${r.secret_ciphertext}) ON CONFLICT(user_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,updated_at=now()`;
      await tx`DELETE FROM mfa_recovery_codes WHERE user_id=${a.id}`;
      const codes = Array.from({ length: 10 }, () =>
        randomBytes(16).toString("hex"),
      );
      for (const code of codes)
        await tx`INSERT INTO mfa_recovery_codes(user_id,code_hash) VALUES(${a.id},${recoveryHash(a.id, code)})`;
      await tx`DELETE FROM mfa_uses WHERE user_id=${a.id}`;
      await tx`INSERT INTO mfa_uses(user_id,counter) VALUES(${a.id},${Math.floor(Date.now() / 30000) + delta})`;
      await tx`DELETE FROM mfa_rotations WHERE user_id=${a.id}`;
      await tx`DELETE FROM sessions WHERE user_id=${a.id}`;
      await audit(tx, a, "auth.mfa.rotated", a.id);
      return { recoveryCodes: codes, signInRequired: true };
    });
    if (!result)
      throw Object.assign(new Error("Invalid or expired enrollment"), {
        statusCode: 401,
      });
    reply.clearCookie("north_session", { path: "/" });
    return result;
  });
  app.post("/api/auth/sessions/revoke", async (req) => {
    const a = await actor(db, req);
    await db`DELETE FROM sessions WHERE user_id=${a.id} AND token_hash<>${hash(req.cookies.north_session!)}`;
    await audit(db, a, "auth.sessions.revoked", a.id);
    return { ok: true };
  });
}
