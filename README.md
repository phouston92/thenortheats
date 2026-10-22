# The North Eats

A development-only, multi-town food ordering monorepo. The customer site, partner portal and platform administration use the same Fastify/PostgreSQL API. The verified integrated journey is **cash collection checkout → partner acceptance/preparation/completion → customer tracking → immutable fees**. This is a partial implementation of the four-phase brief, not a finished platform or a staging/production release.

## Start locally

Prerequisites: Node **24.19.0**, pnpm **10.28.2**, Docker Engine and Compose. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm setup:local
pnpm services
pnpm db:migrate
pnpm db:seed
```

`setup:local` creates a private, ignored `.env` with a randomly generated MFA encryption key; an existing file is preserved. Seed is repeatable and creates four towns, two pending demonstration partners and, when `SEED_ADMIN_EMAIL` is present, the local admin account. It never supplies an approved partner policy or activates a partner automatically. The local Docker database password is for isolated development only.

After migration and seed, enroll the local administrator once:

```bash
pnpm admin:mfa admin@example.test /tmp/north-admin-enrollment.json
```

Import that private file into an authenticator, then delete it. Existing checkouts need a new, randomly generated 64-hex `MFA_ENCRYPTION_KEY` in their private `.env`; the old shared `ADMIN_MFA_SECRET` is no longer accepted. The operator command refuses to overwrite an enrolled credential; subsequent rotation and recovery codes are managed under administration → Platform Settings.

Run `pnpm dev` to start the API, worker and three web apps together, or run each process in a separate terminal:

```bash
pnpm dev:api       # API 3001; /api/health, /api/ready, /api/docs (OpenAPI JSON)
pnpm dev:worker    # Redis-coordinated transactional notification outbox
pnpm dev:web       # Next customer site, port 3000
pnpm dev:partner   # Vite partner portal, port 5174
pnpm dev:admin     # Vite administration, port 5173
pnpm dev:mobile --web --port 8081  # Expo Web development foundation
```

Ports describe local development; no public preview or deployment is created. Server and database scripts automatically load `.env` without overriding exported variables. On physical devices configure `EXPO_PUBLIC_API_URL` to the reachable development API; native device sessions, payments and notifications have not been verified.

## First development order

1. Sign into administration with `admin@example.test` (or your configured seed email). Request an email code.
2. Run `pnpm dev:mail` locally to inspect the private development mailbox. Codes expire after five minutes. Run `pnpm dev:mfa` for the current local administrator authenticator code. These explicit development helpers display authentication codes; never use them with real users or a hosted deployment. No code is returned by the API or written to server logs.
3. In Partners, approve a policy explicitly. For the launch model enter 100 pence completed-order fee, 100 pence customer service fee, zero commission. VAT zero is an **unconfirmed test setting**, not tax advice. Leave tax confirmation unchecked until an accountant has approved treatment. Activate the partner only after policy approval.
4. In Users and Permissions, assign an owner email to that partner. The partner user signs into the independent portal using email OTP.
5. Browse the customer site, choose Lancaster or Morecambe, select the activated partner and place a cash collection order. Advance it in the partner portal. Tracking updates from the real API.
6. The completed cash order generates two unique £1 ledger entries. A card order generates only the partner fee in weekly billing; the customer fee is allocated via the test Stripe adapter, not billed twice. Stripe test card UI and partner onboarding are implemented; they require privately configured test credentials and have not been verified against Stripe. See [payments](docs/payments.md).

## Validation

Use a separate database named with the `_test` suffix. **Integration tests truncate their test database.** Never use a business database.

```bash
docker compose exec -T postgres createdb -U north north_test  # once
export TEST_DATABASE_URL=postgres://north:north_dev_only@127.0.0.1:5432/north_test
pnpm typecheck
pnpm typecheck:mobile
pnpm lint
pnpm test
NODE_ENV=test pnpm test:integration
NEXT_TELEMETRY_DISABLED=1 pnpm build
pnpm exec playwright install --with-deps chromium
pnpm test:browser
pnpm --filter @north/customer-mobile export
pnpm build:backend
pnpm audit:backend  # isolated runtime only; does not replace the repository audit
pnpm audit --audit-level high
```

When an existing system Chromium is available, `CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser` avoids downloading another copy. Browser tests start their own API (3101), customer site (3100), partner portal (5274), admin (5273) and Expo Web (8081), with a separate `.next-browser` cache. They insert clearly named deterministic fixtures. Leave those test ports free; ordinary development servers use different ports. Browser MFA fixtures are test-only and cannot be used by the ordinary `.env` setup.

See [development results](docs/development-progress.md), [requirements coverage](docs/requirements-coverage.md), [open decisions](docs/open-decisions.md) and [security](docs/security.md). The dependency audit currently fails on two high-severity Expo tooling advisories without published fixes (plus one moderate finding); no exceptions are hidden in CI.

Review follow-up: [PR #1 stabilisation report](docs/stabilization-review.md). Access-change migrations revoke existing sessions once; run migrations before starting the updated API.

Current follow-up: [payment/security/isolation report](docs/payment-security-review.md). Backend production-semantics image build and restricted-login smoke instructions are in [deployment](docs/deployment.md); no deployment is authorised.
