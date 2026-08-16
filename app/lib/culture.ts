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

export type CultureMoreItem = {
  rank: number;
  title: string;
  subtitle: string;
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
  spotifyRank?: number;
  category?: string;
};

export type CultureSection = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  sources: CultureSource[];
  layout: CultureLayout;
  items: CultureItem[];
  moreItems?: CultureMoreItem[];
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

function assertExternalUrl(value: string, label: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !allowedLinkHosts.has(url.hostname)) {
    throw new Error(label + " contains an unapproved external URL: " + value);
  }
}

function validateBrief(value: CultureBrief) {
  if (!Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("Culture brief has an invalid generatedAt date");
  }
  if (value.sections.length !== 5) {
    throw new Error("Culture brief must contain exactly five boards");
  }
  const sectionIds = new Set<string>();
  for (const section of value.sections) {
    if (sectionIds.has(section.id)) {
      throw new Error("Culture board IDs must be unique");
    }
    sectionIds.add(section.id);
    if (section.items.length !== 5) {
      throw new Error(section.title + " must contain exactly five items");
    }
    if (section.sources.length < 2) {
      throw new Error(section.title + " must list at least two sources");
    }
    for (const source of section.sources) {
      if (!source.label.trim()) {
        throw new Error(section.title + " has an unlabeled source");
      }
      assertExternalUrl(source.url, section.title + " source");
    }

    section.items.forEach((item, index) => {
      if (item.rank !== index + 1) {
        throw new Error(section.title + " ranks must be sequential");
      }
      if (!/^#[0-9a-f]{6}$/i.test(item.accent)) {
        throw new Error(item.title + " has an invalid accent color");
      }
      if (!item.image.startsWith("/culture/")) {
        throw new Error(item.title + " must use a local cached image");
      }
      assertExternalUrl(item.url, item.title);
      if (item.evidence.length < 2) {
        throw new Error(item.title + " must have at least two sources of evidence");
      }
      const evidenceSources = new Set<string>();
      const evidenceHosts = new Set<string>();
      for (const evidence of item.evidence) {
        assertExternalUrl(evidence.url, item.title + " evidence");
        evidenceSources.add(evidence.source);
        evidenceHosts.add(new URL(evidence.url).hostname);
      }
      if (evidenceSources.size < 2 || evidenceHosts.size < 2) {
        throw new Error(item.title + " evidence must come from distinct sources");
      }
      if (item.spotifyId && !/^[A-Za-z0-9]{22}$/.test(item.spotifyId)) {
        throw new Error(item.title + " has an invalid Spotify track ID");
      }
      if (item.spotifyRank !== undefined && (!Number.isInteger(item.spotifyRank) || item.spotifyRank < 1 || item.spotifyRank > 50)) {
        throw new Error(item.title + " has an invalid Spotify rank");
      }
    });

    if (!section.moreItems?.length) {
      throw new Error(section.title + " must include an expandable continuation");
    }
    const topTitles = new Set(section.items.map((item) => item.title));
    section.moreItems.forEach((item, index) => {
      if (item.rank !== index + 6) {
        throw new Error(section.title + " continuation ranks must begin at six and be sequential");
      }
      if (topTitles.has(item.title)) {
        throw new Error(section.title + " repeats a top-five item in its continuation");
      }
      assertExternalUrl(item.url, item.title);
      if (item.evidence.length < 2) {
        throw new Error(item.title + " continuation must have at least two sources of evidence");
      }
      const evidenceSources = new Set(item.evidence.map((entry) => entry.source));
      const evidenceHosts = new Set(item.evidence.map((entry) => {
        assertExternalUrl(entry.url, item.title + " continuation evidence");
        return new URL(entry.url).hostname;
      }));
      if (evidenceSources.size < 2 || evidenceHosts.size < 2) {
        throw new Error(item.title + " continuation evidence must come from distinct sources");
      }
      if (item.spotifyRank !== undefined && (!Number.isInteger(item.spotifyRank) || item.spotifyRank < 1 || item.spotifyRank > 50)) {
        throw new Error(item.title + " continuation has an invalid Spotify rank");
      }
    });
  }
}

export const cultureBrief = rawBrief as CultureBrief;
validateBrief(cultureBrief);

export function formatUpdatedAt(isoDate: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date(isoDate));
}
