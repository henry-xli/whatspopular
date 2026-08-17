import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description: "The exact sources, ranking rules, and daily publishing flow behind what’s popular?.",
  alternates: { canonical: "/about" },
};

const flow = [
  {
    number: "01",
    title: "Pull sources",
    text: "Fetch the latest public rankings from Know Your Meme, YouTube, Wikimedia, Spotify, Billboard, Google Trends, Google News, and Amazon.",
  },
  {
    number: "02",
    title: "Ingest at midnight Pacific",
    text: "One automated job runs at 12:00 AM Pacific every day. Visitors never trigger source requests or scraping.",
  },
  {
    number: "03",
    title: "Apply seven rules",
    text: "Each board is filtered and ordered by its own rule below. The displayed source metric determines the order; there is no blended score.",
  },
  {
    number: "04",
    title: "Validate and cache",
    text: "Require two source hosts per entry, validate every link, write one JSON snapshot, and download images as local WebP files.",
  },
  {
    number: "05",
    title: "Publish the snapshot",
    text: "Build static HTML and serve it from the edge until the next validated daily snapshot is ready.",
  },
];

const methods = [
  {
    board: "Memes",
    sources: "Know Your Meme’s latest completed Meme of the Month result and Lessons in Meme Culture uploads from the previous two months. YouTube’s official Data API is used when a key is configured.",
    rule: "Keep the poll’s published order and remove any meme without a matching LIMC upload. The site never substitutes the current month’s unfinished poll.",
    metric: "Meme of the Month poll place.",
  },
  {
    board: "Slang",
    sources: "Know Your Meme’s annual slang review + the lifetime view count on each Know Your Meme entry + Urban Dictionary.",
    rule: "Use every term in the annual review, verify that it has a matching Urban Dictionary usage, then order the complete list from most to least Know Your Meme entry views.",
    metric: "Lifetime views on each Know Your Meme entry.",
  },
  {
    board: "People",
    sources: "Wikimedia’s previous-month English Wikipedia Topviews data and Wikidata identity metadata.",
    rule: "Walk down Topviews, keep living people, remove politicians, assign one broad primary category, and allow at most two people from any category. Keep the remaining view order.",
    metric: "Previous-month English Wikipedia views.",
  },
  {
    board: "Movies",
    sources: "Wikimedia’s previous-month English Wikipedia Topviews data, Wikidata for movie classification, and IMDb-linked metadata for rating context.",
    rule: "Keep only movie pages from Topviews and preserve their page-view order. Ratings are displayed but do not affect rank.",
    metric: "Previous-month English Wikipedia views.",
  },
  {
    board: "Music",
    sources: "Spotify’s Today’s Top Hits playlist and the dated Billboard Hot 100.",
    rule: "Select the first 10 playlist tracks that also appear on the Hot 100, then order that same 10-track set by Billboard position. Every result remains playable with Spotify’s official embed.",
    metric: "Billboard Hot 100 position.",
  },
  {
    board: "Products",
    sources: "Google Shopping’s U.S. Rising queries for the past seven days and Amazon search results.",
    rule: "Preserve Google’s Rising order after removing people, media, brand-only terms, duplicates, and queries without a relevant Amazon product listing. Link the selected Amazon listing directly.",
    metric: "Google Shopping Rising-query rank and growth.",
  },
  {
    board: "News",
    sources: "Google Trending Now’s U.S. seven-day view and Google News coverage.",
    rule: "Remove people and sports, sort the remaining topics by Google’s displayed search volume, and link each topic to current coverage.",
    metric: "Seven-day Google search volume.",
  },
];

export default function AboutPage() {
  return (
    <main className="about-page" id="main-content" tabIndex={-1}>
      <section className="about-hero wrap">
        <p className="eyebrow">How the site works</p>
        <h1>Sources in. Rankings out.</h1>
        <p>
          Once a day, what’s popular? pulls public data from the sites named
          below, runs seven documented ranking rules, saves one validated
          snapshot, and publishes that snapshot as a static page. That is the
          whole system.
        </p>
        <a className="button button-primary" href="/">Read today’s briefing</a>
      </section>

      <section className="flow-section" aria-labelledby="flow-title">
        <div className="wrap">
          <div className="section-intro compact">
            <p className="eyebrow">Overall flow</p>
            <h2 id="flow-title">One daily ingestion. Seven rankings. One page.</h2>
          </div>
          <ol className="flowchart">
            {flow.map((step, index) => (
              <li key={step.number}>
                <article>
                  <span>{step.number}</span>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
                {index < flow.length - 1 ? <span className="flow-arrow" aria-hidden="true">→</span> : null}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="algorithm-section wrap" aria-labelledby="algorithm-title">
        <div className="section-intro compact">
          <p className="eyebrow">The seven algorithms</p>
          <h2 id="algorithm-title">Exactly how each list is made.</h2>
        </div>
        <div className="algorithm-grid">
          {methods.map((method, index) => (
            <article key={method.board}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{method.board}</h3>
              <dl>
                <div><dt>Sources</dt><dd>{method.sources}</dd></div>
                <div><dt>Rule</dt><dd>{method.rule}</dd></div>
                <div><dt>Shown metric</dt><dd>{method.metric}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="infrastructure">
        <div className="wrap infrastructure-grid">
          <div>
            <p className="eyebrow">What happens on failure</p>
            <h2>The last good snapshot stays live.</h2>
          </div>
          <p>
            If a required source is down, rate-limited, or produces invalid
            data, the updater publishes nothing and visitors keep the previous
            pre-rendered page. If Google Shopping alone is unavailable, its
            last validated Products board is retained while the other boards
            may refresh. There is no runtime database query, personalized feed,
            or request-time scraper.
          </p>
        </div>
      </section>
    </main>
  );
}
