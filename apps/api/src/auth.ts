import { tmpdir } from "node:os";
import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { verifyMfa, recoveryHash } from "./mfa";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../../packages/database/src/index";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export type Actor = {
  id: string;
  email: string;
  role: string;
  csrf: string;
  partners: string[];
  permissions: string[];
};
export async function actor(db: Database, req: FastifyRequest): Promise<Actor> {
  const token = req.cookies.north_session;
  if (!token)
    throw Object.assign(new Error("Sign in required"), { statusCode: 401 });
  const [u] =
    await db`SELECT u.id,u.email,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=${hash(token)} AND s.expires_at>now() AND NOT u.disabled`;
  if (!u)
    throw Object.assign(new Error("Session expired"), { statusCode: 401 });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers["x-csrf-token"] !== u.csrf
  )
    throw Object.assign(new Error("Invalid CSRF token"), { statusCode: 403 });
  const memberships =
    await db`SELECT partner_id FROM memberships WHERE user_id=${u.id}`;
  return {
    ...u,
    permissions:
      u.role === "admin"
        ? (
            await db`SELECT permission FROM admin_permissions WHERE user_id=${u.id}`
          ).map((p) => p.permission)
        : [],
    partners: ["owner", "operator"].includes(u.role)
      ? memberships.map((x) => x.partner_id)
      : [],
  } as Actor;
}
export function admin(a: Actor, permission: string | null = "operations") {
  if (a.role !== "admin" || (permission && !a.permissions.includes(permission)))
    throw Object.assign(new Error("Administrator permission required"), {
      statusCode: 403,
    });
}
export function tenant(a: Actor, p: string, finance = false) {
  if (a.role === "admin") {
    admin(a, finance ? "finance" : "operations");
    return;
  }
  if (
    !a.partners.includes(p) ||
    !["owner", "operator"].includes(a.role) ||
    (finance && a.role !== "owner")
  )
    throw Object.assign(new Error("Partner permission denied"), {
      statusCode: 403,
    });
}
export async function audit(
  db: any,
  a: Actor,
  action: string,
  subject: string,
  p: string | null = null,
) {
  await db`INSERT INTO audit_logs(actor_id,partner_id,action,subject) VALUES(${a.id},${p},${action},${subject})`;
}
export async function authRoutes(app: FastifyInstance, db: Database) {
  app.post(
    "/api/auth/request",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { email } = z.object({ email: z.email().max(254) }).parse(req.body);
      const normal = email.toLowerCase();
      const code = String(randomInt(100000, 1000000));
      const challenge = randomBytes(16).toString("hex");
      const [record] =
        await db`INSERT INTO auth_challenges(email,code_hash,expires_at) VALUES(${normal},${hash(challenge + code)},now()+interval '5 minutes') RETURNING id`;
      // Development mailbox is never returned by HTTP or written to application logs.
      const mail = { challengeId: record.id, challenge, code, email: normal };
      if (process.env.MAIL_WEBHOOK_URL) {
        const url = new URL(process.env.MAIL_WEBHOOK_URL);
        if (url.protocol !== "https:")
          throw new Error("HTTPS mail provider required");
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mail),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error("Mail provider unavailable");
      } else if (process.env.NODE_ENV !== "production") {
        const dir =
          process.env.DEV_MAIL_DIR ||
          `${tmpdir()}/north-mail-${process.getuid?.() ?? "dev"}`;
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(`${dir}/${record.id}.json`, JSON.stringify(mail), {
          mode: 0o600,
        });
      } else throw new Error("Email provider required");
      reply.code(202);
      return {
        challengeId: record.id,
        challenge,
        message: "Check your email for a verification code.",
      };
    },
  );
  app.post(
    "/api/auth/verify",
    { config: { rateLimit: { max: 15, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const input = z
        .object({
          challengeId: z.uuid(),
          challenge: z.string().length(32),
          code: z.string().regex(/^\d{6}$/),
          recoveryCode: z
            .string()
            .regex(/^[a-f0-9]{32}$/)
            .optional(),
          mfa: z
            .string()
            .regex(/^\d{6}$/)
            .optional(),
        })
        .parse(req.body);
      const result = await db.begin(async (tx) => {
        const [c] =
          await tx`SELECT * FROM auth_challenges WHERE id=${input.challengeId} FOR UPDATE`;
        if (
          !c ||
          c.consumed ||
          c.attempts >= 5 ||
          new Date(c.expires_at) <= new Date()
        )
          return null;
        await tx`UPDATE auth_challenges SET attempts=attempts+1 WHERE id=${c.id}`;
        if (
          !timingSafeEqual(
            Buffer.from(c.code_hash),
            Buffer.from(hash(input.challenge + input.code)),
          )
        )
          return null;
        let [u] =
          await tx`SELECT * FROM users WHERE email=${c.email} FOR SHARE`;
        if (!u) {
          [u] =
            await tx`INSERT INTO users(email,role) VALUES(${c.email},'customer') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING *`;
        }
        if (u.disabled) return null;
        if (u.role === "admin") {
          if (input.recoveryCode) {
            const used =
              await tx`DELETE FROM mfa_recovery_codes WHERE user_id=${u.id} AND code_hash=${recoveryHash(u.id, input.recoveryCode)} RETURNING code_hash`;
            if (!used.length) return null;
            await tx`DELETE FROM sessions WHERE user_id=${u.id}`;
            await tx`INSERT INTO audit_logs(actor_id,action,subject) VALUES(${u.id},'auth.mfa.recovery',${u.id})`;
          } else if (!(await verifyMfa(tx, u.id, input.mfa))) return null;
        }
        await tx`UPDATE auth_challenges SET consumed=true WHERE id=${c.id}`;
        const token = randomBytes(32).toString("hex");
        const csrf = randomBytes(24).toString("hex");
        await tx`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(${hash(token)},${u.id},${csrf},now()+interval '12 hours')`;
        await tx`INSERT INTO audit_logs(actor_id,action,subject) VALUES(${u.id},'auth.login',${u.id})`;
        return {
          token,
          csrf,
          user: { id: u.id, email: u.email, role: u.role },
        };
      });
      if (!result)
        return reply
          .code(401)
          .send({ error: "Invalid or expired verification" });
      reply.setCookie("north_session", result.token, {
        httpOnly: true,
        secure:
          process.env.NODE_ENV === "production" ||
          process.env.COOKIE_SECURE === "true",
        sameSite: "strict",
        path: "/",
        maxAge: 43200,
      });
      return { user: result.user, csrf: result.csrf };
    },
  );
  app.get("/api/auth/me", async (req) => {
    const a = await actor(db, req);
    return {
      user: {
        id: a.id,
        email: a.email,
        role: a.role,
        partners: a.partners,
        permissions: a.permissions,
      },
      csrf: a.csrf,
    };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const a = await actor(db, req);
    await db`DELETE FROM sessions WHERE token_hash=${hash(req.cookies.north_session!)}`;
    await audit(db, a, "auth.logout", a.id);
    reply.clearCookie("north_session", { path: "/" });
    return { ok: true };
  });
}
