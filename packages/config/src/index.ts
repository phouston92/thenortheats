import { mfaKeys } from "./mfa-keys";
import { z } from "zod";
export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .url()
    .refine((value) =>
      ["postgres:", "postgresql:"].includes(new URL(value).protocol),
    ),
  REDIS_URL: z
    .url()
    .refine((value) => ["redis:", "rediss:"].includes(new URL(value).protocol)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export function config(env = process.env) {
  // Image can use production HTTP/cookie semantics; live payments remain prohibited.
  const result = environmentSchema.parse(env);
  if (env.NODE_ENV === "production") {
    if (
      env.COOKIE_SECURE !== "true" ||
      !env.MAIL_WEBHOOK_URL?.startsWith("https://") ||
      !(env.MFA_ENCRYPTION_KEY || env.MFA_ENCRYPTION_KEYS)
    )
      throw new Error(
        "Production runtime requires secure cookies, HTTPS mail and MFA encryption key",
      );
    mfaKeys(env);
    const mail = new URL(env.MAIL_WEBHOOK_URL!);
    if (mail.protocol !== "https:" || mail.username || mail.password)
      throw new Error("Invalid HTTPS mail endpoint");
    const origin = new URL(env.PUBLIC_ORIGIN || "http://invalid");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error("Production HTTPS public origin required");
    for (const field of ["PARTNER_PORTAL_ORIGIN", "ADMIN_PORTAL_ORIGIN"]) {
      if (env[field]) {
        const url = new URL(env[field]);
        if (url.protocol !== "https:" || url.origin !== env[field])
          throw new Error("HTTPS portal origin required");
      }
    }
    if (env.STRIPE_WEBHOOK_SECRET_PREVIOUS) {
      const expires = Date.parse(env.STRIPE_WEBHOOK_PREVIOUS_EXPIRES_AT || "");
      if (
        !Number.isFinite(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 86400000
      )
        throw new Error("Webhook rotation overlap must expire within 24 hours");
    }
    if (
      env.TRUST_PROXY_CIDRS?.split(",").some((v) =>
        ["0.0.0.0/0", "::/0", "true", "*"].includes(v.trim()),
      )
    )
      throw new Error("Explicit trusted proxy networks required");
    if (
      env.STRIPE_PUBLISHABLE_KEY &&
      !env.STRIPE_PUBLISHABLE_KEY.startsWith("pk_test_")
    )
      throw new Error("Live publishable keys are disabled");
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_"))
      throw new Error("Live payments are disabled");
  }
  return result;
}
