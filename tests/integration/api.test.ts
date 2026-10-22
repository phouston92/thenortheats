import { validateRuntimeDatabase } from "../../packages/database/src/runtime-security";
import { compensateOrder } from "../../apps/api/src/compensation";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "../../packages/database/src/index";
import { migrate } from "../../packages/database/src/migrate";
import { seed } from "../../packages/database/src/seed";
import { createApp } from "../../apps/api/src/app";
import Stripe from "stripe";
import { TOTP, Secret } from "otpauth";
import type { PaymentProvider } from "../../packages/payments/src/index";
import { weekStart } from "../../packages/shared/src/index";
import { encryptMfa } from "../../apps/api/src/mfa";
process.env.MFA_ENCRYPTION_KEY = "42".repeat(32);
import { hash } from "../../apps/api/src/auth";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point at a dedicated *_test database",
  );
process.env.DEV_MAIL_DIR = "/tmp/north-integration-mail";
const db = connect(url);
const refundProvider = vi
  .fn<PaymentProvider["refund"]>()
  .mockImplementation(async (_intent, _account, _amount, key) => ({
    id: "re_" + key,
    status: "succeeded",
  }));
const intentProvider = vi
  .fn<PaymentProvider["intent"]>()
  .mockImplementation(async (o) => ({
    id: "pi_" + o.id,
    clientSecret: "test_fixture_only",
  }));
const captureProvider = vi
  .fn<PaymentProvider["capture"]>()
  .mockResolvedValue(undefined);
const app = await createApp(db, {
  intent: intentProvider,
  refund: refundProvider,
  capture: captureProvider,
});
const p1 = "10000000-0000-4000-8000-000000000001",
  p2 = "10000000-0000-4000-8000-000000000002";
