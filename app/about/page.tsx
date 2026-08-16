import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About",
  description: "The exact sources, ranking rules, and daily publishing flow behind what’s popular?.",
  alternates: { canonical: "/about" },
};

const flow = [
  {
    number: "01",
    title: "Pull sources",
    text: "Fetch public pages from Know Your Meme, Lessons in Meme Culture, Urban Dictionary, Google Trends, Wikipedia, IMDb, Box Office Mojo, Spotify, and Billboard.",
  },
  {
    number: "02",
    title: "Run once daily",
    text: "At 10:17 UTC, one automated job downloads the source data. A visitor never triggers scraping.",
  },
  {
    number: "03",
    title: "Apply five rules",
    text: "Each board uses its own explicit filter and ranking rule, listed below. There is no blended mystery score.",
  },
  {
    number: "04",
    title: "Validate and cache",
    text: "Require two source hosts per entry, validate every link, write one JSON snapshot, and download images as local WebP files.",
  },
  {
    number: "05",
    title: "Publish the snapshot",
    text: "Build static HTML and serve it from the edge until the next validated daily snapshot replaces it.",
  },
];

const methods = [
  {
    board: "Memes",
    sources: "Know Your Meme’s latest completed Meme of the Month result + Lessons in Meme Culture uploads from the past two months.",
    rule: "Keep the poll’s published order, but remove any meme without a matching recent LIMC video.",
    metric: "Meme of the Month poll place.",
  },
  {
    board: "Slang",
    sources: "Know Your Meme’s annual slang review + Urban Dictionary + a 12-month U.S. Google Trends comparison.",
    rule: "Use the annual list as the candidate set and order the five by the latest successful Google Trends comparison. If Trends is unavailable, keep the last validated order.",
    metric: "Lifetime views on each Know Your Meme entry.",
  },
  {
    board: "Creators",
    sources: "A maintained cross-media candidate list + 30 days of English Wikipedia pageviews + a linked Google Trends comparison.",
    rule: "Order candidates by Wikipedia views, then allow no more than two people with the same primary profession in the top five.",
    metric: "English Wikipedia views over the past 30 days.",
  },
  {
    board: "Movies",
    sources: "IMDb’s current domestic weekend top 10 + the matching Box Office Mojo weekend table.",
    rule: "Take those 10 movies, re-sort them by cumulative U.S. and Canada gross, and publish the first five.",
    metric: "Cumulative U.S. and Canada box office.",
  },
  {
    board: "Songs",
    sources: "Spotify’s Global Top 50 playlist + the dated Billboard Hot 100.",
    rule: "Select the first five Spotify-ranked tracks that also appear on Billboard, then order only those five by Billboard position.",
    metric: "Billboard Hot 100 position.",
  },
];

export default function AboutPage() {
  return (
    <main className="about-page">
      <section className="about-hero wrap">
        <p className="eyebrow">How the site works</p>
        <h1>Sources in. Rankings out.</h1>
        <p>
          Once a day, what’s popular? pulls public data from the sites named
          below, runs five documented ranking rules, saves one validated
          snapshot, and publishes that snapshot as a static page. That is the
          whole system.
        </p>
        <Link className="button button-primary" href="/">Read today’s briefing</Link>
      </section>

      <section className="flow-section" aria-labelledby="flow-title">
        <div className="wrap">
          <div className="section-intro compact">
            <p className="eyebrow">Overall flow</p>
            <h2 id="flow-title">One ingestion run. Five rankings. One page.</h2>
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
          <p className="eyebrow">The five algorithms</p>
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
            If a source is down, rate-limited, or produces invalid data, the
            updater does not publish a partial replacement. Visitors continue
            receiving the previous pre-rendered page. There is no runtime
            database query, personalized feed, or request-time scraper.
          </p>
        </div>
      </section>
    </main>
  );
}
