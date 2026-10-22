import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../../packages/database/src/index";
import { StripeProvider } from "../../../packages/payments/src/index";
import { actor, admin, audit, tenant, type Actor } from "./auth";
import { stepUp } from "./governance";
import { authLimit } from "./abuse";
import {
  recordFinancialEvent,
  replayFinancialEvents,
  snapshotEvent,
} from "./reconciliation";
import { reconcilePayment } from "./webhooks";
const error = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
const stepInput = z.object({
  mfa: z.string().regex(/^\d{6}$/),
  reason: z.string().trim().min(10).max(500),
});
async function authorize(
  db: Database,
  a: Actor,
  body: unknown,
  subject: string,
) {
  const v = stepInput.parse(body);
  await authLimit(db, "finance-stepup:" + a.id, 10);
  const ok = await db.begin(async (tx) => {
    if (!(await stepUp(tx, a, v.mfa, "finance"))) return false;
    await audit(
      tx,
      a,
      "reconciliation.requested",
      JSON.stringify({ subject, reason: v.reason }),
    );
    return true;
  });
  if (!ok) throw error("Fresh MFA required", 401);
  return v;
}
export async function reconciliationRoutes(app: FastifyInstance, db: Database) {
  app.get("/api/admin/reconciliation", async (req) => {
    admin(await actor(db, req), "finance");
    return {
      jobs: await db`SELECT j.*,e.account,e.kind,e.payload->>'id' AS provider_id,e.source,e.received_at FROM reconciliation_jobs j JOIN provider_events e ON e.event_id=j.event_id WHERE j.state<>'processed' ORDER BY j.updated_at LIMIT 200`,
      payments:
        await db`SELECT p.order_id,p.provider_id,p.stripe_account,p.state,p.updated_at,o.status FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.state IN ('pending','authorised','failed') ORDER BY p.updated_at LIMIT 200`,
      refunds:
        await db`SELECT id,order_id,provider_id,status,amount,origin,created_at FROM refunds WHERE status<>'succeeded' ORDER BY created_at LIMIT 200`,
      compensations:
        await db`SELECT * FROM payment_compensations WHERE state<>'succeeded' ORDER BY updated_at LIMIT 200`,
      captures:
        await db`SELECT c.*,p.state AS payment_state FROM capture_operations c JOIN payments p ON p.order_id=c.order_id WHERE p.state NOT IN ('captured','partially_refunded','refunded') ORDER BY c.created_at LIMIT 200`,
      disputes:
        await db`SELECT * FROM provider_disputes ORDER BY last_event_created DESC LIMIT 200`,
      adjustments:
        await db`SELECT * FROM financial_adjustments ORDER BY created_at DESC LIMIT 200`,
      payouts:
        await db`SELECT p.*,r.complete,r.net_matches,r.next_cursor,(SELECT coalesce(sum(b.net),0)::bigint FROM payout_balance_links l JOIN provider_balances b ON b.account=l.account AND b.provider_id=l.balance_id WHERE l.account=p.account AND l.payout_id=p.provider_id) AS allocated_net,(SELECT count(*)::int FROM payout_balance_links l WHERE l.account=p.account AND l.payout_id=p.provider_id) AS linked_transactions FROM provider_payouts p LEFT JOIN payout_reconciliation r ON r.account=p.account AND r.payout_id=p.provider_id ORDER BY arrival_date DESC LIMIT 200`,
      balances:
        await db`SELECT b.*,s.status,s.checked_at FROM provider_balances b LEFT JOIN provider_balance_status s ON s.account=b.account AND s.provider_id=b.provider_id ORDER BY b.created_at DESC LIMIT 200`,
      applicationFees:
        await db`SELECT * FROM provider_application_fees LIMIT 200`,
    };
  });
  app.get("/api/partner/:id/reconciliation", async (req) => {
    const p = z.uuid().parse((req.params as { id: string }).id);
    tenant(await actor(db, req), p, true);
    return {
      balances:
        await db`SELECT b.*,s.status,s.checked_at FROM provider_balances b LEFT JOIN provider_balance_status s ON s.account=b.account AND s.provider_id=b.provider_id WHERE b.partner_id=${p} ORDER BY b.created_at DESC LIMIT 100`,
      payouts:
        await db`SELECT * FROM provider_payouts WHERE partner_id=${p} ORDER BY arrival_date DESC LIMIT 100`,
      disputes:
        await db`SELECT d.* FROM provider_disputes d JOIN orders o ON o.id=d.order_id WHERE o.partner_id=${p}`,
      adjustments:
        await db`SELECT * FROM financial_adjustments WHERE partner_id=${p} ORDER BY created_at DESC LIMIT 100`,
    };
  });
  app.post("/api/admin/reconciliation/events/:id/replay", async (req) => {
    const a = await actor(db, req);
    admin(a, "finance");
    const id = z
      .string()
      .min(1)
      .max(255)
      .parse((req.params as { id: string }).id);
    await authorize(db, a, req.body, "replay:" + id);
    await replayFinancialEvents(db, id);
    const [job] =
      await db`SELECT * FROM reconciliation_jobs WHERE event_id=${id}`;
    if (!job) throw error("Event not found", 404);
    return job;
  });
  app.post("/api/admin/reconciliation/events/:id/acknowledge", async (req) => {
    const a = await actor(db, req);
    admin(a, "finance");
    const id = z
      .string()
      .min(1)
      .max(255)
      .parse((req.params as { id: string }).id);
    const v = stepInput
      .extend({ evidenceId: z.string().min(1).max(255) })
      .parse(req.body);
    await authorize(db, a, v, "acknowledge:" + id);
    return db.begin(async (tx) => {
      const [e] =
        await tx`SELECT e.event_id FROM provider_events e JOIN reconciliation_jobs j ON j.event_id=e.event_id JOIN provider_events old ON old.event_id=${id} WHERE e.event_id=${v.evidenceId} AND e.source='provider_read' AND j.state='processed' AND e.account=old.account AND e.payload->>'id'=old.payload->>'id' AND e.received_at>=old.received_at`;
      if (!e)
        throw error(
          "Processed provider-read evidence for the same object is required",
        );
      const [job] =
        await tx`UPDATE reconciliation_jobs SET state='processed',last_error=NULL,resolved_by_event=${e.event_id},updated_at=now() WHERE event_id=${id} RETURNING *`;
      await audit(
        tx,
        a,
        "reconciliation.superseded",
        JSON.stringify({
          eventId: id,
          evidenceId: e.event_id,
          reason: v.reason,
        }),
      );
      return job;
    });
  });
  app.post("/api/admin/reconciliation/orders/:id/sync", async (req) => {
    const a = await actor(db, req);
    admin(a, "finance");
    const id = z.uuid().parse((req.params as { id: string }).id);
    const v = stepInput
      .extend({
        intentId: z
          .string()
          .regex(/^pi_[A-Za-z0-9_]+$/)
          .optional(),
      })
      .parse(req.body);
    await authorize(db, a, v, "order-sync:" + id);
    const [p] =
      await db`SELECT p.*,o.service_fee FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.order_id=${id}`;
    if (!p || !(p.provider_id || v.intentId))
      throw error(
        "Known provider intent required; creation is never retried here",
      );
    if (p.provider_id && v.intentId && p.provider_id !== v.intentId)
      throw error("Payment identity conflict");
    const snapshot = await new StripeProvider().reconciliationSnapshot(
      p.stripe_account,
      p.provider_id || v.intentId,
    );
    const pi = snapshot.intent;
    if (
      pi.livemode ||
      pi.id !== (p.provider_id || v.intentId) ||
      pi.metadata.orderId !== id ||
      pi.amount !== p.amount ||
      pi.currency !== "gbp" ||
      pi.application_fee_amount !== p.service_fee
    )
      throw error("Provider snapshot payment mismatch");
    return db.begin(async (tx) => {
      await tx`SELECT id FROM orders WHERE id=${id} FOR UPDATE`;
      const [bound] =
        await tx`UPDATE payments SET provider_id=${pi.id} WHERE order_id=${id} AND (provider_id IS NULL OR provider_id=${pi.id}) RETURNING id`;
      if (!bound) throw error("Payment identity changed");
      const type =
        pi.status === "succeeded"
          ? "payment_intent.succeeded"
          : pi.status === "requires_capture"
            ? "payment_intent.amount_capturable_updated"
            : pi.status === "canceled"
              ? "payment_intent.canceled"
              : pi.status === "requires_payment_method"
                ? "payment_intent.payment_failed"
                : "payment_intent.processing";
      const evidence = snapshotEvent(p.stripe_account, "charge.updated", {
        id: snapshot.charge?.id || "unbound:" + pi.id,
        payment_intent: pi.id,
        amount: pi.amount,
        currency: pi.currency,
        balance_transaction: snapshot.charge?.balance_transaction,
      });
      // Persist a minimal intent-check receipt even when no charge exists yet.
      await tx`INSERT INTO provider_events(event_id,account,kind,provider_created,source,payload) VALUES(${evidence.id},${p.stripe_account},'payment_intent.snapshot',${evidence.created},'provider_read',${tx.json({ id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency, orderId: id })}) ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO reconciliation_jobs(event_id,state) VALUES(${evidence.id},'processed') ON CONFLICT DO NOTHING`;
      await reconcilePayment(tx, {
        id: evidence.id,
        account: p.stripe_account,
        type,
        data: { object: pi },
      });
      if (snapshot.charge) {
        await recordFinancialEvent(
          tx,
          snapshotEvent(p.stripe_account, "charge.updated", snapshot.charge),
        );
        const balance = snapshot.charge.balance_transaction;
        if (balance && typeof balance === "object")
          await recordFinancialEvent(
            tx,
            snapshotEvent(
              p.stripe_account,
              "balance_transaction.snapshot",
              balance,
            ),
          );
      }
      for (const r of snapshot.refunds)
        await recordFinancialEvent(
          tx,
          snapshotEvent(p.stripe_account, "refund.updated", r),
        );
      for (const d of snapshot.disputes)
        await recordFinancialEvent(
          tx,
          snapshotEvent(p.stripe_account, "charge.dispute.updated", d),
        );
      await tx`INSERT INTO provider_order_checks(order_id,payment_status,event_id) VALUES(${id},${pi.status},${evidence.id}) ON CONFLICT(order_id) DO UPDATE SET payment_status=EXCLUDED.payment_status,checked_at=now(),event_id=EXCLUDED.event_id`;
      await audit(tx, a, "reconciliation.order_checked", id);
      return {
        orderId: id,
        providerStatus: pi.status,
        refunds: snapshot.refunds.length,
        disputes: snapshot.disputes.length,
        evidenceId: evidence.id,
      };
    });
  });
  app.post(
    "/api/admin/reconciliation/partners/:id/payouts/:payoutId/sync",
    async (req) => {
      const a = await actor(db, req);
      admin(a, "finance");
      const p = z
        .object({
          id: z.uuid(),
          payoutId: z.string().regex(/^po_[A-Za-z0-9_]+$/),
        })
        .parse(req.params);
      const v = stepInput
        .extend({
          cursor: z
            .string()
            .regex(/^txn_[A-Za-z0-9_]+$/)
            .optional(),
        })
        .parse(req.body);
      await authorize(db, a, v, "payout-sync:" + p.payoutId);
      const [partner] =
        await db`SELECT stripe_account FROM partners WHERE id=${p.id}`;
      if (!partner?.stripe_account) throw error("Connected partner required");
      const [previous] =
        await db`SELECT next_cursor FROM payout_reconciliation WHERE account=${partner.stripe_account} AND payout_id=${p.payoutId}`;
      if (v.cursor && previous?.next_cursor !== v.cursor)
        throw error("Payout cursor must continue a recorded sync");
      const s = await new StripeProvider().payoutSnapshot(
        partner.stripe_account,
        p.payoutId,
        v.cursor,
      );
      if (s.payout.id !== p.payoutId) throw error("Payout identity mismatch");
      await db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${partner.stripe_account + ":" + p.payoutId},3))`;
        const [cursor] =
          await tx`SELECT next_cursor FROM payout_reconciliation WHERE account=${partner.stripe_account} AND payout_id=${p.payoutId}`;
        if (v.cursor && cursor?.next_cursor !== v.cursor)
          throw error("Payout pagination changed; refresh before retry");
        await recordFinancialEvent(
          tx,
          snapshotEvent(partner.stripe_account, "payout.updated", s.payout),
        );
        for (const b of s.balances)
          await recordFinancialEvent(
            tx,
            snapshotEvent(
              partner.stripe_account,
              "balance_transaction.snapshot",
              { ...b, payout_id: s.payout.id },
            ),
          );
        const [sum] =
          await tx`SELECT coalesce(sum(b.net),0)::bigint AS net FROM payout_balance_links l JOIN provider_balances b ON b.account=l.account AND b.provider_id=l.balance_id WHERE l.account=${partner.stripe_account} AND l.payout_id=${p.payoutId}`;
        await tx`INSERT INTO payout_reconciliation(account,payout_id,next_cursor,complete,net_matches) VALUES(${partner.stripe_account},${p.payoutId},${s.nextCursor ?? null},${s.payout.automatic && !s.hasMore},${s.payout.automatic && !s.hasMore ? Number(sum.net) === s.payout.amount : null}) ON CONFLICT(account,payout_id) DO UPDATE SET next_cursor=EXCLUDED.next_cursor,complete=EXCLUDED.complete,net_matches=EXCLUDED.net_matches,checked_at=now()`;
        await audit(tx, a, "reconciliation.payout_checked", p.payoutId, p.id);
      });
      return {
        payoutId: p.payoutId,
        status: s.payout.status,
        transactions: s.balances.length,
        hasMore: s.hasMore,
        nextCursor: s.nextCursor,
        automatic: s.payout.automatic,
      };
    },
  );
  app.post("/api/admin/reconciliation/orders/:id/recover", async (req) => {
    const a = await actor(db, req);
    admin(a, "finance");
    const id = z.uuid().parse((req.params as { id: string }).id);
    const v = stepInput
      .extend({ action: z.enum(["resume_compensation", "retry_capture"]) })
      .parse(req.body);
    await authorize(db, a, v, "recover:" + id);
    return db.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM orders WHERE id=${id} FOR UPDATE`;
      const [check] =
        await tx`SELECT * FROM provider_order_checks WHERE order_id=${id} AND checked_at>now()-interval '5 minutes'`;
      if (!o || !check) throw error("Complete a fresh provider read first");
      if (v.action === "retry_capture") {
        if (
          check.payment_status !== "requires_capture" ||
          ["cancelled", "rejected"].includes(o.status)
        )
          throw error("Provider-authorised active intent required");
        const [retried] =
          await tx`UPDATE capture_operations SET request_key=${randomUUID()},created_at=now() WHERE order_id=${id} RETURNING order_id`;
        if (!retried) throw error("No interrupted capture operation exists");
      } else {
        if (
          !["cancelled", "rejected"].includes(o.status) ||
          check.payment_status !== "succeeded"
        )
          throw error("Cancelled captured order required");
        const [pending] =
          await tx`SELECT id FROM refunds WHERE order_id=${id} AND status='pending'`;
        const [dispute] =
          await tx`SELECT provider_id FROM provider_disputes WHERE order_id=${id} AND status NOT IN ('won','prevented','warning_closed')`;
        const [failedUnconfirmed] =
          await tx`SELECT r.id FROM refunds r WHERE r.order_id=${id} AND r.status='failed' AND NOT EXISTS(SELECT 1 FROM provider_events e JOIN reconciliation_jobs j ON j.event_id=e.event_id WHERE e.source='provider_read' AND j.state='processed' AND e.payload->>'id'=r.provider_id AND e.payload->>'status' IN ('failed','canceled') AND e.received_at>now()-interval '5 minutes')`;
        if (pending || dispute || failedUnconfirmed)
          throw error(
            "Unresolved refund or dispute; no new provider key can be issued",
          );
        if (o.refunded_amount === o.total)
          throw error("Payment has already been fully refunded");
        const [resumed] =
          await tx`UPDATE payment_compensations SET state='pending',request_key=${randomUUID()},last_error=NULL,updated_at=now() WHERE order_id=${id} AND state='blocked' RETURNING order_id`;
        if (!resumed) throw error("No blocked compensation operation exists");
      }
      await audit(
        tx,
        a,
        "reconciliation.recovery_authorised",
        JSON.stringify({ orderId: id, action: v.action, reason: v.reason }),
      );
      return { queued: true, action: v.action };
    });
  });
}
