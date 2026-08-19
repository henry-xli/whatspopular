import type { CultureSection } from "../culture";

export function ExploreIndex({ sections }: { sections: readonly CultureSection[] }) {
  return (
    <nav className="explore-index" aria-label="Jump to a leaderboard">
      <span className="explore-index-label">Jump to</span>
      <div className="explore-index-links">
        {sections.map((section, index) => (
          <span key={section.id} className="explore-index-item">
            {index ? <span className="explore-index-separator" aria-hidden="true">•</span> : null}
            <a href={`#${section.id}`}>{section.title}</a>
          </span>
        ))}
      </div>
    </nav>
  );
}
