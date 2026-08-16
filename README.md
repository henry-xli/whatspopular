# what’s popular?

A finite daily briefing on the memes, slang, creators, movies,
and songs moving through internet culture. The public experience is static-first:
no account, feed, database read, or personalization is required.

## Run it

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run content:update -- --dry-run
npm run content:images
npm run lint
npm test
```

## Daily publishing loop

`scripts/update-trends.mjs` requires two-source evidence for every entry. It
keeps the latest completed Know Your Meme monthly poll in its published order,
then filters it to memes covered by any Lessons in Meme Culture upload from the
past two months. Card descriptions are derived from each meme's Know Your Meme
About section. Slang uses a 12-month set checked with Urban Dictionary and
Google Trends. Creators are ranked by 30-day English Wikipedia views across
digital creators, musicians, actors, and filmmakers, with no profession taking
more than two of the five places. Movies are the five largest
cumulative U.S./Canada grosses within IMDb's current weekend top ten, using Box
Office Mojo's underlying chart data. For songs, Spotify chooses the first five
Top 50 Global tracks that also appear on Billboard's Hot 100; Billboard position
then orders only those selected five. The updater atomically replaces
`data/trends.json` only after validation.

`scripts/cache-images.mjs` derives the current asset set from the validated
briefing, downloads images through strict host and size allowlists, crops them
into local WebP assets, and preserves a generated fallback if an upstream image
is unavailable. It also removes assets no longer referenced by the briefing.
This means visitor requests never proxy an image through a third party.

`.github/workflows/update-daily.yml` runs both jobs once per day, tests the exact
result, and commits only a successful changed briefing to `main`. A failed source
quorum leaves the last-known-good timestamp and page intact.

## Performance architecture

- HTML is pre-rendered and cached at the edge for one day with stale-while-revalidate.
- Culture imagery totals roughly 1 MB, is local, resized, and WebP-compressed.
- Next/Vite assets are content-hashed and cached immutably.
- One official Spotify embed is created only after a visitor presses play, then
  scrolled into view; copyrighted audio is never copied into the repository.
- The Buy Me a Coffee widget is deferred until parsing finishes and initializes before `DOMContentLoaded`.
- No runtime database or scraping occurs during a page request.

This removes origin/database fan-out from the hot path, which is the architecture
needed for large concurrent traffic on Cloudflare. Capacity should still be
confirmed with a load test against the final production account and domain.

## Security

Production responses add a restrictive Content Security Policy, HSTS, frame
denial, MIME sniffing protection, a strict referrer policy, a permissions policy,
and explicit cache rules. Scrapers use HTTPS-only allowlists, timeouts, response
size limits, and atomic writes. React escapes all fetched labels; scraped HTML is
never rendered directly.

## Deployment

The project is configured for Cloudflare’s vinext runtime and OpenAI Sites. Merge
to `main` after connecting the repository to the production project. Point the
`whatspopular.com` custom domain at that deployment in the owning Cloudflare
account. `.openai/hosting.json` records the Sites project after the first publish.
