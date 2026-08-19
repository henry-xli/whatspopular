"use client";

import { useEffect, useState } from "react";

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => setVisible(window.scrollY > 320);
    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });
    return () => window.removeEventListener("scroll", updateVisibility);
  }, []);

  function goToTop() {
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    window.scrollTo({ top: 0, behavior });
  }

  return (
    <button
      className={`scroll-top${visible ? " is-visible" : ""}`}
      type="button"
      onClick={goToTop}
      aria-label="Back to top of Explore"
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
    >
      <span className="scroll-top-icon" aria-hidden="true" />
    </button>
  );
}
