import { Worker, Queue } from "bullmq";
import { connect } from "../../../packages/database/src/index";
import { config } from "../../../packages/config/src/index";
const env = config();
const db = connect();
const connection = { url: env.REDIS_URL };
const queue = new Queue("north-outbox", { connection });
const worker = new Worker(
  "north-outbox",
  async () => {
    // Concurrent-safe transactional outbox. No notification is marked sent without provider acknowledgement.
    await db.begin(async (tx) => {
      const messages =
        await tx`SELECT * FROM notifications WHERE delivered_at IS NULL AND attempts<10 ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED`;
      for (const n of messages) {
        if (!process.env.NOTIFICATION_WEBHOOK_URL) continue;
        const url = new URL(process.env.NOTIFICATION_WEBHOOK_URL);
        if (url.protocol !== "https:")
          throw new Error("HTTPS notification provider required");
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": n.id,
          },
          body: JSON.stringify({
            id: n.id,
            recipient: n.recipient,
            kind: n.kind,
            payload: n.payload,
          }),
          signal: AbortSignal.timeout(5000),
        });
        await tx`UPDATE notifications SET attempts=attempts+1,delivered_at=CASE WHEN ${res.ok} THEN now() ELSE NULL END WHERE id=${n.id}`;
      }
    });
  },
  { connection, concurrency: 1 },
);
await queue.upsertJobScheduler(
  "outbox-poll",
  { every: 5000 },
  {
    name: "deliver-outbox",
    data: {},
    opts: { removeOnComplete: 100, removeOnFail: 100 },
  },
);
worker.on("failed", () =>
  console.error(
    "Notification delivery attempt failed; inspect provider availability",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await worker.close();
    await queue.close();
    await db.end();
    process.exit(0);
  });
console.log(
  "The North Eats development worker started; notification delivery requires a configured provider.",
);
