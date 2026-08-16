import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://whatspopular.com${pathname}`, {
      headers: { accept: "text/html" },
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
});
