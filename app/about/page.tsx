import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About",
  description: "How what’s popular? turns public culture signals into one concise, cached daily briefing.",
  alternates: { canonical: "/about" },
};

const flow = [
  { number: "01", title: "Collect", text: "Read public trend signals once each day—never your personal data." },
  { number: "02", title: "Compare", text: "Require at least two independent public sources for every entry." },
  { number: "03", title: "Contextualize", text: "Add a human-readable explanation, source link, and safety note when needed." },
  { number: "04", title: "Cache", text: "Resize every visual and write one validated, versioned briefing file." },
  { number: "05", title: "Publish", text: "Serve static pages from the edge until tomorrow’s update is ready." },
];

export default function AboutPage() {
  return (
    <main className="about-page">
      <section className="about-hero wrap">
        <p className="eyebrow">About the briefing</p>
        <h1>Know enough to log off.</h1>
        <p>
          what’s popular? is a small antidote to FOMO: one finite page that
          explains what younger, extremely-online people are seeing—without
          asking you to become extremely online too.
        </p>
        <Link className="button button-primary" href="/">Read today’s briefing</Link>
      </section>

      <section className="flow-section" aria-labelledby="flow-title">
        <div className="wrap">
          <div className="section-intro compact">
            <p className="eyebrow">The daily loop</p>
            <h2 id="flow-title">From noisy signals to a quiet page.</h2>
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

      <section className="about-details wrap">
        <article>
          <p className="eyebrow">Signals, not surveillance</p>
          <h2>What goes in</h2>
          <p>
            Public pages from Google Trends, Know Your Meme, Urban Dictionary,
            Lessons in Meme Culture, Wikipedia, IMDb and Box Office Mojo,
            Billboard, and Spotify provide different pieces of the picture.
            Every entry needs corroboration, even when one transparent metric
            sets the order.
          </p>
          <p>
            Each card keeps links to at least two distinct sources. Rankings use
            direct measures—recent video views, Google interest, pageviews,
            cumulative box office, or chart position—rather than a made-up
            blended score. A last-known-good file stays live if a source is
            down.
          </p>
        </article>
        <article className="principle-card">
          <p className="eyebrow">The promise</p>
          <ul>
            <li><strong>Finite by design.</strong><span>Five boards. Five entries each. No endless scroll.</span></li>
            <li><strong>Links over lock-in.</strong><span>Every item opens a primary example or useful source.</span></li>
            <li><strong>Once daily.</strong><span>Enough freshness for context, without manufacturing urgency.</span></li>
            <li><strong>Private by default.</strong><span>No account, profile, personalized ranking, or behavioral ad stack.</span></li>
          </ul>
        </article>
      </section>

      <section className="infrastructure">
        <div className="wrap infrastructure-grid">
          <div>
            <p className="eyebrow">Built to stay tiny</p>
            <h2>Most visits never touch a database.</h2>
          </div>
          <p>
            The scraper does the expensive work once. Visitors receive
            pre-rendered HTML, compressed local images, and a small amount of
            JavaScript from an edge cache. Spotify only loads after you press
            play. That keeps the experience fast, inexpensive, and resilient
            during a traffic spike.
          </p>
        </div>
      </section>
    </main>
  );
}
