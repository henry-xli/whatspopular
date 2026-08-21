import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fallbackBrief from "../data/niche-trends.json" with { type: "json" };
import { generateNicheBatch } from "./ai-descriptions.mjs";
import { additionalNicheCategories } from "./niche-catalog.mjs";
import { fetchBytes, mapConcurrent } from "./runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(root, "data", "niche-trends.json");
const nicheSourceHost = "news.google.com";
const maxBytes = 2 * 1024 * 1024;
const timeoutMs = 15_000;

const categoryDefinitions = [
  { id: "edm", label: "EDM", parent: "Music", query: "EDM electronic dance music", accent: "#8b5cf6" },
  { id: "kpop", label: "K-pop", parent: "Music", query: "K-pop comeback release fandom", accent: "#ff6b9d" },
  { id: "football", label: "Football", parent: "Sports", query: "football soccer World Cup players", accent: "#20b486" },
  { id: "combat-sports", label: "Combat sports", parent: "UFC MMA boxing fight card", accent: "#f05e4f" },
  { id: "beauty", label: "Beauty", parent: "beauty makeup skincare trend product", accent: "#e981a9" },
  { id: "food-drink", label: "Food & drink", parent: "Lifestyle", query: "viral food drink restaurant snack", accent: "#f59e42" },
  { id: "gaming", label: "Gaming", parent: "Culture", query: "video game gaming release trailer", accent: "#3fa7ff" },
  { id: "anime-manga", label: "Anime & manga", parent: "Culture", query: "anime manga series fandom", accent: "#ff5d65" },
  { id: "film-tv", label: "Film & TV", parent: "Culture", query: "movie television trailer casting premiere", accent: "#e8b64e" },
  { id: "books-reading", label: "Books & reading", parent: "Culture", query: "books novels reading book club", accent: "#a77b55" },
  { id: "streetwear", label: "Streetwear", parent: "Lifestyle", query: "streetwear sneakers fashion bag restock", accent: "#f37d43" },
  { id: "internet-culture", label: "Internet culture", parent: "Culture", query: "meme internet slang creator trend", accent: "#e95bd6" },
  { id: "tech", label: "Tech", parent: "Culture", query: "technology gadgets AI smartphone product", accent: "#5a9cff" },
  { id: "creators", label: "Creators", parent: "Culture", query: "creator YouTube influencer interview format", accent: "#ff765f" },
  ...additionalNicheCategories,
].map((category) => ({
  ...category,
  query: category.query ?? category.label,
  description: category.description ?? `${category.label} conversations, releases, and signals that are accelerating beyond the general leaderboard.`,
}));

const fallbackCategories = new Map([
  ...additionalNicheCategories,
  ...fallbackBrief.categories,
].map((category) => [category.id, category]));

