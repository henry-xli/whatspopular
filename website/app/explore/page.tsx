import type { Metadata } from "next";
import { ExploreIndex, ScrollToTop } from "../components/explore-index";
import { Leaderboard } from "../components/leaderboard";
import { SongBoard } from "../components/song-board";
import { cultureBrief } from "../culture";

export const metadata: Metadata = {
  title: "Explore",
  description: "Explore today’s people, movies, books, music, products, news, memes, and slang leaderboards.",
  alternates: { canonical: "/explore" },
};

export default function ExplorePage() {
  return (
    <main id="main-content" tabIndex={-1}>
      <section className="explore-hero wrap" aria-labelledby="explore-title">
        <p className="eyebrow">The {cultureBrief.edition} culture briefing</p>
        <h1 id="explore-title">Everything worth knowing at a glance.</h1>
        <p>{cultureBrief.summary}</p>
        <div className="explore-for-you-callout">
          <div>
            <span className="eyebrow">Want a narrower signal?</span>
            <strong>Build a For You page around the things you actually follow.</strong>
          </div>
          <a className="button button-accent button-small" href="/for-you">Choose your corners <span aria-hidden="true">✦</span></a>
        </div>
        <ExploreIndex sections={cultureBrief.sections} />
      </section>
      <section className="boards wrap" id="boards" aria-label="Culture leaderboards">
        {cultureBrief.sections.map((section) => section.id === "music"
          ? <SongBoard key={section.id} section={section} />
          : <Leaderboard key={section.id} section={section} />)}
      </section>
      <ScrollToTop />
    </main>
  );
}
