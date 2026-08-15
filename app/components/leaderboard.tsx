import type { CSSProperties } from "react";
import Image from "next/image";
import type { CultureSection } from "../lib/culture";

export function Leaderboard({ section }: { section: CultureSection }) {
  return (
    <section className="board" id={section.id} aria-labelledby={`${section.id}-title`}>
      <div className="board-heading">
        <div>
          <p className="eyebrow">{section.eyebrow}</p>
          <h2 id={`${section.id}-title`}>{section.title}</h2>
        </div>
        <p>{section.description}</p>
        <div className="source-list" aria-label="Sources">
          {section.sources.map((source) => <span key={source}>{source}</span>)}
        </div>
      </div>

      <ol className={`card-grid layout-${section.layout}`}>
        {section.items.map((item) => (
          <li key={item.title}>
            <a
              className="culture-card"
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ "--accent": item.accent } as CSSProperties}
              aria-label={`${item.rank}. ${item.title}: open ${item.source}`}
            >
              <div className="card-art">
                <Image
                  src={item.image}
                  alt={item.alt}
                  fill
                  sizes="(max-width: 700px) 72vw, (max-width: 1100px) 32vw, 19vw"
                />
                <span className="rank" aria-hidden="true">{item.rank}</span>
                <span className="source-chip">{item.source}</span>
              </div>
              <div className="card-copy">
                <div className="card-title-line">
                  <h3>{item.title}</h3>
                  <span aria-hidden="true">↗</span>
                </div>
                <p className="subtitle">{item.subtitle}</p>
                {item.rating ? (
                  <div className="rating-row">
                    <span aria-hidden="true">★</span>
                    <strong>{item.rating}</strong>
                    <small>{item.rating === "New" ? "just opened" : "IMDb"}</small>
                  </div>
                ) : null}
                <p className="card-description">{item.description}</p>
                {item.caution ? <p className="caution">Note: {item.caution}</p> : null}
                {item.metric ? (
                  <div className="metric">
                    <span>{item.metric.label}</span>
                    <strong>{item.metric.value}</strong>
                  </div>
                ) : null}
              </div>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
