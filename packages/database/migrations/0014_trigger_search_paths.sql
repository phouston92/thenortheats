-- Explicitly put pg_temp last: runtime-created temporary relations must never
-- shadow the real tenant, pricing, permission or session tables inside guards.
ALTER FUNCTION require_partner_pricing() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION revoke_sessions_on_access_change() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION revoke_permission_sessions() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION guard_item_tenant() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION guard_invoice_tenant() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION require_admin_permission_role() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION clear_nonadmin_grants() SET search_path=pg_catalog,public,pg_temp;
