# Database

`packages/database/migrations` contains sequential, checksum-verified SQL migrations. `pnpm db:migrate` acquires a transaction advisory lock, applies each migration atomically and records its checksum; a second run is a no-op. Never edit applied migrations. `pnpm db:seed` uses stable UUIDs and unique constraints for repeatable local fixtures. `schema.ts` contains initial Drizzle models; SQL is authoritative and the rest of the Drizzle models remain unfinished.

Implemented: towns, users, memberships, sessions, authentication challenges and MFA replay counters; partners, pricing versions and products; orders, item snapshots and status history; payments, webhooks, refunds and reconciliation records; immutable ledger, invoice sequences/headers/lines; outbox notifications, tickets/messages, disabled integration registry and minimal platform settings. Foreign keys, checks, unique keys and partner/time indexes protect the core schema. The activation trigger requires an explicit effective partner policy.

Ledger entries, pricing policies, audit entries and invoice lines reject updates/deletes. Corrections use new entries. Current invoices are drafts only; invoice issue, payment collection, formal credit notes and subscriptions are not implemented. VAT is explicitly configured per policy and captured on ledger rows. Nothing assumes UK VAT treatment.

Tenant access uses bound SQL parameters and explicit membership predicates. SQL migration connections are schema-owner connections for local development. Before staging introduce a separate least-privilege application role, composite tenant foreign keys throughout, RLS defence in depth, and tests against that role. Current database owners can bypass application isolation; do not expose PostgreSQL publicly.

## Migration and recovery

Back up before migration. Migrations run inside one PostgreSQL transaction, protected against concurrent runners. No automatic destructive down migrations are supplied. For failed application releases, revert the application only when compatible with the current schema. Otherwise restore a tested backup into a separate database and reconcile lost writes before switching; never casually reverse financial history.

See requirements-coverage.md for the complete list of entity areas not yet implemented.

## PR #1 stabilisation migrations

0006 installs an access-change trigger that revokes sessions on role/disabled changes; 0007 revokes legacy sessions once on upgrade. 0008 adds nullable immutable ledger tax snapshots without changing existing financial rows. New credits store cumulative tax reversals and invoices use explicit snapshots with a legacy fallback. Apply these migrations before running the updated API. Session logout is intentional; business data is not removed.
