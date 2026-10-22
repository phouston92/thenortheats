import type { FastifyInstance } from "fastify";
import type { Database } from "../../../packages/database/src/index";
import { StripeProvider } from "../../../packages/payments/src/index";
import { settleRefund } from "./orders";
export async function webhookRoutes(app: FastifyInstance, db: Database) {
  app.post(
    "/api/webhooks/stripe",
    { config: { rawBody: true } },
    async (req, reply) => {
      if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY)
        return reply
          .code(503)
          .send({ error: "Stripe test webhook not configured" });
      let event;
      try {
        event = new StripeProvider().stripe.webhooks.constructEvent(
          (req as any).rawBody,
          req.headers["stripe-signature"] as string,
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } catch {
        return reply.code(400).send({ error: "Invalid webhook signature" });
      }
      if (event.livemode)
        return reply.code(400).send({ error: "Live events are disabled" });
      if (event.type === "refund.updated" || event.type === "refund.created") {
        const refund = event.data.object as any;
        // Provider reconciliation for asynchronous refunds: id or original request-key metadata.
        const [local] =
          await db`SELECT r.id,p.stripe_account FROM refunds r JOIN payments p ON p.order_id=r.order_id WHERE r.provider_id=${refund.id}`;
        if (!local || local.stripe_account !== event.account)
          return reply
            .code(409)
            .send({ error: "Refund requires reconciliation" });
        if (refund.status === "succeeded")
          await settleRefund(db, local.id, refund.id, null);
        else if (refund.status === "failed")
          await db`UPDATE refunds SET status='failed' WHERE id=${local.id} AND status='pending'`;
        await db`INSERT INTO webhook_events(provider_id,type) VALUES(${event.id},${event.type}) ON CONFLICT DO NOTHING`;
        return { received: true };
      }
      return db.begin(async (tx) => {
        const saved =
          await tx`INSERT INTO webhook_events(provider_id,type) VALUES(${event.id},${event.type}) ON CONFLICT DO NOTHING RETURNING provider_id`;
        if (!saved.length) return { received: true, duplicate: true };
        if (
          ![
            "payment_intent.succeeded",
            "payment_intent.payment_failed",
            "payment_intent.amount_capturable_updated",
          ].includes(event.type)
        )
          return { received: true };
        const pi = event.data.object as any;
        const [p] =
          await tx`SELECT p.*,o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id WHERE (p.provider_id=${pi.id} OR (p.provider_id IS NULL AND p.order_id::text=${pi.metadata?.orderId || ""})) AND p.stripe_account=${event.account || ""} FOR UPDATE OF p,o`;
        if (!p || pi.currency !== "gbp" || pi.amount !== p.amount)
          throw Object.assign(new Error("Payment reconciliation mismatch"), {
            statusCode: 409,
          });
        const state =
          event.type === "payment_intent.succeeded"
            ? "captured"
            : event.type === "payment_intent.payment_failed"
              ? "failed"
              : "authorised";
        // A delayed failure/authorisation cannot downgrade a successful payment.
        if (
          ["captured", "refunded", "partially_refunded"].includes(p.state) &&
          state !== "captured"
        )
          return { received: true };
        if (state === "captured" && pi.amount_received !== p.amount)
          throw Object.assign(new Error("Captured amount mismatch"), {
            statusCode: 409,
          });
        await tx`UPDATE payments SET state=${state},provider_id=${pi.id},updated_at=now() WHERE id=${p.id}`;
        await tx`UPDATE orders SET payment_state=${state} WHERE id=${p.order_id} AND payment_state NOT IN ('refunded','partially_refunded')`;
        if (state === "captured" && p.order_status === "awaiting_payment") {
          await tx`UPDATE orders SET status='awaiting_acceptance' WHERE id=${p.order_id}`;
          await tx`INSERT INTO order_history(order_id,status) VALUES(${p.order_id},'awaiting_acceptance')`;
          await tx`INSERT INTO notifications(order_id,recipient,kind) SELECT id,partner_id::text,'new_order' FROM orders WHERE id=${p.order_id} ON CONFLICT DO NOTHING`;
        }
        await tx`INSERT INTO reconciliation_records(provider_id,order_id,amount,state) VALUES(${event.id},${p.order_id},${p.amount},${state}) ON CONFLICT DO NOTHING`;
        return { received: true };
      });
    },
  );
}
