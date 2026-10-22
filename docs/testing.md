# Validation

Use the README commands. Unit tests run without services. Integration/browser tests require an isolated `TEST_DATABASE_URL` whose database name ends `_test`; integration setup truncates it. Fixtures never call live payment providers. Browser tests launch dedicated local services with test-specific administrator MFA and private mail directories.

Executed checkpoints are recorded in development-progress.md. Financial tests exercise real PostgreSQL locks, unique constraints and transactions, including five concurrent completion requests. Signed webhook fixtures use the official SDK's test-signature helper, not a signature-verification bypass. Browser tests perform a customer checkout and partner fulfilment with the real shared API, and check the ledger directly. Axe scans apply WCAG 2/2.1/2.2 AA tags to representative dashboard, customer and partner screens, not every possible screen or assistive technology. Responsive checks cover 390px customer/admin widths; native iOS/Android and browser notifications are unverified.

Expo Web export and browser discovery/basket tests validate the mobile foundation only; they do not prove native checkout, native cookie behaviour, secure storage, push tokens or app-store readiness. Provider adapter doubles prove the application logic, not Stripe connectivity/liability/refunds/payouts.

GitHub Actions installs pinned dependencies, runs lint/typechecks/tests/builds, validates migration/seed repeatability, installs Chromium, runs browser tests and audits dependencies. CI itself has not been observed on GitHub. Audit currently fails intentionally on unresolved advisories, not a hidden allowlist. Container image validation is tracked separately in the progress document.
