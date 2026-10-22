import { describe, it, expect } from "vitest";
import { encryptMfa, decryptMfa } from "../../apps/api/src/mfa";
import { config } from "../../packages/config/src/index";
describe("credential encryption and runtime gates", () => {
  it("authenticates ciphertext and binds the secret to one user", () => {
    process.env.MFA_ENCRYPTION_KEY = "42".repeat(32);
    const encrypted = encryptMfa("JBSWY3DPEHPK3PXP", "user-a");
    expect(encrypted).not.toContain("JBSWY");
    expect(decryptMfa(encrypted, "user-a")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decryptMfa(encrypted, "user-b")).toThrow();
    const tampered = Buffer.from(encrypted, "base64");
    tampered[15] ^= 1;
    expect(() => decryptMfa(tampered.toString("base64"), "user-a")).toThrow();
  });
  it("production HTTP configuration fails closed and never enables live payments", () => {
    const env = {
      NODE_ENV: "production" as const,
      DATABASE_URL: "postgres://localhost/db",
      REDIS_URL: "redis://localhost",
    };
    expect(() => config(env)).toThrow();
    const secure = {
      ...env,
      COOKIE_SECURE: "true",
      MAIL_WEBHOOK_URL: "https://mail.example.test",
      MFA_ENCRYPTION_KEY: "42".repeat(32),
      PUBLIC_ORIGIN: "https://example.test",
    };
    expect(config(secure).NODE_ENV).toBe("production");
    expect(() =>
      config({ ...secure, STRIPE_SECRET_KEY: "sk_live_fixture" }),
    ).toThrow("Live payments");
  });
});
