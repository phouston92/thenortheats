# Delivery report

## Scope

The North Eats now has a working integrated **development baseline**, rather than an empty repository. Phase 1 foundations are implemented; Phases 2–4 have functional core slices and substantial outstanding requirements. See requirements-coverage.md for detailed omissions; this report must not be read as complete implementation of the master brief.

- Foundations: TypeScript/pnpm monorepo, pinned stack, local private setup, PostgreSQL/Redis Compose, CI, scripts, migrations, seed, tests and development container.
- Backend: OTP sessions, bootstrap admin MFA, role/tenant checks, explicit partner pricing/activation, products, order state machine, immutable price/financial records, invoice drafts and support-ticket/message foundation.
- Finance: real database cash flow; deterministic provider-double card tests, signed Stripe webhook processing, partial/full fee reversal and idempotency. Stripe account operations, liability, payouts and external refund reconciliation remain unverified.
- Interfaces: branded customer cash ordering/tracking/account foundation, operational partner portal, admin dashboard/partner/pricing/town/finance/support/audit screens; Expo Web-tested discovery/menu/basket and auth/tracking code. Planned UI destinations say so explicitly.

## Executed results

8 unit tests, 19 API/PostgreSQL integration tests and 4 browser journeys passed. Typecheck, mobile typecheck, lint, all web/backend build checks and Expo Web export passed. The browser suite includes actual customer checkout and partner fulfilment plus representative axe/mobile-width checks. PostgreSQL/Redis, BullMQ scheduler execution, local startup and non-root API image readiness/database discovery were verified. See development-progress.md for phase history and test distinctions.

Dependency audit remains failing: 2 high, 2 moderate and 1 low advisories, with no critical findings after upgrades. The high findings are in Expo development tooling without published fixes. The CI audit gate is not suppressed; hosted CI has not been observed. Native devices, Stripe, email/push, accounting, address providers, failover and backup restore remain unverified.

## Run and review

Follow README.md exactly: install, `pnpm setup:local`, `pnpm services`, migrate/seed, then `pnpm dev`. Local admin sign-in uses the explicit private development mailbox and authenticator helpers. Partners require deliberate approved pricing and activation before ordering. The test database must be separate and end `_test`.

Reusable cloud install/start instructions are saved as a draft, not published. Only local development services were started. No VPS, production payments, merge or production deployment occurred.

## Next work and staging gates

1. Resolve security advisories and complete per-user MFA, least-privilege DB isolation and production HTTP/secret/abuse controls.
2. Confirm VAT, inclusive/exclusive advertised fees, refund rules, Connect liability/disputes and invoice collection with the appropriate business/accounting/provider owners.
3. Complete Stripe test onboarding/UI/verification, robust reconciliation and cancellation/refund compensation, then real provider tests.
4. Implement the remaining schemas/menu modifiers/hours/closures/scheduling, billing lifecycle/subscriptions/promotions, address providers, full portal/account workflows and native checkout/push.
5. Validate hardened release containers, external delivery/storage, monitoring, backups/restores and migration rollback before a separately authorised VPS **staging** task. Passing current tests is not production readiness.

## Git delivery

Feature branch: `feature/platform-development-baseline`. Target: `main`. Draft PR requested; creation requires working GitHub API access. A read-only GitHub API request returned `Forbidden`, while Git HTTPS read and dry-run push worked. No secret is embedded in this report. The authorised push and PR creation are attempted after the final local commit; see the task response for the actual outcome.
