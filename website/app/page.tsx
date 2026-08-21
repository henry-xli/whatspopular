import { AboutFlow } from "./components/about-flow";
import { HeroVisuals, type HeroSlide, type HeroSpotlight } from "./components/hero-visuals";
import { Quiz } from "./components/quiz";
import { cultureBrief, formatUpdatedAt, type CultureItem } from "./culture";

function spotlightsFor(sections: typeof cultureBrief.sections): HeroSpotlight[] {
  return sections.flatMap((section) => {
    const top = section.items[0];
    if (!top) return [];
    return [{
      sectionTitle: section.title,
      title: top.title,
      description: top.description,
      image: top.image,
      alt: top.alt,
      url: top.url,
      metric: top.metric,
    } satisfies HeroSpotlight];
  });
}

const heroSlides: HeroSlide[] = cultureBrief.sections.flatMap((section) => section.items.slice(0, 2).map((item: CultureItem) => ({
  id: `${section.id}-${item.rank}`,
  image: item.image,
  alt: item.alt,
})));
const heroSpotlights = spotlightsFor(cultureBrief.sections);

export default function Home() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="hero wrap" aria-labelledby="hero-title">
        <HeroVisuals slides={heroSlides} spotlights={heroSpotlights} />
        <div className="hero-copy">
          <p className="eyebrow">The {cultureBrief.edition} culture briefing</p>
          <h1 id="hero-title">How trendy are you?</h1>
          <div className="hero-actions">
            <Quiz questions={cultureBrief.quiz.questions} durationSeconds={cultureBrief.quiz.durationSeconds} />
            <a className="button button-quiet" href="/explore">
              Explore <span aria-hidden="true">→</span>
            </a>
            <a className="button button-accent" href="/for-you">
              Build your feed <span aria-hidden="true">✦</span>
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
