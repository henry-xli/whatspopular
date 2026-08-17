import type { CSSProperties } from "react";
import type { CultureSection } from "../lib/culture";
import { ExpandedRanking } from "./expanded-ranking";
import { ExternalLinkIcon, StarIcon } from "./icons";

export function Leaderboard({ section }: { section: CultureSection }) {
  const imageSize = section.layout === "poster"
    ? { width: 520, height: 780 }
    : section.layout === "square"
      ? { width: 640, height: 640 }
      : { width: 720, height: 520 };

  return (
    <section className="board" id={section.id} aria-labelledby={`${section.id}-title`}>
      <div className="board-heading">
        <div>
          <p className="eyebrow">{section.eyebrow}</p>
          <h2 id={`${section.id}-title`}>{section.title}</h2>
        </div>
        <p>{section.description}</p>
        <div className="source-list" aria-label="Sources">
          {section.sources.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">
              {source.label}<ExternalLinkIcon />
            </a>
          ))}
        </div>
      </div>

      <ol className={`card-grid layout-${section.layout}`}>
        {section.items.map((item) => (
          <li key={item.title}>
            <a
              className={`culture-card ${item.metric ? "has-metric" : "no-metric"}`}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ "--accent": item.accent } as CSSProperties}
              aria-label={`${item.rank}. ${item.title}: open ${item.source}`}
            >
              <div className="card-art">
                <img
                  src={item.image}
                  alt={item.alt}
                  width={imageSize.width}
                  height={imageSize.height}
                  loading="lazy"
                  decoding="async"
                />
                <span className="rank" aria-hidden="true">{item.rank}</span>
                <span className="source-chip">{item.source}</span>
              </div>
              <div className="card-copy">
                <div className="card-title-line">
                  <h3>{item.title}</h3>
                  <ExternalLinkIcon />
                </div>
                <p className="subtitle">{item.subtitle}</p>
                {item.rating ? (
                  <div className="rating-row">
                    <StarIcon />
                    <strong>{item.rating}</strong>
                    <small>{item.rating === "New" ? "just opened" : "IMDb"}</small>
                  </div>
                ) : null}
                <p className="card-description">{item.description}</p>
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
      <ExpandedRanking section={section} />
    </section>
  );
}
