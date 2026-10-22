import React, { useState, useEffect } from "react";
import { api, setCsrf } from "./api";
export function useSession() {
  const [user, setUser] = useState<any>(undefined);
  useEffect(() => {
    api("/auth/me")
      .then((r) => {
        setCsrf(r.csrf);
        setUser(r.user);
      })
      .catch(() => setUser(null));
  }, []);
  return { user, setUser };
}
export function Login({
  onLogin,
  title = "Sign in",
}: {
  onLogin: (u: any) => void;
  title?: string;
}) {
  const [challenge, setChallenge] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (!challenge) {
        setChallenge(
          await api("/auth/request", {
            method: "POST",
            body: JSON.stringify({ email: data.get("email") }),
          }),
        );
      } else {
        const result = await api("/auth/verify", {
          method: "POST",
          body: JSON.stringify({
            ...challenge,
            code: data.get("code"),
            mfa: data.get("mfa") || undefined,
            recoveryCode: data.get("recoveryCode") || undefined,
          }),
        });
        setCsrf(result.csrf);
        onLogin((await api("/auth/me")).user);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <div className="login-card">
        <span className="eyebrow">THE NORTH EATS</span>
        <h1>{title}</h1>
        <p>Independent food. One connected community.</p>
        <form onSubmit={submit}>
          {!challenge ? (
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
            </label>
          ) : (
            <>
              <p className="notice">
                A code has been sent. In local development, use the private
                development mailbox described in the README.
              </p>
              <label>
                Verification code
                <input
                  name="code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  autoComplete="one-time-code"
                  required
                />
              </label>
              <label>
                Authenticator code (administrators)
                <input name="mfa" inputMode="numeric" pattern="[0-9]{6}" />
              </label>
              <label>
                Recovery code (instead of authenticator)
                <input
                  name="recoveryCode"
                  autoComplete="off"
                  pattern="[a-f0-9]{32}"
                />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy}>
            {busy
              ? "Please wait…"
              : challenge
                ? "Verify and sign in"
                : "Email me a code"}
          </button>
        </form>
      </div>
    </div>
  );
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        ↗
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={"status " + value}>{value.replaceAll("_", " ")}</span>
  );
}
export function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="error">
      {error}
    </div>
  ) : null;
}
export function money(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(n / 100);
}
