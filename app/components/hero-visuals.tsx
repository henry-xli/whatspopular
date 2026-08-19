"use client";

import { useEffect, useRef, useState } from "react";

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
  const [spotlightCurrent, setSpotlightCurrent] = useState(spotlights.length > 1 ? 1 : 0);
  const [spotlightJumping, setSpotlightJumping] = useState(false);
  const spotlightCurrentRef = useRef(spotlights.length > 1 ? 1 : 0);
  const spotlightTimer = useRef<number | null>(null);
  const advanceSpotlightRef = useRef<(direction: -1 | 1) => void>(() => undefined);
  const scheduleSpotlightRef = useRef<(delay: number) => void>(() => undefined);

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

  function setSpotlightPosition(index: number) {
    spotlightCurrentRef.current = index;
    setSpotlightCurrent(index);
  }

  useEffect(() => {
    advanceSpotlightRef.current = (direction) => {
      if (spotlights.length < 2) return;
      const previous = spotlightCurrentRef.current;
      const next = direction === 1 && previous >= spotlights.length + 1
        ? 1
        : direction === -1 && previous <= 0
          ? spotlights.length
          : previous + direction;
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      setSpotlightPosition(next);
      if (reducedMotion && (next === 0 || next === spotlights.length + 1)) {
        window.setTimeout(() => {
          const currentSpotlight = spotlightCurrentRef.current;
          if (currentSpotlight !== 0 && currentSpotlight !== spotlights.length + 1) return;
          setSpotlightJumping(true);
          setSpotlightPosition(currentSpotlight === 0 ? spotlights.length : 1);
          window.requestAnimationFrame(() => setSpotlightJumping(false));
        }, 0);
      }
    };
  }, [spotlights.length]);

  useEffect(() => {
    if (spotlights.length < 2) return undefined;
    const schedule = (delay: number) => {
      if (spotlightTimer.current !== null) window.clearTimeout(spotlightTimer.current);
      spotlightTimer.current = window.setTimeout(() => {
        advanceSpotlightRef.current(1);
        schedule(5_000);
      }, delay);
    };
    scheduleSpotlightRef.current = schedule;
    schedule(5_000);
    return () => {
      if (spotlightTimer.current !== null) window.clearTimeout(spotlightTimer.current);
      scheduleSpotlightRef.current = () => undefined;
    };
  }, [spotlights.length]);

  function finishSpotlightLoop() {
    const currentSpotlight = spotlightCurrentRef.current;
    if (spotlights.length < 2 || (currentSpotlight !== 0 && currentSpotlight !== spotlights.length + 1)) return;
    setSpotlightJumping(true);
    setSpotlightPosition(currentSpotlight === 0 ? spotlights.length : 1);
    window.requestAnimationFrame(() => setSpotlightJumping(false));
  }

  function moveSpotlight(direction: -1 | 1) {
    if (spotlights.length < 2) return;
    advanceSpotlightRef.current(direction);
    scheduleSpotlightRef.current(10_000);
  }

  const loopedSpotlights = spotlights.length > 1
    ? [spotlights[spotlights.length - 1], ...spotlights, spotlights[0]]
    : spotlights;
  const visibleSpotlight = spotlights.length > 1
    ? wrapIndex(spotlightCurrent - 1, spotlights.length)
    : 0;

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
              className={`hero-spotlight-track${spotlightJumping ? " is-jumping" : ""}`}
              style={{ transform: `translate3d(-${spotlightCurrent * 100}%, 0, 0)` }}
              onTransitionEnd={finishSpotlightLoop}
            >
              {loopedSpotlights.map((spotlight, index) => {
                const isClone = spotlights.length > 1 && (index === 0 || index === loopedSpotlights.length - 1);
                const actualIndex = isClone ? -1 : index - (spotlights.length > 1 ? 1 : 0);
                return (
                  <article className="hero-spotlight-slide" key={`${spotlight.sectionTitle}-${index}`} aria-hidden={isClone || actualIndex !== visibleSpotlight}>
                    <p className="hero-spotlight-label">Standout · {spotlight.sectionTitle}</p>
                    <a href={spotlight.url} target="_blank" rel="noopener noreferrer" tabIndex={isClone || actualIndex !== visibleSpotlight ? -1 : 0}>
                      <img src={spotlight.image} alt={spotlight.alt} width="640" height="460" loading={index < 2 ? "eager" : "lazy"} decoding="async" />
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
                );
              })}
            </div>
          </div>
          {spotlights.length > 1 ? (
            <div className="hero-spotlight-controls">
              <button className="hero-spotlight-arrow is-previous" type="button" onClick={() => moveSpotlight(-1)} aria-label="Previous standout">
                <span aria-hidden="true" />
              </button>
              <span aria-live="polite">{visibleSpotlight + 1} / {spotlights.length}</span>
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
