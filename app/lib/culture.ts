import rawBrief from "../../data/trends.json";

export type CultureLayout = "landscape" | "poster" | "square";

export type CultureItem = {
  rank: number;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  alt: string;
  url: string;
  source: string;
  metric?: {
    label: string;
    value: string;
  };
  evidence: Array<{
    source: string;
    url: string;
  }>;
  accent: string;
  rating?: string;
  spotifyId?: string;
  spotifyRank?: number;
  category?: string;
};

export type CultureSource = {
  label: string;
  url: string;
};

export type CultureSection = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  sources: CultureSource[];
  layout: CultureLayout;
  items: CultureItem[];
  moreItems?: CultureItem[];
  moreLabel?: string;
};

export type CultureBrief = {
  edition: string;
  status: string;
  window: string;
  generatedAt: string;
  summary: string;
  sections: CultureSection[];
};

const allowedLinkHosts = new Set([
  "en.wikipedia.org",
  "knowyourmeme.com",
  "open.spotify.com",
  "trends.google.com",
  "trending.knowyourmeme.com",
  "www.boxofficemojo.com",
  "www.imdb.com",
  "www.billboard.com",
  "www.urbandictionary.com",
  "www.youtube.com",
  "pageviews.wmcloud.org"
]);

function assertText(value: unknown, label: string, maximum = 800): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is missing, too long, or contains control characters`);
  }
}

function externalUrl(value: unknown, label: string) {
  assertText(value, label, 2000);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !allowedLinkHosts.has(url.hostname)) {
    throw new Error(`${label} contains an unapproved external URL: ${value}`);
  }
  return url;
}

function validateItem(value: unknown, label: string, rank: number, titles: Set<string>): asserts value is CultureItem {
  if (!value || typeof value !== "object") throw new Error(`${label} is not an object`);
  const item = value as Record<string, unknown>;
  assertText(item.title, `${label} title`, 160);
  assertText(item.subtitle, `${item.title} subtitle`, 180);
  assertText(item.description, `${item.title} description`, 1000);
  assertText(item.alt, `${item.title} image description`, 300);
  assertText(item.source, `${item.title} source`, 100);
  if (item.rank !== rank) throw new Error(`${label} must have rank ${rank}`);
  const titleKey = item.title.trim().toLocaleLowerCase("en-US");
  if (titles.has(titleKey)) throw new Error(`${item.title} is duplicated`);
  titles.add(titleKey);
  if (typeof item.image !== "string" || !/^\/culture\/[a-z0-9-]+\.webp$/.test(item.image)) {
    throw new Error(`${item.title} must use a safe local WebP image`);
  }
  if (typeof item.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(item.accent)) {
    throw new Error(`${item.title} has an invalid accent color`);
  }
  externalUrl(item.url, item.title);
  if (!Array.isArray(item.evidence) || item.evidence.length < 2 || item.evidence.length > 6) {
    throw new Error(`${item.title} must have two to six sources of evidence`);
  }
  const evidenceSources = new Set<string>();
  const evidenceHosts = new Set<string>();
  for (const value of item.evidence) {
    if (!value || typeof value !== "object") throw new Error(`${item.title} has invalid evidence`);
    const evidence = value as Record<string, unknown>;
    assertText(evidence.source, `${item.title} evidence label`, 120);
    evidenceSources.add(evidence.source.toLocaleLowerCase("en-US"));
    evidenceHosts.add(externalUrl(evidence.url, `${item.title} evidence`).hostname);
  }
  if (evidenceSources.size < 2 || evidenceHosts.size < 2) {
    throw new Error(`${item.title} evidence must come from distinct sources`);
  }
  if (item.metric !== undefined) {
    if (!item.metric || typeof item.metric !== "object") throw new Error(`${item.title} has an invalid metric`);
    const metric = item.metric as Record<string, unknown>;
    assertText(metric.label, `${item.title} metric label`, 100);
    assertText(metric.value, `${item.title} metric value`, 60);
  }
  if (item.rating !== undefined) assertText(item.rating, `${item.title} rating`, 20);
  if (item.category !== undefined) assertText(item.category, `${item.title} category`, 40);
  if (item.spotifyId !== undefined && (typeof item.spotifyId !== "string" || !/^[A-Za-z0-9]{22}$/.test(item.spotifyId))) {
    throw new Error(`${item.title} has an invalid Spotify track ID`);
  }
  if (item.spotifyRank !== undefined && (!Number.isInteger(item.spotifyRank) || Number(item.spotifyRank) < 1 || Number(item.spotifyRank) > 50)) {
    throw new Error(`${item.title} has an invalid Spotify rank`);
  }
}

function validateBrief(value: unknown): asserts value is CultureBrief {
  if (!value || typeof value !== "object") throw new Error("Culture brief is not an object");
  const candidate = value as Record<string, unknown>;
  for (const field of ["edition", "status", "window", "summary"] as const) {
    assertText(candidate[field], `Culture brief ${field}`, field === "summary" ? 1000 : 180);
  }
  if (typeof candidate.generatedAt !== "string" || !Number.isFinite(Date.parse(candidate.generatedAt))) {
    throw new Error("Culture brief has an invalid generatedAt date");
  }
  if (!Array.isArray(candidate.sections) || candidate.sections.length !== 5) {
    throw new Error("Culture brief must contain exactly five boards");
  }
  const expected = [
    ["memes", "landscape"],
    ["slang", "landscape"],
    ["creators", "square"],
    ["watch", "poster"],
    ["songs", "square"],
  ];
  candidate.sections.forEach((value, sectionIndex) => {
    if (!value || typeof value !== "object") throw new Error(`Board ${sectionIndex + 1} is invalid`);
    const section = value as Record<string, unknown>;
    const [expectedId, expectedLayout] = expected[sectionIndex];
    if (section.id !== expectedId || section.layout !== expectedLayout) {
      throw new Error(`Board ${sectionIndex + 1} must be ${expectedId} with ${expectedLayout} imagery`);
    }
    for (const field of ["eyebrow", "title", "description"] as const) {
      assertText(section[field], `${expectedId} ${field}`, field === "description" ? 1000 : 180);
    }
    if (!Array.isArray(section.sources) || section.sources.length < 2 || section.sources.length > 6) {
      throw new Error(`${section.title} must list two to six sources`);
    }
    for (const value of section.sources) {
      if (!value || typeof value !== "object") throw new Error(`${section.title} has an invalid source`);
      const source = value as Record<string, unknown>;
      assertText(source.label, `${section.title} source label`, 160);
      externalUrl(source.url, `${section.title} source`);
    }
    if (!Array.isArray(section.items) || section.items.length !== 5) {
      throw new Error(`${section.title} must contain exactly five items`);
    }
    if (!Array.isArray(section.moreItems) || section.moreItems.length < 1 || section.moreItems.length > 15) {
      throw new Error(`${section.title} must contain between one and fifteen continuation items`);
    }
    if (section.moreLabel !== undefined) assertText(section.moreLabel, `${section.title} continuation label`, 160);
    const titles = new Set<string>();
    section.items.forEach((item, index) => validateItem(item, `${section.title} item ${index + 1}`, index + 1, titles));
    section.moreItems.forEach((item, index) => validateItem(item, `${section.title} continuation ${index + 1}`, index + 6, titles));
  });

  const brief = value as CultureBrief;
  const items = (id: string) => {
    const section = brief.sections.find((entry) => entry.id === id)!;
    return [...section.items, ...(section.moreItems ?? [])];
  };

  const memes = items("memes");
  const memePollRanks = memes.map((item) => Number(item.metric?.value.slice(1)));
  if (memes.some((item) => !item.metric?.label.endsWith("Meme of the Month"))
    || memePollRanks.some((rank, index) => !Number.isInteger(rank)
      || (index > 0 && rank <= memePollRanks[index - 1]))) {
    throw new Error("Memes must preserve the published Meme of the Month order");
  }

  const slang = items("slang");
  const slangViews = slang.map((item) => Number(item.metric?.value.replaceAll(",", "")));
  if (slang.some((item) => item.metric?.label !== "Know Your Meme page views")
    || slangViews.some((views, index) => !Number.isFinite(views)
      || (index > 0 && views > slangViews[index - 1]))) {
    throw new Error("Slang must be ordered by Know Your Meme page views");
  }

  const creators = brief.sections.find((section) => section.id === "creators")!;
  const creatorCategories = new Map<string, number>();
  for (const item of creators.items) {
    const count = (creatorCategories.get(item.category ?? "") ?? 0) + 1;
    creatorCategories.set(item.category ?? "", count);
    if (!item.category || count > 2) throw new Error("No profession may take more than two creator places");
  }
  if (items("creators").some((item) => item.metric?.label !== "Wikipedia views · 30 days"
    || item.subtitle.includes("·"))) {
    throw new Error("Creators must use one primary role and 30-day Wikipedia views");
  }

  const movies = items("watch");
  if (movies.some((item) => !item.rating || item.metric?.label !== "U.S. & Canada total gross"
    || !/^\$\d+(?:\.\d{1,2})?[BMK]?$/.test(item.metric.value))) {
    throw new Error("Every movie must include an IMDb rating and abbreviated total gross");
  }

  const songs = items("songs");
  const billboardRanks = songs.map((item) => Number(item.metric?.value.slice(1)));
  if (songs.some((item) => !/^[A-Za-z0-9]{22}$/.test(item.spotifyId ?? "")
      || item.metric?.label !== "Billboard Hot 100")
    || billboardRanks.some((rank, index) => !Number.isInteger(rank) || (index > 0 && rank < billboardRanks[index - 1]))) {
    throw new Error("Every song must be playable and globally ordered by Billboard position");
  }
}

validateBrief(rawBrief);
export const cultureBrief: CultureBrief = rawBrief;

export function formatUpdatedAt(isoDate: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(new Date(isoDate));
}
