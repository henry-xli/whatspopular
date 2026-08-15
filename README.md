# what’s popular?

A finite daily briefing on the memes, formats, slang, creators, movies, shows,
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

`scripts/update-trends.mjs` reads public signals from Google Trends, TikTok
Creative Center (plus an editorial fallback when its page is opaque), Know Your
Meme, Urban Dictionary, Lessons in Meme Culture, Wikipedia pageviews, and IMDb.
It normalizes matches, updates scores and ratings, validates a minimum source
quorum, and atomically replaces `data/trends.json`. Existing entries are the
curated candidate set; the automation re-ranks those candidates rather than
publishing unexplained raw terms.

`scripts/cache-images.mjs` downloads social images through strict host and size
allowlists, crops them into local WebP assets, and preserves a generated fallback
if an upstream image is unavailable. This means visitor requests never proxy an
image through a third party.

`.github/workflows/update-daily.yml` runs both jobs once per day, tests the exact
result, and commits only a successful changed briefing to `main`. A failed source
quorum leaves the last-known-good timestamp and page intact.

## Performance architecture

- HTML is pre-rendered and cached at the edge for one day with stale-while-revalidate.
- Culture imagery totals roughly 1 MB, is local, resized, and WebP-compressed.
- Next/Vite assets are content-hashed and cached immutably.
- Spotify embeds are created only after a visitor presses play.
- The Buy Me a Coffee widget loads after the page becomes idle.
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
