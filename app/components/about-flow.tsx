const flow = [
  {
    number: "01",
    title: "Pull sources",
    text: "Fetch the public rankings, pages, charts, and articles used by the briefing.",
  },
  {
    number: "02",
    title: "Ingest every 48 hours",
    text: "One automated job runs at 12:00 PM Pacific on alternating days. Visitors never trigger scraping or source requests.",
  },
  {
    number: "03",
    title: "Build the snapshot",
    text: "Normalize the selected topics, order each board, and collect the supporting images and links.",
  },
  {
    number: "04",
    title: "Write and quiz",
    text: "Optional AI copy editing uses the selected source excerpts, then creates the fixed quiz pool from the finished descriptions.",
  },
  {
    number: "05",
    title: "Validate and publish",
    text: "Validate links, media, content, and security rules before publishing one cached snapshot at the edge.",
  },
];

type AboutFlowProps = {
  full?: boolean;
  id?: string;
};

export function AboutFlow({ full = false, id }: AboutFlowProps) {
  return (
    <>
      <section className="flow-section" id={id} aria-labelledby="flow-title">
        <div className="wrap">
          <div className="section-intro compact">
            <p className="eyebrow">About the briefing</p>
            <h2 id="flow-title">One 48-hour snapshot. Eight boards. One quiz.</h2>
            <p>what’s popular? turns public cultural signals into a finite briefing, then keeps the same snapshot available to every visitor until the next 48-hour refresh.</p>
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

      {full ? (
        <section className="infrastructure">
          <div className="wrap infrastructure-grid">
            <div>
              <p className="eyebrow">What happens on failure</p>
              <h2>The last good snapshot stays live.</h2>
            </div>
            <p>
              If a required source is down, rate-limited, or produces invalid
              data, the updater publishes nothing and visitors keep the previous
              pre-rendered page. If product discovery alone is unavailable, the
              last validated Products board is retained while the other boards
              may refresh. There is no runtime database query, personalized feed,
              or request-time scraper.
            </p>
          </div>
        </section>
      ) : null}
    </>
  );
}
