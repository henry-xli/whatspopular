"use client";

import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ProfileSettingsPanel } from "./profile-settings";

const STORAGE_KEY = "whatspopular-theme";

function activeTheme() {
  const saved = document.documentElement.dataset.theme;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [locked, setLocked] = useState(false);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const lockRef = useRef(false);

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    const syncTheme = () => setTheme(activeTheme());
    const syncSystemTheme = () => {
      if (!document.documentElement.dataset.theme) syncTheme();
    };
    const syncStoredTheme = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === "light" || event.newValue === "dark") document.documentElement.dataset.theme = event.newValue;
      else delete document.documentElement.dataset.theme;
      syncTheme();
    };

    frameRef.current = window.requestAnimationFrame(syncTheme);
    if (typeof systemTheme.addEventListener === "function") systemTheme.addEventListener("change", syncSystemTheme);
    else systemTheme.addListener(syncSystemTheme);
    window.addEventListener("storage", syncStoredTheme);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (typeof systemTheme.removeEventListener === "function") systemTheme.removeEventListener("change", syncSystemTheme);
      else systemTheme.removeListener(syncSystemTheme);
      window.removeEventListener("storage", syncStoredTheme);
      document.documentElement.classList.remove("theme-transition");
    };
  }, []);

  function toggleTheme() {
    if (lockRef.current) return;
    const next = activeTheme() === "dark" ? "light" : "dark";
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500;
    lockRef.current = true;
    setLocked(true);
    if (duration) document.documentElement.classList.add("theme-transition");
    frameRef.current = window.requestAnimationFrame(() => {
      document.documentElement.dataset.theme = next;
      try { window.localStorage.setItem(STORAGE_KEY, next); } catch {}
      setTheme(next);
      timerRef.current = window.setTimeout(() => {
        document.documentElement.classList.remove("theme-transition");
        lockRef.current = false;
        setLocked(false);
      }, duration);
    });
  }

  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      disabled={locked}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      <span className="theme-track" aria-hidden="true">
        <span className="theme-sun">
          <svg viewBox="0 0 24 24" focusable="false">
            <circle cx="12" cy="12" r="3.5" fill="currentColor" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
          </svg>
        </span>
        <span className="theme-moon">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M19.5 15.2A8 8 0 0 1 8.8 4.5a8 8 0 1 0 10.7 10.7Z" fill="currentColor" />
          </svg>
        </span>
        <span className="theme-thumb" />
      </span>
    </button>
  );
}

type AuthSession = {
  signedIn: boolean;
  user?: { displayName?: string; email?: string; authMethod?: string };
};

function initialsFor(user?: AuthSession["user"]) {
  const value = user?.displayName || user?.email || "";
  const pieces = value.trim().split(/\s+/u).filter(Boolean);
  if (pieces.length > 1) return `${pieces[0][0]}${pieces.at(-1)?.[0] ?? ""}`.toUpperCase();
  return (pieces[0]?.slice(0, 2) || "?").toUpperCase();
}

function ProfileMenu({ pathname }: { pathname: string }) {
  const router = useRouter();
  const [session, setSession] = useState<AuthSession>({ signedIn: false });
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<AuthSession> : null)
      .then((payload) => { if (!cancelled && payload) setSession(payload); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnPointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", closeOnPointer);
    document.addEventListener("keydown", closeOnKey);
    return () => {
      document.removeEventListener("mousedown", closeOnPointer);
      document.removeEventListener("keydown", closeOnKey);
    };
  }, [open]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin" });
      setSession({ signedIn: false });
      setOpen(false);
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const returnTo = encodeURIComponent(pathname || "/");
  const isChatGPTIdentity = session.user?.authMethod === "chatgpt";
  return (
    <div className="profile-menu" ref={menuRef}>
      <button
        className="profile-avatar-button"
        type="button"
        aria-label={session.signedIn ? `Open profile menu for ${session.user?.displayName ?? "your account"}` : "Open account menu"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`profile-avatar${session.signedIn ? " is-signed-in" : ""}`} aria-hidden="true">
          {session.signedIn ? initialsFor(session.user) : <span className="profile-avatar-person">♙</span>}
        </span>
        <span className="sr-only">Profile and settings</span>
      </button>
      {open ? (
        <div className="profile-popover" role="dialog" aria-label="Profile and settings">
          {session.signedIn ? (
            <div className="profile-popover-identity">
              <span className="profile-popover-avatar" aria-hidden="true">{initialsFor(session.user)}</span>
              <span><strong>{session.user?.displayName ?? "what’s popular? member"}</strong><small>{session.user?.email ?? "Signed-in account"}</small></span>
            </div>
          ) : (
            <div className="profile-popover-identity is-anonymous">
              <span className="profile-popover-avatar" aria-hidden="true">♙</span>
              <span><strong>Make this signal yours</strong><small>Save interests across web and mobile</small></span>
            </div>
          )}
          <div className="profile-popover-divider" />
          <div className="profile-theme-row">
            <span><strong>Appearance</strong><small>Light / dark mode</small></span>
            <ThemeToggle />
          </div>
          {session.signedIn ? (
            <>
              <ProfileSettingsPanel
                onIdentityUpdated={(identity) => setSession((current) => ({
                  ...current,
                  user: current.user ? { ...current.user, email: identity.email, displayName: identity.displayName } : current.user,
                }))}
              />
              {isChatGPTIdentity ? (
                <a className="profile-menu-link is-danger" href={`/signout-with-chatgpt?return_to=${returnTo}`}><span>Sign out</span><span aria-hidden="true">↗</span></a>
              ) : (
                <button className="profile-menu-link is-danger" type="button" onClick={() => { void signOut(); }} disabled={signingOut}><span>{signingOut ? "Signing out…" : "Sign out"}</span><span aria-hidden="true">↗</span></button>
              )}
            </>
          ) : (
            <a className="profile-menu-link is-primary" href={`/signin?return_to=${returnTo}`}><span>Sign in or create account</span><span aria-hidden="true">↗</span></a>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <a className="brand" href="/" aria-label="what’s popular? home">
          <span aria-hidden="true" className="brand-mark">
            <img src="/icon.png" alt="" width="34" height="34" />
          </span>
          <span>what’s popular?</span>
        </a>
        <div className="header-actions">
          <nav aria-label="Main navigation">
          <a className={pathname === "/" ? "is-active" : undefined} href="/" aria-current={pathname === "/" ? "page" : undefined}>Home</a>
          <a className={pathname === "/explore" ? "is-active" : undefined} href="/explore" aria-current={pathname === "/explore" ? "page" : undefined}>Explore</a>
          <a className={pathname === "/for-you" ? "is-active" : undefined} href="/for-you" aria-current={pathname === "/for-you" ? "page" : undefined}>For You</a>
          </nav>
          <ProfileMenu pathname={pathname} />
        </div>
      </div>
    </header>
  );
}
