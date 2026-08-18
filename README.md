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

At 12:00 AM Pacific each day, `scripts/update-trends.mjs` verifies its required
sources and writes `data/trends.json` atomically. A bad run cannot replace the
last validated snapshot.

- Memes preserve the latest completed Know Your Meme Meme of the Month order,
  filtered to entries covered by Lessons in Meme Culture in the past two months.
- Slang comes from Know Your Meme’s annual review, is verified with Urban
  Dictionary, and is ordered by lifetime Know Your Meme entry views.
- People come from the previous month’s English Wikipedia Topviews list. The
  updater keeps living non-politicians, assigns one broad primary category, and
  allows at most two people from each category while preserving view order.
- Movies are movie pages in the same previous-month Topviews list, ordered by
  page views. IMDb-linked ratings are context only.
- Books preserve the first ten entries on Goodreads’ U.S. most-read-books page
  for the latest month, ordered by the page’s monthly reader count. Each card
  also uses the linked Goodreads book page for its average star rating and plot
  premise, with Open Library or Wikipedia as a fallback when Goodreads blocks a
  detail page.
- Music selects the first 10 Spotify Today’s Top Hits tracks that also appear on
  the Billboard Hot 100, then orders that same set by Billboard position.
- Products start with Amazon Movers & Shakers across six retail categories and
  recent Google News coverage about viral products. Retail movement alone is
  not enough: a product needs explicit recent demand/social evidence and an
  Amazon match. Ranking combines social signal, Amazon velocity when present,
  freshness, independent confirmations, and scarcity/restock language.
- News uses U.S. Google Trending Now over seven days, excludes people and
  sports, and orders the remainder by Google’s displayed search volume.

Descriptions do not repeat the ranking metric shown on each card and have no
per-entry overrides. The updater derives identity or premise text from current
Wikidata, Wikipedia, IMDb/Cinemeta, Spotify, or Amazon metadata, then adds a factual
recent-news sentence when one is available. Google Trends related queries and
ranked Wikipedia search results disambiguate unfamiliar news topics. Question-
style, editorial, and personality-led headline fragments are rejected. News
entries use the selected publisher article’s direct URL, publication date,
opening paragraphs, and lead image metadata. Topic-matched Wikimedia imagery is
used only when the article does not expose a usable image; the final fallback is
a local title card.

Every entry has evidence from at least two distinct source hosts, with no more
than three linked evidence items or leaderboard source links.
`scripts/cache-images.mjs` validates the snapshot, refreshes News art daily,
downloads other art only when missing or invalid, and converts everything to
bounded local WebP files. Publisher hosts and redirects are checked before any
article image is fetched, and a last-known-good image survives upstream failure.

The YouTube Data API is used for Lessons in Meme Culture when
`YOUTUBE_API_KEY` is configured; otherwise the updater reads YouTube’s public
channel response. `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` enable the
official Spotify attempt, with Spotify’s official playlist embed as the
read-only fallback. `PRODUCT_MOVERS_SNAPSHOT` is an optional JSON recovery input
for Amazon Movers & Shakers when its public page rate-limits automation.

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
