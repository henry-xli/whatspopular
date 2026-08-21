"use client";

import type { CSSProperties, FormEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { NicheCategory, NicheTopic } from "../niche";

const PREFERENCES_KEY = "whatspopular-for-you-tags";
const DEFAULT_TAGS = ["edm", "football", "gaming"];
const SIGN_IN_HREF = "/signin-with-chatgpt?return_to=%2Ffor-you";

type ForYouProps = {
  categories: readonly NicheCategory[];
  generatedAt: string;
  edition: string;
  windowLabel: string;
  summary: string;
  signedIn: boolean;
  displayName?: string;
};

type DigestTopic = NicheTopic & {
  categoryId: string;
  categoryLabel: string;
  categoryParent: string;
};

type DigestLayout = "poster" | "split" | "quote" | "ticker" | "collage";

function MusicPlaybackEmbed({ topic }: { topic: DigestTopic }) {
  if (topic.categoryParent !== "Music" || !topic.playback) return null;
  return (
    <div className="digest-playback">
      <div className="digest-playback-head">
        <span>Playable on this card</span>
        <a href={topic.playback.externalUrl} target="_blank" rel="noopener noreferrer">
          {topic.playback.label} <span aria-hidden="true">↗</span>
        </a>
      </div>
      <iframe
        title={`${topic.title} ${topic.playback.provider} player`}
        src={topic.playback.embedUrl}
        width="100%"
        height="152"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededShuffle<T>(values: readonly T[], seedValue: string) {
  const result = [...values];
  let seed = hashSeed(seedValue);
  for (let index = result.length - 1; index > 0; index -= 1) {
    seed = Math.imul(seed ^ (seed >>> 16), 2246822519) >>> 0;
    const swapIndex = seed % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function digestLayoutFor(index: number, compileNumber: number): DigestLayout {
  const layouts: DigestLayout[] = ["poster", "split", "quote", "ticker", "collage"];
  const offset = hashSeed(`for-you-layout:${compileNumber}`) % layouts.length;
  return layouts[(offset + index) % layouts.length];
}

function readLocalTags(categories: readonly NicheCategory[]) {
  if (typeof window === "undefined") return DEFAULT_TAGS.filter((id) => categories.some((category) => category.id === id));
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? "null");
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((value): value is string => typeof value === "string"
        && categories.some((category) => category.id === value));
      if (valid.length) return [...new Set(valid)];
    }
  } catch {
    // A local preference is optional. The builder still works without it.
  }
  return DEFAULT_TAGS.filter((id) => categories.some((category) => category.id === id));
}

function displayDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "This week";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function groupCategories(categories: readonly NicheCategory[]) {
  const grouped = categories.reduce<Record<string, NicheCategory[]>>((groups, category) => {
    (groups[category.parent] ??= []).push(category);
    return groups;
  }, {});
  const order = ["Music", "Sports", "News", "Lifestyle", "Culture"];
  return Object.fromEntries(Object.entries(grouped).sort(([left], [right]) => {
    const leftIndex = order.indexOf(left);
    const rightIndex = order.indexOf(right);
    return (leftIndex === -1 ? order.length : leftIndex) - (rightIndex === -1 ? order.length : rightIndex);
  }));
}

export function ForYouExperience({
  categories,
  generatedAt,
  edition,
  windowLabel,
  summary,
  signedIn,
  displayName,
}: ForYouProps) {
  const [selectedTags, setSelectedTags] = useState<string[]>(() => DEFAULT_TAGS.filter((id) => categories.some((category) => category.id === id)));
  const [compiled, setCompiled] = useState(false);
  const [compileNumber, setCompileNumber] = useState(0);
  const [gateOpen, setGateOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const profileUpdatedAtRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveGenerationRef = useRef(0);

  const groups = useMemo(() => groupCategories(categories), [categories]);
  const selectedCategories = useMemo(
    () => categories.filter((category) => selectedTags.includes(category.id)),
    [categories, selectedTags],
  );
  const digestTopics = useMemo<DigestTopic[]>(() => {
    const topics = selectedCategories.flatMap((category) => category.topics.map((topic) => ({
      ...topic,
      categoryId: category.id,
      categoryLabel: category.label,
      categoryParent: category.parent,
    })));
    const uniqueTopics = [...new Map(topics.map((topic) => [topic.id, topic])).values()];
    return seededShuffle(uniqueTopics, `${generatedAt}:${selectedTags.join(",")}:${compileNumber}`)
      .slice(0, Math.min(16, uniqueTopics.length));
  }, [compileNumber, generatedAt, selectedCategories, selectedTags]);

  useEffect(() => {
    if (signedIn) return undefined;
    const timer = window.setTimeout(() => setSelectedTags(readLocalTags(categories)), 0);
    return () => window.clearTimeout(timer);
  }, [categories, signedIn]);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    fetch("/api/account/profile", { headers: { accept: "application/json" } })
      .then((response) => response.ok ? response.json() as Promise<{ tags?: unknown[]; updatedAt?: unknown; hasProfile?: boolean }> : null)
      .then((payload) => {
        if (cancelled || !payload) return;
        if (Array.isArray(payload.tags)) {
          const valid = payload.tags.filter((value): value is string => typeof value === "string"
            && categories.some((category) => category.id === value));
          if (payload.hasProfile !== false) setSelectedTags([...new Set(valid)]);
        }
        profileUpdatedAtRef.current = typeof payload.updatedAt === "string" ? payload.updatedAt : null;
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [categories, signedIn]);

  function persistLocal(nextTags: string[]) {
    if (signedIn) return;
    try { window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(nextTags)); } catch {}
  }

  function toggleTag(categoryId: string) {
    setSelectedTags((previous) => {
      const next = previous.includes(categoryId)
        ? previous.filter((id) => id !== categoryId)
        : [...previous, categoryId];
      persistLocal(next);
      setSaved(false);
      setSaveMessage("");
      if (signedIn) {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => { void queueSave(next); }, 350);
      }
      return next;
    });
  }

  function queueSave(nextTags: string[]) {
    if (!signedIn) return Promise.resolve();
    const generation = ++saveGenerationRef.current;
    const next = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (generation !== saveGenerationRef.current) return;
        await saveTags(nextTags);
      });
    saveQueueRef.current = next;
    return next;
  }

  async function saveTags(nextTags = selectedTags) {
    if (!signedIn) return;
    setSaving(true);
    setSaveMessage("");
    try {
      const response = await fetch("/api/account/profile", {
        method: "PUT",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ tags: nextTags, expectedUpdatedAt: profileUpdatedAtRef.current }),
      });
      const payload = await response.json() as { updatedAt?: unknown; tags?: unknown[]; error?: string };
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(payload.tags)) {
          const valid = payload.tags.filter((value): value is string => typeof value === "string" && categories.some((category) => category.id === value));
          setSelectedTags([...new Set(valid)]);
          profileUpdatedAtRef.current = typeof payload.updatedAt === "string" ? payload.updatedAt : profileUpdatedAtRef.current;
          setSaveMessage("Your interests changed on another device, so the newer settings were reloaded.");
          return;
        }
        throw new Error(payload.error || "Unable to save");
      }
      profileUpdatedAtRef.current = typeof payload.updatedAt === "string" ? payload.updatedAt : profileUpdatedAtRef.current;
      setSaved(true);
      setSaveMessage("Saved to your account");
    } catch {
      setSaveMessage("Could not sync this change. Try saving again when you’re online.");
    } finally {
      setSaving(false);
    }
  }

  async function compileFeed(event?: FormEvent) {
    event?.preventDefault();
    if (!selectedTags.length) return;
    if (!signedIn) {
      setGateOpen(true);
      return;
    }
    setCompileNumber((number) => number + 1);
    setCompiled(true);
    await queueSave(selectedTags);
    window.setTimeout(() => document.getElementById("digest-feed")?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
  }

  function revealAgain() {
    setCompileNumber((number) => number + 1);
    setCompiled(true);
    window.setTimeout(() => document.getElementById("digest-feed")?.scrollIntoView({ behavior: "smooth", block: "start" }), 40);
  }

  return (
    <main id="main-content" className="for-you-page" tabIndex={-1}>
      <section className="for-you-hero wrap" aria-labelledby="for-you-title">
        <div className="for-you-kicker">
          <span className="eyebrow">For You / {windowLabel}</span>
          <span className="for-you-date">Snapshot built {displayDate(generatedAt)}</span>
        </div>
        <div className="for-you-heading-grid">
          <div>
            <h1 id="for-you-title">Your internet,<br /><em>more specific.</em></h1>
            <p className="for-you-lede">{summary}</p>
          </div>
        </div>

        <div className="mobile-auth-intro">
          <div>
            <span className="eyebrow">On mobile</span>
            <strong>Your digest is ready after sign-in.</strong>
            <span>Pick your corners once. We’ll keep the next weekly mix waiting.</span>
          </div>
          {signedIn ? (
            <span className="account-state"><span className="status-dot" aria-hidden="true" /> Signed in</span>
          ) : (
            <a className="button button-primary button-small" href={SIGN_IN_HREF}>Sign in</a>
          )}
        </div>

        <form className="tag-builder" onSubmit={compileFeed} aria-labelledby="tag-builder-title">
          <div className="tag-builder-head">
            <div>
              <p className="eyebrow">01 / Tune the signal</p>
              <h2 id="tag-builder-title">Choose your corners</h2>
            </div>
            <div className="tag-builder-summary">
              <span><strong>{selectedTags.length}</strong> selected</span>
              <span aria-hidden="true">·</span>
              <span>{selectedTags.length ? `${selectedCategories.reduce((total, category) => total + category.topics.length, 0)} stories in the mix` : "Pick at least one"}</span>
            </div>
          </div>
          <div className="tag-groups">
            {Object.entries(groups).map(([parent, parentCategories]) => (
              <div className="tag-group" key={parent}>
                <span className="tag-group-label">{parent}</span>
                <div className="tag-list" aria-label={`${parent} interests`}>
                  {parentCategories.map((category) => {
                    const active = selectedTags.includes(category.id);
                    return (
                      <button
                        className={`interest-tag${active ? " is-selected" : ""}`}
                        key={category.id}
                        type="button"
                        onClick={() => toggleTag(category.id)}
                        aria-pressed={active}
                        style={{ "--tag-accent": category.accent } as CSSProperties}
                      >
                        <span className="interest-tag-dot" aria-hidden="true" />
                        {category.label}
                        <span className="interest-tag-check" aria-hidden="true">{active ? "✓" : "+"}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="tag-builder-foot">
            <span className="builder-note"><span className="sparkle" aria-hidden="true">✦</span> We only use cards already gathered in this week’s snapshot.</span>
            <button className="button button-primary compile-button" type="submit" disabled={!selectedTags.length || saving}>
              {saving ? "Saving…" : compiled ? "Recompile my mix" : "Compile my feed"}
              <span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </section>

      {!compiled ? (
        <section className="for-you-preview wrap" aria-labelledby="preview-title">
          <div className="preview-copy">
            <p className="eyebrow">02 / The local compiler</p>
            <h2 id="preview-title">A few minutes of exactly your kind of caught up.</h2>
            <p>We’ll blend one-of-one topics from your tags, keep the mix a little surprising, and give every card a clear “why now” so you can skim with context.</p>
          </div>
          <div className="preview-stack" aria-hidden="true">
            <div className="preview-card preview-card-back"><span>WEEKLY</span><strong>signal</strong></div>
            <div className="preview-card preview-card-middle"><span>{selectedCategories[1]?.label ?? "Your interests"}</span><strong>in motion</strong></div>
            <div className="preview-card preview-card-front"><span>{selectedCategories[0]?.label ?? "Pick a tag"}</span><strong>right now</strong><i>✦</i></div>
          </div>
        </section>
      ) : (
        <section className="digest-section" aria-labelledby="digest-title">
          <div className="digest-intro wrap">
            <div>
              <p className="eyebrow">02 / Your weekly mix</p>
              <h2 id="digest-title">The {edition.toLowerCase()} edition.</h2>
            </div>
            <div className="digest-intro-side">
              <p>{signedIn ? `Saved for ${displayName ?? "your account"}.` : "This mix is built on this device."} Each card has a source and a reason it is moving now.</p>
              <div className="digest-actions">
                <button className="button button-quiet button-small" type="button" onClick={revealAgain}>Shuffle the mix <span aria-hidden="true">↻</span></button>
                <button className="button button-quiet button-small" type="button" onClick={() => document.getElementById("tag-builder-title")?.scrollIntoView({ behavior: "smooth", block: "center" })}>Edit tags</button>
              </div>
            </div>
          </div>
          <div className={`digest-feed wrap${digestTopics.length === 1 ? " digest-feed-single" : ""}`} id="digest-feed" aria-label="Your For You digest">
            {digestTopics.map((topic, index) => {
              const layout = digestLayoutFor(index, compileNumber);
              return (
                <article
                  className={`digest-card digest-card-${layout}`}
                  data-layout={layout}
                  key={`${topic.id}-${compileNumber}`}
                  style={{ "--card-accent": topic.accent, "--card-index": index } as CSSProperties}
                >
                  <div className="digest-card-art">
                    <div className="digest-art-blob" aria-hidden="true" />
                    <img src={topic.image} alt={topic.imageAlt || topic.title} width="720" height="520" loading={index < 2 ? "eager" : "lazy"} decoding="async" />
                    <span className="digest-card-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <span className="digest-card-parent">{topic.categoryParent}</span>
                    <span className="digest-card-stamp" aria-hidden="true">{index % 3 === 0 ? "RISING" : index % 3 === 1 ? "ON THE RADAR" : "WORTH A MINUTE"}</span>
                  </div>
                  <div className="digest-card-body">
                    <div className="digest-card-meta">
                      <span>{topic.categoryLabel}</span>
                      <span aria-hidden="true">·</span>
                      <span className="digest-trend-label">{topic.trendLabel}</span>
                    </div>
                    <h3>{topic.title}</h3>
                    <p className="digest-description">{topic.description}</p>
                    <div className="digest-why">
                      <span>Why now</span>
                      <p>{topic.whyNow}</p>
                    </div>
                    <MusicPlaybackEmbed topic={topic} />
                    <a className="digest-source" href={topic.url} target="_blank" rel="noopener noreferrer">
                      <span>{topic.sourceLabel}</span>
                      <strong>{topic.source}</strong>
                      <span aria-hidden="true">↗</span>
                    </a>
                  </div>
                  <div className="digest-card-edge" aria-hidden="true"><span>{String(index + 1).padStart(2, "0")}</span><i /></div>
                </article>
              );
            })}
          </div>
          <div className="digest-end wrap">
            <span className="sparkle" aria-hidden="true">✦</span>
            <p>That’s the signal for this week.<br /><strong>Come back after the next snapshot.</strong></p>
            {signedIn ? <span className="account-state"><span className="status-dot" aria-hidden="true" /> {saved ? saveMessage || "Saved" : saveMessage || "Account sync on"}</span> : null}
          </div>
        </section>
      )}

      {gateOpen ? (
        <div className="for-you-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setGateOpen(false); }}>
          <section className="for-you-signin-modal" role="dialog" aria-modal="true" aria-labelledby="signin-title">
            <button className="modal-close" type="button" onClick={() => setGateOpen(false)} aria-label="Close sign-in prompt">×</button>
            <span className="modal-symbol" aria-hidden="true">✳</span>
            <p className="eyebrow">Keep your signal close</p>
            <h2 id="signin-title">Your mix is ready.<br /><em>Save it for next week.</em></h2>
            <p>Sign in with ChatGPT to save your tags and have the next pre-built digest waiting when you come back. No live scraping. No infinite feed.</p>
            <a className="button button-primary modal-signin-button" href={SIGN_IN_HREF}>Continue with ChatGPT <span aria-hidden="true">↗</span></a>
            <button className="modal-secondary" type="button" onClick={() => { setGateOpen(false); setCompiled(true); }}>Preview this mix on this device</button>
            <span className="modal-footnote">Your preferences are stored locally until you sign in.</span>
          </section>
        </div>
      ) : null}
    </main>
  );
}
