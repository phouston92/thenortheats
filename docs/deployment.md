# Development containers and future staging

No VPS was contacted and no production deployment is authorised. `compose.yaml` starts only PostgreSQL/Redis with persistent named volumes and loopback-published ports. The local DB password is a non-production fixture. `infrastructure/docker/Dockerfile` is a development image with non-root application execution, pinned Node/pnpm, frozen dependency install, and a selected workspace build. It retains dev tools intentionally; it is not a hardened release image.

```bash
docker build -f infrastructure/docker/Dockerfile --build-arg WORKSPACE=@north/api -t north-development:local .
# A restricted cloud home may require DOCKER_CONFIG=/workspace/.docker.
# Supply development DATABASE_URL/REDIS_URL as runtime settings, never build args.
```

Do not copy local `.env`, node_modules or build outputs into image contexts. Backend scripts read external runtime env. Processes handle SIGTERM and close database/queue connections. API liveness and PostgreSQL readiness routes exist; full dependency readiness, metrics and alerting are pending.

Before any separate VPS staging task: complete the missing requirements/security fixes; verify Stripe's test account model and external email/notifications; agree tax/refund policy; provision TLS and correctly scoped cookies/CSP/CORS; introduce least-privilege DB roles and secret storage; validate image builds and runtime networking on the target; define private persistent volumes/object storage; exercise backup restore and migrations; pass CI/audit/browser/provider tests; configure monitoring, error budgets and rollback. Native app and app-store release are separate work. No source change here authorises production activation.

## Restricted cloud build networking

The validated cloud build used the existing environment proxy with standard Docker `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` build arguments, `--network=host`, and an explicit host entry for the proxy hostname resolved in the running machine. Its public trust certificate was supplied as the BuildKit `proxy_ca` secret. No TLS or package verification was disabled, and the certificate/proxy credentials were not copied into image layers. The host address is environment-specific; resolve it again instead of hardcoding the observed address into reusable configuration. Ordinary developer networks need none of these overrides.

## Isolated backend image (not deployed)

`infrastructure/docker/backend.Dockerfile` is separate from the development image. Its builder installs only the root/API manifests (mobile/frontend workspaces are absent), bundles backend TypeScript and generates a pruned, lockfile-backed API runtime using `pnpm deploy --prod`. Only backend modules and runtime dependencies enter the final non-root Node image. Neither Expo tooling nor application secrets/migration-owner credentials enter the final image. The same image can run the worker with `node worker.mjs`; schema migrations are a separate privileged operator step, not application startup.

```bash
pnpm build:backend
pnpm audit:backend
docker build -f infrastructure/docker/backend.Dockerfile -t north-backend:ci .
docker run --rm --entrypoint node \
  -v "$PWD/scripts/verify-backend.mjs:/verify-backend.mjs:ro" \
  north-backend:ci /verify-backend.mjs
# Uses ONLY TEST_DATABASE_URL (*_test), a temporary generated restricted login,
# local Docker host networking and port 3109; container/login are removed.
pnpm test:backend-image
pnpm audit --audit-level high # still required; currently fails on mobile tooling
```

The runtime role SQL is applied **after** migrations, by the owner. Provision a separate login in a secret manager and grant `north_runtime` to it; never grant the runtime migration-owner membership. API and worker production-semantics startup reject superuser, CREATE ROLE/DB, replication, bypass-RLS, schema-create or immutable-record mutation privileges. No secret or real production login is created in source control. Local image tests use fresh random credentials only on the dedicated test database.

Runtime configuration requires `NODE_ENV=production`, `COOKIE_SECURE=true`, `PUBLIC_ORIGIN=https://…`, HTTPS `MAIL_WEBHOOK_URL`, a private 64-hex `MFA_ENCRYPTION_KEY`, database/Redis URLs and, when enabled for provider tests, **test-only** Stripe credentials. Same-origin edge routing is required; cross-origin API CORS is disabled in production semantics. Set only trusted proxy CIDRs. Provision individual administrator MFA using the operator command before use. TLS termination, static portal headers, secret rotation, backups/restore, OS-image scanning and provider/contract checks remain prerequisites to a separately authorised staging task. The current image supports a secure configuration boundary; it does not establish deployment readiness. No image was pushed to a registry and no service was deployed.

## Current staging preparation

See [VPS staging runbook](staging-runbook.md), [Stripe verification](stripe-test-procedure.md) and [delivery evidence](reconciliation-staging-review.md). The source now includes reviewed-shape Compose, Caddy HTTPS/static portal routing, private Prometheus/alert rules, a compiled one-off migration image and an isolated standalone Next image. No staging service has been started. Application images remain non-root and exclude developer/mobile toolchains; the Next global optional TypeScript compiler is pruned after successful build checks and verified absent at runtime.

The backend image uses a whitelisted secret-file loader and defaults to API mode; use command `worker` for the worker. Compile/execute schema changes only through the separate `--target migration` image with owner credentials. That target contains compiled migration code/SQL; the default application target excludes it. API and worker receive only the restricted login. Readiness checks both PostgreSQL and Redis; worker heartbeat/private authenticated metrics are separate. The old development-image instructions above remain development-only.
