# Architecture

Node 24 / TypeScript / pnpm monorepo. Next.js customer website; React/Vite administration and partner portals; Expo/React Native mobile foundation; Fastify API; PostgreSQL 17 and Redis 7.4 with BullMQ. Workspaces use explicit relative source imports today; package exports establish future shared contracts. No external codebase was imported.

`packages/shared` holds integer pricing, UTC week boundaries and the fulfilment state machine. `validation` provides Zod request contracts, `database` owns migrations/seed and initial Drizzle models, `payments` owns a Stripe test adapter, `ui` supplies shared forms/navigation/status and orange design tokens, `config` rejects production activation. SQL migrations, not the incomplete Drizzle model subset, are the authoritative schema.

API sessions are hashed opaque cookies held in PostgreSQL. OTP challenges are hashed, short-lived, attempt-limited and consumed under a lock. Shared database sessions survive application restarts. Admin MFA is a development bootstrap secret, not complete per-user enrolment. Services store business state in PostgreSQL, not process memory. Partner membership checks precede tenant-scoped data operations; the DB role currently owns the development schema, so this is not RLS-based isolation.

Checkout locks the partner, reads an approved effective policy, verifies products against that partner and stores immutable server-calculated item/price snapshots. Idempotency keys are bound to a request fingerprint and a random guest tracking capability. Fulfilment and payment states are separate. Completion and ledger insertion share a transaction; unique references prevent double fees. Invoice generation serialises by partner, uses only unbilled closed-period ledger rows and unique line references.

BullMQ coordinates transactional-outbox polling. `FOR UPDATE SKIP LOCKED` serialises selected notifications across workers. Provider acknowledgements are required before marking delivery; provider idempotency keys are required to handle crashes after acknowledgement. Without a provider messages remain pending, rather than being falsely marked sent. Outbox delivery infrastructure is a foundation; no real notification delivery was verified.

No production environment is supported. See requirements-coverage.md for omitted models, features and security hardening.
