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
const maxPublisherCandidates = 12;
const maxCandidateAgeDays = 8;
const contextualQuery = "(viral OR meme OR reaction OR return OR comeback OR announcement OR result OR controversy)";
const concreteContextPattern = /\b(?:after|amid|announc|assign|award|brought back|bring(?:s|ing)? back|because|comeback|confirm|debut(?:ed)?|demand|drop|first introduced|introduced|launch|limited(?:[- ]time)?|meme|nomination|nostalgia|original(?:ly)?|reaction|receiv|return(?:ed|ing)?|re-?released?|reintroduc|revived|viral|fans?|funny|walk(?:ed|ing)?|appearance|sold out|restock(?:ed)?|survey|study|research|report|win|won|beat|loss|match|tournament|championship|playoffs?|final|injur|trade|transfer|sign(?:ed|ing)?|ruling|vote|strike|storm|fire|earthquake|mission|update|festival|concert|tour|game|season|episode|chapter|premiere|trailer|cast|world cup|record|roster|suspension|red card|special|stand[- ]up|comedian|comedy|sketch|bit|joke|spoof|ticket|guinness|social media|streaming|chart|book|film|series)\b/i;
const attentionSignalPattern = /\b(?:viral|meme|trending|popular|return|comeback|re-?release|reintroduc|reviv|release|debut|drop|chart|stream(?:ed|ing)?|record|sold out|restock|lineup|headliner|festival|concert|tour|premiere|trailer|award|nomination|win|won|match|tournament|championship|playoffs?|final|ruling|lawsuit|recall|strike|storm|fire|earthquake|mission|roster|suspension|red card|announcement|controversy|spoof|special|ticket|guinness|social media)\b/i;
const genericNicheHeadlinePattern = /(?:^\s*(?:\d+\s+(?:overplayed|ways?|reasons?|things?|songs?|tips?|ideas?|products?|shows?|movies?|books?|recipes?|snacks?|snackable|cocktails?|drinks?|restaurants?|places?|artists?|albums?)\b|top|best|what|why|how|everything|a guide|here are|latest)\b|\b(?:explained|guide|review|roundup|deserves the hype|sets? (?:his|her|their|its) sights|challenges? (?:the )?(?:norms|boundaries)|sparks? (?:a )?debate|what to know|the internet['’]s .* king|making a comeback|latest updates|news and notes|in history|biggest .* ever)\b)/i;
const hardMetaNicheHeadlinePattern = /\b(?:deserves the hype|sets? (?:his|her|their|its) sights|challenges? (?:the )?(?:norms|boundaries)|sparks? (?:a )?debate|the internet['’]s .* king)\b/i;
const numberedNicheHeadlinePattern = /^\s*(?:the\s+)?(?!(?:19|20)\d{2}\b)\d+(?:st|nd|rd|th)?\s+(?!annual\b)/i;
const genericNicheCopyPattern = /\b(?:main[- ]character|having (?:a|its) \w+ week|(?:is|are|was|were) (?:the|a|an) (?:story|headline|moment|vibe)|doing numbers|refuses to stay niche|gets? a second wind|back in rotation|next generation|moving target|worth watching|part of what makes|has amassed serious star power|dominates? social media|the conversation|cultural norms|the scene|the moment|a new era|a fresh take|a changing landscape|current development|generic development|linked report|connect(?:ed|ing)? with fans|continued to connect)\b/i;
const articleBoilerplatePattern = /^(?:reporting by|editing by|edited by|our standards|this article has been reviewed|the following is a transcript|copyright|all rights reserved)\b/i;
const incompleteSentencePattern = /\b(?:St|Mr|Mrs|Ms|Dr|Prof|No|vs|etc)\.$/i;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

const categoryDefinitions = [
  { id: "edm", label: "EDM", parent: "Music", query: "EDM electronic dance music", queryVariants: ["EDM DJ producer release festival lineup", "electronic dance music artist tour festival news"], accent: "#8b5cf6" },
  { id: "kpop", label: "K-pop", parent: "Music", query: "K-pop comeback release fandom", accent: "#ff6b9d" },
  { id: "football", label: "Football", parent: "Sports", query: "soccer FIFA UEFA World Cup players -NFL -NCAA -college", queryVariants: ["soccer latest match transfer tournament news -NFL -NCAA", "FIFA UEFA World Cup soccer players latest -NFL"], accent: "#20b486" },
  { id: "combat-sports", label: "Combat sports", parent: "UFC MMA boxing fight card", accent: "#f05e4f" },
  { id: "beauty", label: "Beauty", parent: "beauty makeup skincare trend product", accent: "#e981a9" },
  { id: "food-drink", label: "Food & drink", parent: "Lifestyle", query: "food drink viral social media trend news", accent: "#f59e42" },
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
  queryVariants: category.queryVariants ?? ({
    "food-drink": ["food drink viral return limited weekend", "viral drink debut"],
    golf: ["PGA Tour golf tournament results player news", "golf players tournament latest news LIV"],
    comedy: ["comedian comedy special tour clip interview latest", "stand-up sketch comedian viral bit show news"],
  }[category.id] ?? []),
  description: category.description ?? `${category.label} conversations, releases, and signals that are accelerating beyond the general leaderboard.`,
}));

const categoryRules = {
  edm: {
    include: /\b(?:EDM|electronic dance|DJ|producer|festival|rave|club|house|techno|trance|dubstep|drum.?and.?bass|remix)\b/i,
    exclude: /\b(?:study|survey|well[- ]being|midlife|research paper|academic)\b/i,
    story: /\b(?:release|released|album|single|track|festival|concert|tour|lineup|headliner|chart|stream|debut|comeback|return|remix|viral|meme|performance|DJ|producer|label|ticket|sold out)\b/i,
  },
  football: {
    include: /\b(?:soccer|association football|FIFA|UEFA|Premier League|La Liga|Serie A|Bundesliga|World Cup|Champions League|Europa League|NWSL|MLS|red card|goalkeeper)\b/i,
    exclude: /\b(?:NFL|NCAA|college football|quarterback|touchdown|transfer portal|roster cuts|American football|Super Bowl)\b/i,
    story: /\b(?:match|goal|win|won|loss|tournament|championship|playoffs?|final|qualif|transfer|sign(?:ed|ing)?|injur|roster|suspend|red card|World Cup|FIFA|UEFA|league|coach|manager)\b/i,
  },
  golf: {
    include: /\b(?:golf|PGA|LPGA|LIV|Masters|Ryder Cup|FedExCup|course|caddie|putt)\b/i,
    story: /\b(?:tournament|championship|round|win|won|qualif|cut|match|return|sign(?:ed|ing)?|injur|suspend|ranking|title|course|PGA|LIV|player|BMW Championship)\b/i,
  },
  baseball: {
    include: /\b(?:baseball|MLB|pitcher|pitching|home run|ballpark|inning|outfielder|shortstop|catcher|minor league)\b/i,
    story: /\b(?:trade|traded|pitch|pitcher|home run|game|win|won|loss|injur|roster|prospect|draft|deadline|inning|playoffs?|championship|documentary)\b/i,
  },
  motorsport: {
    include: /\b(?:Formula 1|F1|racing|motorsport|Grand Prix|driver|paddock|qualifying|race)\b/i,
    story: /\b(?:race|qualifying|Grand Prix|sign(?:ed|ing)?|contract|transfer|driver|team|pole|win|won|crash|penalt|championship|season)\b/i,
  },
  gaming: {
    include: /\b(?:video game|gaming|gameplay|PlayStation|Xbox|Nintendo|Steam|PC game|developer|publisher|trailer)\b/i,
    story: /\b(?:release|launch|trailer|gameplay|update|demo|beta|studio|developer|publisher|sale|review|premiere)\b/i,
  },
  health: {
    include: /\b(?:health|medicine|medical|doctor|patient|hospital|disease|drug|treatment|clinical|wellness|fitness|mental health|public health)\b/i,
    story: /\b(?:study|research|trial|treatment|drug|disease|hospital|doctor|patient|health|medical|guidance|approval|risk|outbreak|wellness|fitness)\b/i,
  },
  comedy: {
    include: /\b(?:comedian|comedy|stand[- ]up|sketch|comic|bit|special|joke|funny|crowd work|Netflix|SNL|Guinness|tour)\b/i,
    story: /\b(?:special|tour|show|series|performance|clip|bit|sketch|interview|appearance|festival|award|release|premiere|controversy|meme|viral|podcast|joke|spoof|social media|ticket|record)\b/i,
  },
};

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

async function fetchBingNewsSearch(query) {
  const url = new URL("https://www.bing.com/news/search");
  url.search = new URLSearchParams({ q: query, setlang: "en-US" });
  const { buffer } = await fetchBytes(url, {
    isAllowedHost: (hostname) => hostname === "www.bing.com",
    kind: "niche publisher search",
    maxBytes,
    timeoutMs,
    attempts: 2,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9, */*;q=0.5",
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

function articleSearchResults(html, headline, sourceUrl) {
  let sourceHost = "";
  try { sourceHost = new URL(sourceUrl).hostname.replace(/^www\./i, "").toLowerCase(); } catch {}
  const results = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["'](https:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawUrl = match[1].replaceAll("&amp;", "&");
    const title = cleanText(match[2], 240);
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "bing.com" || host.endsWith(".bing.com") || host === "google.com" || host.endsWith(".google.com") || !title) continue;
      const overlap = meaningfulWordOverlap(headline, title).length;
      const domainMatch = sourceHost && (host === sourceHost || host.endsWith(`.${sourceHost}`));
      if (overlap < 2 && !domainMatch) continue;
      results.push({ url: url.href, title, overlap, domainMatch });
    } catch {
      // Search result markup contains tracking links and malformed fragments.
    }
  }
  return [...new Map(results.map((result) => [result.url, result])).values()]
    .sort((left, right) => Number(right.domainMatch) - Number(left.domainMatch) || right.overlap - left.overlap)
    .slice(0, maxPublisherCandidates);
}

async function resolvePublisherArticles(candidate) {
  const urls = [];
  const resolved = await resolveGoogleNewsArticle(candidate.link).catch(() => null);
  if (resolved) {
    try {
      const hostname = new URL(resolved).hostname.toLowerCase();
      if (hostname !== "google.com" && !hostname.endsWith(".google.com")) urls.push(resolved);
    } catch {
      // Fall through to the bounded publisher search below.
    }
  }
  const queries = [
    `site:${new URL(candidate.sourceUrl).hostname.replace(/^www\./i, "")} "${candidate.headline.replaceAll('"', "")}"`,
    `"${candidate.headline.replaceAll('"', "")}"`,
  ];
  for (const query of queries) {
    try {
      const results = articleSearchResults(await fetchBingNewsSearch(query), candidate.headline, candidate.sourceUrl);
      urls.push(...results.map((result) => result.url));
      if (urls.length >= 4) break;
    } catch {
      // A search outage should not replace the last valid snapshot.
    }
  }
  return [...new Set(urls)].slice(0, 4);
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
  const seenSentenceKeys = new Set();
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
    .filter((entry) => !incompleteSentencePattern.test(entry.text))
    .filter((entry) => !/\b(?:courtesy|editorial process|our standards|subscribe|newsletter|read more)\b/i.test(entry.text))
    .filter((entry) => {
      const key = entry.text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
      if (!key || seenSentenceKeys.has(key)) return false;
      seenSentenceKeys.add(key);
      return true;
    });
  const safeCandidates = candidates.filter((entry) => !/["“][^"”]+["”]/.test(entry.text));
  const related = safeCandidates
    .filter((entry) => entry.headlineOverlap.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2);
  const relatedIndexes = new Set(related.map((entry) => entry.index));
  const context = safeCandidates
    .filter((entry) => !relatedIndexes.has(entry.index))
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

function publicationAgeDays(value, now) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return null;
  return (now.getTime() - timestamp) / 86_400_000;
}

function isRecentPublication(value, now) {
  const age = publicationAgeDays(value, now);
  return age !== null && age >= -0.25 && age <= maxCandidateAgeDays;
}

function nicheImagePath(id) {
  return `/culture/niche-${String(id).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.webp`;
}

function storyWords(value) {
  const stopWords = new Set(["about", "after", "again", "also", "around", "because", "being", "could", "first", "from", "have", "into", "more", "most", "over", "that", "their", "there", "these", "they", "this", "through", "under", "what", "when", "where", "which", "while", "with", "would", "latest", "news", "report", "reports", "today", "week", "weekly", "returns", "returning"]);
  return new Set(cleanText(value, 2_000)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word)));
}

function sameStoryFamily(left, right) {
  const leftTitle = storyWords(left?.headline);
  const rightTitle = storyWords(right?.headline);
  if (!leftTitle.size || !rightTitle.size) return false;
  const titleOverlap = [...leftTitle].filter((word) => rightTitle.has(word)).length;
  const titleRatio = titleOverlap / Math.min(leftTitle.size, rightTitle.size);
  if (titleOverlap >= 3 && titleRatio >= 0.35) return true;
  const leftContext = storyWords(left?.articleIntro);
  const rightContext = storyWords(right?.articleIntro);
  const contextOverlap = [...leftContext].filter((word) => rightContext.has(word)).length;
  return titleOverlap >= 2 && contextOverlap >= 4;
}

function categoryRuleUsable(category, candidate, focused) {
  const rule = categoryRules[category.id];
  if (!rule) return true;
  const text = `${candidate.headline} ${focused}`;
  if (rule.exclude?.test(text)) return false;
  if (rule.include && !rule.include.test(text)) return false;
  if (rule.story && !rule.story.test(text)) return false;
  return true;
}

function sourceCandidateUsable(category, candidate, now) {
  if (!candidate || !isRecentPublication(candidate.publishedAt, now)) return false;
  const focused = focusedArticleContext(candidate.headline, candidate.articleIntro, 620);
  if (!focused || genericNicheCopyPattern.test(focused)) return false;
  if (hardMetaNicheHeadlinePattern.test(candidate.headline)) return false;
  if (!categoryRuleUsable(category, candidate, focused)) return false;
  if (numberedNicheHeadlinePattern.test(candidate.headline) || genericNicheHeadlinePattern.test(candidate.headline)) return false;
  if (!hasConcreteArticleContext(candidate.headline, candidate.articleIntro)) return false;
  if (!concreteContextPattern.test(`${candidate.headline} ${focused}`)) return false;
  const requiresAttentionSignal = ["edm", "football", "golf", "comedy"].includes(category.id);
  if (requiresAttentionSignal && !attentionSignalPattern.test(`${candidate.headline} ${focused}`)
    && Number(candidate.coverageCount ?? 1) < 2) return false;
  return meaningfulWordOverlap(candidate.headline, focused).length >= 1;
}

function candidateRelevanceScore(candidate, now) {
  const age = publicationAgeDays(candidate.publishedAt, now) ?? maxCandidateAgeDays;
  const freshness = Math.max(0, maxCandidateAgeDays - age + 1);
  const focused = focusedArticleContext(candidate.headline, candidate.articleIntro, 620);
  const headlineSignal = Number(concreteContextPattern.test(candidate.headline));
  const articleSignal = Number(concreteContextPattern.test(focused));
  const causalSignal = Number(/\b(?:after|amid|because|following|when|return|re-?release|meme|viral|reaction|fans?|funny|sold out|restock|won|match|tournament|announc|report|study|research)\b/i.test(focused));
  const overlap = meaningfulWordOverlap(candidate.headline, focused).length;
  const imageSignal = Number(Boolean(candidate.imageSource));
  const coverageSignal = Math.min(4, Number(candidate.coverageCount ?? 1));
  const attentionSignal = Number(attentionSignalPattern.test(`${candidate.headline} ${focused}`));
  return freshness * 12 + coverageSignal * 18 + headlineSignal * 28 + articleSignal * 12 + causalSignal * 10 + attentionSignal * 14 + overlap * 5 + imageSignal * 6;
}

async function categoryCandidates(category, now = new Date()) {
  try {
    const queries = [...new Set([
      category.query,
      ...(category.queryVariants ?? []),
      `${category.query} ${contextualQuery}`,
      `${category.label} latest news ${contextualQuery}`,
    ].filter(Boolean))].slice(0, 3);
    const queryLimit = Math.ceil(maxPublisherCandidates / queries.length);
    const feedItems = await mapConcurrent(queries, 3, async (query) => {
      const url = new URL("https://news.google.com/rss/search");
      url.search = new URLSearchParams({
        q: `${query} when:7d`,
        hl: "en-US",
        gl: "US",
        ceid: "US:en",
      });
      try {
        return parseRss(await fetchText(url), query).slice(0, queryLimit).map((item) => ({ ...item, query }));
      } catch (error) {
        console.warn(`Niche source unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    const allItems = feedItems.flat();
    const seenHeadlines = new Set();
    const items = allItems.filter((item) => {
      const key = item.headline.toLocaleLowerCase("en-US");
      if (seenHeadlines.has(key)) return false;
      seenHeadlines.add(key);
      return true;
    }).map((item) => ({
      ...item,
      coverageCount: allItems.filter((other) => meaningfulWordOverlap(item.headline, other.headline).length >= 3).length,
      coverageSources: [...new Set(allItems
        .filter((other) => meaningfulWordOverlap(item.headline, other.headline).length >= 3)
        .map((other) => other.source)
        .filter(Boolean))],
    })).sort((left, right) => right.coverageCount - left.coverageCount || left.order - right.order)
      .slice(0, maxPublisherCandidates);
    const enriched = await mapConcurrent(items, 3, async (candidate) => {
      try {
        const candidateUrl = new URL(candidate.link);
        const publisherUrls = candidateUrl.hostname === nicheSourceHost
          ? await resolvePublisherArticles(candidate)
          : [candidate.link];
        for (const publisherUrl of publisherUrls) {
          try {
            const metadata = await linkedArticleMetadata(publisherUrl, { allowMissingImage: true });
            const articleIntro = cleanText(metadata.intro, 1_400);
            const enrichedCandidate = {
              ...candidate,
              link: metadata.url,
              articleIntro,
              imageSource: metadata.imageSource,
              imageAlt: metadata.imageAlt,
            };
            if (articleIntro.length < 80 || !sourceCandidateUsable(category, enrichedCandidate, now)) continue;
            if (metadata.title && meaningfulWordOverlap(candidate.headline, metadata.title).length < 2) continue;
            return { ...enrichedCandidate, relevanceScore: candidateRelevanceScore(enrichedCandidate, now) };
          } catch {
            // Try the next publisher result when a syndicator blocks the request.
          }
        }
        return null;
      } catch (error) {
        console.warn(`Niche article unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const valid = [];
    for (const item of enriched.filter(Boolean).sort((left, right) => right.relevanceScore - left.relevanceScore || left.order - right.order)) {
      if (valid.some((existing) => sameStoryFamily(existing, item))) continue;
      valid.push(item);
      if (valid.length === 3) break;
    }
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
        const publishedAt = topic.publishedAt ?? fallbackBrief.generatedAt;
        const priorCandidate = {
          headline: topic.title,
          articleIntro,
          publishedAt,
          imageSource: metadata.imageSource,
        };
        if (articleIntro.length < 80 || !sourceCandidateUsable(category, priorCandidate, now)) return null;
        if (metadata.title && meaningfulWordOverlap(topic.title, metadata.title).length < 2) return null;
        return {
          headline: topic.title,
          source: topic.source,
          sourceUrl: topic.url,
          link: metadata.url,
          publishedAt,
          order: topic.id,
          articleIntro,
          imageSource: metadata.imageSource,
          imageAlt: metadata.imageAlt,
          relevanceScore: candidateRelevanceScore(priorCandidate, now),
        };
      } catch (error) {
        console.warn(`Last-good niche article unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const combined = [];
    for (const item of valid.concat(prior).filter(Boolean)
      .sort((left, right) => right.relevanceScore - left.relevanceScore || String(left.order).localeCompare(String(right.order)))) {
      if (combined.some((existing) => sameStoryFamily(existing, item))) continue;
      combined.push(item);
      if (combined.length === 3) break;
    }
    return combined;
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
    sourceUrl: candidate.link,
    publishedAt: candidate.publishedAt,
    imageSource: candidate.imageSource,
    coverageCount: candidate.coverageCount,
    coverageSources: candidate.coverageSources,
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
    if (incompleteSentencePattern.test(sentence)) continue;
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
  const description = completeSentences(articleIntro, 520);
  const headlineWhyNow = /[.!?]$/.test(headline) ? headline : `${headline}.`;
  const whyNowSource = [...sentenceSegmenter.segment(articleIntro)]
    .map(({ segment }) => segment.trim())
    .filter((sentence) => sentence && !/["“][^"”]+["”]/.test(sentence))
    .sort((left, right) => {
      const score = (sentence) => Number(concreteContextPattern.test(sentence)) * 2
        + Number(attentionSignalPattern.test(sentence))
        + meaningfulWordOverlap(headline, sentence).length;
      return score(right) - score(left);
    })
    .find((sentence) => concreteContextPattern.test(sentence));
  const whyNow = completeSentences(
    concreteContextPattern.test(headline) || attentionSignalPattern.test(headline)
      ? headlineWhyNow
      : whyNowSource || headlineWhyNow,
    280,
  );
  return {
    id: record.id,
    title: headline,
    description,
    whyNow,
    url: candidate.link,
    source: candidate.source,
    sourceLabel: "Read the report",
    evidenceMode: "source-grounded",
    image: nicheImagePath(record.id),
    ...(candidate.imageSource ? {
      imageSource: candidate.imageSource,
      imageSourcePageUrl: candidate.link,
      imageAlt: candidate.imageAlt,
    } : {}),
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    ...(candidate.coverageCount ? { coverageCount: candidate.coverageCount } : {}),
    accent: fallbackTopic.accent ?? category.accent,
    trendLabel: "Reported this week",
  };
}

function retainedTopic(topic, category, index) {
  const id = topic.id || `${category.id}-${index + 1}`;
  return {
    ...topic,
    id,
    image: nicheImagePath(id),
  };
}

function persistedTopicUsable(topic) {
  return topic?.evidenceMode === "source-grounded"
    && /^https:\/\//i.test(topic.url ?? "")
    && !numberedNicheHeadlinePattern.test(topic.title ?? "")
    && !genericNicheHeadlinePattern.test(topic.title ?? "")
    && !hardMetaNicheHeadlinePattern.test(topic.title ?? "")
    && !genericNicheCopyPattern.test(`${topic.title ?? ""} ${topic.description ?? ""} ${topic.whyNow ?? ""}`)
    && concreteContextPattern.test(`${topic.description ?? ""} ${topic.whyNow ?? ""}`);
}

export async function generateNicheSnapshot(brief, { now = new Date(), dryRun = false } = {}) {
  const sourceResults = await mapConcurrent(categoryDefinitions, 4, async (category) => ({
    category,
    candidates: await categoryCandidates(category, now),
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
        && fallback.topics.slice(0, 3).every(persistedTopicUsable);
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
        topics: fallback.topics.slice(0, 3).map((topic, index) => retainedTopic(topic, category, index)),
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
