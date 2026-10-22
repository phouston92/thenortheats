import { z } from "zod";
export const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export function config(env = process.env) {
  // Image can use production HTTP/cookie semantics; live payments remain prohibited.
  const result = environmentSchema.parse(env);
  if (env.NODE_ENV === "production") {
    if (
      env.COOKIE_SECURE !== "true" ||
      !env.MAIL_WEBHOOK_URL?.startsWith("https://") ||
      !/^[a-f0-9]{64}$/i.test(env.MFA_ENCRYPTION_KEY || "")
    )
      throw new Error(
        "Production runtime requires secure cookies, HTTPS mail and MFA encryption key",
      );
    const origin = new URL(env.PUBLIC_ORIGIN || "http://invalid");
    if (origin.protocol !== "https:")
      throw new Error("Production HTTPS public origin required");
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_"))
      throw new Error("Live payments are disabled");
  }
  return result;
}
