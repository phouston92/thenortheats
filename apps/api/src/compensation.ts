import type { Database } from "../../../packages/database/src/index";
import type { PaymentProvider } from "../../../packages/payments/src/index";
import { settleRefund } from "./orders";
// External calls stay outside transactions. Durable keys recover lost responses and concurrent workers.
export async function compensateOrder(
  db: Database,
  provider: PaymentProvider,
  orderId: string,
) {
  const [job] =
    await db`SELECT c.*,o.total,o.refunded_amount,o.payment_state,p.provider_id,p.stripe_account,p.updated_at AS payment_started FROM payment_compensations c JOIN orders o ON o.id=c.order_id JOIN payments p ON p.order_id=o.id WHERE c.order_id=${orderId}`;
  if (!job || job.state !== "pending") return;
  await db`UPDATE payment_compensations SET attempts=attempts+1,updated_at=now() WHERE order_id=${orderId}`;
  try {
    if (!job.provider_id) {
      // The original intent creation may still be in flight. Never create a payment to cancel it.
      if (
        Date.now() - new Date(job.payment_started).getTime() >=
        23 * 60 * 60 * 1000
      )
        await db`UPDATE payment_compensations SET state='blocked',last_error='unbound_payment_requires_reconciliation' WHERE order_id=${orderId}`;
      return;
    }
    if (
      !["captured", "partially_refunded", "refunded"].includes(
        job.payment_state,
      )
    ) {
      if (!provider.cancel) throw new Error("Cancellation adapter unavailable");
      const state = await provider.cancel(
        job.provider_id,
        job.stripe_account,
        "cancel:" + job.request_key,
      );
      if (state === "captured") return; // Wait for signed reconciliation before reserving a refund.
      await db`UPDATE payment_compensations SET state='succeeded',last_error=NULL,updated_at=now() WHERE order_id=${orderId}`;
      return;
    }
    const reservation = await db.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM orders WHERE id=${orderId} FOR UPDATE`;
      if (o.refunded_amount === o.total) return null;
      const [existing] =
        await tx`SELECT * FROM refunds WHERE order_id=${orderId} AND request_key=${job.request_key}`;
      if (existing) return existing;
      const [pending] =
        await tx`SELECT id FROM refunds WHERE order_id=${orderId} AND status='pending'`;
      if (pending) return undefined;
      const [r] =
        await tx`INSERT INTO refunds(order_id,request_key,amount,status,refund_service_fee) VALUES(${orderId},${job.request_key},${o.total - o.refunded_amount},'pending',true) RETURNING *`;
      return r;
    });
    if (reservation === undefined) return;
    if (reservation) {
      if (reservation.status === "failed") {
        await db`UPDATE payment_compensations SET state='blocked',last_error='refund_failed_requires_reconciliation' WHERE order_id=${orderId}`;
        return;
      }
      if (reservation.status !== "succeeded") {
        if (reservation.provider_id) return; // Provider pending; signed webhook settles.
        if (
          Date.now() - new Date(reservation.created_at).getTime() >=
          23 * 60 * 60 * 1000
        ) {
          await db`UPDATE payment_compensations SET state='blocked',last_error='interrupted_refund_requires_reconciliation' WHERE order_id=${orderId}`;
          return;
        }
        const result = await provider.refund(
          job.provider_id,
          job.stripe_account,
          reservation.amount,
          reservation.request_key,
          true,
        );
        if (result.status === "succeeded")
          await settleRefund(db, reservation.id, result.id, null);
        else {
          await db`UPDATE refunds SET provider_id=${result.id},status=${["failed", "canceled"].includes(result.status) ? "failed" : "pending"} WHERE id=${reservation.id} AND status='pending' AND (provider_id IS NULL OR provider_id=${result.id})`;
          return;
        }
      }
    }
    await db`UPDATE payment_compensations SET state='succeeded',last_error=NULL,updated_at=now() WHERE order_id=${orderId}`;
  } catch {
    // Ambiguous network failure is retryable with the same key; no financial success is invented.
    await db`UPDATE payment_compensations SET last_error='provider_operation_unconfirmed',updated_at=now() WHERE order_id=${orderId} AND state='pending'`;
  }
}
export async function processCompensations(
  db: Database,
  provider: PaymentProvider,
) {
  const jobs =
    await db`SELECT order_id FROM payment_compensations WHERE state='pending' ORDER BY updated_at LIMIT 10`;
  for (const job of jobs) await compensateOrder(db, provider, job.order_id);
}