let owner: any, operator: any, admin: any;
async function session(role: string, email: string, p?: string) {
  const [u] =
    await db`INSERT INTO users(email,role) VALUES(${email},${role}) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role RETURNING id`;
  if (p)
    await db`INSERT INTO memberships VALUES(${u.id},${p}) ON CONFLICT DO NOTHING`;
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(24).toString("hex");
  await db`INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(${hash(token)},${u.id},${csrf},now()+interval '1 hour')`;
  return { cookie: "north_session=" + token, "x-csrf-token": csrf };
}
beforeAll(async () => {
  await migrate(db);
  await migrate(db);
  await db`TRUNCATE towns,users,webhook_events,auth_rate_limits CASCADE`;
  await seed(db);
  await seed(db);
  admin = await session("admin", "admin@test.local");
  owner = await session("owner", "owner@test.local", p1);
  operator = await session("operator", "operator@test.local", p1);
  await app.ready();
}, 30000);
afterAll(async () => {
  await app.close();
  await db.end();
});
describe("phase 2 API boundaries", () => {
  it("runs fresh migrations and repeatable seed", async () => {
    expect((await db`SELECT * FROM towns`).length).toBe(4);
    expect((await db`SELECT * FROM partners`).length).toBe(2);
    expect((await db`SELECT * FROM products`).length).toBe(6);
  });
  it("health and database readiness", async () => {
    expect((await app.inject("/api/ready")).statusCode).toBe(200);
  });
  it("denies unauthenticated and wrong role", async () => {
    expect((await app.inject("/api/admin/partners")).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/admin/partners", headers: owner }))
        .statusCode,
    ).toBe(403);
  });
  it("rejects cross-tenant reads and writes", async () => {
    expect(
      (await app.inject({ url: `/api/partner/${p2}`, headers: owner }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/partner/${p2}/settings`,
          headers: owner,
          payload: { paused: true, preparationMinutes: 30 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("blocks CSRF and operational financial administration", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/partner/${p1}/products`,
          headers: operator,
          payload: {
            name: "Test",
            category: "Sides",
            price: 100,
            allergens: [],
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/partner/${p1}/settings`,
          headers: { cookie: owner.cookie },
          payload: { paused: true, preparationMinutes: 25 },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("requires explicit pricing before activation", async () => {
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/admin/partners/${p1}`,
          headers: admin,
          payload: { status: "active" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/partners/${p1}/pricing`,
          headers: admin,
          payload: {
            fixedFee: 100,
            serviceFee: 100,
            vatBasisPoints: 0,
            taxConfirmed: false,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/admin/partners/${p1}`,
          headers: admin,
          payload: { status: "active" },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("verifies OTP once and revokes logout", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/request",
      payload: { email: "new@example.test" },
    });
    expect(res.statusCode).toBe(202);
    const challenge = res.json();
    const mail = JSON.parse(
      await readFile(
        `/tmp/north-integration-mail/${challenge.challengeId}.json`,
        "utf8",
      ),
    );
    const verified = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { ...challenge, code: mail.code },
    }); // strip informational message by Zod
    expect(verified.statusCode).toBe(200);
    const cookie = verified.headers["set-cookie"]!.toString().split(";")[0];
    expect(
      (await app.inject({ url: "/api/auth/me", headers: { cookie } }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          payload: { ...challenge, code: mail.code },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers: { cookie, "x-csrf-token": verified.json().csrf },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/auth/me", headers: { cookie } }))
        .statusCode,
    ).toBe(401);
  });
  it("publishes OpenAPI paths", () => {
    expect(app.swagger().paths).toHaveProperty("/api/health");
  });
});
export { db, app, p1, p2 };

const capturedPaymentEventId =
  "00000000-0000-4000-8000-000000000001" satisfies ReturnType<
    typeof crypto.randomUUID
  >;
describe("phase 3 order and billing scenarios", () => {
  let cashId: string, cardId: string;
  const tracking = "a".repeat(64);
  async function checkout(method = "cash", changes = {}) {
    return app.inject({
      method: "POST",
      url: "/api/orders",
      headers: {
        "idempotency-key": crypto.randomUUID(),
        "x-order-token": tracking,
      },
      payload: {
        partnerId: p1,
        items: [{ productId: p1.slice(0, -1) + "3", quantity: 1 }],
        customerName: "Test Customer",
        customerEmail: "buyer@example.test",
        fulfilment: "collection",
        paymentMethod: method,
        ...changes,
      },
    });
  }
  async function transition(order: string, status: string, reason?: string) {
    return app.inject({
      method: "POST",
      url: `/api/partner/${p1}/orders/${order}/transition`,
      headers: owner,
      payload: { status, reason },
    });
  }
  async function webhook(
    orderId: string,
    type: string,
    eventId = crypto.randomUUID(),
  ) {
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_a_credential";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture";
    const [o] =
      await db`SELECT total,service_fee FROM orders WHERE id=${orderId}`;
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type,
      account: "acct_fixture",
      livemode: false,
      data: {
        object: {
          id: "pi_" + orderId,
          object: "payment_intent",
          metadata: { orderId },
          amount: o.total,
          application_fee_amount: o.service_fee,
          amount_received: type === "payment_intent.succeeded" ? o.total : 0,
          currency: "gbp",
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_fixture",
    });
    return app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
  }
  it("creates a cash order with server prices, separate service fee and idempotency", async () => {
    const key = crypto.randomUUID();
    const payload = {
      partnerId: p1,
      items: [{ productId: p1.slice(0, -1) + "3", quantity: 1 }],
      customerName: "Test Buyer",
      customerEmail: "buyer@example.test",
      fulfilment: "collection",
      paymentMethod: "cash",
    };
    const options = {
      method: "POST" as const,
      url: "/api/orders",
      headers: { "idempotency-key": key, "x-order-token": tracking },
      payload,
    };
    const a = await app.inject(options);
    expect(a.statusCode).toBe(201);
    cashId = a.json().id;
    expect((await app.inject(options)).json().id).toBe(cashId);
    expect(
      (
        await app.inject({
          ...options,
          payload: { ...payload, customerName: "Different" },
        })
      ).statusCode,
    ).toBe(409);
    const o = (
      await app.inject({
        url: "/api/orders/" + cashId,
        headers: { "x-order-token": tracking },
      })
    ).json();
    expect(o.subtotal).toBe(950);
    expect(o.service_fee).toBe(100);
    expect(o.total).toBe(1050);
  });
  it("requires tracking capability and rejects invalid state changes", async () => {
    expect((await app.inject("/api/orders/" + cashId)).statusCode).toBe(404);
    expect((await transition(cashId, "completed")).statusCode).toBe(409);
  });
  it("completes cash order once and accrues exactly £2", async () => {
    for (const state of ["accepted", "preparing", "ready"])
      expect((await transition(cashId, state)).statusCode).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => transition(cashId, "completed")),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const [sum] =
      await db`SELECT sum(amount)::int AS amount,count(*)::int AS count FROM ledger_entries WHERE order_id=${cashId}`;
    expect(sum).toMatchObject({ amount: 200, count: 2 });
  });
  it("rejects/cancels without completed fees", async () => {
    for (const status of ["rejected", "cancelled"]) {
      const res = await checkout();
      expect(res.statusCode).toBe(201);
      const order = res.json().id;
      expect((await transition(order, status, "Test reason")).statusCode).toBe(
        200,
      );
      expect(
        (await db`SELECT * FROM ledger_entries WHERE order_id=${order}`).length,
      ).toBe(0);
    }
  });
  it("rejects scheduled checkout and out-of-zone delivery explicitly", async () => {
    expect(
      (
        await checkout("cash", {
          scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await checkout("cash", {
          fulfilment: "delivery",
          address: { line1: "Test Road", postcode: "PR1 1AA" },
        })
      ).statusCode,
    ).toBe(422);
  });
  it("creates test card intent; only signed webhook confirms payment", async () => {
    await db`UPDATE partners SET stripe_account='acct_fixture' WHERE id=${p1}`;
    const res = await checkout("card");
    expect(res.statusCode).toBe(201);
    cardId = res.json().id;
    expect((await transition(cardId, "accepted")).statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/webhooks/stripe",
          payload: {},
        })
      ).statusCode,
    ).toBe(503);
    expect(
      (
        await webhook(
          cardId,
          "payment_intent.succeeded",
          capturedPaymentEventId,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await webhook(
          cardId,
          "payment_intent.succeeded",
          capturedPaymentEventId,
        )
      ).json().duplicate,
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/webhooks/stripe",
          headers: { "stripe-signature": "invalid" },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
  it("card completion bills only £1 partner fee; delayed failures cannot downgrade", async () => {
    for (const state of ["accepted", "preparing", "ready", "completed"])
      expect((await transition(cardId, state)).statusCode).toBe(200);
    await webhook(cardId, "payment_intent.payment_failed");
    const [o] = await db`SELECT payment_state FROM orders WHERE id=${cardId}`;
    expect(o.payment_state).toBe("captured");
    const [sum] =
      await db`SELECT sum(amount)::int AS amount FROM ledger_entries WHERE order_id=${cardId}`;
    expect(sum.amount).toBe(100);
  });
  it("supports failed payment separately from fulfilment", async () => {
    const res = await checkout("card");
    const order = res.json().id;
    await webhook(order, "payment_intent.payment_failed");
    const [o] =
      await db`SELECT status,payment_state FROM orders WHERE id=${order}`;
    expect(o).toMatchObject({
      status: "awaiting_payment",
      payment_state: "failed",
    });
  });
  it("partial then full refund reverses exactly the partner fee, retry is idempotent", async () => {
    const key = crypto.randomUUID();
    const request = {
      method: "POST" as const,
      url: `/api/admin/orders/${cardId}/refund`,
      headers: admin,
      payload: { amount: 525, requestKey: key, refundServiceFee: true },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          ...request,
          payload: {
            amount: 525,
            requestKey: crypto.randomUUID(),
            refundServiceFee: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    const [o] =
      await db`SELECT payment_state,refunded_amount FROM orders WHERE id=${cardId}`;
    expect(o).toMatchObject({
      payment_state: "refunded",
      refunded_amount: 1050,
    });
    const [sum] =
      await db`SELECT sum(amount)::int AS amount FROM ledger_entries WHERE order_id=${cardId}`;
    expect(sum.amount).toBe(0);
  });
  it("immutable ledger blocks updates; cross-tenant finance denied", async () => {
    await expect(
      db`UPDATE ledger_entries SET amount=0 WHERE order_id=${cashId}`,
    ).rejects.toThrow("immutable");
    await expect(
      db`UPDATE orders SET subtotal=subtotal+1,total=total+1 WHERE id=${cashId}`,
    ).rejects.toThrow("immutable order snapshot");
    expect(
      (await app.inject({ url: `/api/partner/${p2}/finance`, headers: owner }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/partner/${p1}/finance`,
          headers: operator,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("weekly draft invoice is reproducible with unique ledger lines and no automatic collection", async () => {
    const start = weekStart();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(new Date(start).getTime() + 8 * 86400000));
    try {
      const request = {
        method: "POST" as const,
        url: "/api/admin/invoices",
        headers: admin,
        payload: { partnerId: p1, periodStart: start },
      };
      const a = await app.inject(request);
      expect(a.statusCode).toBe(200);
      expect(a.json()).toMatchObject({
        net: 200,
        vat: 0,
        total: 200,
        status: "draft",
      });
      expect((await app.inject(request)).json().id).toBe(a.json().id);
      const lines =
        await db`SELECT ledger_id FROM invoice_lines WHERE invoice_id=${a.json().id}`;
      expect(new Set(lines.map((x) => x.ledger_id)).size).toBe(lines.length);
    } finally {
      vi.useRealTimers();
    }
  });
  async function signedEvent(
    type: string,
    object: unknown,
    options: {
      account?: string;
      eventId?: ReturnType<typeof crypto.randomUUID>;
      live?: boolean;
    } = {},
  ) {
    process.env.STRIPE_SECRET_KEY = "sk_test_fixture_not_a_credential";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_fixture";
    const eventId = options.eventId ?? crypto.randomUUID();
    const payload = JSON.stringify({
      id: eventId,
      object: "event",
      type,
      account: options.account ?? "acct_fixture",
      livemode: options.live ?? false,
      data: { object },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_fixture",
    });
    return app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
  }
  async function capturedCard(complete = true) {
    const res = await checkout("card");
    expect(res.statusCode).toBe(201);
    const orderId: string = res.json().id;
    expect(
      (await webhook(orderId, "payment_intent.succeeded")).statusCode,
    ).toBe(200);
    if (complete)
      for (const state of ["accepted", "preparing", "ready", "completed"])
        expect((await transition(orderId, state)).statusCode).toBe(200);
    return orderId;
  }
  function refundRequest(
    orderId: string,
    amount: number,
    key = crypto.randomUUID(),
    refundServiceFee = true,
  ) {
    return {
      method: "POST" as const,
      url: `/api/admin/orders/${orderId}/refund`,
      headers: admin,
      payload: { amount, requestKey: key, refundServiceFee },
    };
  }
  function refundObject(
    orderId: string,
    amount: number,
    key: string,
    status = "succeeded",
  ) {
    return {
      id: "re_" + key,
      object: "refund",
      amount,
      currency: "gbp",
      payment_intent: "pi_" + orderId,
      status,
      metadata: { refundRequestKey: key },
    };
  }
  it("rejects mismatched payment allocation/account/amount and rolls back deduplication", async () => {
    const order = (await checkout("card")).json().id;
    const pi = {
      id: "pi_" + order,
      object: "payment_intent",
      metadata: { orderId: order },
      amount: 1050,
      amount_received: 1050,
      currency: "gbp",
      application_fee_amount: 100,
    };
    for (const invalid of [
      { amount: 1051 },
      { amount_received: 1049 },
      { currency: "usd" },
      { application_fee_amount: 99 },
      { metadata: { orderId: p2 } },
    ]) {
      const eventId = crypto.randomUUID();
      expect(
        (
          await signedEvent(
            "payment_intent.succeeded",
            { ...pi, ...invalid },
            { eventId },
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (await db`SELECT * FROM webhook_events WHERE provider_id=${eventId}`)
          .length,
      ).toBe(0);
    }
    expect(
      (
        await signedEvent("payment_intent.succeeded", pi, {
          account: "acct_other",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await signedEvent("payment_intent.succeeded", pi, { live: true }))
        .statusCode,
    ).toBe(400);
    const eventId = crypto.randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        signedEvent("payment_intent.succeeded", pi, { eventId }),
      ),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(responses.filter((r) => r.json().duplicate).length).toBe(4);
    expect(
      (
        await db`SELECT * FROM order_history WHERE order_id=${order} AND status='awaiting_acceptance'`
      ).length,
    ).toBe(1);
    expect(
      (
        await db`SELECT * FROM notifications WHERE order_id=${order} AND kind='new_order'`
      ).length,
    ).toBe(1);
  });
  it("cumulative penny refunds and full retries preserve both payment states and credits", async () => {
    const order = await capturedCard();
    let last;
    for (let i = 0; i < 3; i++) {
      last = refundRequest(order, 350, crypto.randomUUID(), false);
      expect((await app.inject(last)).statusCode).toBe(200);
    }
    expect((await app.inject(last!)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          ...last!,
          payload: { ...last!.payload, refundServiceFee: true },
        })
      ).statusCode,
    ).toBe(409);
    const credits =
      await db`SELECT amount FROM ledger_entries WHERE order_id=${order} AND kind='fee_credit' ORDER BY created_at`;
    expect(credits.map((c) => c.amount)).toEqual([-33, -34, -33]);
    await webhook(order, "payment_intent.succeeded");
    await webhook(order, "payment_intent.payment_failed");
    expect(
      (
        await db`SELECT payment_state,refunded_amount FROM orders WHERE id=${order}`
      )[0],
    ).toMatchObject({ payment_state: "refunded", refunded_amount: 1050 });
    expect(
      (await db`SELECT state FROM payments WHERE order_id=${order}`)[0].state,
    ).toBe("refunded");
    expect(refundProvider).toHaveBeenLastCalledWith(
      "pi_" + order,
      "acct_fixture",
      350,
      last!.payload.requestKey,
      false,
    );
  });
  it("validates pending refund webhooks and deduplicates settlement transactionally", async () => {
    const order = await capturedCard();
    const key = crypto.randomUUID();
    refundProvider.mockImplementationOnce(async () => ({
      id: "re_" + key,
      status: "pending",
    }));
    expect(
      (await app.inject(refundRequest(order, 350, key))).json().status,
    ).toBe("pending");
    const pendingCalls = refundProvider.mock.calls.length;
    expect(
      (await app.inject(refundRequest(order, 350, key))).json().status,
    ).toBe("pending");
    expect(refundProvider.mock.calls.length).toBe(pendingCalls);
    const object = refundObject(order, 350, key);
    for (const invalid of [
      { amount: 351 },
      { currency: "usd" },
      { payment_intent: "pi_other" },
    ])
      expect(
        (await signedEvent("refund.updated", { ...object, ...invalid }))
          .statusCode,
      ).toBe(409);
    expect(
      (await signedEvent("refund.updated", object, { account: "acct_other" }))
        .statusCode,
    ).toBe(409);
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(0);
    const eventId = crypto.randomUUID();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        signedEvent("refund.updated", object, { eventId }),
      ),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().duplicate).length).toBe(3);
    expect(
      (
        await db`SELECT refunded_amount,payment_state FROM orders WHERE id=${order}`
      )[0],
    ).toMatchObject({
      refunded_amount: 350,
      payment_state: "partially_refunded",
    });
    expect(
      (await db`SELECT state FROM payments WHERE order_id=${order}`)[0].state,
    ).toBe("partially_refunded");
    expect(
      (
        await db`SELECT * FROM ledger_entries WHERE order_id=${order} AND kind='fee_credit'`
      ).length,
    ).toBe(1);
  });
  it("a webhook racing the HTTP refund response cannot be downgraded to pending", async () => {
    const order = await capturedCard();
    const key = crypto.randomUUID();
    refundProvider.mockImplementationOnce(async () => {
      expect(
        (await signedEvent("refund.created", refundObject(order, 350, key)))
          .statusCode,
      ).toBe(200);
      return { id: "re_" + key, status: "pending" };
    });
    expect(
      (await app.inject(refundRequest(order, 350, key))).json().status,
    ).toBe("succeeded");
    expect(
      (
        await signedEvent(
          "refund.updated",
          refundObject(order, 350, key, "failed"),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await db`SELECT status FROM refunds WHERE request_key=${key}`)[0].status,
    ).toBe("succeeded");
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(350);
  });
  it("recovers a signed refund success after an interrupted provider response", async () => {
    const order = await capturedCard();
    const key = crypto.randomUUID();
    refundProvider.mockRejectedValueOnce(
      new Error("simulated interrupted provider response"),
    );
    const request = refundRequest(order, 350, key);
    expect((await app.inject(request)).statusCode).toBe(500);
    await db`UPDATE refunds SET created_at=now()-interval '25 hours' WHERE request_key=${key}`;
    const attempts = refundProvider.mock.calls.length;
    expect((await app.inject(request)).statusCode).toBe(409);
    expect(refundProvider.mock.calls.length).toBe(attempts);

    expect(
      (await db`SELECT provider_id FROM refunds WHERE request_key=${key}`)[0]
        .provider_id,
    ).toBeNull();
    expect(
      (await signedEvent("refund.updated", refundObject(order, 350, key)))
        .statusCode,
    ).toBe(200);
    const before = refundProvider.mock.calls.length;
    expect((await app.inject(request)).json().status).toBe("succeeded");
    expect(refundProvider.mock.calls.length).toBe(before);
  });
  it("blocks over-refunds, concurrent reservations and terminal failed-key reuse", async () => {
    const order = await capturedCard();
    const failedKey = crypto.randomUUID();
    refundProvider.mockImplementationOnce(async () => ({
      id: "re_" + failedKey,
      status: "failed",
    }));
    expect(
      (await app.inject(refundRequest(order, 350, failedKey))).json().status,
    ).toBe("failed");
    const pendingKey = crypto.randomUUID();
    refundProvider.mockImplementationOnce(async () => ({
      id: "re_" + pendingKey,
      status: "pending",
    }));
    expect(
      (await app.inject(refundRequest(order, 800, pendingKey))).statusCode,
    ).toBe(200);
    const before = refundProvider.mock.calls.length;
    expect(
      (await app.inject(refundRequest(order, 350, failedKey))).statusCode,
    ).toBe(409);
    expect((await app.inject(refundRequest(order, 300))).statusCode).toBe(409);
    expect(refundProvider.mock.calls.length).toBe(before);
    expect(
      (
        await signedEvent(
          "refund.updated",
          refundObject(order, 800, pendingKey),
        )
      ).statusCode,
    ).toBe(200);
    expect((await app.inject(refundRequest(order, 251))).statusCode).toBe(409);
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(800);
  });
  it("denies cross-tenant order, invoice and product access", async () => {
    const other = await session("owner", "other-owner@test.local", p2);
    expect(
      (await app.inject({ url: "/api/orders/" + cashId, headers: other }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/partner/${p2}/orders/${cashId}/transition`,
          headers: other,
          payload: { status: "cancelled", reason: "Wrong tenant" },
        })
      ).statusCode,
    ).toBe(404);
    const [inv] =
      await db`SELECT id FROM invoices WHERE partner_id=${p1} LIMIT 1`;
    expect(
      (await app.inject({ url: "/api/invoices/" + inv.id, headers: other }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/partner/${p2}/products/${p1.slice(0, -1) + "3"}`,
          headers: other,
          payload: { available: false },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("binds checkout idempotency to the authenticated customer as well as the tracking token", async () => {
    const first = await session("customer", "checkout-a@test.local"),
      second = await session("customer", "checkout-b@test.local");
    const request = {
      method: "POST" as const,
      url: "/api/orders",
      headers: {
        ...first,
        "idempotency-key": crypto.randomUUID(),
        "x-order-token": tracking,
      },
      payload: {
        partnerId: p1,
        items: [{ productId: p1.slice(0, -1) + "3", quantity: 1 }],
        customerName: "Identity Bound",
        customerEmail: "identity@example.test",
        fulfilment: "collection",
        paymentMethod: "cash",
      },
    };
    expect((await app.inject(request)).statusCode).toBe(201);
    expect(
      (
        await app.inject({
          ...request,
          headers: { ...request.headers, ...second },
        })
      ).statusCode,
    ).toBe(409);
  });
  it("stale memberships cannot grant customer accounts partner privileges", async () => {
    const headers = await session("customer", "stale-member@test.local", p1);
    expect(
      (await app.inject({ url: "/api/auth/me", headers })).json().user.partners,
    ).toEqual([]);
    expect(
      (await app.inject({ url: "/api/orders/" + cashId, headers })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/partner/${p1}/finance`, headers }))
        .statusCode,
    ).toBe(403);
  });
  it("role/disabled changes revoke existing sessions without revival on restoration", async () => {
    for (const field of ["role", "disabled"] as const) {
      const email = `revoke-${field}@test.local`;
      const headers = await session("operator", email, p1);
      if (field === "role")
        await db`UPDATE users SET role='admin' WHERE email=${email}`;
      else await db`UPDATE users SET disabled=true WHERE email=${email}`;
      expect(
        (await app.inject({ url: "/api/auth/me", headers })).statusCode,
      ).toBe(401);
      await db`UPDATE users SET role='operator',disabled=false WHERE email=${email}`;
      expect(
        (await app.inject({ url: "/api/auth/me", headers })).statusCode,
      ).toBe(401);
    }
  });
  it("OTP expiry and five-attempt lockout cannot be bypassed by changing source IP", async () => {
    for (const expired of [false, true]) {
      const secret = "b".repeat(32);
      const code = "123456";
      const [c] =
        await db`INSERT INTO auth_challenges(email,code_hash,expires_at) VALUES(${expired ? "expired@test.local" : "locked@test.local"},${hash(secret + code)},now()+(${expired ? "-1 minute" : "5 minutes"})::interval) RETURNING id`;
      if (!expired)
        for (let i = 0; i < 5; i++)
          expect(
            (
              await app.inject({
                method: "POST",
                url: "/api/auth/verify",
                remoteAddress: `127.0.2.${i + 1}`,
                payload: {
                  challengeId: c.id,
                  challenge: secret,
                  code: "000000",
                },
              })
            ).statusCode,
          ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/verify",
            remoteAddress: "127.0.2.20",
            payload: { challengeId: c.id, challenge: secret, code },
          })
        ).statusCode,
      ).toBe(401);
    }
  });
  it("administrator OTP requires MFA and a TOTP counter cannot be replayed", async () => {
    const mfaSecret = "JBSWY3DPEHPK3PXP";
    const email = "mfa-regression@test.local";
    await session("admin", email);
    const [mfaUser] = await db`SELECT id FROM users WHERE email=${email}`;
    await db`INSERT INTO admin_mfa(user_id,secret_ciphertext) VALUES(${mfaUser.id},${encryptMfa(mfaSecret, mfaUser.id)})`;
    const secret = "c".repeat(32),
      code = "123456";
    async function challenge() {
      return (
        await db`INSERT INTO auth_challenges(email,code_hash,expires_at) VALUES(${email},${hash(secret + code)},now()+interval '5 minutes') RETURNING id`
      )[0].id as string;
    }
    const c = await challenge();
    const payload = { challengeId: c, challenge: secret, code };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          remoteAddress: "127.0.3.1",
          payload,
        })
      ).statusCode,
    ).toBe(401);
    const mfa = new TOTP({
      secret: Secret.fromBase32(mfaSecret),
    }).generate();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          remoteAddress: "127.0.3.2",
          payload: { ...payload, mfa },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/verify",
          remoteAddress: "127.0.3.3",
          payload: { ...payload, challengeId: await challenge(), mfa },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("expired sessions cannot be reused", async () => {
    const email = "session-expiry@test.local";
    const headers = await session("customer", email);
    await db`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE email=${email})`;
    expect(
      (await app.inject({ url: "/api/auth/me", headers })).statusCode,
    ).toBe(401);
  });
  it("retries persisted intents in their snapshotted account and blocks expired unbound attempts", async () => {
    const key = crypto.randomUUID();
    const request = {
      method: "POST" as const,
      url: "/api/orders",
      headers: { "idempotency-key": key, "x-order-token": tracking },
      payload: {
        partnerId: p1,
        items: [{ productId: p1.slice(0, -1) + "3", quantity: 1 }],
        customerName: "Payment Retry",
        customerEmail: "retry@test.local",
        fulfilment: "collection",
        paymentMethod: "card",
      },
    };
    const res = await app.inject(request);
    expect(res.statusCode).toBe(201);
    const order: string = res.json().id;
    await db`UPDATE partners SET stripe_account='acct_changed' WHERE id=${p1}`;
    try {
      expect((await app.inject(request)).statusCode).toBe(201);
      expect(intentProvider.mock.lastCall?.slice(1)).toEqual([
        "acct_fixture",
        "pi_" + order,
      ]);
    } finally {
      await db`UPDATE partners SET stripe_account='acct_fixture' WHERE id=${p1}`;
    }
    await db`UPDATE payments SET provider_id=NULL,updated_at=now()-interval '25 hours' WHERE order_id=${order}`;
    const calls = intentProvider.mock.calls.length;
    expect((await app.inject(request)).statusCode).toBe(409);
    expect(intentProvider.mock.calls.length).toBe(calls);
  });
  it("partial refunds reverse the original VAT exactly and invoices preserve tax snapshots", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/admin/partners/${p1}/pricing`,
          headers: admin,
          payload: {
            fixedFee: 100,
            serviceFee: 100,
            vatBasisPoints: 2000,
            taxConfirmed: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    const order = await capturedCard();
    for (let i = 0; i < 3; i++)
      expect((await app.inject(refundRequest(order, 350))).statusCode).toBe(
        200,
      );
    const ledger =
      await db`SELECT amount,vat_amount FROM ledger_entries WHERE order_id=${order} ORDER BY created_at,id`;
    expect(ledger.reduce((sum, l) => sum + l.amount, 0)).toBe(0);
    expect(ledger.reduce((sum, l) => sum + l.vat_amount, 0)).toBe(0);
    const credits =
      await db`SELECT amount,vat_amount FROM ledger_entries WHERE order_id=${order} AND kind='fee_credit' ORDER BY created_at`;
    expect(credits.map((l) => l.vat_amount)).toEqual([-7, -6, -7]);
    // Emulate pre-upgrade NULL-tax history without modifying immutable rows.
    const legacy = await capturedCard(false);
    await db`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points,tax_confirmed) VALUES(${p1},${legacy},${legacy + ":partner_fee"},'partner_fee',100,2000,true)`;
    for (const state of ["accepted", "preparing", "ready", "completed"])
      expect((await transition(legacy, state)).statusCode).toBe(200);
    for (const amount of [33, 34]) {
      const [old] =
        await db`INSERT INTO refunds(order_id,request_key,amount,provider_id,status) VALUES(${legacy},${crypto.randomUUID()},350,${"re_legacy_" + crypto.randomUUID()},'succeeded') RETURNING id`;
      await db`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points,tax_confirmed) VALUES(${p1},${legacy},${old.id + ":partner_fee"},'fee_credit',${-amount},2000,true)`;
    }
    await db`UPDATE orders SET refunded_amount=700,payment_state='partially_refunded' WHERE id=${legacy}`;
    await db`UPDATE payments SET state='partially_refunded' WHERE order_id=${legacy}`;
    expect((await app.inject(refundRequest(legacy, 350))).statusCode).toBe(200);
    const [rounding] =
      await db`SELECT vat_amount FROM ledger_entries WHERE order_id=${legacy} AND vat_amount IS NOT NULL`;
    expect(rounding.vat_amount).toBe(-6);
    expect(
      (
        await db`SELECT * FROM ledger_entries WHERE order_id=${legacy} AND vat_amount IS NULL`
      ).length,
    ).toBe(3);
    const nextWeek = new Date(new Date(weekStart()).getTime() + 7 * 86400000)
      .toISOString()
      .slice(0, 10);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(new Date(nextWeek).getTime() + 8 * 86400000));
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/admin/invoices",
        headers: admin,
        payload: { partnerId: p1, periodStart: nextWeek },
      });
      expect(result.statusCode).toBe(200);
      const [sum] =
        await db`SELECT sum(il.net)::int AS net,sum(il.vat)::int AS vat,count(*)::int AS count FROM invoice_lines il JOIN ledger_entries l ON l.id=il.ledger_id WHERE il.invoice_id=${result.json().id} AND l.order_id IN (${order},${legacy})`;
      expect(sum).toMatchObject({ net: 0, vat: 0, count: 8 });
    } finally {
      vi.useRealTimers();
    }
  });
  it("enforces authentication account limits across API instances and source IPs", async () => {
    const other = await createApp(db);
    await other.ready();
    try {
      const email = "distributed-limit@test.local";
      for (let i = 0; i < 5; i++)
        expect(
          (
            await (i % 2 ? other : app).inject({
              method: "POST",
              url: "/api/auth/request",
              remoteAddress: "127.8.0." + (i + 1),
              payload: { email },
            })
          ).statusCode,
        ).toBe(202);
      expect(
        (
          await other.inject({
            method: "POST",
            url: "/api/auth/request",
            remoteAddress: "127.8.1.99",
            payload: { email: email.toUpperCase() },
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await other.close();
    }
  });
  it("requires owner access for onboarding and does not leak cross-tenant readiness", async () => {
    expect(
      (
        await app.inject({
          url: `/api/partner/${p2}/payments/readiness`,
          headers: owner,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/partner/${p1}/payments/onboarding`,
          headers: operator,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("resumes a bound card intent using its capability without creating another order", async () => {
    const res = await checkout("card"),
      orderId = res.json().id;
    expect(res.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/orders/${orderId}/payment`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/orders/${orderId}/payment`,
          headers: { "x-order-token": tracking },
        })
      ).statusCode,
    ).toBe(200);
    expect(intentProvider.mock.calls.at(-1)?.[2]).toBe("pi_" + orderId);
    expect(
      (
        await db`SELECT count(*)::int AS count FROM payments WHERE order_id=${orderId}`
      )[0].count,
    ).toBe(1);
  });
  it("failed captures leave fulfilment unchanged and retry the same provider operation", async () => {
    const res = await checkout("card"),
      order = res.json().id;
    await webhook(order, "payment_intent.amount_capturable_updated");
    const request = {
      method: "POST" as const,
      url: `/api/partner/${p1}/orders/${order}/capture`,
      headers: owner,
    };
    captureProvider.mockRejectedValueOnce(new Error("network interrupted"));
    expect((await app.inject(request)).statusCode).toBe(500);
    expect((await transition(order, "accepted")).statusCode).toBe(409);
    expect((await app.inject(request)).json().status).toBe("awaiting_webhook");
    const calls = captureProvider.mock.calls.slice(-2);
    expect(calls[0]).toEqual(calls[1]);
    expect(
      (await db`SELECT payment_state,status FROM orders WHERE id=${order}`)[0],
    ).toMatchObject({
      payment_state: "authorised",
      status: "awaiting_payment",
    });
    await webhook(order, "payment_intent.succeeded");
    expect((await transition(order, "accepted")).statusCode).toBe(200);
  });
  it("refunds rejected captured orders once after an interrupted provider response", async () => {
    const order = await capturedCard(false);
    expect(
      (await transition(order, "rejected", "Kitchen unavailable")).statusCode,
    ).toBe(200);
    const refund = vi
      .fn<PaymentProvider["refund"]>()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockImplementation(async (_i, _a, _amount, key) => ({
        id: "re_" + key,
        status: "succeeded",
      }));
    const p = { intent: intentProvider, capture: captureProvider, refund };
    await compensateOrder(db, p, order);
    expect(
      (
        await db`SELECT state FROM payment_compensations WHERE order_id=${order}`
      )[0].state,
    ).toBe("pending");
    await Promise.all([
      compensateOrder(db, p, order),
      compensateOrder(db, p, order),
    ]);
    await compensateOrder(db, p, order);
    const [o] =
      await db`SELECT total,refunded_amount,payment_state FROM orders WHERE id=${order}`;
    expect(o.refunded_amount).toBe(o.total);
    expect(o.payment_state).toBe("refunded");
    expect(
      (await db`SELECT * FROM refunds WHERE order_id=${order}`).length,
    ).toBe(1);
    expect(new Set(refund.mock.calls.map((c) => c[3])).size).toBe(1);
    expect(refund.mock.calls.every((c) => c[4] === true)).toBe(true);
    expect(
      (await db`SELECT * FROM ledger_entries WHERE order_id=${order}`).length,
    ).toBe(0);
  });
  it("retains a failed cancellation refund as a visible blocker without inventing credits", async () => {
    const order = await capturedCard(false);
    await transition(order, "cancelled", "Customer cancellation");
    const refund = vi
      .fn<PaymentProvider["refund"]>()
      .mockResolvedValue({ id: "re_failed_" + order, status: "failed" });
    const p = { intent: intentProvider, capture: captureProvider, refund };
    await compensateOrder(db, p, order);
    await compensateOrder(db, p, order);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(
      (
        await db`SELECT state,last_error FROM payment_compensations WHERE order_id=${order}`
      )[0],
    ).toMatchObject({
      state: "blocked",
      last_error: "refund_failed_requires_reconciliation",
    });
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(0);
  });
  it("reopens compensation when a signed capture races a confirmed cancellation", async () => {
    const res = await checkout("card"),
      order = res.json().id;
    await transition(order, "cancelled", "No longer required");
    const cancel = vi
      .fn<NonNullable<PaymentProvider["cancel"]>>()
      .mockResolvedValue("cancelled");
    const p = {
      intent: intentProvider,
      capture: captureProvider,
      refund: refundProvider,
      cancel,
    };
    await compensateOrder(db, p, order);
    expect(
      (
        await db`SELECT state FROM payment_compensations WHERE order_id=${order}`
      )[0].state,
    ).toBe("succeeded");
    expect((await webhook(order, "payment_intent.succeeded")).statusCode).toBe(
      200,
    );
    expect(
      (
        await db`SELECT state FROM payment_compensations WHERE order_id=${order}`
      )[0].state,
    ).toBe("pending");
    await compensateOrder(db, p, order);
    expect(
      (await db`SELECT payment_state,status FROM orders WHERE id=${order}`)[0],
    ).toMatchObject({ payment_state: "refunded", status: "cancelled" });
  });
  it("rotates only the signed-in administrator MFA, revokes sessions and uses recovery once", async () => {
    const email = "rotation-admin@test.local",
      headers = await session("admin", email);
    const [u] = await db`SELECT id FROM users WHERE email=${email}`;
    const oldSecret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa(user_id,secret_ciphertext) VALUES(${u.id},${encryptMfa(oldSecret, u.id)})`;
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/rotate",
      remoteAddress: "127.9.1.1",
      headers,
      payload: {
        mfa: new TOTP({ secret: Secret.fromBase32(oldSecret) }).generate(),
      },
    });
    expect(start.statusCode).toBe(200);
    expect(start.headers["cache-control"]).toBe("no-store");
    const newSecret = start.json().secret;
    expect(
      (
        await db`SELECT secret_ciphertext FROM admin_mfa WHERE user_id=${u.id}`
      )[0].secret_ciphertext,
    ).not.toContain(newSecret);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/mfa/confirm",
          remoteAddress: "127.9.1.2",
          headers,
          payload: { mfa: "000000" },
        })
      ).statusCode,
    ).toBe(401);
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/confirm",
      remoteAddress: "127.9.1.3",
      headers,
      payload: {
        mfa: new TOTP({ secret: Secret.fromBase32(newSecret) }).generate(),
      },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recoveryCodes).toHaveLength(10);
    expect(
      (await app.inject({ url: "/api/auth/me", headers })).statusCode,
    ).toBe(401);
    const recoveryCode = confirm.json().recoveryCodes[0];
    async function recover(ip: string) {
      const challenge = "d".repeat(32),
        code = "123456";
      const [c] =
        await db`INSERT INTO auth_challenges(email,code_hash,expires_at) VALUES(${email},${hash(challenge + code)},now()+interval '5 minutes') RETURNING id`;
      return app.inject({
        method: "POST",
        url: "/api/auth/verify",
        remoteAddress: ip,
        payload: { challengeId: c.id, challenge, code, recoveryCode },
      });
    }
    expect((await recover("127.9.2.1")).statusCode).toBe(200);
    expect((await recover("127.9.2.2")).statusCode).toBe(401);
    expect(
      (
        await db`SELECT count(*)::int AS count FROM mfa_recovery_codes WHERE user_id=${u.id}`
      )[0].count,
    ).toBe(9);
  });
  it("runtime database role can read data but cannot mutate immutable records or schema", async () => {
    await db.unsafe(
      await readFile(
        new URL(
          "../../infrastructure/database/runtime-role.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await expect(validateRuntimeDatabase(db)).rejects.toThrow(
      "least-privilege",
    );
    const rows = await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE north_runtime");
      await validateRuntimeDatabase(tx);
      return tx`SELECT id FROM towns LIMIT 1`;
    });
    expect(rows.length).toBe(1);
    for (const statement of [
      "UPDATE ledger_entries SET amount=0",
      "DELETE FROM audit_logs",
      "TRUNCATE orders CASCADE",
      "CREATE TABLE runtime_escape(id int)",
      "SELECT * FROM schema_migrations",
    ]) {
      await expect(
        db.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE north_runtime");
          await tx.unsafe(statement);
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});
