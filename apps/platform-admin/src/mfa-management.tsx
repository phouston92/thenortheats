import { useState } from "react";
import { api } from "../../../packages/ui/src/api";
export function MfaManagement() {
  const [error, setError] = useState(""),
    [enrollment, setEnrollment] = useState<{
      secret: string;
      uri: string;
    } | null>(null),
    [codes, setCodes] = useState<string[]>([]);
  return (
    <section className="panel">
      <div className="panel-body">
        <h2>Your administrator security</h2>
        <p>
          Rotate your own authenticator using a fresh code. Confirmation revokes
          every session. Store the new recovery codes privately; each works once
          with an email verification code.
        </p>
        {error && <p role="alert">{error}</p>}
        {codes.length > 0 ? (
          <>
            <p>Save these codes now, then sign in again.</p>
            <pre>{codes.join("\n")}</pre>
            <button onClick={() => window.location.reload()}>
              I saved my recovery codes
            </button>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              const data = new FormData(e.currentTarget);
              try {
                if (enrollment) {
                  const result = await api("/auth/mfa/confirm", {
                    method: "POST",
                    body: JSON.stringify({ mfa: data.get("mfa") }),
                  });
                  setCodes(result.recoveryCodes);
                  setEnrollment(null);
                } else
                  setEnrollment(
                    await api("/auth/mfa/rotate", {
                      method: "POST",
                      body: JSON.stringify({ mfa: data.get("mfa") }),
                    }),
                  );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
            key={enrollment ? "confirm" : "start"}
          >
            {enrollment && (
              <>
                <p>Import this secret into your authenticator:</p>
                <code>{enrollment.secret}</code>
                <p>
                  Confirm a code from the new authenticator within ten minutes.
                </p>
              </>
            )}
            <label>
              {enrollment
                ? "New authenticator code"
                : "Current authenticator code"}
              <input
                name="mfa"
                inputMode="numeric"
                pattern="[0-9]{6}"
                required
                autoComplete="one-time-code"
              />
            </label>
            <button>
              {enrollment ? "Confirm rotation" : "Start authenticator rotation"}
            </button>
          </form>
        )}
        <button
          className="quiet"
          onClick={() => {
            void api("/auth/sessions/revoke", { method: "POST" })
              .then(() => setError("Other sessions revoked."))
              .catch((e) => setError(e.message));
          }}
        >
          Sign out other sessions
        </button>
      </div>
    </section>
  );
}
