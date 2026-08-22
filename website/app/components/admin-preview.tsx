"use client";

import { useCallback, useEffect, useState } from "react";

export const ADMIN_PREVIEW_STORAGE_KEY = "whatspopular-admin-preview-auth";
const ADMIN_PREVIEW_EVENT = "whatspopular-admin-preview-change";

export type AdminPreviewMode = "signed-in" | "signed-out";

function normalizeMode(value: string | null): AdminPreviewMode | null {
  return value === "signed-in" || value === "signed-out" ? value : null;
}

export function readAdminPreviewMode(): AdminPreviewMode | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeMode(window.localStorage.getItem(ADMIN_PREVIEW_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeAdminPreviewMode(mode: AdminPreviewMode | null) {
  if (typeof window === "undefined") return;
  try {
    if (mode) window.localStorage.setItem(ADMIN_PREVIEW_STORAGE_KEY, mode);
    else window.localStorage.removeItem(ADMIN_PREVIEW_STORAGE_KEY);
  } catch {
    // The preview is optional and must not break the real account experience.
  }
  window.dispatchEvent(new CustomEvent(ADMIN_PREVIEW_EVENT, { detail: mode }));
}

export function useAdminPreviewMode() {
  const [mode, setMode] = useState<AdminPreviewMode | null>(null);

  useEffect(() => {
    const sync = () => setMode(readAdminPreviewMode());
    const onStorage = (event: StorageEvent) => {
      if (event.key === ADMIN_PREVIEW_STORAGE_KEY) sync();
    };
    sync();
    window.addEventListener("storage", onStorage);
    window.addEventListener(ADMIN_PREVIEW_EVENT, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(ADMIN_PREVIEW_EVENT, sync);
    };
  }, []);

  const updateMode = useCallback((nextMode: AdminPreviewMode | null) => {
    writeAdminPreviewMode(nextMode);
    setMode(nextMode);
  }, []);

  return [mode, updateMode] as const;
}

function modeLabel(mode: AdminPreviewMode | null) {
  if (mode === "signed-in") return "signed-in";
  if (mode === "signed-out") return "signed-out";
  return "real account";
}

export function AdminPreviewSection() {
  const [mode, setMode] = useAdminPreviewMode();

  return (
    <section className="profile-settings-section profile-admin-preview" aria-labelledby="profile-admin-preview-title">
      <div className="profile-settings-section-heading">
        <p className="profile-settings-label" id="profile-admin-preview-title">Admin preview</p>
        <span>Temporary local testing</span>
      </div>
      <p className="profile-settings-note">
        Preview either account state while the real providers are being set up. This changes only this browser and never creates, signs in, or signs out a real account.
      </p>
      <div className="profile-admin-preview-controls" role="group" aria-label="Preview account state">
        <button
          className={`profile-admin-preview-button${mode === "signed-in" ? " is-selected" : ""}`}
          type="button"
          aria-pressed={mode === "signed-in"}
          onClick={() => setMode("signed-in")}
        >
          Preview signed in
        </button>
        <button
          className={`profile-admin-preview-button${mode === "signed-out" ? " is-selected" : ""}`}
          type="button"
          aria-pressed={mode === "signed-out"}
          onClick={() => setMode("signed-out")}
        >
          Preview signed out
        </button>
      </div>
      {mode ? (
        <button className="profile-settings-action" type="button" onClick={() => setMode(null)}>
          Use real account session
        </button>
      ) : null}
      <p className="profile-admin-preview-status" role="status">
        Current preview: <strong>{modeLabel(mode)}</strong>
      </p>
    </section>
  );
}
