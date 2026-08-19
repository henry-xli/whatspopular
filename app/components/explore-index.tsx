"use client";

import type { CultureSection } from "../culture";

export function ExploreIndex({ sections }: { sections: readonly CultureSection[] }) {
  function jumpTo(sectionId: string) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    section.scrollIntoView({ behavior, block: "start", inline: "nearest" });
  }

  return (
    <nav className="explore-index" aria-label="Jump to a leaderboard">
      <span className="explore-index-label">Jump to</span>
      <div className="explore-index-links">
        {sections.map((section, index) => (
          <span key={section.id} className="explore-index-item">
            {index ? <span className="explore-index-separator" aria-hidden="true">•</span> : null}
            <button
              className="explore-index-link"
              type="button"
              aria-controls={section.id}
              onClick={() => jumpTo(section.id)}
            >
              {section.title}
            </button>
          </span>
        ))}
      </div>
    </nav>
  );
}
