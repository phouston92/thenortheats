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
    await tx`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points,tax_confirmed) VALUES(${o.partner_id},${o.id},${o.id + ":" + kind},${kind},${amount},${p.vat_basis_points},${p.tax_confirmed}) ON CONFLICT(reference) DO NOTHING`;
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
      (s, l) => s + ratio(l.amount, l.vat_basis_points, 10000),
      0,
    );
    const [row] =
      await tx`INSERT INTO invoices(partner_id,period_start,period_end,net,vat,total) VALUES(${partnerId},${parsed},${end},${net},${vat},${net + vat}) RETURNING *`;
    for (const l of entries)
      await tx`INSERT INTO invoice_lines(invoice_id,ledger_id,description,net,vat) VALUES(${row.id},${l.id},${l.kind + " " + (l.order_id || "")},${l.amount},${ratio(l.amount, l.vat_basis_points, 10000)})`;
    return row;
  });
}
export async function orderRoutes(
  app: FastifyInstance,
  db: Database,
  providerOverride?: PaymentProvider,
) {
  const provider = () => providerOverride || new StripeProvider();
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
    const fingerprint = hash(JSON.stringify(v) + hash(token));
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
      const [o] = await db<
        {
          id: string;
          total: number;
          service_fee: number;
          stripe_account: string;
        }[]
      >`SELECT o.*,p.stripe_account FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=${result.id}`;
      const intent = await provider().intent(o, o.stripe_account);
      await db`UPDATE payments SET provider_id=${intent.id} WHERE order_id=${o.id}`;
      return reply
        .code(201)
        .send({ id: o.id, clientSecret: intent.clientSecret });
    }
    return reply.code(201).send({ id: result.id });
  });
  app.get("/api/orders/:id", async (req, reply) => {
    const orderId = id.parse((req.params as any).id);
    const [o] =
      await db`SELECT id,partner_id,customer_id,tracking_hash,customer_name,customer_email,address,status,payment_state,fulfilment,subtotal,delivery_fee,service_fee,total,created_at,refunded_amount FROM orders WHERE id=${orderId}`;
    if (!o) return reply.code(404).send({ error: "Order not found" });
    const token = req.headers["x-order-token"];
    let allowed = typeof token === "string" && hash(token) === o.tracking_hash;
    if (!allowed && req.cookies.north_session) {
      const a = await actor(db, req);
      allowed =
        a.role === "admin" ||
        o.customer_id === a.id ||
        a.partners.includes(o.partner_id);
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
      if (v.status === "completed") await completeFees(tx, o);
      await tx`INSERT INTO notifications(order_id,recipient,kind,payload) VALUES(${o.id},${o.customer_email},${"status:" + v.status},${tx.json({ status: v.status })}) ON CONFLICT DO NOTHING`;
      await audit(tx, a, "order." + v.status, o.id, p);
      return { id: o.id, status: v.status };
    });
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
    if (reservation.refund.status === "succeeded") return reservation.refund;
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
      await db`UPDATE refunds SET provider_id=${res.id},status=${res.status === "failed" ? "failed" : "pending"} WHERE id=${reservation.refund.id}`;
      return { status: res.status };
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
  return db.begin(async (tx) => {
    const [r] = await tx`SELECT * FROM refunds WHERE id=${refundId} FOR UPDATE`;
    if (!r) throw fail("Unknown refund");
    if (r.status === "succeeded") return r;
    const [o] =
      await tx`SELECT * FROM orders WHERE id=${r.order_id} FOR UPDATE`;
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
        await tx`SELECT id FROM ledger_entries WHERE reference=${o.id + ":" + kind}`;
      if (!original) continue;
      const adjustment =
        ratio(fee, cumulative, o.total) -
        ratio(fee, o.refunded_amount, o.total);
      if (adjustment)
        await tx`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points,tax_confirmed) VALUES(${o.partner_id},${o.id},${r.id + ":" + kind},'fee_credit',${-adjustment},${o.pricing_snapshot.vat_basis_points},${o.pricing_snapshot.tax_confirmed}) ON CONFLICT DO NOTHING`;
    }
    await tx`UPDATE refunds SET status='succeeded',provider_id=${providerId} WHERE id=${r.id}`;
    await tx`UPDATE orders SET refunded_amount=${cumulative},payment_state=${cumulative === o.total ? "refunded" : "partially_refunded"} WHERE id=${o.id}`;
    await tx`INSERT INTO audit_logs(actor_id,partner_id,action,subject) VALUES(${actorId},${o.partner_id},'refund.settled',${r.id})`;
    return { id: r.id, status: "succeeded", amount: r.amount };
  });
}
