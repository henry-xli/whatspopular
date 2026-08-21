"use client";

import { useState } from "react";

type MobileLinkProps = {
  requestId: string;
  code: string;
  signedIn: boolean;
  displayName?: string;
};

export function MobileLinkExperience({ requestId, code, signedIn, displayName }: MobileLinkProps) {
  const [status, setStatus] = useState<"idle" | "working" | "approved" | "error">("idle");
  const [message, setMessage] = useState("");
  const validRequest = /^[0-9a-f-]{20,80}$/i.test(requestId) && /^[A-Z2-9]{8}$/.test(code);
  const signInHref = `/signin-with-chatgpt?return_to=${encodeURIComponent(`/mobile-link?request_id=${requestId}&code=${code}`)}`;

  async function approve() {
    if (!validRequest || !signedIn || status === "working") return;
    setStatus("working");
    setMessage("");
    try {
      const response = await fetch("/api/mobile/link/approve", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ requestId, code }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "This link request is no longer available.");
      setStatus("approved");
      setMessage("The phone is now linked. You can return to the app.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "This link request could not be approved.");
    }
  }

  return (
    <main id="main-content" className="account-page wrap" tabIndex={-1}>
      <section className="account-panel mobile-link-panel" aria-labelledby="mobile-link-title">
        <span className="modal-symbol" aria-hidden="true">✳</span>
        <p className="eyebrow">Secure device link</p>
        <h1 id="mobile-link-title">Bring your signal<br /><em>to your phone.</em></h1>
        {!validRequest ? (
          <p className="account-error">This link is invalid. Start a new link from the mobile app.</p>
        ) : !signedIn ? (
          <>
            <p>Sign in with ChatGPT first. The short-lived link code is not an account password and cannot be reused.</p>
            <a className="button button-primary" href={signInHref}>Continue with ChatGPT <span aria-hidden="true">↗</span></a>
          </>
        ) : status === "approved" ? (
          <>
            <p className="account-success">{message}</p>
            <p className="account-muted">Signed in as {displayName ?? "your account"}. Your selected interests will stay synchronized across devices.</p>
          </>
        ) : (
          <>
            <p>The mobile app is asking to connect to this account. Approve only if you started this link on your own phone.</p>
            <div className="mobile-link-code" aria-label={`Link code ${code}`}>{code}</div>
            <button className="button button-primary" type="button" onClick={approve} disabled={status === "working"}>
              {status === "working" ? "Linking…" : "Approve this phone"} <span aria-hidden="true">↗</span>
            </button>
            {message ? <p className="account-error" role="alert">{message}</p> : null}
            <p className="account-muted">This request expires shortly and can be used only once.</p>
          </>
        )}
      </section>
    </main>
  );
}
