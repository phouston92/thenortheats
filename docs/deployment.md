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