function cleanText(value, maxLength = 600) {
  return String(value ?? "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

async function fetchText(rawUrl) {
  const { buffer } = await fetchBytes(rawUrl, {
    isAllowedHost: (hostname) => hostname === nicheSourceHost,
    kind: "niche source",
    maxBytes,
    timeoutMs,
    attempts: 2,
    headers: {
      accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
    },
  });
  return buffer.toString("utf8");
}

function tagValue(block, tag) {
  return block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "";
}

function parseRss(xml, query) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((match, index) => {
      const block = match[1];
      const rawTitle = cleanText(tagValue(block, "title"), 240);
      const sourceBlock = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
      const source = cleanText(sourceBlock?.[2], 100) || "Google News";
      const sourceUrl = sourceBlock?.[1]?.match(/\burl=["']([^"']+)/i)?.[1] ?? "";
      const publishedAt = cleanText(tagValue(block, "pubDate"), 80);
      const link = cleanText(tagValue(block, "link"), 1600);
      const title = rawTitle.replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`, "i"), "").trim();
      return {
        headline: title || rawTitle,
        source,
        sourceUrl: /^https:\/\//i.test(sourceUrl) ? sourceUrl : `https://news.google.com/search?q=${encodeURIComponent(query)}`,
        link: /^https:\/\//i.test(link) ? link : `https://news.google.com/search?q=${encodeURIComponent(query)}`,
        publishedAt,
        order: index,
      };
    })
    .filter((item) => item.headline.length >= 20);
}

async function categoryCandidates(category) {
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({
    q: `${category.query} when:7d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  try {
    const items = parseRss(await fetchText(url), category.query);
    const seen = new Set();
    return items.filter((item) => {
      const key = item.headline.toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3);
  } catch (error) {
    console.warn(`Niche source unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function fallbackCategory(category) {
  const candidate = fallbackCategories.get(category.id);
  return candidate ?? {
    ...category,
    topics: [],
  };
}

function fallbackRecords(category, count) {
  return fallbackCategory(category).topics.slice(0, count).map((topic, index) => ({
    id: `${category.id}-${index + 1}`,
    category: category.label,
    categoryContext: category.description,
    title: topic.title,
    sourceSnippets: [{
      source: topic.source,
      headline: `${topic.title}: ${topic.whyNow}`,
      publishedAt: fallbackBrief.generatedAt,
    }],
    fallback: topic,
  }));
}

function candidateRecords(category, candidates) {
  return candidates.slice(0, 3).map((candidate, index) => ({
    id: `${category.id}-${index + 1}`,
    category: category.label,
    categoryContext: category.description,
    title: candidate.headline,
    sourceSnippets: [{
      source: candidate.source,
      headline: candidate.headline,
      publishedAt: candidate.publishedAt,
    }],
    candidate,
  }));
}

function baseTopic(record, category, index, fallback) {
  const candidate = record.candidate;
  const fallbackTopic = fallback?.topics?.[index] ?? fallbackBrief.categories[0].topics[index % 3];
  return {
    id: record.id,
    title: fallbackTopic.title,
    description: fallbackTopic.description,
    whyNow: fallbackTopic.whyNow,
    url: candidate?.link ?? fallbackTopic.url,
    source: candidate?.source ?? fallbackTopic.source,
    sourceLabel: candidate ? "Read the source" : fallbackTopic.sourceLabel,
    image: fallbackTopic.image,
    accent: fallbackTopic.accent ?? category.accent,
    trendLabel: fallbackTopic.trendLabel,
  };
}

export async function generateNicheSnapshot(brief, { now = new Date(), dryRun = false } = {}) {
  const sourceResults = await mapConcurrent(categoryDefinitions, 4, async (category) => ({
    category,
    candidates: await categoryCandidates(category),
  }));
  const records = sourceResults.flatMap(({ category, candidates }) => {
    const fallback = fallbackCategory(category);
    const sourceRecords = candidates.length >= 3 ? candidateRecords(category, candidates) : fallbackRecords(category, 3);
    return sourceRecords.map((record, index) => ({
      ...record,
      fallback: baseTopic(record, category, index, fallback),
    }));
  });
  let generated = new Map();
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      generated = await generateNicheBatch(records);
    } catch (error) {
      console.warn(`AI niche topics unavailable; deterministic niche cards retained: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log("AI niche topics skipped: OPENAI_API_KEY is not configured; deterministic niche cards remain active.");
  }

  const categories = categoryDefinitions.map((category) => {
    const fallback = fallbackCategory(category);
    const categoryRecords = records.filter((record) => record.category === category.label).slice(0, 3);
    const topics = categoryRecords.map((record, index) => {
      const base = record.fallback ?? baseTopic(record, category, index, fallback);
      const ai = generated.get(record.id);
      return {
        ...base,
        ...(ai ? {
          title: ai.title,
          description: ai.description,
          whyNow: ai.whyNow,
          trendLabel: ai.trendLabel,
        } : {}),
      };
    });
    return {
      id: category.id,
      label: category.label,
      parent: category.parent,
      description: fallback.description,
      accent: category.accent,
      topics,
    };
  });
  const snapshot = {
    generatedAt: now.toISOString(),
    edition: `Week of ${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(now)}`,
    window: "Past 7 days",
    summary: fallbackBrief.summary,
    categories,
  };
  if (dryRun) {
    console.log(`Niche snapshot dry run: ${categories.length} categories, ${generated.size} AI topic cards, ${categories.reduce((total, category) => total + category.topics.length, 0)} total cards.`);
  } else {
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return snapshot;
}

if (process.argv.includes("--standalone")) {
  const rawBrief = JSON.parse(await readFile(path.join(root, "data", "trends.json"), "utf8"));
  await generateNicheSnapshot(rawBrief, { dryRun: process.argv.includes("--dry-run") });
}
