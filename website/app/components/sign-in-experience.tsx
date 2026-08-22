"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type SignInProps = { returnTo: string; initialError: string };
type ProviderStatus = { emailVerificationConfigured: boolean; googleConfigured: boolean };

async function readResponse(response: Response) {
  const payload = await response.json().catch(() => ({})) as { error?: string; expiresAt?: string };
  if (!response.ok) throw new Error(payload.error || "The account service returned an error.");
  return payload;
}
export function SignInExperience({ returnTo, initialError }: SignInProps) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [signupStep, setSignupStep] = useState<"details" | "verify">("details");
  const [identifier, setIdentifier] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(initialError);
  const [providers, setProviders] = useState<ProviderStatus>({ emailVerificationConfigured: false, googleConfigured: false });

  useEffect(() => {
    fetch("/api/auth/providers", { headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<ProviderStatus> : null)
      .then((payload) => { if (payload) setProviders(payload); })
      .catch(() => undefined);
  }, []);

  const googleHref = useMemo(() => `/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`, [returnTo]);

  function switchMode(nextMode: "login" | "signup") {
    setMode(nextMode);
    setSignupStep("details");
    setMessage("");
    setCode("");
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await readResponse(await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ identifier, password, client: "web" }),
      }));
      window.location.assign(returnTo);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  async function startSignup(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmPassword) {
      setMessage("Those passwords do not match.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await readResponse(await fetch("/api/auth/signup/start", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username, email, password, client: "web" }),
      }));
      setSignupStep("verify");
      setMessage(`We sent a six-digit code to ${email.trim().toLowerCase()}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "We could not start account creation.");
    } finally {
      setBusy(false);
    }
  }

  async function verifySignup(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await readResponse(await fetch("/api/auth/signup/verify", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, code, client: "web" }),
      }));
      window.location.assign(returnTo);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Verification failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main-content" className="account-page wrap signin-page" tabIndex={-1}>
      <section className="account-panel signin-panel" aria-labelledby="signin-title">
        <div className="account-kicker"><p className="eyebrow">Your signal, synced</p><span className="account-state"><span className="status-dot" aria-hidden="true" /> Web + mobile</span></div>
        <h1 id="signin-title">Make it<br /><em>specific.</em></h1>
        <p className="signin-lede">Sign in once, save your For You interests, and get the same digest on every device.</p>

        <a className={`google-signin-button${providers.googleConfigured ? "" : " is-unavailable"}`} href={providers.googleConfigured ? googleHref : undefined} aria-disabled={!providers.googleConfigured} onClick={(event) => { if (!providers.googleConfigured) event.preventDefault(); }}>
          <span className="google-g-mark" aria-hidden="true">G</span>
          <span>{providers.googleConfigured ? "Continue with Google" : "Google sign-in — setup pending"}</span>
          <span aria-hidden="true">↗</span>
        </a>
        {!providers.googleConfigured ? <p className="signin-provider-note">Google sign-in will appear here when the site owner adds its OAuth credentials.</p> : null}

        <div className="signin-or"><span>or use your email</span></div>
        <div className="signin-mode-switch" role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "is-active" : undefined} onClick={() => switchMode("login")}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "is-active" : undefined} onClick={() => switchMode("signup")}>Create account</button>
        </div>

        {mode === "login" ? (
          <form className="signin-form" onSubmit={login}>
            <label><span>Username or email</span><input value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" required /></label>
            <label><span>Password</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}<span aria-hidden="true">↗</span></button>
          </form>
        ) : signupStep === "details" ? (
          <form className="signin-form" onSubmit={startSignup}>
            <label><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={24} pattern="[A-Za-z0-9_]+" required /></label>
            <label><span>Email</span><input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required /></label>
            <label><span>Password <small>12+ characters</small></span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
            <label><span>Confirm password</span><input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
            <button className="button button-primary" type="submit" disabled={busy || !providers.emailVerificationConfigured}>{busy ? "Sending code…" : "Email me a verification code"}<span aria-hidden="true">↗</span></button>
            {!providers.emailVerificationConfigured ? <p className="signin-provider-note">Email delivery is not configured on this deployment yet, so account creation is safely disabled until a mail provider is connected.</p> : null}
          </form>
        ) : (
          <form className="signin-form" onSubmit={verifySignup}>
            <label><span>Verification code</span><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required /></label>
            <button className="button button-primary" type="submit" disabled={busy || code.length !== 6}>{busy ? "Checking code…" : "Verify and create account"}<span aria-hidden="true">↗</span></button>
            <button className="text-button" type="button" onClick={() => setSignupStep("details")}>Use a different email</button>
          </form>
        )}
        {message ? <p className="signin-message" role="status">{message}</p> : null}
        <p className="signin-security-note">Passwords are never stored in the browser. Verification codes expire quickly and can only be used once.</p>
      </section>
    </main>
  );
}
