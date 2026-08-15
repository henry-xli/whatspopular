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
  signal: string;
  score: number;
  accent: string;
  caution?: string;
  rating?: string;
  spotifyId?: string;
};

export type CultureSection = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  sources: string[];
  layout: CultureLayout;
  items: CultureItem[];
};

export type CultureBrief = {
  edition: string;
  status: string;
  window: string;
  generatedAt: string;
  summary: string;
  spotlight: {
    eyebrow: string;
    title: string;
    description: string;
    image: string;
    alt: string;
    url: string;
    source: string;
    stat: string;
    statLabel: string;
  };
  pulse: Array<{
    label: string;
    value: string;
    image: string;
    url: string;
  }>;
  sections: CultureSection[];
};

const allowedLinkHosts = new Set([
  "ads.tiktok.com",
  "knowyourmeme.com",
  "open.spotify.com",
  "trending.knowyourmeme.com",
  "www.imdb.com",
  "www.instagram.com",
  "www.tiktok.com",
  "www.youtube.com"
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
  if (value.sections.length !== 6) {
    throw new Error("Culture brief must contain exactly six boards");
  }
  if (value.pulse.length !== 4) {
    throw new Error("Culture pulse must contain exactly four items");
  }

  assertExternalUrl(value.spotlight.url, "Spotlight");
  if (!value.spotlight.image.startsWith("/culture/")) {
    throw new Error("Spotlight image must be a local cached asset");
  }

  for (const pulseItem of value.pulse) {
    assertExternalUrl(pulseItem.url, "Pulse item");
    if (!pulseItem.image.startsWith("/culture/")) {
      throw new Error("Pulse image must be a local cached asset");
    }
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
      if (item.spotifyId && !/^[A-Za-z0-9]{22}$/.test(item.spotifyId)) {
        throw new Error(item.title + " has an invalid Spotify track ID");
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
