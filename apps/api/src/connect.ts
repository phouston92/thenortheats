import type { FastifyInstance } from "fastify";
import type { Database } from "../../../packages/database/src/index";
import { StripeProvider } from "../../../packages/payments/src/index";
import { id } from "../../../packages/validation/src/index";
import { actor, tenant, audit } from "./auth";
function portalOrigin() {
  const origin = new URL(
    process.env.PARTNER_PORTAL_ORIGIN || "http://localhost:5174",
  );
  if (
    origin.protocol !== "https:" &&
    !(
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(origin.hostname)
    )
  )
    throw new Error("HTTPS partner portal origin required");
  return origin.origin;
}
export async function connectRoutes(app: FastifyInstance, db: Database) {
  app.get("/api/partner/:id/payments/readiness", async (req) => {
    const a = await actor(db, req),
      partnerId = id.parse((req.params as { id: string }).id);
    tenant(a, partnerId, true);
    const [p] =
      await db`SELECT stripe_account FROM partners WHERE id=${partnerId}`;
    if (!p)
      throw Object.assign(new Error("Partner not found"), { statusCode: 404 });
    if (!p.stripe_account)
      return { connected: false, ready: false, testMode: true };
    try {
      await new StripeProvider().ready(p.stripe_account);
      return { connected: true, ready: true, testMode: true };
    } catch {
      return { connected: true, ready: false, testMode: true };
    }
  });
  app.post("/api/partner/:id/payments/onboarding", async (req) => {
    const a = await actor(db, req),
      partnerId = id.parse((req.params as { id: string }).id);
    tenant(a, partnerId, true);
    const origin = portalOrigin(),
      provider = new StripeProvider();
    const p = await db.begin(async (tx) => {
      const [p] =
        await tx`SELECT * FROM partners WHERE id=${partnerId} FOR UPDATE`;
      if (!p)
        throw Object.assign(new Error("Partner not found"), {
          statusCode: 404,
        });
      if (
        !p.stripe_account &&
        p.stripe_onboarding_started_at &&
        Date.now() - new Date(p.stripe_onboarding_started_at).getTime() >=
          23 * 60 * 60 * 1000
      )
        throw Object.assign(
          new Error("Interrupted onboarding requires provider reconciliation"),
          { statusCode: 409 },
        );
      await tx`UPDATE partners SET stripe_onboarding_started_at=COALESCE(stripe_onboarding_started_at,now()) WHERE id=${partnerId}`;
      return p;
    });
    let account = p.stripe_account as string | null;
    if (!account) {
      const created = await provider.createAccount(partnerId);
      const [saved] =
        await db`UPDATE partners SET stripe_account=${created.id} WHERE id=${partnerId} AND (stripe_account IS NULL OR stripe_account=${created.id}) RETURNING stripe_account`;
      if (!saved)
        throw Object.assign(new Error("Connected account conflict"), {
          statusCode: 409,
        });
      account = created.id;
    }
    // Refresh returns to the portal; a new authenticated POST obtains another expiring link.
    const link = await provider.onboarding(
      account,
      origin + "/?connect=refresh",
      origin + "/?connect=return",
    );
    await audit(db, a, "payments.onboarding", partnerId, partnerId);
    return { url: link.url, expiresAt: link.expires_at, testMode: true };
  });
}
