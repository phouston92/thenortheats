import { authLimit } from "./abuse";
import type { FastifyInstance } from "fastify";
import type { Database, Query } from "../../../packages/database/src/index";
import { actor, admin, audit, type Actor } from "./auth";
import { verifyMfa } from "./mfa";
import { z } from "zod";
export const permissionSchema = z.enum([
  "operations",
  "finance",
  "support",
  "governance",
]);
export async function stepUp(
  tx: Query,
  a: Actor,
  mfa: string,
  permission: "finance" | "governance",
) {
  const [u] =
    await tx`SELECT id FROM users WHERE id=${a.id} AND role='admin' AND NOT disabled FOR SHARE`;
  const [grant] =
    await tx`SELECT user_id FROM admin_permissions WHERE user_id=${a.id} AND permission=${permission}`;
  if (!u || !grant || !(await verifyMfa(tx, a.id, mfa))) return false;
  return true;
}
export async function governanceRoutes(app: FastifyInstance, db: Database) {
  app.get("/api/admin/access/users", async (req) => {
    admin(await actor(db, req), "governance");
    return db`SELECT u.id,u.email,u.role,u.disabled,u.created_at,EXISTS(SELECT 1 FROM admin_mfa m WHERE m.user_id=u.id) AS mfa_enrolled,ARRAY(SELECT permission FROM admin_permissions p WHERE p.user_id=u.id ORDER BY permission) AS permissions,ARRAY(SELECT partner_id FROM memberships m WHERE m.user_id=u.id) AS partners FROM users u ORDER BY u.created_at DESC LIMIT 200`;
  });
  app.post("/api/admin/access/users", async (req) => {
    const a = await actor(db, req);
    admin(a, "governance");
    const v = z
      .object({
        email: z.email().max(254),
        role: z.enum(["customer", "operator", "owner", "admin"]),
        disabled: z.boolean(),
        permissions: z.array(permissionSchema).max(4),
        partners: z.array(z.uuid()).max(100),
        reason: z.string().trim().min(10).max(500),
        mfa: z.string().regex(/^\d{6}$/),
      })
      .parse(req.body);
    if (v.role !== "admin" && v.permissions.length)
      throw Object.assign(
        new Error("Only administrators can hold platform permissions"),
        { statusCode: 400 },
      );
    if (!["operator", "owner"].includes(v.role) && v.partners.length)
      throw Object.assign(
        new Error("Only partner staff can hold memberships"),
        { statusCode: 400 },
      );
    await authLimit(db, "governance-stepup:" + a.id, 10);
    const result = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(874125)`;
      if (!(await stepUp(tx, a, v.mfa, "governance"))) return null;
      const [existing] =
        await tx`SELECT * FROM users WHERE email=${v.email.toLowerCase()} FOR UPDATE`;
      if (
        existing &&
        (v.role !== "admin" ||
          v.disabled ||
          !v.permissions.includes("governance"))
      ) {
        const [others] =
          await tx`SELECT count(*)::int AS count FROM users u JOIN admin_permissions p ON p.user_id=u.id WHERE u.id<>${existing.id} AND u.role='admin' AND NOT u.disabled AND p.permission='governance' AND EXISTS(SELECT 1 FROM admin_mfa m WHERE m.user_id=u.id)`;
        const [isGovernor] =
          await tx`SELECT user_id FROM admin_permissions WHERE user_id=${existing.id} AND permission='governance'`;
        if (isGovernor && !others.count)
          throw Object.assign(
            new Error("Cannot remove the last active governance administrator"),
            { statusCode: 409 },
          );
      }
      const [u] =
        await tx`INSERT INTO users(email,role,disabled) VALUES(${v.email.toLowerCase()},${v.role},${v.disabled}) ON CONFLICT(email) DO UPDATE SET role=EXCLUDED.role,disabled=EXCLUDED.disabled RETURNING id`;
      await tx`DELETE FROM admin_permissions WHERE user_id=${u.id}`;
      for (const permission of new Set(v.permissions))
        await tx`INSERT INTO admin_permissions VALUES(${u.id},${permission})`;
      await tx`DELETE FROM memberships WHERE user_id=${u.id}`;
      for (const partner of new Set(v.partners))
        await tx`INSERT INTO memberships VALUES(${u.id},${partner})`;
      await tx`DELETE FROM sessions WHERE user_id=${u.id}`;
      await audit(
        tx,
        a,
        "access.changed",
        JSON.stringify({
          userId: u.id,
          role: v.role,
          disabled: v.disabled,
          permissions: v.permissions,
          partners: v.partners,
          reason: v.reason,
        }),
      );
      return {
        id: u.id,
        mfaEnrollmentRequired:
          v.role === "admin" &&
          !(await tx`SELECT user_id FROM admin_mfa WHERE user_id=${u.id}`)
            .length,
      };
    });
    if (!result)
      throw Object.assign(new Error("Fresh MFA required"), { statusCode: 401 });
    return result;
  });
}
