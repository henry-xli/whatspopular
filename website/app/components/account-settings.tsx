"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { NicheCategory } from "../niche";

type AccountSettingsProps = {
  categories: readonly NicheCategory[];
  signedIn: boolean;
  displayName?: string;
  email?: string;
};

function grouped(categories: readonly NicheCategory[]) {
  return categories.reduce<Record<string, NicheCategory[]>>((result, category) => {
    (result[category.parent] ??= []).push(category);
    return result;
  }, {});
}

export function AccountSettingsExperience({ categories, signedIn, displayName, email }: AccountSettingsProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const groups = useMemo(() => grouped(categories), [categories]);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    fetch("/api/account/profile", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Account settings are unavailable right now.");
        return response.json() as Promise<{ tags?: unknown[]; updatedAt?: unknown }>;
      })
      .then((payload) => {
        if (cancelled) return;
        const valid = Array.isArray(payload.tags)
          ? payload.tags.filter((value): value is string => typeof value === "string" && categories.some((category) => category.id === value))
          : [];
        setTags([...new Set(valid)]);
        setUpdatedAt(typeof payload.updatedAt === "string" ? payload.updatedAt : null);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Account settings are unavailable right now.");
      });
    return () => { cancelled = true; };
  }, [categories, signedIn]);

  function toggleTag(id: string) {
    setTags((previous) => previous.includes(id) ? previous.filter((tag) => tag !== id) : [...previous, id]);
    setMessage("");
  }

  async function save() {
    if (!signedIn || saving) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/account/profile", {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ tags, expectedUpdatedAt: updatedAt }),
      });
      const payload = await response.json() as { error?: string; tags?: unknown[]; updatedAt?: unknown };
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(payload.tags)) {
          setTags(payload.tags.filter((value): value is string => typeof value === "string"));
          setUpdatedAt(typeof payload.updatedAt === "string" ? payload.updatedAt : updatedAt);
        }
        throw new Error(payload.error || "Settings could not be saved.");
      }
      setUpdatedAt(typeof payload.updatedAt === "string" ? payload.updatedAt : updatedAt);
      setMessage("Saved. Your next digest will use this mix on every device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function revokeMobileSessions() {
    if (!signedIn || revoking) return;
    if (!revokeConfirm) {
      setRevokeConfirm(true);
      return;
    }
    setRevoking(true);
    setRevokeConfirm(false);
    setMessage("");
    try {
      const response = await fetch("/api/account/sessions/revoke", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Mobile sessions could not be signed out.");
      setMessage("All mobile sessions have been signed out.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mobile sessions could not be signed out.");
    } finally {
      setRevoking(false);
    }
  }

  if (!signedIn) {
    return (
      <main id="main-content" className="account-page wrap" tabIndex={-1}>
        <section className="account-panel" aria-labelledby="account-title">
          <p className="eyebrow">Account settings</p>
          <h1 id="account-title">Keep your signal<br /><em>in sync.</em></h1>
          <p>Sign in with ChatGPT to save your interest tags and link the mobile app. This site does not store a second password or keep credentials in browser storage.</p>
          <a className="button button-primary" href="/signin-with-chatgpt?return_to=%2Faccount">Continue with ChatGPT <span aria-hidden="true">↗</span></a>
        </section>
      </main>
    );
  }

  return (
    <main id="main-content" className="account-page wrap" tabIndex={-1}>
      <section className="account-panel" aria-labelledby="account-title">
        <div className="account-kicker"><p className="eyebrow">Account settings</p><span className="account-state"><span className="status-dot" aria-hidden="true" /> Synced account</span></div>
        <h1 id="account-title">Keep your signal<br /><em>in sync.</em></h1>
        <div className="account-identity">
          <strong>{displayName ?? "what’s popular? member"}</strong>
          <span>{email ?? "ChatGPT account"}</span>
        </div>
        <div className="account-setting-copy">
          <p className="eyebrow">Your shared interests</p>
          <p>These tags are the source of truth for the website and mobile digest. Device-only appearance and notification choices remain local to each device.</p>
        </div>
        <div className="account-tag-groups">
          {Object.entries(groups).map(([parent, parentCategories]) => (
            <div className="tag-group" key={parent}>
              <span className="tag-group-label">{parent}</span>
              <div className="tag-list" aria-label={`${parent} interests`}>
                {parentCategories.map((category) => {
                  const active = tags.includes(category.id);
                  return (
                    <button
                      className={`interest-tag${active ? " is-selected" : ""}`}
                      key={category.id}
                      type="button"
                      onClick={() => toggleTag(category.id)}
                      disabled={saving}
                      aria-pressed={active}
                      style={{ "--tag-accent": category.accent } as CSSProperties}
                    >
                      <span className="interest-tag-dot" aria-hidden="true" />{category.label}
                      <span className="interest-tag-check" aria-hidden="true">{active ? "✓" : "+"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="account-actions">
          <span className="account-muted">{loaded ? `${tags.length} interests selected` : "Loading your interests…"}</span>
          <button className="button button-primary" type="button" onClick={save} disabled={!loaded || saving}>{saving ? "Saving…" : "Save shared settings"} <span aria-hidden="true">↗</span></button>
        </div>
        {message ? <p className={message.startsWith("Saved") || message.startsWith("All mobile") ? "account-success" : "account-error"} role="status">{message}</p> : null}
        <div className="account-mobile-link">
          <p className="eyebrow">Link the mobile app</p>
          <p>Start the link from the app. It will show a short-lived code here for you to approve; no password or token is typed into the website.</p>
          <a className="button button-quiet button-small" href="/for-you">Open your For You page <span aria-hidden="true">↗</span></a>
          <button className="button button-quiet button-small account-revoke-button" type="button" onClick={revokeMobileSessions} disabled={revoking}>
            {revoking ? "Signing out devices…" : revokeConfirm ? "Confirm sign out all devices" : "Sign out all mobile devices"}
          </button>
        </div>
      </section>
    </main>
  );
}
