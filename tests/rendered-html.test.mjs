import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { fetchBytes, mapConcurrent } from "../scripts/lib/runtime.mjs";

async function render(pathname = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}-${init.method ?? "GET"}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://whatspopular.com${pathname}`, {
      headers: { accept: "text/html" },
      ...init,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the complete finite culture briefing", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-src[^;]*https:\/\/buymeacoffee\.com/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-permitted-cross-domain-policies"), "none");
  assert.match(response.headers.get("cache-control") ?? "", /s-maxage=86400/);

  const html = await response.text();
  assert.match(html, /Internet culture,/);
  assert.match(html, /minus the infinite scroll/);
  assert.match(html, />Memes</);
  assert.match(html, />Slang</);
  assert.match(html, />Creators</);
  assert.match(html, />Movies</);
  assert.match(html, />Songs</);
  assert.match(html, /latest complete month/);
  assert.match(html, /Know Your Meme page views/);
  assert.match(html, /Wikipedia views · 30 days/);
  assert.match(html, /U\.S\. &amp; Canada total gross/);
  assert.match(html, /Billboard Hot 100/);
  assert.match(html, /class="source-list"[^>]*>[\s\S]*?<a /);
  assert.doesNotMatch(html, /How an entry earns a spot|>Right now<|The whole internet\. Five short lists\.|Less feed\. More signal\./);
  assert.doesNotMatch(html, /Viral formats|TikTok|KYM \+ LIMC signal|SocialCounts|Social Blade|Subscribers gained/i);
  assert.match(html, /BMC-Widget/);
  assert.match(html, /<script[^>]*data-name="BMC-Widget"[^>]*defer=""/);
  assert.match(html, /buymeacoffee\.com\/0wtynrfutb/);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /<main id="main-content" tabindex="-1">/);
  assert.match(html, /og\.jpg/);
  assert.doesNotMatch(html, /og\.png|data-nimg|\/_next\/image\?/);
  const images = html.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(images.length, 49);
  assert.ok(images.every((image) => /\balt="[^"]+"/.test(image)));
  assert.ok(images.every((image) => /\bwidth="\d+"/.test(image) && /\bheight="\d+"/.test(image)));
  assert.ok(images.every((image) => /\bloading="lazy"/.test(image) && /\bdecoding="async"/.test(image)));
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  assert.equal((html.match(/class="culture-card/g) ?? []).length, 25);
  assert.equal((html.match(/<details class="expanded-ranking"/g) ?? []).length, 5);
  assert.equal((html.match(/class="expanded-entry /g) ?? []).length, 24);
  assert.equal((html.match(/aria-label="Play /g) ?? []).length, 10);
  assert.match(html, /Show ranks 6/);
  assert.match(html, /this shit pisses me off/i);
  assert.match(html, /toothy collectible toy/i);
});

test("renders the About flowchart", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Sources in\. Rankings out\./);
  assert.match(html, /One ingestion run\. Five rankings\. One page\./);
  assert.match(html, /10:17 UTC/);
  for (const label of ["Pull sources", "Run once daily", "Apply five rules", "Validate and cache", "Publish the snapshot"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  for (const board of ["Memes", "Slang", "Creators", "Movies", "Songs"]) {
    assert.match(html, new RegExp(`>${board}<`));
  }
  assert.match(html, /last good snapshot stays live/i);
  assert.match(html, /<main class="about-page" id="main-content" tabindex="-1">/);
});

test("never edge-caches errors or unsafe request methods", async () => {
  const missing = await render("/definitely-not-a-page");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  const post = await render("/", { method: "POST" });
  assert.equal(post.headers.get("cache-control"), "no-store");
});

test("reuses deployment-versioned HTML from the edge cache", async () => {
  const hadCaches = Object.hasOwn(globalThis, "caches");
  const originalCaches = globalThis.caches;
  let stored;
  let matches = 0;
  let puts = 0;
  globalThis.caches = {
    default: {
      async match(request) {
        matches += 1;
        return stored?.url === request.url ? stored.response.clone() : undefined;
      },
      async put(request, response) {
        puts += 1;
        stored = { url: request.url, response };
      },
    },
  };
  try {
    const first = await render("/");
    assert.equal(first.status, 200);
    const firstHtml = await first.text();
    const second = await render("/?campaign=ignored");
    assert.equal(await second.text(), firstHtml);
    assert.equal(matches, 2);
    assert.equal(puts, 1);
    assert.match(stored.url, /\?__wpv=/);
    assert.doesNotMatch(stored.url, /campaign/);
  } finally {
    if (hadCaches) globalThis.caches = originalCaches;
    else delete globalThis.caches;
  }
});

test("validates every redirect before making the next request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  };
  try {
    await assert.rejects(fetchBytes("https://example.com/start", {
      isAllowedHost: (hostname) => hostname === "example.com",
      kind: "test",
      maxBytes: 1024,
      timeoutMs: 1000,
      attempts: 1,
    }), /unapproved test URL/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects oversized upstream responses before reading them", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(2048), {
    headers: { "content-length": "2048", "content-type": "text/plain" },
  });
  try {
    await assert.rejects(fetchBytes("https://example.com/data", {
      isAllowedHost: (hostname) => hostname === "example.com",
      kind: "test",
      maxBytes: 1024,
      timeoutMs: 1000,
      attempts: 1,
    }), /exceeds 1024 bytes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded concurrency preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([3, 1, 4, 2], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [6, 2, 8, 4]);
  assert.equal(peak, 2);
});

test("keeps content and outbound links constrained", async () => {
  const brief = JSON.parse(await readFile(new URL("../data/trends.json", import.meta.url), "utf8"));
  assert.equal(brief.sections.length, 5);
  assert.ok(brief.sections.every((section) => section.items.length === 5));
  assert.ok(brief.sections.every((section) => section.moreItems.length >= 1 && section.moreItems.length <= 5));
  for (const section of brief.sections) {
    assert.ok(section.sources.length >= 2);
    assert.ok(section.sources.every((source) => source.label && new URL(source.url).protocol === "https:"));
    assert.deepEqual(section.moreItems.map((item) => item.rank), section.moreItems.map((_, index) => index + 6));
    assert.ok(section.moreItems.every((item) => !section.items.some((topItem) => topItem.title === item.title)));
    assert.ok(section.moreItems.every((item) => !/(?:…|\.{3})\s*$/.test(item.description)));
  }
  const items = brief.sections.flatMap((section) => [...section.items, ...section.moreItems]);
  for (const item of items) {
    assert.match(item.image, /^\/culture\/[a-z0-9-]+\.webp$/);
    assert.equal(new URL(item.url).protocol, "https:");
    assert.ok(item.description.length >= 30);
    assert.ok(item.alt.length >= 5);
    assert.match(item.accent, /^#[0-9a-f]{6}$/i);
    assert.ok(item.evidence.length >= 2);
    assert.ok(new Set(item.evidence.map((entry) => entry.source)).size >= 2);
    assert.ok(new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size >= 2);
  }
  const memes = brief.sections.find((section) => section.id === "memes");
  assert.ok(memes.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.youtube.com")));
  assert.ok(memes.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "knowyourmeme.com")));
  assert.ok(memes.moreItems.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.youtube.com")));
  assert.ok(memes.moreItems.every((item) => item.description.length >= 40));
  assert.doesNotMatch(memes.items.map((item) => item.title).join(" "), /Pirate Gaster/i);
  assert.ok(memes.items.every((item) => /Meme of the Month$/.test(item.metric.label)));
  const pollRanks = memes.items.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(pollRanks, [...pollRanks].sort((left, right) => left - right));
  assert.doesNotMatch(memes.items.map((item) => item.description).join(" "), /placed in Know Your Meme|reached Lessons in Meme Culture|has a Know Your Meme entry/i);
  const creators = brief.sections.find((section) => section.id === "creators");
  assert.ok(creators.items.every((item) => item.metric.label === "Wikipedia views · 30 days"));
  assert.ok(creators.items.every((item) => !item.subtitle.includes("·")));
  assert.ok(creators.moreItems.every((item) => !item.subtitle.includes("·")));
  const categoryCounts = new Map();
  for (const item of creators.items) categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  assert.ok([...categoryCounts.values()].every((count) => count <= 2));
  const slang = brief.sections.find((section) => section.id === "slang");
  assert.ok(slang.items.every((item) => item.metric.label === "Know Your Meme page views"));
  assert.ok(slang.items.every((item) => /^\d{1,3}(?:,\d{3})*$/.test(item.metric.value)));
  assert.ok(slang.moreItems.every((item) => item.metric.label === "Know Your Meme page views"));
  const slangViews = [...slang.items, ...slang.moreItems].map((item) => Number(item.metric.value.replaceAll(",", "")));
  assert.deepEqual(slangViews, [...slangViews].sort((left, right) => right - left));
  assert.match([...slang.items, ...slang.moreItems].find((item) => item.title === "TS PMO ICL").description, /this shit pisses me off/i);
  assert.match([...slang.items, ...slang.moreItems].find((item) => item.title === "Labubu Matcha Dubai Chocolate").description, /Labubu.*matcha.*Dubai chocolate/i);
  const movies = brief.sections.find((section) => section.id === "watch");
  assert.equal(movies.title, "Movies");
  const allMovies = [...movies.items, ...movies.moreItems];
  assert.ok(allMovies.every((item) => item.metric.label === "U.S. & Canada total gross"));
  assert.ok(allMovies.every((item) => /^\$\d+(?:\.\d{1,2})?[BMK]?$/.test(item.metric.value)));
  assert.ok(allMovies.every((item) => item.rating === "New" || /^\d+(?:\.\d)?$/.test(item.rating)));
  assert.ok(allMovies.every((item) => item.description.length >= 30));
  assert.ok(movies.items.some((item) => item.title === "Toy Story 5"));
  assert.ok(movies.items.every((item) => !/One Night Only|Super Troopers 3/.test(item.title)));
  const songs = brief.sections.find((section) => section.id === "songs");
  assert.match(songs.description, /first 10 Spotify Global Top 50 tracks/i);
  const allSongs = [...songs.items, ...songs.moreItems];
  assert.ok(allSongs.every((item) => item.metric.label === "Billboard Hot 100"));
  assert.ok(allSongs.every((item) => Number.isInteger(item.spotifyRank) && item.spotifyRank <= 50));
  assert.ok(allSongs.every((item) => /^[A-Za-z0-9]{22}$/.test(item.spotifyId)));
  const billboardRanks = allSongs.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(billboardRanks, [...billboardRanks].sort((left, right) => left - right));
  assert.ok(allSongs.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.billboard.com")));
  assert.doesNotMatch(JSON.stringify(brief), /tiktok|socialcounts|socialblade/i);
  assert.doesNotMatch(JSON.stringify(brief), /caution|b\*{2,}|a\*{2,}/i);
  assert.doesNotMatch(JSON.stringify(brief), /"(?:signal|score)":/);
  const referencedImages = new Set(items.map((item) => item.image.split("/").at(-1)));
  const cachedImages = new Set((await readdir(new URL("../public/culture/", import.meta.url))).filter((file) => file.endsWith(".webp")));
  assert.deepEqual(cachedImages, referencedImages);

  const expectedDimensions = {
    landscape: { width: 720, height: 520 },
    poster: { width: 520, height: 780 },
    square: { width: 640, height: 640 },
  };
  for (const section of brief.sections) {
    for (const item of [...section.items, ...section.moreItems]) {
      const metadata = await sharp(fileURLToPath(new URL(`../public${item.image}`, import.meta.url))).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, expectedDimensions[section.layout].width);
      assert.equal(metadata.height, expectedDimensions[section.layout].height);
    }
  }

  const socialPreview = await sharp(fileURLToPath(new URL("../public/og.jpg", import.meta.url))).metadata();
  assert.equal(socialPreview.format, "jpeg");
  assert.equal(socialPreview.width, 1200);
  assert.equal(socialPreview.height, 630);
});
