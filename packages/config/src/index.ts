import { z } from "zod";
export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test"]).default("development"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
});
export function config(env = process.env) {
  return environmentSchema.parse(env);
}
