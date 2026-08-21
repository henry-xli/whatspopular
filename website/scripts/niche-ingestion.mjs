import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fallbackBrief from "../data/niche-trends.json" with { type: "json" };
import { generateNicheBatch, isNicheTopicUsable } from "./ai-descriptions.mjs";
import { additionalNicheCategories } from "./niche-catalog.mjs";
import { linkedArticleMetadata, resolveGoogleNewsArticle } from "./news-article.mjs";
import { fetchBytes, mapConcurrent } from "./runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(root, "data", "niche-trends.json");
const nicheSourceHost = "news.google.com";
const maxBytes = 2 * 1024 * 1024;
const timeoutMs = 15_000;
const maxPublisherCandidates = 8;
const contextualQuery = "(viral OR meme OR reaction OR return OR comeback OR announcement OR result OR controversy)";
const concreteContextPattern = /\b(?:after|amid|announc|assign|brought back|bring(?:s|ing)? back|because|comeback|confirm|debut(?:ed)?|demand|debut|first introduced|introduced|launch|limited(?:[- ]time)?|meme|nostalgia|original(?:ly)?|popular|reaction|receiv|return(?:ed|ing)?|re-?released?|revived|viral|fans?|funny|walk(?:ed|ing)?|appearance|sold out|restock(?:ed)?|survey|study|research|report|win|won|beat|loss|match|tournament|championship|playoffs?|final|injur|trade|transfer|sign(?:ed|ing)?|ruling|vote|strike|storm|fire|earthquake|mission|update|festival|concert|tour|game|season|episode|chapter|book|film|series|overplayed|dominat)\b/i;
const articleBoilerplatePattern = /^(?:reporting by|editing by|edited by|our standards|this article has been reviewed|the following is a transcript|copyright|all rights reserved)\b/i;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

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

function hasConcreteArticleContext(headline, intro) {
  if (!intro || articleBoilerplatePattern.test(intro)) return false;
  const focused = focusedArticleContext(headline, intro, 620);
  if (!focused || !concreteContextPattern.test(focused)) return false;
  const stopWords = new Set(["about", "after", "again", "also", "around", "because", "being", "could", "first", "from", "have", "into", "more", "most", "over", "that", "their", "there", "these", "they", "this", "through", "under", "what", "when", "where", "which", "while", "with", "would"]);
  const words = (value) => cleanText(value, 1_400)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !stopWords.has(word));
  const introWords = new Set(words(focused));
  const overlap = words(headline).filter((word) => introWords.has(word));
  return overlap.length >= 1;
}

function meaningfulWordOverlap(left, right) {
  const stopWords = new Set(["about", "after", "again", "also", "around", "because", "being", "could", "first", "from", "have", "into", "more", "most", "over", "that", "their", "there", "these", "they", "this", "through", "under", "what", "when", "where", "which", "while", "with", "would"]);
  const words = (value) => cleanText(value, 1_400)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !stopWords.has(word));
  const rightWords = new Set(words(right));
  return [...new Set(words(left))].filter((word) => rightWords.has(word));
}

