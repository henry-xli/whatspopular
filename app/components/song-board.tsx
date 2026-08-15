"use client";

import type { CSSProperties } from "react";
import { useState } from "react";
import Image from "next/image";
import type { CultureSection } from "../lib/culture";

export function SongBoard({ section }: { section: CultureSection }) {
  const [activeTrack, setActiveTrack] = useState<string | null>(null);

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
      <ol className="card-grid layout-square song-grid">
        {section.items.map((item) => {
          const isActive = activeTrack === item.spotifyId;
          return (
            <li key={item.title}>
              <article className="culture-card song-card" style={{ "--accent": item.accent } as CSSProperties}>
                <div className="card-art">
                  <Image src={item.image} alt={item.alt} fill sizes="(max-width: 700px) 72vw, 19vw" />
                  <span className="rank" aria-hidden="true">{item.rank}</span>
                  <button
                    type="button"
                    className="play-button"
                    onClick={() => setActiveTrack(isActive ? null : item.spotifyId ?? null)}
                    aria-label={`${isActive ? "Close player for" : "Play"} ${item.title}`}
                    aria-expanded={isActive}
                  >
                    <span aria-hidden="true">{isActive ? "×" : "▶"}</span>
                  </button>
                </div>
                <div className="card-copy">
                  <div className="card-title-line">
                    <h3><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a></h3>
                    <span aria-hidden="true">↗</span>
                  </div>
                  <p className="subtitle">{item.subtitle}</p>
                  <p className="card-description">{item.description}</p>
                  <div className="signal"><span>{item.signal}</span><strong>{item.score}</strong></div>
                </div>
                {isActive && item.spotifyId ? (
                  <div className="embed-wrap">
                    <iframe
                      title={`Spotify player for ${item.title}`}
                      src={`https://open.spotify.com/embed/track/${item.spotifyId}?utm_source=generator&theme=0`}
                      width="100%"
                      height="152"
                      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                      loading="lazy"
                    />
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
