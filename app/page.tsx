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
    <main id="main-content" tabIndex={-1}>
      <section className="hero wrap" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">The {cultureBrief.edition} culture briefing</p>
          <h1 id="hero-title">
            Internet culture,
            <span>minus the infinite scroll.</span>
          </h1>
          <p className="hero-deck">{cultureBrief.summary}</p>
          <div className="hero-actions">
            <a className="button button-primary" href="#boards">
              Catch me up <span aria-hidden="true">↓</span>
            </a>
            <a className="button button-quiet" href="/about">
              How this works
            </a>
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

      </section>

      <section className="boards wrap" id="boards" aria-label="Culture leaderboards">
        {regularBoards.map((section) => (
          <Leaderboard key={section.id} section={section} />
        ))}
        {songBoard ? <SongBoard section={songBoard} /> : null}
      </section>
    </main>
  );
}
