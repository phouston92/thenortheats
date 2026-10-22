import { useEffect, useState } from "react";
import { api } from "../../../packages/ui/src/api";
export function AccessManagement() {
  const [users, setUsers] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    try {
      setUsers(await api("/admin/access/users"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="panel">
      <div className="panel-body">
        <h2>Administrator and staff access</h2>
        <p>
          Permissions are explicit. Every change is audited and signs the
          affected user out. New administrators need individual authenticator
          enrollment by an authorised operator. The last active access governor
          cannot be removed.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <label>
          Review an account
          <select
            value={selected?.id || ""}
            onChange={(e) =>
              setSelected(users.find((u) => u.id === e.target.value) || null)
            }
          >
            <option value="">Create or update by email</option>
            {users.map((u) => (
              <option value={u.id} key={u.id}>
                {u.email} · {u.role}
                {u.disabled ? " · disabled" : ""}
              </option>
            ))}
          </select>
        </label>
        <form
          key={selected?.id || "new"}
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            const f = new FormData(e.currentTarget);
            try {
              const r = await api("/admin/access/users", {
                method: "POST",
                body: JSON.stringify({
                  email: f.get("email"),
                  role: f.get("role"),
                  disabled: f.get("disabled") === "on",
                  permissions: f.getAll("permission"),
                  partners: String(f.get("partners") || "")
                    .split(",")
                    .map((p) => p.trim())
                    .filter(Boolean),
                  reason: f.get("reason"),
                  mfa: f.get("mfa"),
                }),
              });
              setNotice(
                r.mfaEnrollmentRequired
                  ? "Access saved. Operator MFA enrollment is required before administrator login."
                  : "Access saved; previous sessions revoked.",
              );
              await load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              defaultValue={selected?.email || ""}
            />
          </label>
          <label>
            Role
            <select name="role" defaultValue={selected?.role || "customer"}>
              {["customer", "operator", "owner", "admin"].map((role) => (
                <option value={role} key={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              name="disabled"
              type="checkbox"
              defaultChecked={selected?.disabled}
            />
            Disable account
          </label>
          <fieldset>
            <legend>Platform administrator permissions</legend>
            {["operations", "finance", "support", "governance"].map((p) => (
              <label className="check" key={p}>
                <input
                  type="checkbox"
                  name="permission"
                  value={p}
                  defaultChecked={selected?.permissions?.includes(p)}
                />
                {p}
              </label>
            ))}
          </fieldset>
          <label>
            Partner IDs (staff only, comma separated)
            <input
              name="partners"
              defaultValue={selected?.partners?.join(",") || ""}
            />
          </label>
          <label>
            Reason
            <input name="reason" required minLength={10} maxLength={500} />
          </label>
          <label>
            Fresh authenticator code
            <input
              name="mfa"
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
            />
          </label>
          <button>Save access and revoke sessions</button>
        </form>
      </div>
    </section>
  );
}
