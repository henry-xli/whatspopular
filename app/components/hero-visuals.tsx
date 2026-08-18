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

export function HeroVisuals({ slides, spotlight }: { slides: HeroSlide[]; spotlight: HeroSpotlight | null }) {
  const [orderedSlides, setOrderedSlides] = useState(slides);
  const [current, setCurrent] = useState(0);

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
      {spotlight ? (
        <aside className="hero-spotlight" aria-labelledby="hero-spotlight-title">
          <p className="hero-spotlight-label">Standout · {spotlight.sectionTitle}</p>
          <a href={spotlight.url} target="_blank" rel="noopener noreferrer">
            <img src={spotlight.image} alt={spotlight.alt} width="96" height="96" loading="eager" decoding="async" />
            <span className="hero-spotlight-copy">
              <strong id="hero-spotlight-title">{spotlight.title}</strong>
              <span>{spotlight.description}</span>
              {spotlight.metric ? (
                <span className="hero-spotlight-metric">
                  <small>{spotlight.metric.label}</small>
                  <b>{spotlight.metric.value}</b>
                </span>
              ) : null}
            </span>
          </a>
        </aside>
      ) : null}
    </div>
  );
}
