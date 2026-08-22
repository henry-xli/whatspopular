"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { NicheCategory } from "../niche";

type Identity = {
  username: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  updatedAt: string | null;
  authMethod: string;
  canEditIdentity: boolean;
};

type ProfileSettingsProps = {
  onIdentityUpdated?: (identity: Identity) => void;
};

function grouped(categories: readonly NicheCategory[]) {
  return categories.reduce<Record<string, NicheCategory[]>>((result, category) => {
    (result[category.parent] ??= []).push(category);
    return result;
  }, {});
}

function errorMessage(payload: unknown, fallback: string) {
  return typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
    ? payload.error
    : fallback;
}

export function ProfileSettingsPanel({ onIdentityUpdated }: ProfileSettingsProps) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [categories, setCategories] = useState<NicheCategory[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [profileUpdatedAt, setProfileUpdatedAt] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailChallenge, setEmailChallenge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingUsername, setSavingUsername] = useState(false);
  const [savingTags, setSavingTags] = useState(false);
  const [sendingEmailCode, setSendingEmailCode] = useState(false);
  const [verifyingEmail, setVerifyingEmail] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"success" | "error">("success");

  const groups = useMemo(() => grouped(categories), [categories]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/account/identity", { headers: { accept: "application/json" }, credentials: "same-origin" }),
      fetch("/api/account/profile", { headers: { accept: "application/json" }, credentials: "same-origin" }),
      fetch("/api/niche", { headers: { accept: "application/json" } }),
    ])
      .then(async ([identityResponse, profileResponse, nicheResponse]) => {
        const identityPayload = await identityResponse.json() as Identity & { error?: string };
        const profilePayload = await profileResponse.json() as { tags?: unknown[]; updatedAt?: unknown; error?: string };
        const nichePayload = await nicheResponse.json() as { categories?: NicheCategory[] };
        if (!identityResponse.ok) throw new Error(errorMessage(identityPayload, "Account settings are unavailable right now."));
        if (!profileResponse.ok) throw new Error(errorMessage(profilePayload, "Shared interests are unavailable right now."));
        if (!nicheResponse.ok || !Array.isArray(nichePayload.categories)) throw new Error("Interest categories are unavailable right now.");
        if (cancelled) return;
        const validCategories = nichePayload.categories.filter((category): category is NicheCategory => Boolean(category?.id && category?.label && category?.parent));
        const validIds = new Set(validCategories.map((category) => category.id));
        const validTags = Array.isArray(profilePayload.tags)
          ? [...new Set(profilePayload.tags.filter((tag): tag is string => typeof tag === "string" && validIds.has(tag)))]
          : [];
        setIdentity(identityPayload);
        setUsername(identityPayload.username);
        setCategories(validCategories);
        setTags(validTags);
        setProfileUpdatedAt(typeof profilePayload.updatedAt === "string" ? profilePayload.updatedAt : null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessageKind("error");
          setMessage(error instanceof Error ? error.message : "Account settings are unavailable right now.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function setStatus(nextMessage: string, kind: "success" | "error" = "success") {
    setMessageKind(kind);
    setMessage(nextMessage);
  }

  function toggleTag(id: string) {
    setTags((previous) => previous.includes(id) ? previous.filter((tag) => tag !== id) : [...previous, id]);
    setMessage("");
  }

  async function saveUsername() {
    if (!identity?.canEditIdentity || savingUsername || username === identity.username) return;
    setSavingUsername(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/identity", {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username }),
      });
      const payload = await response.json() as Identity & { error?: string };
      if (!response.ok) throw new Error(errorMessage(payload, "Username could not be saved."));
      setIdentity(payload);
      setUsername(payload.username);
      onIdentityUpdated?.(payload);
      setStatus("Username saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Username could not be saved.", "error");
    } finally {
      setSavingUsername(false);
    }
  }

  async function sendEmailCode() {
    if (!identity?.canEditIdentity || sendingEmailCode || !newEmail.trim()) return;
    setSendingEmailCode(true);
    setEmailChallenge(false);
    setEmailCode("");
    setMessage("");
    try {
      const response = await fetch("/api/account/email/start", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: newEmail }),
      });
      const payload = await response.json() as { pending?: boolean; email?: string; error?: string };
      if (!response.ok) throw new Error(errorMessage(payload, "We could not send that verification code."));
      setNewEmail(payload.email ?? newEmail.trim().toLowerCase());
      setEmailChallenge(true);
      setStatus("A six-digit verification code was sent to your new email.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "We could not send that verification code.", "error");
    } finally {
      setSendingEmailCode(false);
    }
  }

  async function verifyEmailCode() {
    if (!identity?.canEditIdentity || verifyingEmail || emailCode.length !== 6) return;
    setVerifyingEmail(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: emailCode }),
      });
      const payload = await response.json() as Identity & { error?: string };
      if (!response.ok) throw new Error(errorMessage(payload, "That verification code could not be accepted."));
      setIdentity(payload);
      setProfileUpdatedAt(payload.updatedAt ?? profileUpdatedAt);
      setNewEmail("");
      setEmailCode("");
      setEmailChallenge(false);
      onIdentityUpdated?.(payload);
      setStatus("Email updated and verified.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "That verification code could not be accepted.", "error");
    } finally {
      setVerifyingEmail(false);
    }
  }

  async function saveTags() {
    if (!identity || savingTags) return;
    setSavingTags(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/profile", {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ tags, expectedUpdatedAt: profileUpdatedAt }),
      });
      const payload = await response.json() as { tags?: unknown[]; updatedAt?: unknown; error?: string };
      if (!response.ok) throw new Error(errorMessage(payload, "Shared interests could not be saved."));
      setProfileUpdatedAt(typeof payload.updatedAt === "string" ? payload.updatedAt : profileUpdatedAt);
      setStatus("Interests saved across web and mobile.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Shared interests could not be saved.", "error");
    } finally {
      setSavingTags(false);
    }
  }

  async function revokeMobileSessions() {
    if (revoking) return;
    if (!revokeConfirm) {
      setRevokeConfirm(true);
      return;
    }
    setRevoking(true);
    setRevokeConfirm(false);
    try {
      const response = await fetch("/api/account/sessions/revoke", { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(errorMessage(payload, "Mobile sessions could not be signed out."));
      setStatus("All mobile sessions have been signed out.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Mobile sessions could not be signed out.", "error");
    } finally {
      setRevoking(false);
    }
  }

  if (loading) return <div className="profile-settings-panel"><p className="profile-settings-loading">Loading your settings…</p></div>;

  return (
    <div className="profile-settings-panel" aria-label="Account settings">
      <div className="profile-settings-title">
        <span>Settings</span>
        <small>Everything here stays in this profile menu.</small>
      </div>

      {identity?.canEditIdentity ? (
        <section className="profile-settings-section" aria-labelledby="profile-details-title">
          <p className="profile-settings-label" id="profile-details-title">Account details</p>
          <label className="profile-settings-field">
            <span>Username</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" maxLength={24} />
          </label>
          <button className="profile-settings-action" type="button" onClick={() => { void saveUsername(); }} disabled={savingUsername || username === identity.username}>
            {savingUsername ? "Saving username…" : "Save username"}
          </button>
          <div className="profile-settings-email">
            <div className="profile-settings-email-current"><span>Verified email</span><strong>{identity.email}</strong></div>
            <label className="profile-settings-field">
              <span>Change email</span>
              <input value={newEmail} onChange={(event) => setNewEmail(event.target.value)} type="email" autoComplete="email" placeholder="new@email.com" />
            </label>
            <button className="profile-settings-action" type="button" onClick={() => { void sendEmailCode(); }} disabled={sendingEmailCode || !newEmail.trim()}>
              {sendingEmailCode ? "Sending code…" : "Email me a verification code"}
            </button>
            {emailChallenge ? (
              <div className="profile-settings-code">
                <label className="profile-settings-field">
                  <span>Six-digit code</span>
                  <input value={emailCode} onChange={(event) => setEmailCode(event.target.value.replace(/\D/gu, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
                </label>
                <button className="profile-settings-action is-primary" type="button" onClick={() => { void verifyEmailCode(); }} disabled={verifyingEmail || emailCode.length !== 6}>
                  {verifyingEmail ? "Checking code…" : "Verify new email"}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <p className="profile-settings-note">This sign-in provider manages your username and email. You can still tune the interests saved to this profile.</p>
      )}

      <section className="profile-settings-section" aria-labelledby="profile-interests-title">
        <div className="profile-settings-section-heading">
          <p className="profile-settings-label" id="profile-interests-title">For You interests</p>
          <span>{tags.length} selected</span>
        </div>
        <div className="profile-settings-tag-groups">
          {Object.entries(groups).map(([parent, parentCategories]) => (
            <div className="profile-settings-tag-group" key={parent}>
              <span>{parent}</span>
              <div className="profile-settings-tags">
                {parentCategories.map((category) => {
                  const selected = tags.includes(category.id);
                  return (
                    <button
                      key={category.id}
                      className={`profile-settings-tag${selected ? " is-selected" : ""}`}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => toggleTag(category.id)}
                      style={{ "--tag-accent": category.accent } as CSSProperties}
                    >
                      <span className="profile-settings-tag-dot" aria-hidden="true" />{category.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <button className="profile-settings-action is-primary" type="button" onClick={() => { void saveTags(); }} disabled={savingTags}>
          {savingTags ? "Saving interests…" : "Save shared interests"}
        </button>
      </section>

      <section className="profile-settings-section profile-settings-device" aria-labelledby="profile-device-title">
        <p className="profile-settings-label" id="profile-device-title">Sessions</p>
        <p className="profile-settings-note">Sign out every mobile session if you lose a phone or want to reset device access.</p>
        <button className="profile-settings-action is-danger" type="button" onClick={() => { void revokeMobileSessions(); }} disabled={revoking}>
          {revoking ? "Signing out devices…" : revokeConfirm ? "Confirm sign out all devices" : "Sign out all mobile devices"}
        </button>
      </section>

      {message ? <p className={`profile-settings-message is-${messageKind}`} role="status">{message}</p> : null}
    </div>
  );
}
