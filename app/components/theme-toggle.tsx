"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "whatspopular-theme";

function activeTheme() {
  const saved = document.documentElement.dataset.theme;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [locked, setLocked] = useState(false);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    frameRef.current = window.requestAnimationFrame(() => setTheme(activeTheme()));
    return () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  function toggleTheme() {
    if (locked) return;
    const next = activeTheme() === "dark" ? "light" : "dark";
    setLocked(true);
    document.documentElement.classList.add("theme-transition");

    frameRef.current = window.requestAnimationFrame(() => {
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem(STORAGE_KEY, next);
      setTheme(next);
      timerRef.current = window.setTimeout(() => {
        document.documentElement.classList.remove("theme-transition");
        setLocked(false);
      }, 500);
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
        <span className="theme-sun">☀</span>
        <span className="theme-moon">☾</span>
        <span className="theme-thumb" />
      </span>
    </button>
  );
}
