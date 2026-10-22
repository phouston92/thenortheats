import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const name = "north-web-check-" + randomBytes(6).toString("hex");
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error("Docker web check failed: " + r.stderr);
  return r.stdout.trim();
}
let started = false;
try {
  docker([
    "run",
    "--rm",
    "-d",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--tmpfs",
    "/tmp:size=32m,mode=1777",
    "-p",
    "127.0.0.1:3108:3000",
    "--name",
    name,
    process.env.WEB_IMAGE || "north-web:ci",
  ]);
  started = true;
  let response;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch("http://127.0.0.1:3108");
      if (r.ok) {
        response = r;
        break;
      }
    } catch {
      /* Waiting for local startup. */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!response) throw new Error("Web release image failed readiness");
  const policy = response.headers.get("content-security-policy") || "",
    nonce = /nonce-([^']+)/.exec(policy)?.[1],
    html = await response.text();
  if (
    !nonce ||
    !html.includes('nonce="' + nonce + '"') ||
    !policy.includes("'strict-dynamic'") ||
    policy.includes("'unsafe-eval'") ||
    response.headers.get("cache-control")?.includes("public")
  )
    throw new Error("Production nonce/CSP/cache configuration failed");
  const next = await fetch("http://127.0.0.1:3108");
  if (next.headers.get("content-security-policy") === policy)
    throw new Error("HTML nonce reused");
  console.log(
    "Read-only non-root web image passed HTTP readiness and fresh nonce/strict script CSP checks.",
  );
} finally {
  if (started) docker(["stop", "--time", "10", name]);
}
