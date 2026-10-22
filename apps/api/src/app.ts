import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import rawBody from "fastify-raw-body";
import { z } from "zod";
import { orderRoutes } from "./orders";
import { webhookRoutes } from "./webhooks";
import type { PaymentProvider } from "../../../packages/payments/src/index";
import { connect, type Database } from "../../../packages/database/src/index";
import { id, policyInput } from "../../../packages/validation/src/index";
import { actor, admin, tenant, audit, authRoutes } from "./auth";
export async function createApp(
  db: Database = connect(),
  provider?: PaymentProvider,
) {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              "res.headers.set-cookie",
            ],
          },
    bodyLimit: 262144,
    disableRequestLogging: true,
  });
  await app.register(cors, {
    origin: ["http://localhost:8081", "http://127.0.0.1:8081"],
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(helmet);
  await app.register(swagger, {
    openapi: { info: { title: "The North Eats API", version: "0.1.0" } },
  });
  app.get("/api/docs", async () => app.swagger());
  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: "utf8",
    runFirst: true,
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as any;
    if (e instanceof z.ZodError)
      return reply.code(400).send({
        error: "Invalid input",
        issues: e.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    if (e.code === "23505")
      return reply.code(409).send({ error: "Conflicting or duplicate record" });
    if (e.code === "22P02")
      return reply.code(400).send({ error: "Invalid identifier" });
    const status = e.statusCode || 500;
    if (status >= 500) req.log.error({ code: e.code }, "Request failed");
    reply
      .code(status)
      .send({ error: status >= 500 ? "Service operation failed" : e.message });
  });
  app.get("/api/health", async () => ({
    status: "ok",
    service: "The North Eats API",
  }));
  app.get("/api/ready", async () => {
    await db`SELECT 1`;
    return { status: "ready" };
  });
  await authRoutes(app, db);
  app.get(
    "/api/towns",
    async () => db`SELECT * FROM towns WHERE active ORDER BY name`,
  );
  app.get("/api/partners", async (req) => {
    const town = (req.query as any).town;
    return town
      ? db`SELECT p.id,p.name,p.town_id,p.preparation_minutes,p.collection,p.delivery_fee,t.name AS town FROM partners p JOIN towns t ON t.id=p.town_id WHERE p.status='active' AND NOT p.paused AND t.active AND t.name=${town} ORDER BY p.name`
      : db`SELECT p.id,p.name,p.town_id,p.preparation_minutes,p.collection,p.delivery_fee,t.name AS town FROM partners p JOIN towns t ON t.id=p.town_id WHERE p.status='active' AND NOT p.paused AND t.active ORDER BY p.name`;
  });
  app.get("/api/partners/:id/menu", async (req, reply) => {
    const p = id.parse((req.params as any).id);
    const [partner] =
      await db`SELECT id,name,delivery_fee,collection FROM partners WHERE id=${p} AND status='active' AND NOT paused`;
    if (!partner)
      return reply.code(404).send({ error: "Takeaway unavailable" });
    const [policy] =
      await db`SELECT service_fee FROM fee_policies WHERE partner_id=${p} AND effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1`;
    return {
      partner,
      serviceFee: policy?.service_fee,
      products:
        await db`SELECT id,name,category,description,price,allergens,available FROM products WHERE partner_id=${p} ORDER BY category,name`,
    };
  });
  app.get("/api/admin/partners", async (req) => {
    admin(await actor(db, req));
    return db`SELECT p.*,t.name AS town,(SELECT row_to_json(f) FROM fee_policies f WHERE f.partner_id=p.id AND effective_at<=now() ORDER BY effective_at DESC,id DESC LIMIT 1) AS pricing FROM partners p JOIN towns t ON t.id=p.town_id ORDER BY p.created_at DESC`;
  });
  app.post("/api/admin/partners", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const v = z
      .object({ name: z.string().trim().min(2).max(100), townId: id })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [p] =
        await tx`INSERT INTO partners(name,town_id) VALUES(${v.name},${v.townId}) RETURNING *`;
      await audit(tx, a, "partner.created", p.id, p.id);
      return p;
    });
  });
  app.post("/api/admin/partners/:id/pricing", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const p = id.parse((req.params as any).id);
    const v = policyInput.parse(req.body);
    return db.begin(async (tx) => {
      const [f] =
        await tx`INSERT INTO fee_policies(partner_id,fixed_fee,basis_points,minimum_fee,maximum_fee,service_fee,subscription_fee,vat_basis_points,tax_confirmed,approved_by,effective_at) VALUES(${p},${v.fixedFee},${v.basisPoints},${v.minimumFee},${v.maximumFee},${v.serviceFee},${v.subscriptionFee},${v.vatBasisPoints},${v.taxConfirmed},${a.id},${v.effectiveAt || new Date().toISOString()}) RETURNING *`;
      await audit(tx, a, "pricing.approved", f.id, p);
      return f;
    });
  });
  app.patch("/api/admin/partners/:id", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const p = id.parse((req.params as any).id);
    const v = z
      .object({ status: z.enum(["active", "pending", "suspended"]) })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [policy] =
        await tx`SELECT id FROM fee_policies WHERE partner_id=${p} AND effective_at<=now() LIMIT 1`;
      if (v.status === "active" && !policy)
        throw Object.assign(new Error("Explicit approved pricing required"), {
          statusCode: 409,
        });
      const [row] =
        await tx`UPDATE partners SET status=${v.status} WHERE id=${p} RETURNING *`;
      await audit(tx, a, "partner." + v.status, p, p);
      return row;
    });
  });
  app.post("/api/admin/towns", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const { name } = z
      .object({ name: z.string().trim().min(2).max(80) })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [row] =
        await tx`INSERT INTO towns(name) VALUES(${name}) RETURNING *`;
      await audit(tx, a, "town.created", row.id);
      return row;
    });
  });
  app.post("/api/admin/staff", async (req) => {
    const a = await actor(db, req);
    admin(a);
    const v = z
      .object({
        email: z.email(),
        role: z.enum(["owner", "operator"]),
        partnerId: id,
      })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [u] =
        await tx`INSERT INTO users(email,role) VALUES(${v.email.toLowerCase()},${v.role}) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role WHERE users.role IN ('owner','operator','customer') RETURNING id`;
      if (!u)
        throw Object.assign(new Error("Cannot reassign administrator"), {
          statusCode: 409,
        });
      await tx`INSERT INTO memberships(user_id,partner_id) VALUES(${u.id},${v.partnerId}) ON CONFLICT DO NOTHING`;
      await audit(tx, a, "staff.assigned", u.id, v.partnerId);
      return { id: u.id };
    });
  });
  app.get("/api/admin/customers", async (req) => {
    admin(await actor(db, req));
    return db`SELECT id,email,disabled,created_at FROM users WHERE role='customer' ORDER BY created_at DESC LIMIT 200`;
  });
  app.get("/api/admin/audit", async (req) => {
    admin(await actor(db, req));
    return db`SELECT l.*,u.email AS actor FROM audit_logs l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.id DESC LIMIT 200`;
  });
  app.get("/api/admin/integrations", async (req) => {
    admin(await actor(db, req));
    return db`SELECT * FROM integrations WHERE enabled`;
  });
  app.get("/api/admin/summary", async (req) => {
    admin(await actor(db, req));
    const [s] =
      await db`SELECT (SELECT count(*)::int FROM partners WHERE status='active') AS active_partners,(SELECT count(*)::int FROM partners WHERE status='pending') AS pending_partners,(SELECT count(*)::int FROM orders WHERE created_at>=date_trunc('day',now())) AS orders_today,(SELECT coalesce(sum(amount),0)::int FROM ledger_entries) AS platform_revenue`;
    return s;
  });
  app.get("/api/partner/:id", async (req) => {
    const p = id.parse((req.params as any).id);
    tenant(await actor(db, req), p);
    const [row] = await db`SELECT * FROM partners WHERE id=${p}`;
    return row;
  });
  app.patch("/api/partner/:id/settings", async (req) => {
    const a = await actor(db, req);
    const p = id.parse((req.params as any).id);
    tenant(a, p);
    const v = z
      .object({
        paused: z.boolean(),
        preparationMinutes: z.number().int().min(5).max(180),
      })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [row] =
        await tx`UPDATE partners SET paused=${v.paused},preparation_minutes=${v.preparationMinutes} WHERE id=${p} RETURNING *`;
      await audit(tx, a, "partner.operations", p, p);
      return row;
    });
  });
  app.get("/api/partner/:id/products", async (req) => {
    const p = id.parse((req.params as any).id);
    tenant(await actor(db, req), p);
    return db`SELECT * FROM products WHERE partner_id=${p} ORDER BY category,name`;
  });
  app.post("/api/partner/:id/products", async (req) => {
    const a = await actor(db, req);
    const p = id.parse((req.params as any).id);
    tenant(a, p, true);
    const v = z
      .object({
        name: z.string().min(2).max(100),
        category: z.string().min(2).max(80),
        description: z.string().max(1000).default(""),
        price: z.number().int().min(1).max(100000),
        allergens: z.array(z.string().max(80)).max(30),
      })
      .parse(req.body);
    return db.begin(async (tx) => {
      const [row] =
        await tx`INSERT INTO products(partner_id,name,category,description,price,allergens) VALUES(${p},${v.name},${v.category},${v.description},${v.price},${v.allergens}) RETURNING *`;
      await audit(tx, a, "product.created", row.id, p);
      return row;
    });
  });
  app.patch("/api/partner/:id/products/:productId", async (req, reply) => {
    const a = await actor(db, req);
    const p = id.parse((req.params as any).id);
    tenant(a, p);
    const product = id.parse((req.params as any).productId);
    const v = z.object({ available: z.boolean() }).parse(req.body);
    const [row] =
      await db`UPDATE products SET available=${v.available} WHERE partner_id=${p} AND id=${product} RETURNING *`;
    if (!row) return reply.code(404).send({ error: "Product not found" });
    await audit(db, a, "product.availability", product, p);
    return row;
  });
  app.get("/api/support", async (req) => {
    const a = await actor(db, req);
    return a.role === "admin"
      ? db`SELECT * FROM support_tickets ORDER BY created_at DESC LIMIT 200`
      : db`SELECT * FROM support_tickets WHERE customer_id=${a.id} OR partner_id=ANY(${a.partners}::uuid[]) ORDER BY created_at DESC LIMIT 100`;
  });
  app.post("/api/support", async (req) => {
    const a = await actor(db, req);
    const v = z
      .object({
        subject: z.string().trim().min(3).max(200),
        partnerId: id.optional(),
      })
      .parse(req.body);
    if (v.partnerId) tenant(a, v.partnerId);
    const [row] =
      await db`INSERT INTO support_tickets(subject,customer_id,partner_id) VALUES(${v.subject},${a.id},${v.partnerId || null}) RETURNING *`;
    return row;
  });
  app.get("/api/support/:id/messages", async (req, reply) => {
    const a = await actor(db, req);
    const ticket = id.parse((req.params as any).id);
    const [t] = await db`SELECT * FROM support_tickets WHERE id=${ticket}`;
    if (
      !t ||
      !(
        a.role === "admin" ||
        t.customer_id === a.id ||
        a.partners.includes(t.partner_id)
      )
    )
      return reply.code(404).send({ error: "Ticket not found" });
    return db`SELECT id,body,created_at FROM ticket_messages WHERE ticket_id=${ticket} ORDER BY created_at`;
  });
  app.post("/api/support/:id/messages", async (req, reply) => {
    const a = await actor(db, req);
    const ticket = id.parse((req.params as any).id);
    const { body } = z
      .object({ body: z.string().trim().min(1).max(5000) })
      .parse(req.body);
    const [t] = await db`SELECT * FROM support_tickets WHERE id=${ticket}`;
    if (
      !t ||
      !(
        a.role === "admin" ||
        t.customer_id === a.id ||
        a.partners.includes(t.partner_id)
      )
    )
      return reply.code(404).send({ error: "Ticket not found" });
    const [row] =
      await db`INSERT INTO ticket_messages(ticket_id,author_id,body) VALUES(${ticket},${a.id},${body}) RETURNING id,body,created_at`;
    return row;
  });
  await orderRoutes(app, db, provider);
  await webhookRoutes(app, db);
  return app;
}
