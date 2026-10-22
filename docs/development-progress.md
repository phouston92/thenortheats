# Development progress — 22 October 2026

Branch: `feature/platform-development-baseline`, based on `main`. No production deployment, live payment or VPS connection. The result is an integrated development baseline; Phases 2–4 are partial. The full brief is **not complete**. See requirements-coverage.md for every major unfinished area.

## Phase 1 — foundations checkpoint

- Empty repository inspected; feature branch created before implementation.
- All 13 pnpm workspace projects installed with pnpm 10.28.2 and frozen lockfile. Node 24.19.0.
- Initial typecheck/lint, 2 configuration tests, Next/Vite/API/worker checks passed before backend work.
- PostgreSQL 17.7 and Redis 7.4.7 Compose services started healthy.
- CI gates, local configuration, migration/seed scripts and startup documentation created.

## Phase 2 — core backend checkpoint (partial specification)

- Fresh PostgreSQL schema migrated; repeat migration and seed tested without duplication. Both demonstration partner menus seed correctly; partners remain pending without explicit approved pricing.
- First 8 API integration tests passed: health/readiness, generated OpenAPI paths, OTP single use/logout, role/CSRF boundaries, cross-tenant denial and pricing-before-activation.
- Backend phase typecheck/lint/unit checks and builds passed before interfaces.
- Initial Drizzle model subset and SQL constraints/triggers implemented. Complete entity coverage, granular roles, production authentication and database-role hardening remain unfinished.

## Phase 3 — core order/finance checkpoint (partial specification)

- Cash and provider-double card ordering, fulfilment transitions, snapshots and idempotent transactional fee accrual.
- Test-mode Stripe direct-charge adapter; verified raw webhook signatures and event deduplication; partial/full refunds and proportional fee credits; closed-week draft invoices.
- 19 PostgreSQL/API integration tests passed, including five concurrent completion requests, cash £2/card £1 fee allocation, invalid/cancelled/rejected orders, failed payment, duplicate webhook/completion/refund, tenant financial boundaries, immutable ledger/order snapshots and repeat invoice generation.
- 8 unit tests passed across configuration, state transitions, integer/percentage/rounding/refund calculations and UTC week boundaries.
- A JSON pricing-snapshot encoding defect was caught by financial integration tests and fixed before UI delivery. A stale fixed webhook fixture ID was corrected by resetting the independent webhook test table.
- Scheduled checkout, real Stripe flows, disputes, external payment/refund reconciliation, formal invoices/credit notes, subscriptions, promotions/loyalty and address providers remain unfinished/unverified.

## Phase 4 — interface checkpoint (partial specification)

- Customer Next site, independent partner Vite portal and platform administration Vite portal build and serve. All use the real shared API; empty/planned states are labelled honestly.
- Four Playwright journeys passed using installed Chromium: admin OTP+MFA and partner creation; customer cash checkout→partner completion→customer tracking with £2 ledger assertion; responsive customer browsing; live Expo Web discovery/menu/basket.
- Axe WCAG 2/2.1/2.2 AA scans passed on tested admin/customer/partner pages. Admin and customer layouts checked at 390px. Automated scans are not a full accessibility conformance claim.
- Initial contrast failures were fixed. A final parallel Next build/dev cache collision was diagnosed; separate `.next`/`.next-dev` directories now allow both checks to pass together. The interrupted collision run is not counted as passing.
- Expo Web export and separate mobile TypeScript check passed. React Native/Expo application started in Web development mode and used API discovery in Chromium. Native iOS/Android execution, native payments, secure storage and push notifications were not tested or completed.

## Final validation and runtime evidence

| Check                                                  | Executed result                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                       | Passed, 13 workspace projects                                                                             |
| `pnpm typecheck`, `pnpm typecheck:mobile`, `pnpm lint` | Passed                                                                                                    |
| `pnpm test`                                            | 8 passed, 0 failed, 0 skipped                                                                             |
| `NODE_ENV=test pnpm test:integration`                  | 19 passed, 0 failed, 0 skipped                                                                            |
| `pnpm build`                                           | Next customer site, both Vite portals, API/worker TypeScript checks passed                                |
| `CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser`    | 4 passed; includes real API ordering and representative axe scans                                         |
| `pnpm --filter @north/customer-mobile export`          | Expo Web bundle exported successfully                                                                     |
| PostgreSQL/Redis Compose                               | Healthy; migrations/seed repeatability verified                                                           |
| BullMQ worker                                          | Scheduler registered; 4 completed polling jobs, 0 failed at observation; provider delivery unconfigured   |
| Development image build                                | Passed with proxy routing and trust certificate; no verification disabled                                 |
| Non-root image runtime                                 | Passed `/api/ready` and database-backed `/api/towns` (four towns); smoke container stopped/removed        |
| `pnpm dev` convenience startup                         | Started API, worker and three web apps; readiness and HTTP responses checked                              |
| Dependency audit                                       | **Failed**: 0 critical, 2 high, 2 moderate, 1 low; details in security.md                                 |
| GitHub Actions                                         | Workflow triggered and queued/running on GitHub; completed result pending; audit gate is expected to fail |
| External providers/native devices/HA restore           | Unrun or unverified; no readiness claim                                                                   |

Docker initially lacked proxy DNS, then its non-root runtime could not read private-mode copied files. Supported proxy/CA build options and explicit node ownership resolved those failures. The temporary smoke container did not publish any external site.

## Environment persistence and delivery

Reusable `install_script` and `start_skill` saved to the cloud environment draft. Required network destinations for browser downloads, Stripe documentation and GitHub API were added while preserving package-manager presets. Draft saving does not publish the snapshot or prove restoration into a fresh task. Review/save environment settings and publish only the **development** environment when appropriate; this is unrelated to production deployment.

Git HTTPS read and feature-branch push succeeded through the platform proxy. GitHub API access initially returned `Forbidden`, but the subsequent authorised draft-PR creation succeeded. Draft PR [#1](https://github.com/phouston92/thenortheats/pull/1) is open, targets `main`, and was verified as a draft. GitHub Actions was queued/running at the final observation; no completed hosted result is claimed. No token values were requested/disclosed and no merge occurred.

## PR #1 stabilisation follow-up

See [stabilization-review.md](stabilization-review.md) for the later review, current test totals, deterministic UUID CI fix, compatible dependency updates, exact remaining advisories/exposure, payment/refund/VAT/session corrections and final hosted CI outcome. Earlier checkpoint totals above remain the original baseline history.
