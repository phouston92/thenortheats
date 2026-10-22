import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database, Query } from "../../../packages/database/src/index";
import { settleRefundInTransaction } from "./orders";
export type FinancialEvent = {
  id: string;
  account: string;
  type: string;
  created: number;
  source: "webhook" | "provider_read";
  data: Record<string, any>;
};
const money = z.number().int().safe(),
  positive = money.positive(),
  key = z.string().min(1).max(255);
const objectId = (v: any): string | undefined =>
  typeof v === "string" ? v : typeof v?.id === "string" ? v.id : undefined;
const fail = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409 });
export function financialEvent(
  raw: {
    id: string;
    account?: string;
    type: string;
    created?: number;
    data: { object: any };
  },
  source: FinancialEvent["source"] = "webhook",
): FinancialEvent | null {
  const o = raw.data.object;
  if (o.livemode === true) throw fail("Live provider objects disabled");
  let data: Record<string, any>;
  if (["refund.created", "refund.updated", "refund.failed"].includes(raw.type))
    data = {
      id: o.id,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      payment_intent: objectId(o.payment_intent),
      refundRequestKey: o.metadata?.refundRequestKey,
    };
  else if (raw.type.startsWith("charge.dispute."))
    data = {
      id: o.id,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      charge: objectId(o.charge),
      payment_intent: objectId(o.payment_intent),
      reason: o.reason,
      evidence_due_by: o.evidence_details?.due_by ?? null,
    };
  else if (
    ["charge.succeeded", "charge.updated", "charge.refunded"].includes(raw.type)
  )
    data = {
      id: o.id,
      amount: o.amount,
      currency: o.currency,
      payment_intent: objectId(o.payment_intent),
      paid: o.paid,
      captured: o.captured,
      amount_captured: o.amount_captured,
      balance_transaction: objectId(o.balance_transaction),
    };
  else if (raw.type.startsWith("payout."))
    data = {
      id: o.id,
      amount: o.amount,
      currency: o.currency,
      status: o.status,
      automatic: o.automatic,
      arrival_date: o.arrival_date,
      balance_transaction: objectId(o.balance_transaction) ?? null,
      failure_code: o.failure_code ?? null,
    };
  else if (
    ["application_fee.created", "application_fee.refunded"].includes(raw.type)
  )
    data = {
      id: o.id,
      amount: o.amount,
      amount_refunded: o.amount_refunded,
      currency: o.currency,
      charge: objectId(o.charge),
    };
  else if (
    raw.type === "balance_transaction.snapshot" &&
    source === "provider_read"
  )
    data = {
      id: o.id,
      amount: o.amount,
      fee: o.fee,
      net: o.net,
      currency: o.currency,
      source: objectId(o.source) ?? "unattributed",
      category: o.reporting_category,
      status: o.status,
      fee_details: o.fee_details?.map((f: any) => ({
        amount: f.amount,
        currency: f.currency,
        type: f.type,
      })),
      available_on: o.available_on,
      payout_id: o.payout_id,
    };
  else return null;
  // Never persist raw Stripe payloads (which may contain client secrets or personal data).
  return {
    id: key.parse(raw.id),
    account: key.parse(raw.account || objectId(o.account) || "unmapped"),
    type: raw.type,
    created: z
      .number()
      .int()
      .nonnegative()
      .parse(raw.created ?? 0),
    source,
    data: JSON.parse(JSON.stringify(data)),
  };
}
async function defer(
  tx: Query,
  e: FinancialEvent,
  reason: string,
  blocked = false,
) {
  await tx`UPDATE reconciliation_jobs SET state=${blocked ? "blocked" : "pending"},last_error=${reason},updated_at=now() WHERE event_id=${e.id}`;
  return false;
}
export async function applyFinancialEvent(tx: Query, e: FinancialEvent) {
  const [partner] =
    await tx`SELECT id FROM partners WHERE stripe_account=${e.account}`;
  if (!partner) return defer(tx, e, "unknown_connected_account", true);
  const o = e.data;
  key.parse(o.id);
  if (o.currency !== "gbp") throw fail("Provider currency mismatch");
  if (e.type.startsWith("refund.")) {
    positive.parse(o.amount);
    key.parse(o.payment_intent);
    z.enum([
      "pending",
      "succeeded",
      "failed",
      "canceled",
      "requires_action",
    ]).parse(o.status);
    const [payment] =
      await tx`SELECT p.*,o.refunded_amount,o.payment_state FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.provider_id=${o.payment_intent} AND p.stripe_account=${e.account} FOR UPDATE OF o,p`;
    if (!payment) return defer(tx, e, "unknown_payment");
    if (
      !["captured", "partially_refunded", "refunded"].includes(
        payment.payment_state,
      )
    )
      return defer(tx, e, "capture_not_reconciled");
    let [refund] =
      await tx`SELECT * FROM refunds WHERE provider_id=${o.id} OR (provider_id IS NULL AND request_key=${o.refundRequestKey || ""}) FOR UPDATE`;
    if (
      refund &&
      (refund.order_id !== payment.order_id ||
        refund.amount !== o.amount ||
        (refund.provider_id && refund.provider_id !== o.id))
    )
      throw fail("Refund reconciliation mismatch");
    if (!refund) {
      if (o.amount > payment.amount - payment.refunded_amount)
        return defer(tx, e, "external_refund_exceeds_remaining", true);
      [refund] =
        await tx`INSERT INTO refunds(order_id,request_key,amount,provider_id,status,refund_service_fee,origin) VALUES(${payment.order_id},${"stripe:" + e.account + ":" + o.id},${o.amount},${o.id},'pending',false,'dashboard') RETURNING *`;
    }
    if (refund.status === "succeeded") return true;
    if (o.status === "succeeded") {
      if (refund.status === "failed")
        return defer(tx, e, "conflicting_terminal_refund", true);
      await settleRefundInTransaction(tx, refund.id, o.id, null);
    } else
      await tx`UPDATE refunds SET provider_id=${o.id},status=CASE WHEN ${["failed", "canceled"].includes(o.status)} THEN 'failed' ELSE status END WHERE id=${refund.id} AND status='pending'`;
    return true;
  }
  if (e.type.startsWith("charge.dispute.")) {
    positive.parse(o.amount);
    key.parse(o.charge);
    key.parse(o.reason);
    z.enum([
      "warning_needs_response",
      "warning_under_review",
      "warning_closed",
      "needs_response",
      "under_review",
      "won",
      "lost",
      "prevented",
    ]).parse(o.status);
    const [p] =
      await tx`SELECT p.*,o.partner_id FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.stripe_account=${e.account} AND (p.charge_id=${o.charge} OR p.provider_id=${o.payment_intent || ""}) FOR UPDATE OF o,p`;
    if (!p) return defer(tx, e, "unknown_disputed_charge");
    if (o.amount > p.amount || (p.charge_id && p.charge_id !== o.charge))
      throw fail("Dispute reconciliation mismatch");
    await tx`UPDATE payments SET charge_id=${o.charge} WHERE id=${p.id} AND charge_id IS NULL`;
    const [old] =
      await tx`SELECT * FROM provider_disputes WHERE account=${e.account} AND provider_id=${o.id} FOR UPDATE`;
    if (old && (old.order_id !== p.order_id || old.amount !== o.amount))
      throw fail("Dispute immutable fields mismatch");
    if (old && e.source !== "provider_read") {
      if (e.created < Number(old.last_event_created)) return true;
      if (
        ["won", "lost", "prevented", "warning_closed"].includes(old.status) &&
        old.status !== o.status
      ) {
        if (!["won", "lost", "prevented", "warning_closed"].includes(o.status))
          return true;
        return defer(tx, e, "conflicting_terminal_dispute", true);
      }
    }
    await tx`INSERT INTO provider_disputes(account,provider_id,order_id,amount,currency,status,reason,evidence_due_by,last_event_created,last_event_id) VALUES(${e.account},${o.id},${p.order_id},${o.amount},'gbp',${o.status},${o.reason},${o.evidence_due_by},${e.created},${e.id}) ON CONFLICT(account,provider_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,evidence_due_by=EXCLUDED.evidence_due_by,last_event_created=EXCLUDED.last_event_created,last_event_id=EXCLUDED.last_event_id`;
    const target =
      ["won", "prevented", "warning_closed"].includes(o.status) ||
      o.status.startsWith("warning_")
        ? 0
        : -o.amount;
    const [sum] =
      await tx`SELECT coalesce(sum(amount),0)::int AS amount FROM financial_adjustments WHERE account=${e.account} AND dispute_id=${o.id}`;
    // A close-before-create still records both sides of the exposure history.
    if (!old && o.status === "won") {
      await tx`INSERT INTO financial_adjustments(reference,account,dispute_id,partner_id,order_id,amount,kind,event_id) VALUES(${e.account + ":" + o.id + ":debit"},${e.account},${o.id},${p.partner_id},${p.order_id},${-o.amount},'dispute_debit',${e.id}) ON CONFLICT DO NOTHING`;
      sum.amount = -o.amount;
    }
    const delta = target - sum.amount;
    if (delta)
      await tx`INSERT INTO financial_adjustments(reference,account,dispute_id,partner_id,order_id,amount,kind,event_id) VALUES(${e.id + ":exposure"},${e.account},${o.id},${p.partner_id},${p.order_id},${delta},${delta > 0 ? "dispute_reversal" : old ? "dispute_correction" : "dispute_debit"},${e.id}) ON CONFLICT DO NOTHING`;
    return true;
  }
  if (e.type.startsWith("charge.")) {
    // One PaymentIntent can have failed authorisations followed by a different
    // successful charge. Only actual captured charge evidence is canonical.
    z.boolean().parse(o.paid);
    z.boolean().parse(o.captured);
    if (!o.paid || !o.captured) return true;
    positive.parse(o.amount);
    key.parse(o.payment_intent);
    const [p] =
      await tx`SELECT p.* FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.provider_id=${o.payment_intent} AND p.stripe_account=${e.account} FOR UPDATE OF o,p`;
    if (!p) return defer(tx, e, "unknown_charge_payment");
    if (o.amount_captured !== undefined && o.amount_captured !== p.amount)
      return defer(tx, e, "partial_capture_requires_review", true);
    if (p.amount !== o.amount || (p.charge_id && p.charge_id !== o.id))
      throw fail("Charge reconciliation mismatch");
    await tx`UPDATE payments SET charge_id=${o.id} WHERE id=${p.id} AND charge_id IS NULL`;
    return true;
  }
  if (e.type.startsWith("application_fee.")) {
    money.nonnegative().parse(o.amount);
    money.nonnegative().max(o.amount).parse(o.amount_refunded);
    key.parse(o.charge);
    const [p] =
      await tx`SELECT p.order_id,o.service_fee FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.charge_id=${o.charge} AND p.stripe_account=${e.account}`;
    if (!p) return defer(tx, e, "unknown_application_fee_charge");
    if (o.amount !== p.service_fee)
      throw fail("Application fee allocation mismatch");
    const [old] =
      await tx`SELECT * FROM provider_application_fees WHERE provider_id=${o.id} FOR UPDATE`;
    if (
      old &&
      (old.account !== e.account ||
        old.order_id !== p.order_id ||
        old.amount !== o.amount)
    )
      throw fail("Application fee immutable fields mismatch");
    await tx`INSERT INTO provider_application_fees(provider_id,account,order_id,amount,amount_refunded,last_event_id) VALUES(${o.id},${e.account},${p.order_id},${o.amount},${o.amount_refunded},${e.id}) ON CONFLICT(provider_id) DO UPDATE SET amount_refunded=greatest(provider_application_fees.amount_refunded,EXCLUDED.amount_refunded),last_event_id=EXCLUDED.last_event_id`;
    return true;
  }
  if (e.type.startsWith("payout.")) {
    positive.parse(o.amount);
    z.enum(["pending", "in_transit", "paid", "failed", "canceled"]).parse(
      o.status,
    );
    z.boolean().parse(o.automatic);
    money.nonnegative().parse(o.arrival_date);
    const [old] =
      await tx`SELECT * FROM provider_payouts WHERE account=${e.account} AND provider_id=${o.id} FOR UPDATE`;
    if (old && (old.amount !== o.amount || old.automatic !== o.automatic))
      throw fail("Payout immutable fields mismatch");
    if (old && e.source !== "provider_read") {
      if (e.created < Number(old.last_event_created)) return true;
      if (
        e.created === Number(old.last_event_created) &&
        old.status !== o.status
      )
        return defer(tx, e, "same_timestamp_payout_conflict", true);
    }
    await tx`INSERT INTO provider_payouts(account,provider_id,partner_id,amount,currency,status,automatic,arrival_date,balance_transaction,failure_code,last_event_created,last_event_id) VALUES(${e.account},${o.id},${partner.id},${o.amount},'gbp',${o.status},${o.automatic},${o.arrival_date},${o.balance_transaction},${o.failure_code},${e.created},${e.id}) ON CONFLICT(account,provider_id) DO UPDATE SET status=EXCLUDED.status,arrival_date=EXCLUDED.arrival_date,balance_transaction=EXCLUDED.balance_transaction,failure_code=EXCLUDED.failure_code,last_event_created=EXCLUDED.last_event_created,last_event_id=EXCLUDED.last_event_id`;
    return true;
  }
  if (e.type === "balance_transaction.snapshot") {
    if (e.source !== "provider_read")
      throw fail("Balance snapshots require authenticated provider reads");
    money.parse(o.amount);
    money.parse(o.fee);
    money.parse(o.net);
    key.parse(o.source);
    key.parse(o.category);
    money.nonnegative().parse(o.available_on);
    z.enum(["pending", "available"]).parse(o.status);
    const fees = z
      .array(z.object({ amount: money, currency: z.literal("gbp"), type: key }))
      .parse(o.fee_details);
    if (o.net !== o.amount - o.fee) throw fail("Balance net mismatch");
    const [old] =
      await tx`SELECT * FROM provider_balances WHERE account=${e.account} AND provider_id=${o.id}`;
    if (
      old &&
      (old.amount !== o.amount ||
        old.fee !== o.fee ||
        old.net !== o.net ||
        old.source_id !== o.source)
    )
      throw fail("Balance immutable fields mismatch");
    await tx`INSERT INTO provider_balances(account,provider_id,partner_id,source_id,amount,fee,net,currency,category,fee_details,available_on) VALUES(${e.account},${o.id},${partner.id},${o.source},${o.amount},${o.fee},${o.net},'gbp',${o.category},${tx.json(fees)},${o.available_on}) ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO provider_balance_status(account,provider_id,status,event_id) VALUES(${e.account},${o.id},${o.status},${e.id}) ON CONFLICT(account,provider_id) DO UPDATE SET status=EXCLUDED.status,event_id=EXCLUDED.event_id,checked_at=now()`;
    if (o.payout_id) {
      const [payout] =
        await tx`SELECT automatic FROM provider_payouts WHERE account=${e.account} AND provider_id=${o.payout_id}`;
      if (!payout) return defer(tx, e, "unknown_payout");
      if (!payout.automatic)
        return defer(
          tx,
          e,
          "manual_payout_cannot_be_automatically_allocated",
          true,
        );
      await tx`INSERT INTO payout_balance_links VALUES(${e.account},${o.payout_id},${o.id}) ON CONFLICT DO NOTHING`;
      const [link] =
        await tx`SELECT payout_id FROM payout_balance_links WHERE account=${e.account} AND balance_id=${o.id}`;
      if (link?.payout_id !== o.payout_id)
        throw fail("Balance already allocated to another payout");
    }
    return true;
  }
  return false;
}
export async function recordFinancialEvent(tx: Query, e: FinancialEvent) {
  await tx`INSERT INTO provider_events(event_id,account,kind,provider_created,source,payload) VALUES(${e.id},${e.account},${e.type},${e.created},${e.source},${tx.json(e.data)}) ON CONFLICT DO NOTHING`;
  await tx`INSERT INTO reconciliation_jobs(event_id) VALUES(${e.id}) ON CONFLICT DO NOTHING`;
  const [job] =
    await tx`SELECT * FROM reconciliation_jobs WHERE event_id=${e.id} FOR UPDATE`;
  if (job.state === "processed") return;
  await tx`UPDATE reconciliation_jobs SET attempts=attempts+1 WHERE event_id=${e.id}`;
  if (await applyFinancialEvent(tx, e))
    await tx`UPDATE reconciliation_jobs SET state='processed',last_error=NULL,updated_at=now() WHERE event_id=${e.id}`;
}
export async function replayFinancialEvents(db: Database, eventId?: string) {
  const jobs = eventId
    ? await db`SELECT e.* FROM provider_events e JOIN reconciliation_jobs j ON j.event_id=e.event_id WHERE e.event_id=${eventId}`
    : await db`SELECT e.* FROM provider_events e JOIN reconciliation_jobs j ON j.event_id=e.event_id WHERE j.state='pending' ORDER BY j.updated_at LIMIT 20`;
  for (const r of jobs) {
    try {
      await db.begin((tx) =>
        recordFinancialEvent(tx, {
          id: r.event_id,
          account: r.account,
          type: r.kind,
          created: Number(r.provider_created),
          source: r.source,
          data: r.payload,
        }),
      );
    } catch (e) {
      await db`UPDATE reconciliation_jobs SET state='blocked',last_error='provider_evidence_requires_review',updated_at=now() WHERE event_id=${r.event_id}`;
      if (eventId) throw e;
    }
  }
}
export function snapshotEvent(
  account: string,
  type: string,
  object: Record<string, any>,
): FinancialEvent {
  const event = financialEvent(
    {
      id:
        "read:" +
        createHash("sha256")
          .update(account + type + JSON.stringify(object) + Date.now())
          .digest("hex"),
      account,
      type,
      created: Math.floor(Date.now() / 1000),
      data: { object },
    },
    "provider_read",
  );
  if (!event) throw new Error("Unsupported snapshot");
  return event;
}
