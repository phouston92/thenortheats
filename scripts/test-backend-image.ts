import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "../packages/database/src/index";
const source = process.env.TEST_DATABASE_URL;
if (!source || !new URL(source).pathname.endsWith("_test"))
  throw new Error("Dedicated *_test database required");
const db = connect(source),
  suffix = randomBytes(8).toString("hex"),
  role = "north_image_" + suffix,
  name = "north-image-" + suffix;
function docker(args: string[], env = process.env) {
  const r = spawnSync("docker", args, { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error("Docker command failed: " + r.stderr);
  return r.stdout.trim();
}
let created = false,
  started = false;
try {
  await db.unsafe(
    await readFile(
      new URL("../infrastructure/database/runtime-role.sql", import.meta.url),
      "utf8",
    ),
  );
  // Identifiers/password are generated hex, never request input or shell text.
  const password = randomBytes(32).toString("hex");
  await db.unsafe(
    `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
  );
  created = true;
  await db.unsafe(`GRANT north_runtime TO ${role}`);
  const runtime = new URL(source);
  runtime.username = role;
  runtime.password = password;
  const env = {
    ...process.env,
    DATABASE_URL: runtime.toString(),
    NODE_ENV: "production" as const,
    PORT: "3109",
    COOKIE_SECURE: "true",
    PUBLIC_ORIGIN: "https://image.example.test",
    MAIL_WEBHOOK_URL: "https://mail.example.test",
    MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  };
  docker(
    [
      "run",
      "--rm",
      "-d",
      "--network=host",
      "--name",
      name,
      ...[
        "DATABASE_URL",
        "REDIS_URL",
        "NODE_ENV",
        "PORT",
        "COOKIE_SECURE",
        "PUBLIC_ORIGIN",
        "MAIL_WEBHOOK_URL",
        "MFA_ENCRYPTION_KEY",
      ].flatMap((k) => ["-e", k]),
      process.env.BACKEND_IMAGE || "north-backend:ci",
    ],
    env,
  );
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:3109/api/ready");
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Wait for startup. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready)
    throw new Error(
      "Production image did not become ready with least-privilege login",
    );
  const response = await fetch("http://127.0.0.1:3109/api/auth/me");
  if (
    response.status !== 401 ||
    response.headers.get("cache-control") !== "no-store" ||
    response.headers.get("x-content-type-options") !== "nosniff"
  )
    throw new Error("Runtime HTTP security smoke failed");
  console.log(
    "Backend image readiness, least-privilege login, authentication and HTTP headers passed (local test database only).",
  );
} finally {
  if (started) docker(["stop", "--time", "10", name]);
  if (created) await db.unsafe(`DROP ROLE ${role}`);
  await db.end();
}
