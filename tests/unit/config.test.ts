import { describe, it, expect } from "vitest";
import { environmentSchema } from "../../packages/config/src/index";
describe("development boundary", () => {
  it("rejects production and missing database", () => {
    expect(
      environmentSchema.safeParse({ NODE_ENV: "production" }).success,
    ).toBe(false);
  });
  it("accepts development services", () => {
    expect(
      environmentSchema.parse({
        DATABASE_URL: "postgres://localhost/db",
        REDIS_URL: "redis://localhost",
      }).PORT,
    ).toBe(3001);
  });
});
