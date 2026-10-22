import type { FastifyInstance } from "fastify";
import type { Database } from "../../../packages/database/src/index";
import { hash } from "./auth";
// One atomic UPSERT per bucket; shared across instances and fails closed on DB failure.
export async function authLimit(db: Database, key: string, maximum: number) {
  const [bucket] =
    await db`INSERT INTO auth_rate_limits(key_hash,attempts,expires_at) VALUES(${hash(key)},1,now()+interval '15 minutes') ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at<=now() THEN 1 ELSE auth_rate_limits.attempts+1 END,expires_at=CASE WHEN auth_rate_limits.expires_at<=now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING attempts`;
  if (bucket.attempts > maximum)
    throw Object.assign(
      new Error("Too many authentication attempts; try again later"),
      { statusCode: 429 },
    );
}
export function authAbuseProtection(app: FastifyInstance, db: Database) {
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/auth/") || req.method !== "POST") return;
    await authLimit(db, "auth:ip:" + req.ip, 60);
    const body = req.body as Record<string, unknown> | undefined;
    if (req.url === "/api/auth/request" && typeof body?.email === "string")
      await authLimit(db, "auth:email:" + body.email.trim().toLowerCase(), 5);
    if (req.url === "/api/auth/verify" && typeof body?.challengeId === "string")
      await authLimit(db, "auth:challenge:" + body.challengeId, 15);
  });
}
