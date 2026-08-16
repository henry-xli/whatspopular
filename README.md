# what’s popular?

A finite daily briefing on internet culture. Visitors receive pre-rendered HTML
and local images; there is no account, feed, runtime database query, or
request-time scraper.

## Develop

Node.js 22.13 or newer is required.

```bash
npm ci
npm run dev
```

Before committing:

```bash
npm run content:update -- --dry-run
npm run content:images
npm run lint
npm run typecheck
npm test
```

## How rankings are made

Once daily, `scripts/update-trends.mjs` verifies every required source and writes
`data/trends.json` atomically. If any source fails, no new snapshot is published.

- Memes preserve the latest completed Know Your Meme Meme of the Month order,
  filtered to entries covered by Lessons in Meme Culture in the past two months.
- Slang comes from Know Your Meme’s annual review, is verified with Urban
  Dictionary, and is ordered by lifetime Know Your Meme entry views.
- Creators are ordered by 30-day English Wikipedia views, with at most two
  people from one primary profession in the top five; each list links a
  configured Google Trends comparison for independent context.
- Movies are IMDb’s weekend top 10 re-ordered by cumulative U.S./Canada gross
  from Box Office Mojo, with IMDb-linked Cinemeta metadata.
- Songs are the first 10 Spotify Global Top 50 tracks also on the Billboard Hot
  100, then all 10 are ordered by Billboard position.

Every entry has evidence from at least two distinct approved source hosts.
`scripts/cache-images.mjs` validates the snapshot, downloads only missing or
invalid art through HTTPS allowlists, converts it to bounded local WebP files,
and preserves a last-known-good image when an upstream host fails.

## Architecture and maintenance

- `app/` contains the pages, components, styles, and runtime data validation.
- `data/trends.json` is the single preprocessed content snapshot.
- `scripts/` contains the daily ingestion and image pipeline.
- `worker/index.ts` applies edge caching and production security headers.
- `tests/` checks rendered content, headers, links, media, and data invariants.
- `.github/workflows/update-daily.yml` refreshes, verifies, and commits once daily.

Content-hashed application assets cache immutably; successful HTML navigations
use a deployment-versioned edge cache, and local media uses
stale-while-revalidate. Error responses, React server requests, and unsafe HTTP
methods are never cached. Spotify audio loads only after a play action, and the
Buy Me a Coffee widget is deferred until the document has been parsed.

The project targets the Cloudflare-compatible vinext runtime and OpenAI Sites.
The deployment project is recorded in `.openai/hosting.json`; the custom
`whatspopular.com` domain must be configured in the owning Cloudflare account.
