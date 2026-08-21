import rawNicheBrief from "../data/niche-trends.json";

export type NichePlayback = {
  provider: "Apple Music" | "SoundCloud" | "Spotify" | "YouTube";
  externalUrl: string;
  embedUrl: string;
  label: string;
};

export type NichePopularityEvidence = {
  mode: "independent-coverage" | "measurable-signal" | "concrete-trend-signal";
  coverageCount: number;
  coverageSources: string[];
  signal: string;
};

export type NicheTopic = {
  id: string;
  title: string;
  description: string;
  whyNow: string;
  url: string;
  source: string;
  sourceLabel: string;
  image: string;
  imageSource?: string;
  imageSourcePageUrl?: string;
  imageAlt?: string;
  playback?: NichePlayback;
  coverageCount: number;
  coverageSources: string[];
  popularityEvidence: NichePopularityEvidence;
  publishedAt?: string;
  accent: string;
  trendLabel: string;
};

export type NicheCategory = {
  id: string;
  label: string;
  parent: string;
  description: string;
  accent: string;
  topics: NicheTopic[];
};

export type NicheBrief = {
  generatedAt: string;
  edition: string;
  window: string;
  summary: string;
  categories: NicheCategory[];
};

export const nicheBrief = rawNicheBrief as unknown as NicheBrief;

export const nicheCategories = nicheBrief.categories;

export function topicCountFor(categories: readonly NicheCategory[]) {
  return categories.reduce((count, category) => count + category.topics.length, 0);
}

export function categoryById(categoryId: string) {
  return nicheCategories.find((category) => category.id === categoryId);
}
