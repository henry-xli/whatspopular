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
  assert.match(html, /Movies &amp; shows/);
  assert.match(html, />Songs</);
  assert.match(html, /July 2026 · latest complete month/);
  assert.match(html, /Subscribers gained · 30 days/);
  assert.doesNotMatch(html, /Viral formats|TikTok|KYM \+ LIMC signal/i);
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
  assert.doesNotMatch(JSON.stringify(brief), /tiktok/i);
  assert.doesNotMatch(JSON.stringify(brief), /"(?:signal|score)":/);
  const referencedImages = new Set(brief.sections.flatMap((section) => section.items.map((item) => item.image.split("/").at(-1))));
  const cachedImages = new Set((await readdir(new URL("../public/culture/", import.meta.url))).filter((file) => file.endsWith(".webp")));
  assert.deepEqual(cachedImages, referencedImages);
});
