"use client";

import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import type { CultureSection } from "../lib/culture";
import { ExpandedRanking } from "./expanded-ranking";
import { CloseIcon, ExternalLinkIcon, PlayIcon } from "./icons";

export function SongBoard({ section }: { section: CultureSection }) {
  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const activeItem = [...section.items, ...(section.moreItems ?? [])]
    .find((item) => item.spotifyId === activeTrack);

  useEffect(() => {
    if (!activeTrack) return;
    const frame = window.requestAnimationFrame(() => {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      playerRef.current?.scrollIntoView({ behavior, block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTrack]);

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
      <ol className="card-grid layout-square song-grid">
        {section.items.map((item) => {
          const isActive = activeTrack === item.spotifyId;
          return (
            <li key={item.title}>
              <article className="culture-card song-card" style={{ "--accent": item.accent } as CSSProperties}>
                <div className="card-art">
                  <img src={item.image} alt={item.alt} width="640" height="640" loading="lazy" decoding="async" />
                  <span className="rank" aria-hidden="true">{item.rank}</span>
                  <button
                    type="button"
                    className="play-button"
                    onClick={() => setActiveTrack(isActive ? null : item.spotifyId ?? null)}
                    aria-label={`${isActive ? "Close player for" : "Play"} ${item.title}`}
                    aria-expanded={isActive}
                  >
                    {isActive ? <CloseIcon /> : <PlayIcon />}
                  </button>
                </div>
                <div className="card-copy">
                  <div className="card-title-line">
                    <h3><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
                    <ExternalLinkIcon />
                  </div>
                  <p className="subtitle">{item.subtitle}</p>
                  <p className="card-description">{item.description}</p>
                  {item.metric ? (
                    <div className="metric">
                      <span>{item.metric.label}</span>
                      <strong>{item.metric.value}</strong>
                    </div>
                  ) : null}
                </div>
              </article>
            </li>
          );
        })}
      </ol>
      <ExpandedRanking
        section={section}
        activeTrack={activeTrack}
        onTrackChange={setActiveTrack}
      />
      {activeItem?.spotifyId ? (
        <div className="song-player" ref={playerRef} aria-live="polite">
          <div className="song-player-heading">
            <span>Now playing</span>
            <strong>{activeItem.title} · {activeItem.subtitle}</strong>
            <button type="button" onClick={() => setActiveTrack(null)} aria-label="Close Spotify player">
              <CloseIcon />
            </button>
          </div>
          <div className="embed-wrap">
            <iframe
              title={`Spotify player for ${activeItem.title}`}
              src={`https://open.spotify.com/embed/track/${activeItem.spotifyId}?utm_source=generator&theme=0`}
              width="100%"
              height="152"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
