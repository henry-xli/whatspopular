import Link from "next/link";
import Image from "next/image";
import { cultureBrief, formatUpdatedAt } from "./lib/culture";
import { Leaderboard } from "./components/leaderboard";
import { SongBoard } from "./components/song-board";

export default function Home() {
  const regularBoards = cultureBrief.sections.filter(
    (section) => section.id !== "songs",
  );
  const songBoard = cultureBrief.sections.find(
    (section) => section.id === "songs",
  );

  return (
    <main>
      <section className="hero wrap" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">The {cultureBrief.edition} culture briefing</p>
          <h1 id="hero-title">
            Internet culture,
            <span>minus the infinite scroll.</span>
          </h1>
          <p className="hero-deck">{cultureBrief.summary}</p>
          <div className="hero-actions">
            <Link className="button button-primary" href="#boards">
              Catch me up <span aria-hidden="true">↓</span>
            </Link>
            <Link className="button button-quiet" href="/about">
              How this works
            </Link>
          </div>
          <div className="freshness" aria-label="Brief freshness">
            <span className="live-dot" aria-hidden="true" />
            <span>{cultureBrief.status}</span>
            <span aria-hidden="true">•</span>
            <time dateTime={cultureBrief.generatedAt}>
              Updated {formatUpdatedAt(cultureBrief.generatedAt)}
            </time>
          </div>
        </div>

        <a
          className="spotlight"
          href={cultureBrief.spotlight.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${cultureBrief.spotlight.title}: open ${cultureBrief.spotlight.source}`}
        >
          <div className="spotlight-art">
            <Image
              src={cultureBrief.spotlight.image}
              alt={cultureBrief.spotlight.alt}
              fill
              priority
              sizes="(max-width: 850px) 100vw, 42vw"
            />
            <span className="source-chip">{cultureBrief.spotlight.source}</span>
          </div>
          <div className="spotlight-copy">
            <p className="eyebrow">{cultureBrief.spotlight.eyebrow}</p>
            <h2>{cultureBrief.spotlight.title}</h2>
            <p>{cultureBrief.spotlight.description}</p>
            <div className="spotlight-stat">
              <strong>{cultureBrief.spotlight.stat}</strong>
              <span>{cultureBrief.spotlight.statLabel}</span>
              <span className="open-mark" aria-hidden="true">↗</span>
            </div>
          </div>
        </a>
      </section>

      <section className="pulse-wrap" aria-labelledby="pulse-title">
        <div className="wrap pulse">
          <div className="pulse-title">
            <span className="pulse-bolt" aria-hidden="true">ϟ</span>
            <span id="pulse-title">Right now</span>
          </div>
          <div className="pulse-items">
            {cultureBrief.pulse.map((item) => (
              <a
                key={item.label}
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pulse-item"
              >
                <span className="pulse-avatar">
                  <Image src={item.image} alt="" fill sizes="40px" />
                </span>
                <span>
                  <small>{item.label}</small>
                  <strong>{item.value}</strong>
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="boards wrap" id="boards" aria-labelledby="boards-title">
        <div className="section-intro">
          <p className="eyebrow">Five is plenty</p>
          <h2 id="boards-title">The whole internet. Six short lists.</h2>
          <p>
            Ranked from public momentum signals, then edited for context. Tap any
            card to see the thing itself—not another engagement trap.
          </p>
        </div>

        {regularBoards.map((section) => (
          <Leaderboard key={section.id} section={section} />
        ))}
        {songBoard ? <SongBoard section={songBoard} /> : null}
      </section>

      <section className="method-tease">
        <div className="wrap method-tease-grid">
          <div>
            <p className="eyebrow">Less feed. More signal.</p>
            <h2>One deliberate update a day.</h2>
          </div>
          <p>
            We collect public trend signals, compare momentum across sources,
            cache every visual, and publish one static briefing to the edge. No
            accounts, no tracking pixels, no personalized rabbit holes.
          </p>
          <Link className="button button-outline" href="/about">
            See the recipe <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
