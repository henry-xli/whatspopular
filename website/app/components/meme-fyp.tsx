"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { NicheCategory, NicheTopic } from "../niche";

export type MemeFypItem = {
  id: string;
  title: string;
  description: string;
  whyNow: string;
  url: string;
  source: string;
  sourceLabel: string;
  image: string;
  imageAlt?: string;
  accent: string;
  trendLabel: string;
};

type MemeFypProps = {
  items: readonly MemeFypItem[];
  generatedAt: string;
  summary: string;
};

const stopWords = new Set([
  "about", "after", "again", "also", "because", "being", "from", "have", "into", "more", "most", "that", "their", "there", "these", "they", "this", "through", "under", "what", "when", "where", "which", "while", "with", "would", "meme", "memes", "viral", "internet", "trend", "trending",
]);

function tokens(value: string) {
  return new Set(String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word)));
}

function sameMemeOrTopic(left: MemeFypItem, right: MemeFypItem) {
  const leftWords = tokens(`${left.title} ${left.description}`);
  const rightWords = tokens(`${right.title} ${right.description}`);
  if (!leftWords.size || !rightWords.size) return false;
  const overlap = [...leftWords].filter((word) => rightWords.has(word)).length;
  const ratio = overlap / Math.min(leftWords.size, rightWords.size);
  return (overlap >= 3 && ratio >= 0.42) || (overlap >= 2 && ratio >= 0.66);
}

function uniqueMemeItems(items: readonly MemeFypItem[]) {
  const unique: MemeFypItem[] = [];
  for (const item of items) {
    if (!unique.some((existing) => sameMemeOrTopic(existing, item))) unique.push(item);
  }
  return unique;
}

function itemFromTopic(topic: NicheTopic, category: NicheCategory): MemeFypItem {
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    whyNow: topic.whyNow,
    url: topic.url,
    source: topic.source,
    sourceLabel: topic.sourceLabel,
    image: topic.image,
    imageAlt: topic.imageAlt,
    accent: topic.accent || category.accent,
    trendLabel: topic.trendLabel,
  };
}

function isUsableItem(value: unknown): value is MemeFypItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["id", "title", "description", "whyNow", "url", "source", "sourceLabel", "image", "accent", "trendLabel"]
    .every((key) => typeof item[key] === "string" && String(item[key]).trim().length > 0);
}

function liveMemeItems(value: unknown) {
  if (!value || typeof value !== "object") return [];
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.categories)) return [];
  const category = snapshot.categories.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === "memes");
  if (!category || typeof category !== "object" || !Array.isArray((category as Record<string, unknown>).topics)) return [];
  const categoryRecord = category as NicheCategory;
  return uniqueMemeItems(categoryRecord.topics.map((topic) => itemFromTopic(topic, categoryRecord)).filter(isUsableItem)).slice(0, 12);
}

function displayDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "This week";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function sourceAction(item: MemeFypItem) {
  try {
    const host = new URL(item.url).hostname.toLowerCase();
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "Open on TikTok";
  } catch {
    // The ingestion validator already rejects invalid external URLs.
  }
  return item.sourceLabel || "Open the source";
}

export function MemeFypExperience({ items, generatedAt, summary }: MemeFypProps) {
  const initialItems = useMemo(() => uniqueMemeItems(items).slice(0, 12), [items]);
  const [feedItems, setFeedItems] = useState(initialItems);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/niche", { headers: { accept: "application/json" }, cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<unknown> : null)
      .then((payload) => {
        const nextItems = liveMemeItems(payload);
        if (!cancelled && nextItems.length) setFeedItems(nextItems);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [generatedAt]);

  return (
    <main className="meme-fyp-page" tabIndex={-1}>
      <div className="meme-fyp-feed" aria-label="Meme For You feed">
        <article className="meme-fyp-slide meme-fyp-intro" style={{ "--meme-accent": "#d35cf1" } as CSSProperties}>
          <div className="meme-fyp-intro-copy">
            <p className="eyebrow">Meme FYP / {displayDate(generatedAt)}</p>
            <h1>Memes,<br /><em>one at a time.</em></h1>
            <p>{summary}</p>
            <p className="meme-fyp-instruction">Swipe up to move to the next distinct meme. Similar stories are removed before they reach this feed.</p>
          </div>
          <div className="meme-fyp-intro-meta">
            <span>{feedItems.length} distinct signals</span>
            <span>Source-grounded snapshot</span>
          </div>
        </article>

        {feedItems.map((item, index) => (
          <article
            className="meme-fyp-slide meme-fyp-story"
            key={item.id}
            style={{ "--meme-accent": item.accent } as CSSProperties}
          >
            <img src={item.image} alt={item.imageAlt || item.title} width="1280" height="1920" loading={index < 2 ? "eager" : "lazy"} decoding="async" />
            <div className="meme-fyp-story-shade" aria-hidden="true" />
            <div className="meme-fyp-story-number" aria-hidden="true">{String(index + 1).padStart(2, "0")} / {String(feedItems.length).padStart(2, "0")}</div>
            <div className="meme-fyp-story-content">
              <div className="meme-fyp-story-meta">
                <span>MEME</span>
                <span aria-hidden="true">·</span>
                <span>{item.trendLabel}</span>
              </div>
              <h2>{item.title}</h2>
              <p>{item.description}</p>
              <div className="meme-fyp-why">
                <span>Why it is here</span>
                <p>{item.whyNow}</p>
              </div>
              <a className="meme-fyp-source" href={item.url} target="_blank" rel="noopener noreferrer">
                <span>{sourceAction(item)}</span>
                <strong>{item.source}</strong>
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </article>
        ))}

        <article className="meme-fyp-slide meme-fyp-end" style={{ "--meme-accent": "#6f48e5" } as CSSProperties}>
          <p className="eyebrow">End of meme FYP</p>
          <h2>You’re caught up.</h2>
          <p>The next daily snapshot will replace this set with newly gathered meme signals. There is no endless duplicate scroll.</p>
          <a className="button button-primary" href="/explore">Back to Explore <span aria-hidden="true">↗</span></a>
        </article>
      </div>
    </main>
  );
}
