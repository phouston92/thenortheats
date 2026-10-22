import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const path = await mkdtemp(join(tmpdir(), "north-staging-check-")),
  folder = resolve("infrastructure/staging");
const env = {
  ...process.env,
  SECRETS_DIR: path,
  PORTAL_ARTIFACTS: path,
  BACKEND_IMAGE: "north-backend@sha256:" + "0".repeat(64),
  WEB_IMAGE: "north-web@sha256:" + "0".repeat(64),
  PUBLIC_ORIGIN: "https://customer.example.test",
  PARTNER_PORTAL_ORIGIN: "https://partner.example.test",
  ADMIN_PORTAL_ORIGIN: "https://admin.example.test",
  CUSTOMER_HOST: "customer.example.test",
  PARTNER_HOST: "partner.example.test",
  ADMIN_HOST: "admin.example.test",
};
function docker(args) {
  const r = spawnSync("docker", args, { env, stdio: "inherit" });
  if (r.status !== 0)
    throw new Error("Staging configuration validation failed");
}
try {
  await writeFile(
    join(path, "monitoring_token"),
    "fixture-monitoring-token-not-a-credential",
    { mode: 0o600 },
  );
  docker(["compose", "-f", folder + "/compose.yaml", "config", "--quiet"]);
  docker([
    "run",
    "--rm",
    "--entrypoint",
    "caddy",
    ...["CUSTOMER_HOST", "PARTNER_HOST", "ADMIN_HOST"].flatMap((k) => [
      "-e",
      k,
    ]),
    "-v",
    folder + "/Caddyfile:/etc/caddy/Caddyfile:ro",
    "caddy:2.10.2-alpine",
    "validate",
    "--config",
    "/etc/caddy/Caddyfile",
    "--adapter",
    "caddyfile",
  ]);
  docker([
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "/bin/promtool",
    "-v",
    folder + "/prometheus.yml:/etc/prometheus/prometheus.yml:ro",
    "-v",
    folder + "/alerts.yml:/etc/prometheus/alerts.yml:ro",
    "-v",
    path + "/monitoring_token:/run/secrets/monitoring_token:ro",
    "prom/prometheus:v3.7.3",
    "check",
    "config",
    "/etc/prometheus/prometheus.yml",
  ]);
  console.log(
    "Compose, Caddy and Prometheus/alert syntax validated only; no staging service was started.",
  );
} finally {
  await rm(path, { recursive: true, force: true });
}
