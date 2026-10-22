import { StripeProvider } from "../../packages/payments/src/index";
import { intentResponse } from "../fixtures/stripe";
import { dependencyHealth } from "../../apps/api/src/operations";
import {
  financialEvent,
  recordFinancialEvent,
  replayFinancialEvents,
  snapshotEvent,
} from "../../apps/api/src/reconciliation";
import { rotateMfaKey } from "../../scripts/rotate-mfa-key";
import { decryptMfa } from "../../apps/api/src/mfa";
import { validateRuntimeDatabase } from "../../packages/database/src/runtime-security";
import { compensateOrder } from "../../apps/api/src/compensation";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
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
let scenario = 0,
  scenarioIp = "127.11.0.1";
beforeEach(() => {
  scenarioIp = "127.11.0." + ++scenario;
});
async function session(role: string, email: string, p?: string) {
  const [u] =
    await db`INSERT INTO users(email,role) VALUES(${email},${role}) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role RETURNING id`;
  if (role === "admin")
    for (const permission of ["operations", "finance", "support", "governance"])
      await db`INSERT INTO admin_permissions VALUES(${u.id},${permission}) ON CONFLICT DO NOTHING`;
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
  await db`TRUNCATE towns,users,webhook_events,auth_rate_limits,provider_events CASCADE`;
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
      remoteAddress: scenarioIp,
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
      remoteAddress: scenarioIp,
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
      remoteAddress: scenarioIp,
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
      remoteAddress: scenarioIp,
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
      created?: number;
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
      created: options.created ?? Math.floor(Date.now() / 1000),
      data: { object },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: "whsec_fixture",
    });
    return app.inject({
      method: "POST",
      url: "/api/webhooks/stripe",
      remoteAddress: scenarioIp,
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
      remoteAddress: scenarioIp,
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
      remoteAddress: scenarioIp,
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
      remoteAddress: scenarioIp,
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
  it("adopts Dashboard refunds exactly once and never invoices the online service fee", async () => {
    const order = await capturedCard(),
      object = {
        id: "re_dashboard_" + crypto.randomUUID(),
        payment_intent: "pi_" + order,
        amount: 350,
        currency: "gbp",
        status: "succeeded",
      },
      eventId = crypto.randomUUID();
    expect(
      (await signedEvent("refund.created", object, { eventId })).statusCode,
    ).toBe(200);
    expect(
      (await signedEvent("refund.created", object, { eventId })).json()
        .duplicate,
    ).toBe(true);
    expect((await signedEvent("refund.updated", object)).statusCode).toBe(200);
    expect(
      (
        await db`SELECT amount,origin,status FROM refunds WHERE order_id=${order}`
      )[0],
    ).toMatchObject({ amount: 350, origin: "dashboard", status: "succeeded" });
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(350);
    expect(
      (
        await db`SELECT * FROM ledger_entries WHERE order_id=${order} AND kind='fee_credit'`
      ).length,
    ).toBe(1);
    expect(
      (
        await db`SELECT * FROM ledger_entries WHERE order_id=${order} AND kind='cash_service_fee'`
      ).length,
    ).toBe(0);
  });
  it("replays an external refund arriving before its capture without inventing payment success", async () => {
    const res = await checkout("card"),
      order = res.json().id;
    const eventId = crypto.randomUUID(),
      object = {
        id: "re_early_" + order,
        payment_intent: "pi_" + order,
        amount: 200,
        currency: "gbp",
        status: "succeeded",
      };
    expect(
      (await signedEvent("refund.updated", object, { eventId })).statusCode,
    ).toBe(200);
    expect(
      (
        await db`SELECT state,last_error FROM reconciliation_jobs WHERE event_id=${eventId}`
      )[0],
    ).toMatchObject({ state: "pending", last_error: "capture_not_reconciled" });
    expect(
      (await db`SELECT * FROM refunds WHERE order_id=${order}`).length,
    ).toBe(0);
    await webhook(order, "payment_intent.succeeded");
    await replayFinancialEvents(db, eventId);
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(200);
    expect(
      (
        await db`SELECT state FROM reconciliation_jobs WHERE event_id=${eventId}`
      )[0].state,
    ).toBe("processed");
  });
  it("quarantines unmatched/oversized external refunds and rejects foreign currency", async () => {
    const order = await capturedCard(false),
      [o] = await db`SELECT total FROM orders WHERE id=${order}`;
    const object = {
        id: "re_invalid_" + order,
        payment_intent: "pi_" + order,
        amount: o.total + 1,
        currency: "gbp",
        status: "succeeded",
      },
      eventId = crypto.randomUUID();
    expect(
      (await signedEvent("refund.updated", object, { eventId })).statusCode,
    ).toBe(200);
    expect(
      (
        await db`SELECT state FROM reconciliation_jobs WHERE event_id=${eventId}`
      )[0].state,
    ).toBe("blocked");
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(0);
    expect(
      (
        await signedEvent("refund.updated", {
          ...object,
          amount: 1,
          currency: "usd",
        })
      ).statusCode,
    ).toBe(409);
    const unknown = crypto.randomUUID();
    await signedEvent(
      "refund.created",
      { ...object, id: "re_unknown", amount: 1, payment_intent: "pi_unknown" },
      { eventId: unknown },
    );
    expect(
      (
        await db`SELECT last_error FROM reconciliation_jobs WHERE event_id=${unknown}`
      )[0].last_error,
    ).toBe("unknown_payment");
  });
  it("reconciles failed/pending Dashboard refunds without credits and ignores a stale failure after success", async () => {
    const order = await capturedCard(),
      object = {
        id: "re_pending_ext_" + order,
        payment_intent: "pi_" + order,
        amount: 100,
        currency: "gbp",
        status: "pending",
      };
    await signedEvent("refund.created", object);
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(0);
    await signedEvent("refund.updated", { ...object, status: "succeeded" });
    await signedEvent("refund.failed", { ...object, status: "failed" });
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(100);
  });
  it("records dispute debit/reversal once despite duplicates and out-of-order events", async () => {
    const order = await capturedCard(),
      charge = "ch_" + order;
    await db`UPDATE payments SET charge_id=${charge} WHERE order_id=${order}`;
    const object = {
      id: "dp_" + order,
      charge,
      amount: 400,
      currency: "gbp",
      status: "needs_response",
      reason: "fraudulent",
      evidence_details: { due_by: 2000000000 },
    };
    await signedEvent("charge.dispute.created", object, { created: 100 });
    expect((await app.inject(refundRequest(order, 100))).statusCode).toBe(409);
    await signedEvent(
      "charge.dispute.closed",
      { ...object, status: "won" },
      { created: 200 },
    );
    await signedEvent("charge.dispute.created", object, { created: 50 });
    await signedEvent(
      "charge.dispute.closed",
      { ...object, status: "won" },
      { created: 200 },
    );
    const [sum] =
      await db`SELECT sum(amount)::int AS amount,count(*)::int AS count FROM financial_adjustments WHERE order_id=${order}`;
    expect(sum).toMatchObject({ amount: 0, count: 2 });
    expect(
      (
        await db`SELECT status FROM provider_disputes WHERE provider_id=${object.id}`
      )[0].status,
    ).toBe("won");
    expect(
      (
        await db`SELECT sum(amount)::int AS amount FROM ledger_entries WHERE order_id=${order}`
      )[0].amount,
    ).toBe(100);
  });
  it("handles dispute close-before-create, and lost chargebacks block refund compensation", async () => {
    const order = await capturedCard(false),
      charge = "ch_closed_" + order;
    await db`UPDATE payments SET charge_id=${charge} WHERE order_id=${order}`;
    const object = {
      id: "dp_close_" + order,
      charge,
      amount: 200,
      currency: "gbp",
      status: "won",
      reason: "fraudulent",
      evidence_details: { due_by: null },
    };
    await signedEvent("charge.dispute.closed", object, { created: 200 });
    await signedEvent(
      "charge.dispute.created",
      { ...object, status: "needs_response" },
      { created: 100 },
    );
    expect(
      (
        await db`SELECT count(*)::int AS count,sum(amount)::int AS amount FROM financial_adjustments WHERE order_id=${order}`
      )[0],
    ).toMatchObject({ count: 2, amount: 0 });
    const lost = { ...object, id: "dp_lost_" + order, status: "lost" };
    await signedEvent("charge.dispute.closed", lost, { created: 300 });
    await transition(order, "cancelled", "Chargeback investigation");
    await compensateOrder(
      db,
      {
        intent: intentProvider,
        refund: refundProvider,
        capture: captureProvider,
      },
      order,
    );
    expect(
      (
        await db`SELECT state,last_error FROM payment_compensations WHERE order_id=${order}`
      )[0],
    ).toMatchObject({
      state: "blocked",
      last_error: "dispute_requires_reconciliation",
    });
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(0);
  });
  it("retains immutable settlement entries, validates net amounts and allocates only automatic payouts", async () => {
    const payout = {
      id: "po_settlement",
      amount: 800,
      currency: "gbp",
      status: "paid",
      automatic: true,
      arrival_date: 2000000000,
      balance_transaction: "txn_payout",
      failure_code: null,
    };
    await signedEvent("payout.paid", payout, { created: 200 });
    const balance = {
      id: "txn_settlement",
      amount: 1000,
      fee: 200,
      net: 800,
      currency: "gbp",
      source: "ch_settlement",
      reporting_category: "charge",
      status: "available",
      fee_details: [
        { type: "stripe_fee", amount: 100, currency: "gbp" },
        { type: "application_fee", amount: 100, currency: "gbp" },
      ],
      available_on: 1900000000,
      payout_id: payout.id,
    };
    for (let i = 0; i < 2; i++)
      await db.begin((tx) =>
        recordFinancialEvent(
          tx,
          snapshotEvent(
            "acct_fixture",
            "balance_transaction.snapshot",
            balance,
          ),
        ),
      );
    expect(
      (
        await db`SELECT * FROM provider_balances WHERE provider_id=${balance.id}`
      ).length,
    ).toBe(1);
    expect(
      (
        await db`SELECT * FROM payout_balance_links WHERE payout_id=${payout.id}`
      ).length,
    ).toBe(1);
    await expect(
      db.begin((tx) =>
        recordFinancialEvent(
          tx,
          snapshotEvent("acct_fixture", "balance_transaction.snapshot", {
            ...balance,
            net: 801,
          }),
        ),
      ),
    ).rejects.toThrow("Balance net mismatch");
    await expect(
      db`UPDATE provider_balances SET net=0 WHERE provider_id=${balance.id}`,
    ).rejects.toThrow("immutable");
    await expect(db`DELETE FROM financial_adjustments`).rejects.toThrow(
      "immutable",
    );
  });
  it("uses payout event chronology and quarantines same-second status conflicts", async () => {
    const object = {
      id: "po_ordered",
      amount: 500,
      currency: "gbp",
      status: "paid",
      automatic: true,
      arrival_date: 2000000000,
      balance_transaction: "txn_ordered",
      failure_code: null,
    };
    await signedEvent("payout.paid", object, { created: 200 });
    await signedEvent(
      "payout.created",
      { ...object, status: "pending" },
      { created: 100 },
    );
    expect(
      (
        await db`SELECT status FROM provider_payouts WHERE provider_id=${object.id}`
      )[0].status,
    ).toBe("paid");
    const conflict = crypto.randomUUID();
    await signedEvent(
      "payout.failed",
      { ...object, status: "failed", failure_code: "account_closed" },
      { created: 200, eventId: conflict },
    );
    expect(
      (
        await db`SELECT state FROM reconciliation_jobs WHERE event_id=${conflict}`
      )[0].state,
    ).toBe("blocked");
    await signedEvent(
      "payout.failed",
      { ...object, status: "failed", failure_code: "account_closed" },
      { created: 300 },
    );
    expect(
      (
        await db`SELECT status FROM provider_payouts WHERE provider_id=${object.id}`
      )[0].status,
    ).toBe("failed");
  });
  it("records observed application-fee refunds without another invoice credit", async () => {
    const order = await capturedCard(),
      charge = "ch_fee_" + order;
    await db`UPDATE payments SET charge_id=${charge} WHERE order_id=${order}`;
    const o = {
      id: "fee_" + order,
      account: "acct_fixture",
      charge,
      amount: 100,
      amount_refunded: 40,
      currency: "gbp",
    };
    await signedEvent("application_fee.refunded", o);
    await signedEvent("application_fee.created", { ...o, amount_refunded: 0 });
    expect(
      (
        await db`SELECT amount_refunded FROM provider_application_fees WHERE order_id=${order}`
      )[0].amount_refunded,
    ).toBe(40);
    expect(
      (await db`SELECT * FROM ledger_entries WHERE order_id=${order}`).length,
    ).toBe(1);
    expect(
      (
        await signedEvent("application_fee.created", {
          ...o,
          id: "fee_bad_" + order,
          amount: 101,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("strips client secrets and personal data from provider evidence", async () => {
    const event = financialEvent({
      id: "evt_safe",
      account: "acct_fixture",
      type: "refund.created",
      created: 1,
      data: {
        object: {
          id: "re_safe",
          amount: 1,
          currency: "gbp",
          status: "pending",
          payment_intent: "pi_safe",
          client_secret: "DO_NOT_STORE",
          billing_details: { email: "PRIVATE_EMAIL" },
        },
      },
    })!;
    expect(JSON.stringify(event)).not.toContain("DO_NOT_STORE");
    expect(JSON.stringify(event)).not.toContain("PRIVATE_EMAIL");
  });
  it("enforces finance/governance scopes and revokes sessions after permission changes", async () => {
    const headers = await session("admin", "scoped-admin@test.local");
    const [u] =
      await db`SELECT id FROM users WHERE email='scoped-admin@test.local'`;
    await db`DELETE FROM admin_permissions WHERE user_id=${u.id} AND permission<>'finance'`;
    expect(
      (await app.inject({ url: "/api/admin/reconciliation", headers }))
        .statusCode,
    ).toBe(401);
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    await db`INSERT INTO sessions VALUES(${hash(token)},${u.id},${csrf},now()+interval '1 hour',now())`;
    const limited = { cookie: "north_session=" + token, "x-csrf-token": csrf };
    expect(
      (await app.inject({ url: "/api/admin/reconciliation", headers: limited }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/admin/access/users", headers: limited }))
        .statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ url: "/api/admin/partners", headers: limited }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/partner/" + p2 + "/reconciliation",
          headers: owner,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/admin/reconciliation",
          headers: operator,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("database constraints reject cross-tenant ledger, order item and invoice associations", async () => {
    const order = await capturedCard(),
      [o] = await db`SELECT id FROM orders WHERE id=${order}`;
    await expect(
      db`INSERT INTO ledger_entries(partner_id,order_id,reference,kind,amount,vat_basis_points) VALUES(${p2},${o.id},${"cross:" + order},'adjustment',1,0)`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db`INSERT INTO order_items(order_id,product_id,name,quantity,unit_price) VALUES(${order},'10000001-0000-4000-8000-000000000003','Wrong tenant',1,10)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db`UPDATE products SET partner_id=${p2} WHERE id='10000000-0000-4000-8000-000000000003'`,
    ).rejects.toMatchObject({ code: "23514" });
    const [invoice] =
      await db`INSERT INTO invoices(partner_id,period_start,period_end,net,vat,total) VALUES(${p2},'2020-01-06','2020-01-13',1,0,1) RETURNING id`;
    const [ledger] =
      await db`SELECT id FROM ledger_entries WHERE order_id=${order} LIMIT 1`;
    await expect(
      db`INSERT INTO invoice_lines(invoice_id,ledger_id,description,net,vat) VALUES(${invoice.id},${ledger.id},'Cross tenant',1,0)`,
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("requires fresh MFA for access governance, audits grants and revokes target sessions", async () => {
    const governor = await session("admin", "governor@test.local"),
      [g] = await db`SELECT id FROM users WHERE email='governor@test.local'`;
    const secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${g.id},${encryptMfa(secret, g.id)},now())`;
    const target = await session("customer", "governance-target@test.local");
    const payload = {
      email: "governance-target@test.local",
      role: "admin",
      disabled: false,
      permissions: ["finance"],
      partners: [],
      reason: "Grant reviewed financial operations access",
      mfa: "000000",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/access/users",
          headers: governor,
          payload,
        })
      ).statusCode,
    ).toBe(401);
    payload.mfa = new TOTP({ secret: Secret.fromBase32(secret) }).generate();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/access/users",
          headers: governor,
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/auth/me", headers: target })).statusCode,
    ).toBe(401);
    const [u] = await db`SELECT id FROM users WHERE email=${payload.email}`;
    expect(
      (
        await db`SELECT permission FROM admin_permissions WHERE user_id=${u.id}`
      ).map((p) => p.permission),
    ).toEqual(["finance"]);
    expect(
      (
        await db`SELECT action FROM audit_logs WHERE action='access.changed' AND subject LIKE ${"%" + u.id + "%"}`
      ).length,
    ).toBe(1);
  });
  it("cannot remove the last active governance administrator", async () => {
    const governor = await session("admin", "last-governor@test.local"),
      [g] =
        await db`SELECT id FROM users WHERE email='last-governor@test.local'`;
    const secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${g.id},${encryptMfa(secret, g.id)},now())`;
    const others =
      await db`DELETE FROM admin_permissions WHERE permission='governance' AND user_id<>${g.id} RETURNING user_id`;
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/admin/access/users",
        headers: governor,
        payload: {
          email: "last-governor@test.local",
          role: "admin",
          disabled: true,
          permissions: [],
          partners: [],
          reason: "Attempt to disable the final access governor",
          mfa: new TOTP({ secret: Secret.fromBase32(secret) }).generate(),
        },
      });
      expect(result.statusCode).toBe(409);
      expect(result.json().error).toContain("last active");
    } finally {
      for (const row of others)
        await db`INSERT INTO admin_permissions VALUES(${row.user_id},'governance') ON CONFLICT DO NOTHING`;
    }
  });
  it("requires current provider evidence before any new refund/capture recovery key", async () => {
    const headers = await session("admin", "recovery-review@test.local"),
      [u] =
        await db`SELECT id FROM users WHERE email='recovery-review@test.local'`;
    const secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${u.id},${encryptMfa(secret, u.id)},now())`;
    const order = await capturedCard(false);
    await transition(order, "cancelled", "Financial recovery test");
    const result = await app.inject({
      method: "POST",
      url: `/api/admin/reconciliation/orders/${order}/recover`,
      headers,
      payload: {
        action: "resume_compensation",
        reason: "Review ambiguous cancellation payment status",
        mfa: new TOTP({ secret: Secret.fromBase32(secret) }).generate(),
      },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toContain("fresh provider read");
    expect(
      (
        await db`SELECT state FROM payment_compensations WHERE order_id=${order}`
      )[0].state,
    ).toBe("pending");
  });
  it("readiness checks Redis and private monitoring requires a separate credential", async () => {
    const d = await dependencyHealth(db, "redis://127.0.0.1:1");
    expect(d.database).toBe(true);
    expect(d.redis).toBe(false);
    process.env.MONITORING_TOKEN = "test-monitoring-token-".repeat(3);
    try {
      expect((await app.inject("/internal/metrics")).statusCode).toBe(401);
      const r = await app.inject({
        url: "/internal/metrics",
        headers: { authorization: "Bearer " + process.env.MONITORING_TOKEN },
      });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain("north_database_up 1");
      expect(r.body).toContain("north_redis_up 1");
      expect(r.body).not.toContain("north_dev_only");
    } finally {
      delete process.env.MONITORING_TOKEN;
    }
  });
  it("production origin checks reject cross-site authentication and sensitive writes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "https://customer.example.test");
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/request",
            headers: { origin: "https://evil.example.test" },
            payload: { email: "origin@test.local" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/request",
            headers: { "sec-fetch-site": "cross-site" },
            payload: { email: "origin@test.local" },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("read-only provider refresh validates payment identity, adopts refunds and cannot create another charge", async () => {
    const order = await capturedCard(false),
      [o] = await db`SELECT total FROM orders WHERE id=${order}`;
    const headers = await session("admin", "sync-review@test.local"),
      [u] = await db`SELECT id FROM users WHERE email='sync-review@test.local'`,
      secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${u.id},${encryptMfa(secret, u.id)},now())`;
    const refund: Stripe.Refund = {
      id: "re_sync_" + order,
      object: "refund",
      amount: 100,
      balance_transaction: null,
      charge: null,
      created: 1,
      currency: "gbp",
      metadata: null,
      payment_intent: "pi_" + order,
      reason: null,
      receipt_number: null,
      source_transfer_reversal: null,
      status: "succeeded",
      transfer_reversal: null,
    };
    const spy = vi
      .spyOn(StripeProvider.prototype, "reconciliationSnapshot")
      .mockResolvedValue({
        intent: intentResponse({
          id: "pi_" + order,
          amount: o.total,
          amount_received: o.total,
          metadata: { orderId: order },
          status: "succeeded",
        }),
        charge: null,
        refunds: [refund],
        disputes: [],
      });
    try {
      const r = await app.inject({
        method: "POST",
        url: `/api/admin/reconciliation/orders/${order}/sync`,
        headers,
        payload: {
          reason: "Verify interrupted provider refund response",
          mfa: new TOTP({ secret: Secret.fromBase32(secret) }).generate(),
        },
      });
      expect(r.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith("acct_fixture", "pi_" + order);
      expect(
        (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
          .refunded_amount,
      ).toBe(100);
      expect(
        (await db`SELECT * FROM provider_order_checks WHERE order_id=${order}`)
          .length,
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("recovery only rotates a failed refund key after complete fresh provider evidence", async () => {
    const order = await capturedCard(false),
      [o] = await db`SELECT total FROM orders WHERE id=${order}`;
    await transition(order, "cancelled", "Recovery verification");
    const failed = vi
      .fn<PaymentProvider["refund"]>()
      .mockResolvedValue({ id: "re_recovery_" + order, status: "failed" });
    await compensateOrder(
      db,
      { intent: intentProvider, capture: captureProvider, refund: failed },
      order,
    );
    await compensateOrder(
      db,
      { intent: intentProvider, capture: captureProvider, refund: failed },
      order,
    );
    const headers = await session("admin", "verified-recovery@test.local"),
      [u] =
        await db`SELECT id FROM users WHERE email='verified-recovery@test.local'`,
      secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${u.id},${encryptMfa(secret, u.id)},now())`;
    const refund: Stripe.Refund = {
      id: "re_recovery_" + order,
      object: "refund",
      amount: o.total,
      balance_transaction: null,
      charge: null,
      created: 1,
      currency: "gbp",
      metadata: null,
      payment_intent: "pi_" + order,
      reason: null,
      receipt_number: null,
      source_transfer_reversal: null,
      status: "failed",
      transfer_reversal: null,
    };
    const spy = vi
      .spyOn(StripeProvider.prototype, "reconciliationSnapshot")
      .mockResolvedValue({
        intent: intentResponse({
          id: "pi_" + order,
          amount: o.total,
          amount_received: o.total,
          metadata: { orderId: order },
          status: "succeeded",
        }),
        charge: null,
        refunds: [refund],
        disputes: [],
      });
    try {
      const otp = new TOTP({ secret: Secret.fromBase32(secret) });
      const r = await app.inject({
        method: "POST",
        url: `/api/admin/reconciliation/orders/${order}/sync`,
        headers,
        payload: {
          reason: "Confirm the original refund is terminally failed",
          mfa: otp.generate(),
        },
      });
      expect(r.statusCode).toBe(200);
      // A distinct accepted adjacent TOTP counter models the next authenticator step without sleeping.
      const next = otp.generate({ timestamp: Date.now() + 30000 });
      const oldKey = (
        await db`SELECT request_key FROM payment_compensations WHERE order_id=${order}`
      )[0].request_key;
      const recovery = await app.inject({
        method: "POST",
        url: `/api/admin/reconciliation/orders/${order}/recover`,
        headers,
        payload: {
          action: "resume_compensation",
          reason: "Provider failure reviewed, authorise a new refund",
          mfa: next,
        },
      });
      expect(recovery.statusCode).toBe(200);
      expect(
        (
          await db`SELECT state,request_key FROM payment_compensations WHERE order_id=${order}`
        )[0],
      ).toMatchObject({ state: "pending" });
      expect(
        (
          await db`SELECT request_key FROM payment_compensations WHERE order_id=${order}`
        )[0].request_key,
      ).not.toBe(oldKey);
    } finally {
      spy.mockRestore();
    }
  });

  it("rotates webhook secrets with a bounded overlap and rejects the expired signing key", async () => {
    const original = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_current";
    process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS = "whsec_previous";
    process.env.STRIPE_WEBHOOK_PREVIOUS_EXPIRES_AT = new Date(
      Date.now() + 60000,
    ).toISOString();
    async function deliver(secret: string) {
      const payload = JSON.stringify({
        id: crypto.randomUUID(),
        type: "payment_intent.processing",
        account: "acct_fixture",
        livemode: false,
        data: { object: { id: "pi_rotation" } },
      });
      return app.inject({
        method: "POST",
        url: "/api/webhooks/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": Stripe.webhooks.generateTestHeaderString({
            payload,
            secret,
          }),
        },
        payload,
      });
    }
    try {
      expect((await deliver("whsec_previous")).statusCode).toBe(200);
      process.env.STRIPE_WEBHOOK_PREVIOUS_EXPIRES_AT = new Date(
        Date.now() - 1000,
      ).toISOString();
      expect((await deliver("whsec_previous")).statusCode).toBe(400);
      expect((await deliver("whsec_current")).statusCode).toBe(200);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = original;
      delete process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS;
      delete process.env.STRIPE_WEBHOOK_PREVIOUS_EXPIRES_AT;
    }
  });
  it("requires processed matching provider evidence to acknowledge a quarantined event", async () => {
    const object = {
      id: "po_evidence",
      amount: 500,
      currency: "gbp",
      status: "paid",
      automatic: true,
      arrival_date: 2000000000,
      balance_transaction: "txn_evidence",
      failure_code: null,
    };
    await signedEvent("payout.paid", object, { created: 200 });
    const eventId = crypto.randomUUID();
    await signedEvent(
      "payout.failed",
      { ...object, status: "failed" },
      { created: 200, eventId },
    );
    const evidence = snapshotEvent("acct_fixture", "payout.updated", {
      ...object,
      status: "failed",
    });
    await db.begin((tx) => recordFinancialEvent(tx, evidence));
    const headers = await session("admin", "evidence-review@test.local"),
      [u] =
        await db`SELECT id FROM users WHERE email='evidence-review@test.local'`,
      secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${u.id},${encryptMfa(secret, u.id)},now())`;
    const result = await app.inject({
      method: "POST",
      url: `/api/admin/reconciliation/events/${eventId}/acknowledge`,
      headers,
      payload: {
        reason: "Authoritative provider payout state supersedes conflict",
        evidenceId: evidence.id,
        mfa: new TOTP({ secret: Secret.fromBase32(secret) }).generate(),
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().resolved_by_event).toBe(evidence.id);
    expect(
      (await db`SELECT * FROM provider_events WHERE event_id=${eventId}`)
        .length,
    ).toBe(1);
  });
  it("never automatically allocates manual payouts and never grants a customer administrator permissions", async () => {
    const payout = {
      id: "po_manual",
      amount: 500,
      currency: "gbp",
      status: "paid",
      automatic: false,
      arrival_date: 2000000000,
      balance_transaction: "txn_manual",
      failure_code: null,
    };
    await signedEvent("payout.paid", payout);
    const event = snapshotEvent(
      "acct_fixture",
      "balance_transaction.snapshot",
      {
        id: "txn_manual_item",
        amount: 500,
        fee: 0,
        net: 500,
        currency: "gbp",
        source: "ch_manual",
        reporting_category: "charge",
        status: "available",
        fee_details: [],
        available_on: 1900000000,
        payout_id: payout.id,
      },
    );
    await db.begin((tx) => recordFinancialEvent(tx, event));
    expect(
      (
        await db`SELECT state,last_error FROM reconciliation_jobs WHERE event_id=${event.id}`
      )[0],
    ).toMatchObject({
      state: "blocked",
      last_error: "manual_payout_cannot_be_automatically_allocated",
    });
    expect(
      (
        await db`SELECT * FROM payout_balance_links WHERE payout_id=${payout.id}`
      ).length,
    ).toBe(0);
    const [u] =
      await db`INSERT INTO users(email,role) VALUES('grant-customer@test.local','customer') RETURNING id`;
    await expect(
      db`INSERT INTO admin_permissions VALUES(${u.id},'finance')`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("provider payout refresh records complete net reconciliation without adding platform invoice fees", async () => {
    const headers = await session("admin", "payout-review@test.local"),
      [u] =
        await db`SELECT id FROM users WHERE email='payout-review@test.local'`,
      secret = "JBSWY3DPEHPK3PXP";
    await db`INSERT INTO admin_mfa VALUES(${u.id},${encryptMfa(secret, u.id)},now())`;
    const lastResponse = {
      headers: {},
      requestId: "req_fixture",
      statusCode: 200,
    };
    const payout: Stripe.Response<Stripe.Payout> = {
      id: "po_sync",
      object: "payout",
      amount: 800,
      application_fee: null,
      application_fee_amount: null,
      arrival_date: 2000000000,
      automatic: true,
      balance_transaction: "txn_po_sync",
      created: 1,
      currency: "gbp",
      description: null,
      destination: null,
      failure_balance_transaction: null,
      failure_code: null,
      failure_message: null,
      livemode: false,
      metadata: {},
      method: "standard",
      original_payout: null,
      payout_method: null,
      reconciliation_status: "completed",
      reversed_by: null,
      source_type: "card",
      statement_descriptor: null,
      status: "paid",
      trace_id: null,
      type: "bank_account",
      lastResponse,
    };
    const balance: Stripe.BalanceTransaction = {
      id: "txn_sync",
      object: "balance_transaction",
      balance_type: "payments",
      amount: 1000,
      available_on: 1,
      created: 1,
      currency: "gbp",
      description: null,
      exchange_rate: null,
      fee: 200,
      fee_details: [
        {
          amount: 100,
          currency: "gbp",
          description: null,
          type: "stripe_fee",
          application: null,
        },
        {
          amount: 100,
          currency: "gbp",
          description: null,
          type: "application_fee",
          application: null,
        },
      ],
      net: 800,
      reporting_category: "charge",
      source: "ch_sync",
      status: "available",
      type: "charge",
    };
    const spy = vi
      .spyOn(StripeProvider.prototype, "payoutSnapshot")
      .mockResolvedValue({
        payout,
        balances: [balance],
        hasMore: false,
        nextCursor: null,
      });
    try {
      const before = (
        await db`SELECT count(*)::int AS count FROM ledger_entries`
      )[0].count;
      const result = await app.inject({
        method: "POST",
        url: `/api/admin/reconciliation/partners/${p1}/payouts/po_sync/sync`,
        headers,
        payload: {
          reason: "Reconcile completed automatic payout with merchant balance",
          mfa: new TOTP({ secret: Secret.fromBase32(secret) }).generate(),
        },
      });
      expect(result.statusCode).toBe(200);
      expect(spy).toHaveBeenCalledWith("acct_fixture", "po_sync", undefined);
      expect(
        (
          await db`SELECT complete,net_matches FROM payout_reconciliation WHERE payout_id='po_sync'`
        )[0],
      ).toMatchObject({ complete: true, net_matches: true });
      expect(
        (await db`SELECT count(*)::int AS count FROM ledger_entries`)[0].count,
      ).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("settles API-requested refund failure webhooks without issuing a credit", async () => {
    const order = await capturedCard(),
      key = crypto.randomUUID(),
      headers = await session("admin", "refund-failure-event@test.local");
    refundProvider.mockResolvedValueOnce({
      id: "re_failed_event_" + key,
      status: "pending",
    });
    expect(
      (await app.inject({ ...refundRequest(order, 100, key), headers }))
        .statusCode,
    ).toBe(200);
    const object = {
      ...refundObject(order, 100, key),
      id: "re_failed_event_" + key,
      status: "failed",
    };
    expect((await signedEvent("refund.failed", object)).statusCode).toBe(200);
    expect(
      (await db`SELECT status FROM refunds WHERE request_key=${key}`)[0].status,
    ).toBe("failed");
    expect(
      (await db`SELECT refunded_amount FROM orders WHERE id=${order}`)[0]
        .refunded_amount,
    ).toBe(0);
  });

  it("tenant guards cannot be bypassed with runtime-created temporary shadow tables", async () => {
    const order = await capturedCard(false);
    await db.unsafe(
      await readFile(
        new URL(
          "../../infrastructure/database/runtime-role.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await expect(
      db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE north_runtime");
        await tx.unsafe(
          "CREATE TEMP TABLE orders(id uuid,partner_id uuid) ON COMMIT DROP; CREATE TEMP TABLE products(id uuid,partner_id uuid) ON COMMIT DROP",
        );
        await tx`INSERT INTO pg_temp.orders VALUES(${order},${p1})`;
        await tx`INSERT INTO pg_temp.products VALUES('10000001-0000-4000-8000-000000000003',${p1})`;
        await tx`INSERT INTO public.order_items(order_id,product_id,name,quantity,unit_price) VALUES(${order},'10000001-0000-4000-8000-000000000003','Shadow attack',1,1)`;
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("failed charge attempts do not pin a payment to the wrong charge on retry", async () => {
    const res = await checkout("card"),
      order = res.json().id,
      [o] = await db`SELECT total,service_fee FROM orders WHERE id=${order}`;
    const pi = {
      id: "pi_" + order,
      currency: "gbp",
      amount: o.total,
      application_fee_amount: o.service_fee,
      amount_received: 0,
      metadata: { orderId: order },
      latest_charge: "ch_failed_" + order,
    };
    expect(
      (await signedEvent("payment_intent.payment_failed", pi)).statusCode,
    ).toBe(200);
    const failedCharge = {
      id: pi.latest_charge,
      payment_intent: pi.id,
      amount: o.total,
      amount_captured: 0,
      currency: "gbp",
      paid: false,
      captured: false,
    };
    expect((await signedEvent("charge.updated", failedCharge)).statusCode).toBe(
      200,
    );
    expect(
      (await db`SELECT charge_id FROM payments WHERE order_id=${order}`)[0]
        .charge_id,
    ).toBeNull();
    expect(
      (
        await signedEvent("payment_intent.succeeded", {
          ...pi,
          latest_charge: "ch_success_" + order,
          amount_received: o.total,
        })
      ).statusCode,
    ).toBe(200);
    expect((await signedEvent("charge.updated", failedCharge)).statusCode).toBe(
      200,
    );
    expect(
      (
        await db`SELECT charge_id,state FROM payments WHERE order_id=${order}`
      )[0],
    ).toMatchObject({ charge_id: "ch_success_" + order, state: "captured" });
  });
  it("rotation re-encrypts legacy MFA atomically and revokes sessions without exposing plaintext", async () => {
    const headers = await session("admin", "key-rotation@test.local"),
      [u] =
        await db`SELECT id FROM users WHERE email='key-rotation@test.local'`;
    await db`INSERT INTO admin_mfa(user_id,secret_ciphertext) VALUES(${u.id},${encryptMfa("JBSWY3DPEHPK3PXP", u.id)})`;
    process.env.MFA_ENCRYPTION_KEYS = JSON.stringify({ next: "43".repeat(32) });
    process.env.MFA_ACTIVE_KEY_ID = "next";
    try {
      expect(await rotateMfaKey(db)).toBeGreaterThan(0);
      const [row] =
        await db`SELECT secret_ciphertext FROM admin_mfa WHERE user_id=${u.id}`;
      expect(row.secret_ciphertext.startsWith("v1:next:")).toBe(true);
      expect(decryptMfa(row.secret_ciphertext, u.id)).toBe("JBSWY3DPEHPK3PXP");
      expect(
        (await app.inject({ url: "/api/auth/me", headers })).statusCode,
      ).toBe(401);
      expect(await rotateMfaKey(db)).toBe(0);
    } finally {
      delete process.env.MFA_ENCRYPTION_KEYS;
      delete process.env.MFA_ACTIVE_KEY_ID;
    }
  });
});
