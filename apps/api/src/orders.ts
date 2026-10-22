import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database, Query } from "../../../packages/database/src/index";
import { checkoutInput, id } from "../../../packages/validation/src/index";
import {
  canTransition,
  partnerFee,
  ratio,
  type OrderState,
} from "../../../packages/shared/src/index";
import {
  StripeProvider,
  type PaymentProvider,
} from "../../../packages/payments/src/index";
import { actor, admin, tenant, hash, audit } from "./auth";
const fail = (message: string, statusCode = 409) =>
  Object.assign(new Error(message), { statusCode });
export async function completeFees(tx: Query, o: any) {
  const p = o.pricing_snapshot;
  for (const [kind, amount] of [
    ["partner_fee", o.partner_fee],
    ...(o.payment_method === "cash"
      ? [["cash_service_fee", o.service_fee]]
      : []),
  ] as [string, number][])
    await tx`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points,tax_confirmed,vat_amount) VALUES(${o.partner_id},${o.id},${o.id + ":" + kind},${kind},${amount},${p.vat_basis_points},${p.tax_confirmed},${ratio(amount, p.vat_basis_points, 10000)}) ON CONFLICT(reference) DO NOTHING`;
}
export async function invoice(db: Database, partnerId: string, start: string) {
  const parsed = z.iso.date().parse(start);
  const d = new Date(parsed);
  if (d.getUTCDay() !== 1)
    throw fail("Billing period must start Monday (UTC)", 400);
  const end = new Date(d.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  if (new Date(end) > new Date())
    throw fail("Only closed weekly periods may be billed");
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${partnerId},1))`;
    const [existing] =
      await tx`SELECT * FROM invoices WHERE partner_id=${partnerId} AND period_start=${parsed}`;
    if (existing) return existing;
    // Older unbilled adjustments are carried forward. Never add new lines to an existing invoice.
    const entries =
      await tx`SELECT l.* FROM ledger_entries l WHERE l.partner_id=${partnerId} AND l.created_at<${end}::date AND NOT EXISTS(SELECT 1 FROM invoice_lines il WHERE il.ledger_id=l.id) ORDER BY l.created_at,l.id FOR UPDATE`;
    const net = entries.reduce((s, l) => s + l.amount, 0);
    const vat = entries.reduce(
      (s, l) =>
        s + (l.vat_amount ?? ratio(l.amount, l.vat_basis_points, 10000)),
      0,
    );
    const [row] =
      await tx`INSERT INTO invoices(partner_id,period_start,period_end,net,vat,total) VALUES(${partnerId},${parsed},${end},${net},${vat},${net + vat}) RETURNING *`;
    for (const l of entries)
      await tx`INSERT INTO invoice_lines(invoice_id,ledger_id,description,net,vat) VALUES(${row.id},${l.id},${l.kind + " " + (l.order_id || "")},${l.amount},${l.vat_amount ?? ratio(l.amount, l.vat_basis_points, 10000)})`;
    return row;
  });
}
export async function orderRoutes(
  app: FastifyInstance,
  db: Database,
  providerOverride?: PaymentProvider,
) {
  const provider = () => providerOverride || new StripeProvider();
  async function resumePayment(orderId: string) {
    const [o] = await db<
      {
        id: string;
        total: number;
        service_fee: number;
        stripe_account: string;
        provider_id: string | null;
        updated_at: Date;
        status: string;
      }[]
    >`SELECT o.*,p.stripe_account,p.provider_id,p.updated_at FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=${orderId}`;
    if (o.status !== "awaiting_payment") return { id: o.id };
    // Stripe may prune idempotency keys after 24 hours. Retrieve known intents,
    // and fail closed for old interrupted creation instead of risking a second charge.
    if (
      !o.provider_id &&
      Date.now() - new Date(o.updated_at).getTime() >= 23 * 60 * 60 * 1000
    )
      throw fail(
        "Interrupted payment requires provider reconciliation before retry",
      );
    const intent = await provider().intent(
      o,
      o.stripe_account,
      o.provider_id ?? undefined,
    );
    const bound =
      await db`UPDATE payments SET provider_id=${intent.id} WHERE order_id=${o.id} AND (provider_id IS NULL OR provider_id=${intent.id}) RETURNING id`;
    if (!bound.length) throw fail("Payment provider identity mismatch");
    return {
      id: o.id,
      clientSecret: intent.clientSecret,
      stripeAccount: o.stripe_account,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.startsWith("pk_test_")
        ? process.env.STRIPE_PUBLISHABLE_KEY
        : null,
    };
  }
  app.post("/api/orders", async (req, reply) => {
    const v = checkoutInput.parse(req.body);
    const requestKey = z.uuid().parse(req.headers["idempotency-key"]);
    const token = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.headers["x-order-token"]);
    if (v.scheduledAt)
      throw fail(
        "Scheduled checkout not enabled until authorisation and capacity rules are configured",
        422,
      );
    let customerId: string | null = null;
    if (req.cookies.north_session) {
      const a = await actor(db, req);
      if (a.role !== "customer")
        throw fail("Use customer checkout account", 403);
      customerId = a.id;
    }
    const fingerprint = hash(
      JSON.stringify(v) + hash(token) + (customerId ?? "guest"),
    );
    const result = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},2))`;
      const [existing] =
        await tx`SELECT id,request_hash,payment_method FROM orders WHERE request_key=${requestKey}`;
      if (existing) {
        if (existing.request_hash !== fingerprint)
          throw fail("Idempotency key reused with different request");
        return existing;
      }
      const [p] =
        await tx`SELECT p.* FROM partners p JOIN towns t ON t.id=p.town_id WHERE p.id=${v.partnerId} AND p.status='active' AND NOT p.paused AND t.active FOR UPDATE OF p`;
      if (!p) throw fail("Takeaway is unavailable");
      if (v.fulfilment === "collection" && !p.collection)
        throw fail("Collection unavailable");
      if (
        v.fulfilment === "delivery" &&
        (!v.address ||
          !p.delivery_postcodes.includes(
            v.address.postcode.trim().toUpperCase().split(/\s+/)[0],
          ))
      )
        throw fail("Address outside supported delivery postcodes", 422);
      if (v.paymentMethod === "card" && !p.stripe_account)
        throw fail("Card payments unavailable; use cash", 422);
      if (
        v.paymentMethod === "card" &&
        !providerOverride &&
        !process.env.STRIPE_SECRET_KEY
      )
        throw fail("Test card payments not configured", 503);
      const [f] = await tx<
        {
          id: string;
          fixed_fee: number;
          basis_points: number;
          minimum_fee: number;
          maximum_fee: number | null;
          service_fee: number;
          subscription_fee: number;
        }[]
      >`SELECT * FROM fee_policies WHERE partner_id=${p.id} AND effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1`;
      if (!f) throw fail("Approved pricing required");
      if (f.subscription_fee > 0)
        throw fail(
          "Subscription billing is not implemented; policy cannot take orders",
          422,
        );
      const seen = new Set<string>();
      let subtotal = 0;
      const items: {
        id: string;
        name: string;
        price: number;
        quantity: number;
      }[] = [];
      for (const item of v.items) {
        if (seen.has(item.productId))
          throw fail("Duplicate product; combine quantities", 400);
        seen.add(item.productId);
        const [product] = await tx<
          { id: string; name: string; price: number }[]
        >`SELECT * FROM products WHERE id=${item.productId} AND partner_id=${p.id} AND available FOR SHARE`;
        if (!product) throw fail("Product unavailable");
        subtotal += product.price * item.quantity;
        items.push({ ...item, ...product });
      }
      if (!Number.isSafeInteger(subtotal) || subtotal > 1000000)
        throw fail("Basket exceeds development order limit", 422);
      const delivery = v.fulfilment === "delivery" ? p.delivery_fee : 0;
      const total = subtotal + delivery + f.service_fee;
      const [o] =
        await tx`INSERT INTO orders(partner_id,customer_id,tracking_hash,request_key,request_hash,customer_name,customer_email,fulfilment,address,status,payment_method,payment_state,subtotal,delivery_fee,service_fee,partner_fee,total,pricing_snapshot) VALUES(${p.id},${customerId},${hash(token)},${requestKey},${fingerprint},${v.customerName},${v.customerEmail},${v.fulfilment},${v.address ? tx.json(v.address) : null},${v.paymentMethod === "cash" ? "awaiting_acceptance" : "awaiting_payment"},${v.paymentMethod},${v.paymentMethod === "cash" ? "pending" : "pending"},${subtotal},${delivery},${f.service_fee},${partnerFee(subtotal, f)},${total},${tx.json(f)}) RETURNING *`;
      for (const item of items)
        await tx`INSERT INTO order_items(order_id,product_id,name,quantity,unit_price) VALUES(${o.id},${item.id},${item.name},${item.quantity},${item.price})`;
      await tx`INSERT INTO order_history(order_id,status) VALUES(${o.id},${o.status})`;
      if (v.paymentMethod === "cash")
        await tx`INSERT INTO notifications(order_id,recipient,kind) VALUES(${o.id},${p.id},'new_order') ON CONFLICT DO NOTHING`;
      if (v.paymentMethod === "card")
        await tx`INSERT INTO payments(order_id,state,amount,stripe_account) VALUES(${o.id},'pending',${total},${p.stripe_account})`;
      return o;
    });
    // Provider call occurs outside the SQL transaction, recoverable via the same order idempotency key.
    if (result.payment_method === "card") {
      return reply.code(201).send(await resumePayment(result.id));
    }
    return reply.code(201).send({ id: result.id });
  });
  app.post("/api/orders/:id/payment", async (req, reply) => {
    const orderId = id.parse((req.params as any).id);
    const [o] =
      await db`SELECT id,tracking_hash,customer_id,payment_method FROM orders WHERE id=${orderId}`;
    if (!o) return reply.code(404).send({ error: "Order not found" });
    const token = req.headers["x-order-token"];
    let allowed = typeof token === "string" && hash(token) === o.tracking_hash;
    if (req.cookies.north_session) {
      const a = await actor(db, req);
      allowed = allowed || (a.role === "customer" && o.customer_id === a.id);
    }
    if (!allowed) return reply.code(404).send({ error: "Order not found" });
    if (o.payment_method !== "card") throw fail("Card order required");
    return resumePayment(orderId);
  });
  app.get("/api/orders/:id", async (req, reply) => {
    const orderId = id.parse((req.params as any).id);
    const [o] =
      await db`SELECT id,partner_id,customer_id,tracking_hash,customer_name,customer_email,address,status,payment_state,payment_method,fulfilment,subtotal,delivery_fee,service_fee,total,created_at,refunded_amount FROM orders WHERE id=${orderId}`;
    if (!o) return reply.code(404).send({ error: "Order not found" });
    const token = req.headers["x-order-token"];
    let allowed = typeof token === "string" && hash(token) === o.tracking_hash;
    if (!allowed && req.cookies.north_session) {
      const a = await actor(db, req);
      allowed =
        a.role === "admin" ||
        o.customer_id === a.id ||
        (["owner", "operator"].includes(a.role) &&
          a.partners.includes(o.partner_id));
    }
    if (!allowed) return reply.code(404).send({ error: "Order not found" });
    delete o.tracking_hash;
    delete o.customer_id;
    return {
      ...o,
      items:
        await db`SELECT name,quantity,unit_price FROM order_items WHERE order_id=${orderId}`,
      history:
        await db`SELECT status,created_at FROM order_history WHERE order_id=${orderId} ORDER BY id`,
    };
  });
  app.get("/api/account/orders", async (req) => {
    const a = await actor(db, req);
    return db`SELECT id,status,payment_state,total,created_at,partner_id FROM orders WHERE customer_id=${a.id} ORDER BY created_at DESC LIMIT 100`;
  });
  app.get("/api/admin/orders", async (req) => {
    admin(await actor(db, req));
    return db`SELECT o.id,o.partner_id,o.customer_name,o.status,o.payment_method,o.payment_state,o.total,o.created_at,p.name AS partner FROM orders o JOIN partners p ON p.id=o.partner_id ORDER BY o.created_at DESC LIMIT 200`;
  });
  app.get("/api/partner/:id/orders", async (req) => {
    const p = id.parse((req.params as any).id);
    tenant(await actor(db, req), p);
    return db`SELECT id,customer_name,status,fulfilment,payment_method,payment_state,total,created_at FROM orders WHERE partner_id=${p} ORDER BY created_at DESC LIMIT 100`;
  });
  app.post("/api/partner/:id/orders/:orderId/transition", async (req) => {
    const a = await actor(db, req);
    const p = id.parse((req.params as any).id);
    tenant(a, p);
    const orderId = id.parse((req.params as any).orderId);
    const v = z
      .object({
        status: z.enum([
          "accepted",
          "rejected",
          "preparing",
          "ready",
          "out_for_delivery",
          "completed",
          "cancelled",
        ]),
        reason: z.string().trim().min(3).max(300).optional(),
      })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [o] =
        await tx`SELECT * FROM orders WHERE id=${orderId} AND partner_id=${p} FOR UPDATE`;
      if (!o) throw fail("Order not found", 404);
      if (o.status === v.status) return { id: o.id, status: o.status };
      if (!canTransition(o.status as OrderState, v.status, o.fulfilment))
        throw fail("Invalid order transition");
      if (["rejected", "cancelled"].includes(v.status) && !v.reason)
        throw fail("Reason required", 400);
      if (
        v.status === "completed" &&
        o.payment_method === "card" &&
        o.payment_state !== "captured"
      )
        throw fail("Captured payment required");
      await tx`UPDATE orders SET status=${v.status},completed_at=CASE WHEN ${v.status}='completed' THEN now() ELSE completed_at END,payment_state=CASE WHEN ${v.status}='completed' AND payment_method='cash' THEN 'captured' ELSE payment_state END WHERE id=${o.id}`;
      await tx`INSERT INTO order_history(order_id,status,reason,actor_id) VALUES(${o.id},${v.status},${v.reason || null},${a.id})`;
      if (
        ["cancelled", "rejected"].includes(v.status) &&
        o.payment_method === "card"
      )
        await tx`INSERT INTO payment_compensations(order_id) VALUES(${o.id}) ON CONFLICT DO NOTHING`;
      if (v.status === "completed") await completeFees(tx, o);
      await tx`INSERT INTO notifications(order_id,recipient,kind,payload) VALUES(${o.id},${o.customer_email},${"status:" + v.status},${tx.json({ status: v.status })}) ON CONFLICT DO NOTHING`;
      await audit(tx, a, "order." + v.status, o.id, p);
      return { id: o.id, status: v.status };
    });
  });
  app.post("/api/partner/:id/orders/:orderId/capture", async (req) => {
    const a = await actor(db, req),
      p = id.parse((req.params as any).id);
    tenant(a, p, true);
    const orderId = id.parse((req.params as any).orderId);
    const operation = await db.begin(async (tx) => {
      const [o] =
        await tx`SELECT o.*,p.provider_id,p.stripe_account FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=${orderId} AND o.partner_id=${p} FOR UPDATE OF o,p`;
      if (!o) throw fail("Order not found", 404);
      if (o.payment_state === "captured") return null;
      if (
        o.payment_state !== "authorised" ||
        ["cancelled", "rejected"].includes(o.status)
      )
        throw fail("Authorised active payment required");
      const [op] =
        await tx`INSERT INTO capture_operations(order_id) VALUES(${o.id}) ON CONFLICT(order_id) DO UPDATE SET order_id=EXCLUDED.order_id RETURNING *`;
      if (Date.now() - new Date(op.created_at).getTime() >= 23 * 60 * 60 * 1000)
        throw fail("Interrupted capture requires reconciliation");
      return {
        provider_id: String(o.provider_id),
        stripe_account: String(o.stripe_account),
        key: String(op.request_key),
      };
    });
    if (operation)
      await provider().capture(
        operation.provider_id,
        operation.stripe_account,
        operation.key,
      );
    // Only a verified webhook can report captured or advance fulfilment.
    return { status: operation ? "awaiting_webhook" : "captured" };
  });
  app.get("/api/partner/:id/finance", async (req) => {
    const p = id.parse((req.params as any).id);
    tenant(await actor(db, req), p, true);
    return {
      ledger:
        await db`SELECT * FROM ledger_entries WHERE partner_id=${p} ORDER BY created_at DESC LIMIT 200`,
      invoices:
        await db`SELECT * FROM invoices WHERE partner_id=${p} ORDER BY period_start DESC`,
    };
  });
  app.get("/api/admin/finance", async (req) => {
    admin(await actor(db, req));
    return {
      ledger:
        await db`SELECT l.*,p.name AS partner FROM ledger_entries l JOIN partners p ON p.id=l.partner_id ORDER BY l.created_at DESC LIMIT 200`,
      invoices:
        await db`SELECT i.*,p.name AS partner FROM invoices i JOIN partners p ON p.id=i.partner_id ORDER BY i.created_at DESC LIMIT 200`,
    };
  });
  app.post("/api/admin/invoices", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const v = z
      .object({ partnerId: id, periodStart: z.iso.date() })
      .parse(req.body);
    const row = await invoice(db, v.partnerId, v.periodStart);
    await audit(db, a, "invoice.generated", row.id, v.partnerId);
    return row;
  });
  app.get("/api/invoices/:id", async (req, reply) => {
    const a = await actor(db, req);
    const invoiceId = id.parse((req.params as any).id);
    const [i] = await db`SELECT * FROM invoices WHERE id=${invoiceId}`;
    if (!i) return reply.code(404).send({ error: "Invoice not found" });
    tenant(a, i.partner_id, true);
    return {
      ...i,
      lines:
        await db`SELECT * FROM invoice_lines WHERE invoice_id=${invoiceId}`,
    };
  });
  app.post("/api/admin/orders/:id/refund", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const orderId = id.parse((req.params as any).id);
    const v = z
      .object({
        amount: z.number().int().min(1),
        requestKey: z.uuid(),
        refundServiceFee: z.boolean(),
      })
      .parse(req.body);
    // Reserve before external calls, under the order lock. One outstanding refund at a time.
    const reservation = await db.begin(async (tx) => {
      const [o] = await tx`SELECT * FROM orders WHERE id=${orderId} FOR UPDATE`;
      if (!o) throw fail("Order not found", 404);
      const [prior] =
        await tx`SELECT * FROM refunds WHERE request_key=${v.requestKey}`;
      if (prior) {
        if (
          prior.order_id !== o.id ||
          prior.amount !== v.amount ||
          prior.refund_service_fee !== v.refundServiceFee
        )
          throw fail("Refund key conflict");
        if (prior.status === "failed")
          throw fail(
            "Failed refund is terminal; use a new request key after reconciliation",
          );
        return { o, refund: prior };
      }
      if (
        o.payment_state !== "captured" &&
        o.payment_state !== "partially_refunded"
      )
        throw fail("Payment is not refundable");
      const [pending] =
        await tx`SELECT id FROM refunds WHERE order_id=${o.id} AND status='pending'`;
      if (pending) throw fail("Refund operation pending; reconcile it first");
      if (v.amount > o.total - o.refunded_amount)
        throw fail("Refund exceeds remaining amount");
      if (o.payment_method === "cash")
        throw fail(
          "Cash refunds need confirmed partner repayment and are not enabled",
          422,
        );
      const [r] =
        await tx`INSERT INTO refunds(order_id,request_key,amount,status,refund_service_fee) VALUES(${o.id},${v.requestKey},${v.amount},'pending',${v.refundServiceFee}) RETURNING *`;
      return { o, refund: r };
    });
    if (
      reservation.refund.status === "succeeded" ||
      reservation.refund.provider_id
    )
      return {
        id: reservation.refund.id,
        status: reservation.refund.status,
        amount: reservation.refund.amount,
      };
    if (
      Date.now() - new Date(reservation.refund.created_at).getTime() >=
      23 * 60 * 60 * 1000
    )
      throw fail(
        "Interrupted refund requires provider reconciliation before retry",
      );
    const [payment] =
      await db`SELECT * FROM payments WHERE order_id=${orderId}`;
    const res = await provider().refund(
      payment.provider_id,
      payment.stripe_account,
      v.amount,
      v.requestKey,
      reservation.refund.refund_service_fee,
    );
    if (res.status !== "succeeded") {
      // A signed webhook may settle while the original HTTP response is in flight.
      // Never downgrade a terminal result with a stale pending/failed response.
      const [current] =
        await db`UPDATE refunds SET provider_id=${res.id},status=${["failed", "canceled"].includes(res.status) ? "failed" : "pending"} WHERE id=${reservation.refund.id} AND status='pending' AND (provider_id IS NULL OR provider_id=${res.id}) RETURNING status`;
      if (current) return { status: current.status };
      const [settled] =
        await db`SELECT status,provider_id FROM refunds WHERE id=${reservation.refund.id}`;
      if (settled?.provider_id !== res.id)
        throw fail("Refund provider identity mismatch");
      return { status: settled.status };
    }
    return settleRefund(db, reservation.refund.id, res.id, a.id);
  });
}
export async function settleRefund(
  db: Database,
  refundId: string,
  providerId: string,
  actorId: string | null,
) {
  return db.begin((tx) =>
    settleRefundInTransaction(tx, refundId, providerId, actorId),
  );
}
export async function settleRefundInTransaction(
  tx: Query,
  refundId: string,
  providerId: string,
  actorId: string | null,
) {
  const [lookup] = await tx`SELECT order_id FROM refunds WHERE id=${refundId}`;
  if (!lookup) throw fail("Unknown refund");
  // Match the reservation path's lock order: order first, refund second.
  const [o] =
    await tx`SELECT * FROM orders WHERE id=${lookup.order_id} FOR UPDATE`;
  const [r] = await tx`SELECT * FROM refunds WHERE id=${refundId} FOR UPDATE`;
  if (r.provider_id && r.provider_id !== providerId)
    throw fail("Refund provider identity mismatch");
  if (r.status === "succeeded")
    return { id: r.id, status: r.status, amount: r.amount };
  if (r.status !== "pending")
    throw fail("Refund is terminal; reconciliation required");
  const cumulative = o.refunded_amount + r.amount;
  if (cumulative > o.total) throw fail("Refund exceeds payment");
  // Reverse fees cumulatively to avoid penny drift over many partial refunds.
  for (const [kind, fee] of [
    ["partner_fee", o.partner_fee],
    ...(o.payment_method === "cash" && r.refund_service_fee
      ? [["cash_service_fee", o.service_fee]]
      : []),
  ] as [string, number][]) {
    const [original] =
      await tx`SELECT amount,vat_basis_points,tax_confirmed,vat_amount FROM ledger_entries WHERE reference=${o.id + ":" + kind}`;
    if (!original) continue;
    const adjustment =
      ratio(fee, cumulative, o.total) - ratio(fee, o.refunded_amount, o.total);
    const originalVat =
      original.vat_amount ??
      ratio(original.amount, original.vat_basis_points, 10000);
    const previousCredits =
      await tx`SELECT amount,vat_basis_points,vat_amount FROM ledger_entries WHERE order_id=${o.id} AND kind='fee_credit' AND reference LIKE ${"%:" + kind}`;
    const alreadyReversedVat = -previousCredits.reduce(
      (sum, l) =>
        sum + (l.vat_amount ?? ratio(l.amount, l.vat_basis_points, 10000)),
      0,
    );
    const targetVat =
      fee === 0 ? 0 : ratio(originalVat, ratio(fee, cumulative, o.total), fee);
    const vatAdjustment = targetVat - alreadyReversedVat;
    // Carry cumulative tax rounding explicitly; never recompute each partial
    // credit independently (three 33/34/33p credits must reverse exactly 20p VAT).
    if (adjustment || vatAdjustment)
      await tx`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points,tax_confirmed,vat_amount) VALUES(${o.partner_id},${o.id},${r.id + ":" + kind},'fee_credit',${-adjustment},${original.vat_basis_points},${original.tax_confirmed},${-vatAdjustment}) ON CONFLICT DO NOTHING`;
  }
  const paymentState =
    cumulative === o.total ? "refunded" : "partially_refunded";
  await tx`UPDATE refunds SET status='succeeded',provider_id=${providerId} WHERE id=${r.id}`;
  await tx`UPDATE orders SET refunded_amount=${cumulative},payment_state=${paymentState} WHERE id=${o.id}`;
  await tx`UPDATE payments SET state=${paymentState},updated_at=now() WHERE order_id=${o.id}`;
  if (cumulative === o.total)
    await tx`UPDATE payment_compensations SET state='succeeded',last_error=NULL,updated_at=now() WHERE order_id=${o.id}`;
  await tx`INSERT INTO audit_logs(actor_id,partner_id,action,subject) VALUES(${actorId},${o.partner_id},'refund.settled',${r.id})`;
  return { id: r.id, status: "succeeded", amount: r.amount };
}
