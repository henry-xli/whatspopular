import type { Metadata } from "next";
import { cultureBrief, type CultureItem } from "../culture";
import { MemeFypExperience, type MemeFypItem } from "../components/meme-fyp";
import { nicheBrief, type NicheCategory, type NicheTopic } from "../niche";

export const revalidate = 300;

export const metadata: Metadata = {
  title: "Meme FYP",
  description: "Swipe through distinct meme signals from the current culture snapshot.",
  alternates: { canonical: "/meme-fyp" },
};

function fromNiche(topic: NicheTopic, category: NicheCategory): MemeFypItem {
  return {
    id: topic.id,
    title: topic.title,
    description: topic.description,
    whyNow: topic.whyNow,
    url: topic.url,
    source: topic.source,
    sourceLabel: topic.sourceLabel,
    image: topic.image,
    imageAlt: topic.imageAlt,
    accent: topic.accent || category.accent,
    trendLabel: topic.trendLabel,
  };
}

function fromCulture(item: CultureItem): MemeFypItem {
  return {
    id: `culture-${item.rank}-${item.title.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-")}`,
    title: item.title,
    description: item.description,
    whyNow: item.description,
    url: item.url,
    source: item.source,
    sourceLabel: "Open the source",
    image: item.image,
    imageAlt: item.alt,
    accent: item.accent,
    trendLabel: item.metric?.label || "Current meme signal",
  };
}

export default function MemeFypPage() {
  const nicheCategory = nicheBrief.categories.find((category) => category.id === "memes");
  const cultureSection = cultureBrief.sections.find((section) => section.id === "memes");
  const items = nicheCategory?.topics.length
    ? nicheCategory.topics.map((topic) => fromNiche(topic, nicheCategory))
    : (cultureSection?.items ?? []).map(fromCulture);

  return (
    <MemeFypExperience
      items={items}
      generatedAt={nicheBrief.generatedAt}
      summary={nicheCategory?.description ?? cultureSection?.description ?? nicheBrief.summary}
    />
  );
}
