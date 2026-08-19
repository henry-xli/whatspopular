import type { CSSProperties } from "react";
import { releaseDateFor, type CultureSection } from "../culture";
import { CloseIcon, ExternalLinkIcon, PlayIcon, StarIcon } from "./icons";

type ExpandedRankingProps = {
  section: CultureSection;
  activeTrack?: string | null;
  onTrackChange?: (trackId: string | null) => void;
};

export function ExpandedRanking({ section, activeTrack, onTrackChange }: ExpandedRankingProps) {
  if (!section.moreItems?.length) return null;

  const firstRank = section.moreItems[0].rank;
  const lastRank = section.moreItems[section.moreItems.length - 1]?.rank ?? firstRank;
  const label = section.moreLabel ?? `Show ranks ${firstRank}–${lastRank}`;
  const isSong = section.id === "music";
  const imageSize = section.layout === "poster"
    ? { width: 520, height: 780 }
    : section.layout === "square"
      ? { width: 640, height: 640 }
      : { width: 720, height: 520 };

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
                className={`expanded-entry layout-${section.layout}${canPlay ? " playable-entry" : ""}${isSong ? " song-expanded-entry" : ""}`}
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
                    <img
                      src={item.image}
                      alt={item.alt}
                      width={imageSize.width}
                      height={imageSize.height}
                      loading="lazy"
                      decoding="async"
                    />
                  </div>
                  <div className="expanded-copy">
                    <span className="expanded-subtitle">{item.subtitle}</span>
                    <strong className="expanded-title">{item.title}</strong>
                    {isSong ? <span className="expanded-song-release">Released {releaseDateFor(item)}</span> : <p>{item.description}</p>}
                    <div className="expanded-facts">
                      {item.rating ? (
                        <span className="expanded-rating">
                          {/^[0-9]{1,2}(?:\.\d+)?$/.test(item.rating) ? <StarIcon /> : null}
                          <strong>{item.rating}</strong>
                          <small>{item.ratingLabel ?? (item.rating === "New" ? "just opened" : "IMDb")}</small>
                        </span>
                      ) : null}
                      {item.metric ? (
                        <span className={`expanded-metric${isSong ? " song-expanded-metric" : ""}`}>
                          <small>{item.metric.label}</small>
                          <strong>{item.metric.value}</strong>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <ExternalLinkIcon className="expanded-link" />
                </a>
                {canPlay ? (
                  <button
                    type="button"
                    className="expanded-play"
                    onClick={() => onTrackChange?.(isActive ? null : item.spotifyId ?? null)}
                    aria-label={`${isActive ? "Close player for" : "Play"} ${item.title}`}
                    aria-expanded={isActive}
                  >
                    {isActive ? <CloseIcon /> : <PlayIcon />}
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
