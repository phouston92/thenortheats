import { readFile } from "node:fs/promises";
// Explicit names only; runtime secrets never enter image layers or stdout.
for (const name of [
  "DATABASE_URL",
  "REDIS_URL",
  "MFA_ENCRYPTION_KEY",
  "MFA_ENCRYPTION_KEYS",
  "MFA_ACTIVE_KEY_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_PREVIOUS",
  "STRIPE_WEBHOOK_PREVIOUS_EXPIRES_AT",
  "MAIL_WEBHOOK_URL",
  "NOTIFICATION_WEBHOOK_URL",
  "MONITORING_TOKEN",
]) {
  const path = process.env[name + "_FILE"];
  if (!path) continue;
  if (process.env[name])
    throw new Error(
      "Conflicting environment and file configuration for " + name,
    );
  if (!path.startsWith("/run/secrets/") || path.includes(".."))
    throw new Error("Secret path must be inside /run/secrets");
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error("Empty runtime secret: " + name);
  process.env[name] = value;
}
const mode = process.argv[2] || "api";
if (!["api", "worker"].includes(mode))
  throw new Error("Unknown backend process");
await import("./" + mode + ".mjs");
