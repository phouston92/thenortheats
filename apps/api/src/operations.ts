import Redis from "ioredis";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../../packages/database/src/index";
import { actor, admin, hash } from "./auth";
import { timingSafeEqual } from "node:crypto";
export async function dependencyHealth(
  db: Database,
  redisUrl = process.env.REDIS_URL,
) {
  let database = false,
    redis = false,
    worker = false;
  try {
    await db`SELECT 1`;
    database = true;
  } catch {
    /* Return health, never connection strings. */
  }
  if (redisUrl) {
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      enableOfflineQueue: false,
    });
    client.on("error", () => {});
    try {
      await client.connect();
      redis = (await client.ping()) === "PONG";
      worker = Boolean(
        await client.get(
          "north:worker:" +
            (process.env.NORTH_INSTANCE ||
              process.env.NODE_ENV ||
              "development"),
        ),
      );
    } catch {
      /* Unavailable dependency. */
    } finally {
      client.disconnect();
    }
  }
  return { database, redis, worker };
}
export async function operationsRoutes(app: FastifyInstance, db: Database) {
  app.get("/api/ready", async (_req, reply) => {
    const d = await dependencyHealth(db);
    return reply.code(d.database && d.redis ? 200 : 503).send({
      status: d.database && d.redis ? "ready" : "unavailable",
      dependencies: { database: d.database, redis: d.redis },
    });
  });
  async function counts() {
    const [r] =
      await db`SELECT (SELECT count(*)::int FROM reconciliation_jobs WHERE state='pending') AS reconciliation_pending,(SELECT count(*)::int FROM reconciliation_jobs WHERE state='blocked') AS reconciliation_blocked,(SELECT count(*)::int FROM notifications WHERE delivered_at IS NULL) AS outbox_pending,(SELECT count(*)::int FROM payment_compensations WHERE state='blocked') AS compensation_blocked,(SELECT count(*)::int FROM payout_reconciliation WHERE complete AND NOT net_matches) AS payout_mismatches`;
    return r;
  }
  app.get("/api/admin/operations", async (req) => {
    admin(await actor(db, req));
    return { dependencies: await dependencyHealth(db), queues: await counts() };
  });
  app.get("/internal/metrics", async (req, reply) => {
    const expected = process.env.MONITORING_TOKEN;
    if (!expected || expected.length < 32)
      return reply.code(503).send({ error: "Monitoring not configured" });
    if (
      !timingSafeEqual(
        Buffer.from(hash(req.headers.authorization || "")),
        Buffer.from(hash("Bearer " + expected)),
      )
    )
      return reply
        .code(401)
        .send({ error: "Monitoring authentication required" });
    const d = await dependencyHealth(db),
      c = d.database ? await counts() : {};
    return reply
      .header("cache-control", "no-store")
      .type("text/plain; version=0.0.4")
      .send(
        [
          "north_api_up 1",
          `north_database_up ${+d.database}`,
          `north_redis_up ${+d.redis}`,
          `north_worker_up ${+d.worker}`,
          ...Object.entries(c).map(([k, v]) => "north_" + k + " " + v),
        ].join("\n") + "\n",
      );
  });
}
