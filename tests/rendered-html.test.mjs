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
  assert.match(html, /The whole internet\. Five short lists\./);
  assert.match(html, />Memes</);
  assert.match(html, />Slang</);
  assert.match(html, />Creators</);
  assert.match(html, />Movies</);
  assert.match(html, />Songs</);
  assert.match(html, /latest complete month/);
  assert.match(html, /Wikipedia views · 30 days|Google Trends interest · 30 days/);
  assert.match(html, /U\.S\. &amp; Canada total gross/);
  assert.match(html, /Billboard Hot 100/);
  assert.doesNotMatch(html, /Viral formats|TikTok|KYM \+ LIMC signal|SocialCounts|Social Blade|Subscribers gained/i);
  assert.match(html, /BMC-Widget/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  assert.equal((html.match(/class="culture-card/g) ?? []).length, 25);
});

test("renders the About flowchart", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Know enough to log off/);
  for (const label of ["Collect", "Compare", "Contextualize", "Cache", "Publish"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /Most visits never touch a database/);
});

test("keeps content and outbound links constrained", async () => {
  const brief = JSON.parse(await readFile(new URL("../data/trends.json", import.meta.url), "utf8"));
  assert.equal(brief.sections.length, 5);
  assert.ok(brief.sections.every((section) => section.items.length === 5));
  const items = [...brief.pulse, ...brief.sections.flatMap((section) => section.items)];
  for (const item of items) {
    assert.match(item.image, /^\/culture\/[a-z0-9-]+\.webp$/);
    assert.equal(new URL(item.url).protocol, "https:");
  }
  for (const item of brief.sections.flatMap((section) => section.items)) {
    assert.ok(item.evidence.length >= 2);
    assert.ok(new Set(item.evidence.map((entry) => entry.source)).size >= 2);
    assert.ok(new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size >= 2);
  }
  const memes = brief.sections.find((section) => section.id === "memes");
  assert.ok(memes.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.youtube.com")));
  assert.ok(memes.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "knowyourmeme.com")));
  assert.doesNotMatch(memes.items.map((item) => item.title).join(" "), /Pirate Gaster/i);
  assert.ok(memes.items.every((item) => /Meme of the Month$/.test(item.metric.label)));
  const pollRanks = memes.items.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(pollRanks, [...pollRanks].sort((left, right) => left - right));
  assert.doesNotMatch(memes.items.map((item) => item.description).join(" "), /placed in Know Your Meme|reached Lessons in Meme Culture|has a Know Your Meme entry/i);
  const creators = brief.sections.find((section) => section.id === "creators");
  assert.ok(creators.items.filter((item) => /Digital creator|Streamer|Technology creator/i.test(item.subtitle)).length >= 2);
  const movies = brief.sections.find((section) => section.id === "watch");
  assert.equal(movies.title, "Movies");
  assert.ok(movies.items.every((item) => item.metric.label === "U.S. & Canada total gross"));
  assert.ok(movies.items.every((item) => /^\$\d+(?:\.\d{1,2})?[BMK]?$/.test(item.metric.value)));
  assert.ok(movies.items.some((item) => item.title === "Toy Story 5"));
  assert.ok(movies.items.every((item) => !/One Night Only|Super Troopers 3/.test(item.title)));
  const songs = brief.sections.find((section) => section.id === "songs");
  assert.ok(songs.items.every((item) => item.metric.label === "Billboard Hot 100"));
  const billboardRanks = songs.items.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(billboardRanks, [...billboardRanks].sort((left, right) => left - right));
  assert.ok(songs.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.billboard.com")));
  assert.doesNotMatch(JSON.stringify(brief), /tiktok|socialcounts|socialblade/i);
  assert.doesNotMatch(JSON.stringify(brief), /caution|b\*{2,}|a\*{2,}/i);
  assert.doesNotMatch(JSON.stringify(brief), /"(?:signal|score)":/);
  const referencedImages = new Set(brief.sections.flatMap((section) => section.items.map((item) => item.image.split("/").at(-1))));
  const cachedImages = new Set((await readdir(new URL("../public/culture/", import.meta.url))).filter((file) => file.endsWith(".webp")));
  assert.deepEqual(cachedImages, referencedImages);
});
