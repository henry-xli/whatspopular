# what’s popular?

A finite 48-hour briefing, quiz, and niche-interest digest on internet culture.
Visitors receive pre-rendered HTML, local images, and a cached mobile snapshot
at `/api/brief`; the For You page assembles pre-generated cards locally after
the user chooses interest tags.

Explore displays boards in this order: People, Movies, Books, Music, Products,
News, Memes, and Slang.

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

At 12:00 PM Pacific every 48 hours, `scripts/update-trends.mjs` verifies its
required sources and writes `data/trends.json` atomically. A bad run cannot
replace the last validated snapshot.

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
  recent web coverage with explicit buying, collecting, restock, launch, or
  sold-out demand language. Retail movement alone never qualifies a product:
  the candidate must have current demand evidence and either positive retail
  movement or two independent confirming publisher sources. Evidence is
  resolved to direct publisher articles; comparison/roundup snippets that are
  really about another product, editorial headings, retailer names, and
  duplicate product families are discarded. Amazon is matched first, but only
  a verified product-detail listing is used as the destination. If no relevant
  listing can be verified, the card links directly to the validated publisher
  article instead of an unfiltered Amazon search page. Names are normalized across
  model-number formatting and aliases before scoring by demand, retail
  velocity, freshness, confirmations, and scarcity. Product copy identifies
  the product type and summarizes the recent demand context; a product page’s
  structured-data/gallery image is preferred over a brand logo, with the
  article image used only when it is the relevant product image.
- News reads the complete structured U.S. Google Trending Now feed over seven
  days (not only the visible table rows), excludes people and sports, resolves
  current article context, and orders the remainder by Google’s displayed
  search volume.

Descriptions do not repeat the ranking metric shown on each card and have no
per-entry overrides. The updater first derives identity or premise context from
current Wikidata, Wikipedia, IMDb/Cinemeta, Goodreads, Open Library, Spotify, or
Amazon metadata and the selected publisher excerpts. When `OPENAI_API_KEY` is
configured, five bounded Responses API batches rewrite the People, Movies,
Books, Products, and News descriptions and create quiz prompts once during
ingestion: films and books receive plot premises, while people, products, and
news receive a concise reason for their recent relevance. The quiz stores 15
questions (three each from Memes, People, Movies, Books, and News), four choices
per question, and 15 seconds per question in the same snapshot. Quiz prompts
receive only a preselected current-relevance excerpt for memes, people, and
news, or a plot-premise excerpt for movies and books. Music and Products are
excluded because their short descriptions do not provide enough context for a
useful question. Source snippets are treated as
untrusted data, structured output is validated, and each failed or missing
result keeps its deterministic fallback. The key is never shipped to the
browser. Google Trends
related queries and ranked Wikipedia search results disambiguate unfamiliar
news topics. Question-style, editorial, and personality-led headline fragments
are rejected. News entries use the selected publisher article’s direct URL,
publication date, opening paragraphs, and lead image metadata. Topic-matched
Wikimedia imagery is used only when the article does not expose a usable image;
the final fallback is a local title card.

The AI copy pass is optional and has no effect on ranking or visitor
traffic. To enable it, add an `OPENAI_API_KEY` repository secret under GitHub
Settings → Secrets and variables → Actions. The workflow uses the cost-sensitive
`gpt-5.6-luna` model by default; an optional `OPENAI_DESCRIPTION_MODEL`
repository variable can select another available text model. If the secret is
absent or the API is unavailable, ingestion remains fully functional with the
deterministic copy and quiz prompts. `npm run content:quiz` regenerates the
quiz pool from the descriptions already in the snapshot without fetching any
external source.

The AI copy pass receives one already-curated, entity-matched context per card;
it never receives publisher labels, raw headline lists, or unrelated search
alternates. Complete-sentence, attribution, clickbait, and section-specific
quality checks reject noisy output and keep the deterministic fallback when a
response is incomplete or unsupported. Article intros are retained only at
sentence boundaries, so an upstream page cannot leave a clipped sentence in
the snapshot.

