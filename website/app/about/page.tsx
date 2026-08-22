import type { Metadata } from "next";
import { AboutFlow } from "../components/about-flow";

export const metadata: Metadata = {
  title: "About",
  description: "A concise overview of the daily source, validation, and publishing flow behind what’s popular?.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <main className="about-page" id="main-content" tabIndex={-1}>
      <section className="about-hero wrap">
        <p className="eyebrow">About the briefing</p>
        <h1>Sources in. Context out.</h1>
        <p>
          Every day, what’s popular? pulls public data, builds the eight
          leaderboards shown on Explore, prepares the fixed quiz pool, and
          publishes one validated snapshot. The site does not scrape or call
          an AI service when someone visits.
        </p>
      </section>
      <AboutFlow full />
    </main>
  );
}
