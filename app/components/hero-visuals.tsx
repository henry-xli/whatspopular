"use client";

import { useEffect, useState } from "react";

export type HeroSlide = {
  id: string;
  image: string;
  alt: string;
};

export type HeroSpotlight = {
  sectionTitle: string;
  title: string;
  description: string;
  image: string;
  alt: string;
  url: string;
  metric?: {
    label: string;
    value: string;
  };
};

function wrapIndex(index: number, length: number) {
  return (index + length) % length;
}

function shuffle<T>(values: readonly T[]) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    const swapIndex = typeof globalThis.crypto?.getRandomValues === "function"
      ? (globalThis.crypto.getRandomValues(random)[0] % (index + 1))
      : Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function HeroVisuals({ slides, spotlights }: { slides: HeroSlide[]; spotlights: HeroSpotlight[] }) {
  const [orderedSlides, setOrderedSlides] = useState(slides);
  const [current, setCurrent] = useState(0);
  const [spotlightCurrent, setSpotlightCurrent] = useState(0);

  useEffect(() => {
    const randomize = window.setTimeout(() => {
      setOrderedSlides(shuffle(slides));
      setCurrent(0);
    }, 0);
    return () => window.clearTimeout(randomize);
  }, [slides]);

  useEffect(() => {
    if (orderedSlides.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setCurrent((previous) => (previous + 1) % orderedSlides.length);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [orderedSlides.length]);

  useEffect(() => {
    if (spotlights.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setSpotlightCurrent((previous) => (previous + 1) % spotlights.length);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [spotlights.length]);

  function moveSpotlight(direction: -1 | 1) {
    if (spotlights.length < 2) return;
    setSpotlightCurrent((previous) => wrapIndex(previous + direction, spotlights.length));
  }

  return (
    <div className="hero-visuals">
      <div className="hero-slideshow" aria-hidden="true">
        <div className="hero-slideshow-track" style={{ transform: `translate3d(-${current * 100}%, 0, 0)` }}>
          {orderedSlides.map((slide, index) => (
            <div className="hero-slide" key={slide.id}>
              <img src={slide.image} alt={slide.alt} width="720" height="520" loading={index < 2 ? "eager" : "lazy"} decoding="async" />
            </div>
          ))}
        </div>
      </div>
      {spotlights.length ? (
        <aside className="hero-spotlight" role="region" aria-label="Standout entries" aria-roledescription="carousel">
          <div className="hero-spotlight-viewport">
            <div
              className="hero-spotlight-track"
              style={{ transform: `translate3d(-${spotlightCurrent * 100}%, 0, 0)` }}
            >
              {spotlights.map((spotlight, index) => (
                <article className="hero-spotlight-slide" key={spotlight.sectionTitle} aria-hidden={index !== spotlightCurrent}>
                  <p className="hero-spotlight-label">Standout · {spotlight.sectionTitle}</p>
                  <a href={spotlight.url} target="_blank" rel="noopener noreferrer" tabIndex={index === spotlightCurrent ? 0 : -1}>
                    <img src={spotlight.image} alt={spotlight.alt} width="640" height="460" loading={index === 0 ? "eager" : "lazy"} decoding="async" />
                    <span className="hero-spotlight-copy">
                      <strong>{spotlight.title}</strong>
                      <span>{spotlight.description}</span>
                      {spotlight.metric ? (
                        <span className="hero-spotlight-metric">
                          <small>{spotlight.metric.label}</small>
                          <b>{spotlight.metric.value}</b>
                        </span>
                      ) : null}
                    </span>
                  </a>
                </article>
              ))}
            </div>
          </div>
          {spotlights.length > 1 ? (
            <div className="hero-spotlight-controls">
              <button className="hero-spotlight-arrow is-previous" type="button" onClick={() => moveSpotlight(-1)} aria-label="Previous standout">
                <span aria-hidden="true" />
              </button>
              <span aria-live="polite">{spotlightCurrent + 1} / {spotlights.length}</span>
              <button className="hero-spotlight-arrow is-next" type="button" onClick={() => moveSpotlight(1)} aria-label="Next standout">
                <span aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
