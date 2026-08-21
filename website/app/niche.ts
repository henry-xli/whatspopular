import rawNicheBrief from "../data/niche-trends.json";

export type NicheTopic = {
  id: string;
  title: string;
  description: string;
  whyNow: string;
  url: string;
  source: string;
  sourceLabel: string;
  image: string;
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

export const nicheBrief = rawNicheBrief as NicheBrief;

export const nicheCategories = nicheBrief.categories;

export function topicCountFor(categories: readonly NicheCategory[]) {
  return categories.reduce((count, category) => count + category.topics.length, 0);
}

export function categoryById(categoryId: string) {
  return nicheCategories.find((category) => category.id === categoryId);
}
