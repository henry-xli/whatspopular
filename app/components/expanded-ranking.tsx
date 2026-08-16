"use client";

import type { CSSProperties } from "react";
import Image from "next/image";
import type { CultureSection } from "../lib/culture";

type ExpandedRankingProps = {
  section: CultureSection;
  activeTrack?: string | null;
  onTrackChange?: (trackId: string | null) => void;
};

export function ExpandedRanking({ section, activeTrack, onTrackChange }: ExpandedRankingProps) {
  if (!section.moreItems?.length) return null;

  const firstRank = section.moreItems[0].rank;
  const lastRank = section.moreItems.at(-1)?.rank ?? firstRank;
  const label = section.moreLabel ?? `Show ranks ${firstRank}–${lastRank}`;

  return (
    <details className="expanded-ranking">
      <summary>
        <span>{label}</span>
        <span className="expand-symbol" aria-hidden="true">+</span>
      </summary>
      <ol start={firstRank}>
        {section.moreItems.map((item) => {
          const canPlay = Boolean(item.spotifyId && onTrackChange);
          const isActive = activeTrack === item.spotifyId;
          return (
            <li key={item.title} value={item.rank}>
              <article
                className={`expanded-entry layout-${section.layout}${canPlay ? " playable-entry" : ""}`}
                style={{ "--accent": item.accent } as CSSProperties}
              >
                <a
                  className="expanded-entry-main"
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${item.rank}. ${item.title}: open ${item.source}`}
                >
                  <span className="expanded-rank" aria-hidden="true">{item.rank}</span>
                  <div className="expanded-art">
                    <Image src={item.image} alt={item.alt} fill sizes="100px" />
                  </div>
                  <div className="expanded-copy">
                    <div className="expanded-kicker">
                      <span className="expanded-source">{item.source}</span>
                      <span className="expanded-subtitle">{item.subtitle}</span>
                    </div>
                    <strong className="expanded-title">{item.title}</strong>
                    <p>{item.description}</p>
                    <div className="expanded-facts">
                      {item.rating ? (
                        <span className="expanded-rating">
                          <span aria-hidden="true">★</span>
                          <strong>{item.rating}</strong>
                          <small>{item.rating === "New" ? "just opened" : "IMDb"}</small>
                        </span>
                      ) : null}
                      {item.metric ? (
                        <span className="expanded-metric">
                          <small>{item.metric.label}</small>
                          <strong>{item.metric.value}</strong>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span className="expanded-link" aria-hidden="true">↗</span>
                </a>
                {canPlay ? (
                  <button
                    type="button"
                    className="expanded-play"
                    onClick={() => onTrackChange?.(isActive ? null : item.spotifyId ?? null)}
                    aria-label={`${isActive ? "Close player for" : "Play"} ${item.title}`}
                    aria-expanded={isActive}
                  >
                    <span aria-hidden="true">{isActive ? "×" : "▶"}</span>
                  </button>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
