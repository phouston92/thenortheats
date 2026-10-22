-- Run as the migration owner after migrations, never as the API login.
-- Grant this NOLOGIN group to a separately provisioned login with its own secret.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='north_runtime') THEN
    CREATE ROLE north_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
REVOKE ALL ON SCHEMA public FROM north_runtime;
GRANT USAGE ON SCHEMA public TO north_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM north_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  towns,users,partners,memberships,sessions,auth_challenges,mfa_uses,admin_mfa,
  mfa_recovery_codes,mfa_rotations,auth_rate_limits,products,orders,order_history,
  payments,webhook_events,refunds,invoices,reconciliation_records,notifications,
  support_tickets,ticket_messages,integrations,platform_settings,payment_compensations,capture_operations
TO north_runtime;
GRANT SELECT,INSERT ON audit_logs,fee_policies,order_items,ledger_entries,invoice_lines TO north_runtime;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO north_runtime;
-- No schema_migrations access, ownership, DDL, TRUNCATE or mutable ledger grants.
-- Application tenant predicates remain mandatory; this group is not per-tenant RLS.
