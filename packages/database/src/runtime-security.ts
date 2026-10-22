import type { Query } from "./index";
export async function validateRuntimeDatabase(db: Query) {
  const [r] = await db`SELECT
 EXISTS(SELECT 1 FROM pg_roles WHERE pg_has_role(current_user,oid,'MEMBER') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS privileged,
 has_schema_privilege(current_user,'public','CREATE') AS schema_owner,
 has_table_privilege(current_user,'ledger_entries','UPDATE,DELETE,TRUNCATE') AS ledger_mutation,
 has_table_privilege(current_user,'audit_logs','UPDATE,DELETE,TRUNCATE') AS audit_mutation`;
  if (r.privileged || r.schema_owner || r.ledger_mutation || r.audit_mutation)
    throw new Error(
      "Backend runtime requires a least-privilege database login; migration/owner credentials are prohibited",
    );
}
