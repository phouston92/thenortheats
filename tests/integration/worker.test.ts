import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Queue, Worker, QueueEvents } from "bullmq";
it("the patched BullMQ UUID dependency supports a real coordinated job", async () => {
  if (!process.env.REDIS_URL)
    throw new Error("REDIS_URL required for the integration queue");
  const connection = { url: process.env.REDIS_URL };
  const name = "north-pr1-smoke-" + randomUUID();
  const queue = new Queue(name, { connection });
  const events = new QueueEvents(name, { connection });
  const worker = new Worker(name, async (job) => ({ nonce: job.data.nonce }), {
    connection,
  });
  try {
    await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);
    const nonce = randomUUID();
    const job = await queue.add("round-trip", { nonce });
    await expect(job.waitUntilFinished(events, 10000)).resolves.toEqual({
      nonce,
    });
    expect(await job.getState()).toBe("completed");
  } finally {
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }
}, 15000);
