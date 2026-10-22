import { useEffect, useState } from "react";
import { api } from "../../../packages/ui/src/api";
const actions = {
  payment: "Refresh payment from Stripe",
  payout: "Reconcile an automatic payout",
  replay: "Retry a saved reconciliation event",
  refund: "Resume a blocked cancellation refund",
  capture: "Authorise a capture retry",
  acknowledge: "Resolve superseded evidence",
};
export function ReconciliationPanel() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [action, setAction] = useState<keyof typeof actions>("payment"),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setData(await api("/admin/reconciliation"));
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
        <h2>Stripe reconciliation · test mode</h2>
        <p>
          Review payment exceptions, merchant settlements and disputes. Merchant
          balance movements are not platform invoices. A provider refresh reads
          Stripe; refund or capture recovery requires verified recent evidence.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <button className="quiet" onClick={() => void load()}>
          Refresh reconciliation records
        </button>
        {data &&
          (
            [
              "jobs",
              "payments",
              "refunds",
              "compensations",
              "captures",
              "disputes",
              "adjustments",
              "payouts",
              "balances",
              "applicationFees",
            ] as const
          ).map((name) => (
            <details key={name}>
              <summary>
                {name.replace(/([A-Z])/g, " $1")} · {data[name].length}
              </summary>
              {!data[name].length ? (
                <p>No records.</p>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        {Object.keys(data[name][0]).map((k) => (
                          <th key={k}>{k.replaceAll("_", " ")}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data[name].map((r: any, i: number) => (
                        <tr key={i}>
                          {Object.values(r).map((v: any, j: number) => (
                            <td key={j}>
                              {typeof v === "object"
                                ? JSON.stringify(v)
                                : String(v ?? "—")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          ))}
        <h3>Review or recover an operation</h3>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setNotice("");
            const f = new FormData(e.currentTarget),
              id = String(f.get("id")),
              body: any = { mfa: f.get("mfa"), reason: f.get("reason") };
            let path = "";
            if (action === "payment") {
              path = `/admin/reconciliation/orders/${encodeURIComponent(id)}/sync`;
              if (f.get("intentId")) body.intentId = f.get("intentId");
            }
            if (action === "payout") {
              path = `/admin/reconciliation/partners/${encodeURIComponent(String(f.get("partnerId")))}/payouts/${encodeURIComponent(id)}/sync`;
              if (f.get("cursor")) body.cursor = f.get("cursor");
            }
            if (action === "replay")
              path = `/admin/reconciliation/events/${encodeURIComponent(id)}/replay`;
            if (action === "acknowledge") {
              path = `/admin/reconciliation/events/${encodeURIComponent(id)}/acknowledge`;
              body.evidenceId = f.get("evidenceId");
            }
            if (action === "refund" || action === "capture") {
              path = `/admin/reconciliation/orders/${encodeURIComponent(id)}/recover`;
              body.action =
                action === "refund" ? "resume_compensation" : "retry_capture";
            }
            try {
              const result = await api(path, {
                method: "POST",
                body: JSON.stringify(body),
              });
              setNotice("Review completed: " + JSON.stringify(result));
              await load();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Action
            <select
              value={action}
              onChange={(e) =>
                setAction(e.target.value as keyof typeof actions)
              }
            >
              {Object.entries(actions).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {action === "payout"
              ? "Payout ID"
              : action === "replay" || action === "acknowledge"
                ? "Reconciliation event ID"
                : "Order ID"}
            <input name="id" required />
          </label>
          {action === "payment" && (
            <label>
              Stripe intent ID (only for an unbound interrupted payment)
              <input name="intentId" />
            </label>
          )}
          {action === "payout" && (
            <>
              <label>
                Partner ID
                <input name="partnerId" required />
              </label>
              <label>
                Next page cursor (from the last response)
                <input name="cursor" />
              </label>
            </>
          )}
          {action === "acknowledge" && (
            <label>
              Verified replacement evidence ID
              <input name="evidenceId" required />
            </label>
          )}
          <label>
            Review reason
            <input name="reason" minLength={10} maxLength={500} required />
          </label>
          <label>
            Fresh authenticator code
            <input
              name="mfa"
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              autoComplete="one-time-code"
            />
          </label>
          {action === "refund" && (
            <p className="notice">
              This queues a new Stripe test refund only after the previous
              operation is confirmed failed and no unresolved refund or dispute
              remains.
            </p>
          )}
          <button disabled={busy}>
            {busy ? "Checking…" : actions[action]}
          </button>
        </form>
      </div>
    </section>
  );
}
