import { AboutFlow } from "./components/about-flow";
import { Quiz } from "./components/quiz";
import { cultureBrief, formatUpdatedAt } from "./culture";

export default function Home() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="hero wrap" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">The {cultureBrief.edition} culture briefing</p>
          <h1 id="hero-title">How trendy are you?</h1>
          <div className="hero-actions">
            <Quiz questions={cultureBrief.quiz.questions} durationSeconds={cultureBrief.quiz.durationSeconds} />
            <a className="button button-quiet" href="/explore">
              Explore <span aria-hidden="true">→</span>
            </a>
          </div>
          <p className="hero-deck">{cultureBrief.summary}</p>
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

      <AboutFlow id="about" />
    </main>
  );
}
