# Security and current limits

This application refuses `NODE_ENV=production`; development and test only. Never connect it to real customers, live payments or an internet-facing VPS. No production deployment was attempted.

Implemented controls: hashed five-minute OTP challenges, five-attempt limit, single-use consumption under row lock; hashed opaque 12-hour sessions and logout revocation; admin TOTP replay counters; role/membership checks; CSRF token required for authenticated writes; HttpOnly SameSite Strict cookies; parameterised SQL; Zod input limits; request body/rate limits; generic server errors and request logging disabled; verified raw-body Stripe signatures; audit and financial immutability; server-calculated order prices and unique financial references. Secure cookies can be enabled with `COOKIE_SECURE=true` for HTTPS testing. CORS is limited to the two local Expo Web origins; portal/web traffic uses same-origin proxies. Guest order capabilities must be treated like credentials; they are held in browser storage, never public query strings.

The private development mailbox is outside the checkout, mode 0700, with files mode 0600. Explicit CLI helpers display local OTP/TOTP values for developer testing; these are not production delivery systems. `.env` is ignored and created exclusively without overwriting existing values. Tests use clearly named fake provider secrets solely to sign deterministic local fixtures.

## Unfinished controls

Per-user MFA enrolment/recovery and secret encryption; Redis-distributed auth rate limits and account-level abuse counters; login-CSRF/origin hardening and session rotation; granular per-membership permissions and administrator lifecycle; RLS/least-privilege DB role and composite tenant keys; retention and removal of old OTP/session/mail records; production CSP/TLS/proxy hardening and external-origin configuration; attachment malware scanning/presigned upload authorisation (no upload endpoint exists); privacy/consent/data-retention operations; formal threat model and security review. The Fastify API supplies Helmet defaults, but customer/portal deployment security headers are not production hardened.

Basic API tenant, RBAC and CSRF checks are exercised. This does not establish OWASP compliance or full WCAG conformance. No support impersonation endpoint exists; audited delegated support access remains unimplemented.

## Dependency audit

The initial scan found vulnerable framework/test packages. Next, Fastify, Drizzle, Vite and Vitest were upgraded to patched versions; PostCSS, sharp and image-size use pinned patched overrides. Final recorded scan: **0 critical, 2 high, 2 moderate, 1 low**. High advisories without published fixes affect `node-forge` (Expo CLI) and `braces` (Metro/micromatch). Moderate findings affect transitive `uuid` and `sprintf-js`; low affects esbuild on Windows. These are unresolved, not suppressed. `pnpm audit --audit-level high` therefore fails and CI must not be represented as green. Do not remove the gate to hide this. Review a newer compatible Expo toolchain or provider fixes before staging. Update scans as registries change.