Every entry has evidence from at least two distinct source hosts (or one
recent viral source plus independently recorded Amazon velocity), with no more
than three linked evidence items or leaderboard source links.
`scripts/cache-images.mjs` validates the snapshot, refreshes News and Products
art at each ingestion, downloads other art only when missing or invalid, and converts
everything to bounded local WebP files. Product pages and selected publisher
metadata are DNS-validated before an image is fetched, and a last-known-good
image survives upstream failure.

The YouTube Data API is used for Lessons in Meme Culture when
`YOUTUBE_API_KEY` is configured; otherwise the updater reads YouTube’s public
channel response. `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` enable the
official Spotify attempt, with Spotify’s official playlist embed as the
read-only fallback. `PRODUCT_MOVERS_SNAPSHOT` is an optional JSON recovery input
for Amazon Movers & Shakers when its public page rate-limits automation;
`PRODUCT_TRENDS_SNAPSHOT` remains accepted as a backwards-compatible alias.

## Architecture and maintenance

- `app/` contains pages, components, styles, and runtime data validation; the
  shared culture model lives in `app/culture.ts`. `/` is the quiz-first home
  page, `/explore` contains the leaderboards, `/for-you` contains the niche tag
  builder and local digest compiler, and `/about` contains the flow explanation.
  Signed-in tag preferences are stored in D1 under the hosted user identity.
- `data/trends.json` and `data/niche-trends.json` are the preprocessed culture
  and niche snapshots.
- `scripts/niche-catalog.mjs` defines the expanded interest taxonomy: 42 lanes
  across music, sports, news, lifestyle, and culture. `content:niche-catalog`
  materializes its deterministic fallback cards into the weekly snapshot.
- `scripts/` contains the 48-hour ingestion, niche source adapters, AI copy
  pass, and image pipeline. The helpers are kept as separate files because
  they are independent network/security boundaries; combining them would make
  source changes harder to review and increase the blast radius of a failure.
- `worker.ts` applies edge caching and production security headers.
- `tests/` checks rendered content, headers, links, media, and data invariants.
- `.github/workflows/update-daily.yml` refreshes, verifies, and commits every 48 hours.

Content-hashed application assets cache immutably; successful HTML navigations
use a deployment-versioned edge cache, and local media uses
stale-while-revalidate. Error responses, React server requests, and unsafe HTTP
methods are never cached. Spotify audio loads only after a play action, and the
Buy Me a Coffee widget is deferred until the document has been parsed.

The project targets the Cloudflare-compatible vinext runtime and managed Sites
hosting. The deployment project pointer is kept in the neutral root-level
`hosting.json`; the build copies it into `dist/.openai/hosting.json` only in the
deployment artifact because the Sites packaging format requires that location.
The source repository therefore contains no provider metadata directory. The
custom `whatspopular.com` domain must be configured in the owning Cloudflare
account.

## Account authentication

The profile avatar in the shared header is the account entry point; there is no
separate Account navigation tab. First-party accounts use the same D1-backed
identity for the website and iOS app. Passwords are PBKDF2-HMAC-SHA-256 hashes
with per-account salts, verification codes are salted, short-lived, limited to
five attempts, and sessions store only token hashes. The web uses an HttpOnly
`__Host-wp_session` cookie; the app uses a Keychain-held access/refresh pair
with refresh-token rotation.

Email signup stays disabled until an email provider is configured. Set the
managed Site secrets `AUTH_EMAIL_API_KEY`, `AUTH_EMAIL_FROM`, and optionally
`AUTH_EMAIL_API_URL` (the default API shape is Resend’s `/emails` endpoint).
Google sign-in requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; set
`GOOGLE_REDIRECT_URI` to the exact production URL
`https://whatspopular.pigeonflare.chatgpt.site/api/auth/google/callback` and
register that same URI in Google Cloud. The native app uses the same OAuth
callback and exchanges a one-time code through its `whatspopular://` callback,
so it never receives a browser session cookie or an OAuth access token.
