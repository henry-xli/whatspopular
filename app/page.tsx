import { AboutFlow } from "./components/about-flow";
import { HeroVisuals, type HeroSlide, type HeroSpotlight } from "./components/hero-visuals";
import { Quiz } from "./components/quiz";
import { cultureBrief, formatUpdatedAt, type CultureItem, type CultureSection } from "./culture";

function metricSignal(value: string) {
  const clean = value.replaceAll(",", "").trim().toUpperCase();
  const rank = clean.match(/^#(\d+)$/);
  if (rank) return 100_000 / Number(rank[1]);
  const amount = clean.match(/^(\d+(?:\.\d+)?)([KMB])?\+?$/);
  if (!amount) return 0;
  return Number(amount[1]) * ({ K: 1_000, M: 1_000_000, B: 1_000_000_000 }[amount[2] as "K" | "M" | "B"] ?? 1);
}

function spotlightFor(sections: CultureSection[]) {
  return sections
    .map((section): (HeroSpotlight & { score: number }) | null => {
      const ranked = section.items.filter((item) => item.metric);
      const top = ranked[0];
      if (!top?.metric) return null;
      const topSignal = metricSignal(top.metric.value);
      const comparison = ranked.slice(1).map((item) => metricSignal(item.metric?.value ?? ""))
        .filter((signal) => signal > 0)
        .sort((left, right) => left - right);
      const baseline = comparison[Math.floor(comparison.length / 2)] ?? topSignal;
      const standout = topSignal > 0 ? topSignal / Math.max(1, baseline) : 0;
      return {
        score: Math.log10(topSignal + 1) + Math.log2(Math.max(1, standout)),
        sectionTitle: section.title,
        title: top.title,
        description: top.description,
        image: top.image,
        alt: top.alt,
        url: top.url,
        metric: top.metric,
      } satisfies HeroSpotlight & { score: number };
    })
    .filter((candidate): candidate is HeroSpotlight & { score: number } => Boolean(candidate))
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

const heroSlides: HeroSlide[] = cultureBrief.sections.flatMap((section) => section.items.slice(0, 2).map((item: CultureItem) => ({
  id: `${section.id}-${item.rank}`,
  image: item.image,
  alt: item.alt,
})));
const heroSpotlight = spotlightFor(cultureBrief.sections);

export default function Home() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="hero wrap" aria-labelledby="hero-title">
        <HeroVisuals slides={heroSlides} spotlight={heroSpotlight} />
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
