import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "../../packages/database/src/index";
import { migrate } from "../../packages/database/src/migrate";
import { seed } from "../../packages/database/src/seed";
import { createApp } from "../../apps/api/src/app";
import Stripe from "stripe";
import { weekStart } from "../../packages/shared/src/index";
import { hash } from "../../apps/api/src/auth";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error(
    "TEST_DATABASE_URL must point at a dedicated *_test database",
  );
process.env.DEV_MAIL_DIR = "/tmp/north-integration-mail";
const db = connect(url);
const app = await createApp(db, {
  intent: async (o) => ({
    id: "pi_" + o.id,
    clientSecret: "test_fixture_only",
  }),
  refund: async (_intent, _account, _amount, key) => ({
    id: "re_" + key,
    status: "succeeded",
  }),
  capture: async () => {},
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
  await db`TRUNCATE towns,users,webhook_events CASCADE`;
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
    const [o] = await db`SELECT total FROM orders WHERE id=${orderId}`;
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
      (await webhook(cardId, "payment_intent.succeeded", "evt_success"))
        .statusCode,
    ).toBe(200);
    expect(
      (await webhook(cardId, "payment_intent.succeeded", "evt_success")).json()
        .duplicate,
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
});