function focusedArticleContext(headline, intro, maxLength = 420) {
  const candidates = [...sentenceSegmenter.segment(cleanText(intro, 1_400))]
    .map(({ segment: text }, index) => ({
      text: text.trim(),
      index,
      headlineOverlap: meaningfulWordOverlap(headline, text),
      score: (text.match(concreteContextPattern) ? 1 : 0)
        + meaningfulWordOverlap(headline, text).length * 3
        - (articleBoilerplatePattern.test(text) ? 8 : 0)
        - (/\b(?:courtesy|editorial process|our standards|subscribe|newsletter|read more)\b/i.test(text) ? 5 : 0)
        - (/^[\s"“”'’]*(?:said|says|according to)\b/i.test(text) || /["“][^"”]+["”]/.test(text) ? 6 : 0),
    }))
    .filter((entry) => entry.text.length >= 45 && !/^(?:although|because|but|which|while|with|as)\b/i.test(entry.text.replace(/^[\s"“”'’]+/, "")))
    .filter((entry) => !/\b(?:courtesy|editorial process|our standards|subscribe|newsletter|read more)\b/i.test(entry.text));
  const related = candidates
    .filter((entry) => entry.headlineOverlap.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2);
  const context = candidates
    .filter((entry) => !/["“][^"”]+["”]/.test(entry.text))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 1);
  const sentences = [...new Map(related.concat(context).map((entry) => [entry.index, entry])).values()]
    .sort((left, right) => left.index - right.index);
  let result = "";
  for (const sentence of sentences) {
    const next = `${result} ${sentence.text}`.trim();
    if (next.length > maxLength && result) break;
    result = next;
  }
  return result;
}

async function categoryCandidates(category) {
  try {
    const queries = [category.query, `${category.query} ${contextualQuery}`];
    const feedItems = await mapConcurrent(queries, 2, async (query) => {
      const url = new URL("https://news.google.com/rss/search");
      url.search = new URLSearchParams({
        q: `${query} when:7d`,
        hl: "en-US",
        gl: "US",
        ceid: "US:en",
      });
      try {
        return parseRss(await fetchText(url), query).slice(0, maxPublisherCandidates / 2);
      } catch (error) {
        console.warn(`Niche source unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    const seenHeadlines = new Set();
    const items = feedItems.flat().filter((item) => {
      const key = item.headline.toLocaleLowerCase("en-US");
      if (seenHeadlines.has(key)) return false;
      seenHeadlines.add(key);
      return true;
    }).slice(0, maxPublisherCandidates);
    const enriched = await mapConcurrent(items, 3, async (candidate) => {
      try {
        const candidateUrl = new URL(candidate.link);
        const publisherUrl = candidateUrl.hostname === nicheSourceHost
          ? await resolveGoogleNewsArticle(candidate.link)
          : candidate.link;
        const metadata = await linkedArticleMetadata(publisherUrl, { allowMissingImage: true });
        const articleIntro = cleanText(metadata.intro, 1_400);
        if (articleIntro.length < 80 || !hasConcreteArticleContext(candidate.headline, articleIntro)) return null;
        if (metadata.title && meaningfulWordOverlap(candidate.headline, metadata.title).length < 2) return null;
        return { ...candidate, link: metadata.url, articleIntro };
      } catch (error) {
        console.warn(`Niche article unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const seen = new Set();
    const valid = enriched.filter((item) => item && (() => {
      const key = item.headline.toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })()).slice(0, 3);
    if (valid.length >= 3) return valid;

    // Google News occasionally returns its own interstitial instead of a
    // publisher URL. Revalidate the last source-grounded cards directly so a
    // resolver outage does not force a generic fallback or lose a good feed.
    const priorTopics = fallbackCategory(category).topics
      .filter((topic) => topic.evidenceMode === "source-grounded" && /^https:\/\//i.test(topic.url ?? ""))
      .slice(0, maxPublisherCandidates);
    const prior = await mapConcurrent(priorTopics, 3, async (topic) => {
      try {
        const metadata = await linkedArticleMetadata(topic.url, { allowMissingImage: true });
        const articleIntro = cleanText(metadata.intro, 1_400);
        if (articleIntro.length < 80 || !hasConcreteArticleContext(topic.title, articleIntro)) return null;
        if (metadata.title && meaningfulWordOverlap(topic.title, metadata.title).length < 2) return null;
        return {
          headline: topic.title,
          source: topic.source,
          sourceUrl: topic.url,
          link: metadata.url,
          publishedAt: fallbackBrief.generatedAt,
          order: topic.id,
          articleIntro,
        };
      } catch (error) {
        console.warn(`Last-good niche article unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const combinedSeen = new Set();
    return valid.concat(prior).filter((item) => item && (() => {
      const key = item.headline.toLocaleLowerCase("en-US");
      if (combinedSeen.has(key)) return false;
      combinedSeen.add(key);
      return true;
    })()).slice(0, 3);
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

function candidateRecords(category, candidates) {
  return candidates.slice(0, 3).map((candidate, index) => ({
    id: `${category.id}-${index + 1}`,
    category: category.label,
    categoryContext: category.description,
    title: candidate.headline,
    sourceSnippets: [
      {
        kind: "current_headline",
        source: candidate.source,
        headline: candidate.headline,
        text: candidate.headline,
        publishedAt: candidate.publishedAt,
      },
      {
        kind: "current_coverage",
        source: candidate.source,
        headline: candidate.headline,
        text: candidate.articleIntro,
        publishedAt: candidate.publishedAt,
      },
    ],
    candidate,
  }));
}

function completeSentences(value, maxLength = 520) {
  let result = "";
  for (const { segment } of sentenceSegmenter.segment(cleanText(value, 1_400))) {
    const sentence = segment.trim();
    if (!sentence || /^(?:although|because|but|which|while|with|as)\b/i.test(sentence.replace(/^[\s"“”'’]+/, "")) && sentence.length < 72) break;
    const next = `${result} ${sentence}`.trim();
    if (next.length > maxLength && result) break;
    result = next;
  }
  return result;
}

function sourceGroundedTopic(record, category, index, fallback) {
  const candidate = record.candidate;
  const fallbackTopic = fallback?.topics?.[index] ?? fallbackBrief.categories[0].topics[index % 3];
  const headline = cleanText(candidate?.headline, 180);
  const articleIntro = focusedArticleContext(headline, candidate?.articleIntro, 420);
  if (!candidate || !articleIntro) throw new Error(`Niche topic ${record.id} has no source-grounded article context`);
  return {
    id: record.id,
    title: headline,
    description: articleIntro,
    whyNow: completeSentences(articleIntro, 280),
    url: candidate.link,
    source: candidate.source,
    sourceLabel: "Read the report",
    evidenceMode: "source-grounded",
    image: fallbackTopic.image,
    accent: fallbackTopic.accent ?? category.accent,
    trendLabel: "Recent coverage",
  };
}

export async function generateNicheSnapshot(brief, { now = new Date(), dryRun = false } = {}) {
  const sourceResults = await mapConcurrent(categoryDefinitions, 4, async (category) => ({
    category,
    candidates: await categoryCandidates(category),
  }));
  const retainedCategoryIds = new Set();
  const records = sourceResults.flatMap(({ category, candidates }) => {
    const fallback = fallbackCategory(category);
    if (candidates.length < 3) {
      retainedCategoryIds.add(category.id);
      console.warn(`${category.label} produced only ${candidates.length} source-grounded topics; retaining its last validated cards`);
      return [];
    }
    const sourceRecords = candidateRecords(category, candidates);
    return sourceRecords.map((record, index) => ({
      ...record,
      fallback: sourceGroundedTopic(record, category, index, fallback),
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
    if (retainedCategoryIds.has(category.id)) {
      const hasVerifiedFallback = fallback.topics?.length >= 3
        && fallback.topics.slice(0, 3).every((topic) => topic.evidenceMode === "source-grounded");
      if (!hasVerifiedFallback) {
        console.warn(`${category.label} has no verified last-good cards; excluding the tag until fresh coverage is available`);
        return { id: category.id, label: category.label, parent: category.parent, description: category.description, accent: category.accent, topics: [] };
      }
      return {
        id: category.id,
        label: category.label,
        parent: category.parent,
        description: fallback.description,
        accent: category.accent,
        topics: fallback.topics.slice(0, 3),
      };
    }
    const categoryRecords = records.filter((record) => record.category === category.label).slice(0, 3);
    const topics = categoryRecords.map((record, index) => {
      const base = record.fallback ?? sourceGroundedTopic(record, category, index, fallback);
      const ai = generated.get(record.id);
      const usableAi = ai && isNicheTopicUsable(ai, record) ? ai : null;
      return {
        ...base,
        ...(usableAi ? {
          title: usableAi.title,
          description: usableAi.description,
          whyNow: usableAi.whyNow,
          trendLabel: usableAi.trendLabel,
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
  const publishableCategories = categories.filter((category) => category.topics.length >= 3);
  const snapshot = {
    generatedAt: now.toISOString(),
    edition: `Week of ${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(now)}`,
    window: "Past 7 days",
    summary: fallbackBrief.summary,
    categories: publishableCategories,
  };
  if (dryRun) {
    console.log(`Niche snapshot dry run: ${publishableCategories.length} categories, ${generated.size} AI topic cards, ${retainedCategoryIds.size} retained categories, ${publishableCategories.reduce((total, category) => total + category.topics.length, 0)} total cards.`);
  } else {
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return snapshot;
}

if (process.argv.includes("--standalone")) {
  const rawBrief = JSON.parse(await readFile(path.join(root, "data", "trends.json"), "utf8"));
  await generateNicheSnapshot(rawBrief, { dryRun: process.argv.includes("--dry-run") });
}
