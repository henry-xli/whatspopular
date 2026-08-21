import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzipSync } from "node:zlib";
import { generateDescriptionBatch, generateQuizBatch, isDescriptionUsable } from "./ai-descriptions.mjs";
import { withHeadlessPage } from "./headless-browser.mjs";
import { linkedArticleMetadata, publicHttpsUrl, resolveGoogleNewsArticle } from "./news-article.mjs";
import { generateNicheSnapshot } from "./niche-ingestion.mjs";
import { createRateLimiter, fetchBytes, mapConcurrent } from "./runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "data", "trends.json");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const quizOnly = process.argv.includes("--quiz-only");
const refreshContextOnly = process.argv.includes("--refresh-context");
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 18_000;
const accents = ["#ffc857", "#9b8cff", "#57d5a4", "#5ab0ff", "#ff6b57"];
const wikidataPersonCache = new Map();
const wikidataResponseCache = new Map();
const scheduleWikidataRequest = createRateLimiter(500);
const aiDescriptionContexts = new WeakMap();
const quizSectionIds = ["memes", "people", "movies", "books", "news"];
const quizQuestionCount = quizSectionIds.length * 3;
const quizDurationSeconds = 15;

const allowedHosts = new Set([
  "accounts.spotify.com",
  "api.urbandictionary.com",
  "api.spotify.com",
  "commons.wikimedia.org",
  "en.wikipedia.org",
  "knowyourmeme.com",
  "news.google.com",
  "open.spotify.com",
  "openlibrary.org",
  "v3-cinemeta.strem.io",
  "trending.knowyourmeme.com",
  "trends.google.com",
  "wikimedia.org",
  "pageviews.wmcloud.org",
  "www.amazon.com",
  "datasets.imdbws.com",
  "www.bing.com",
  "html.duckduckgo.com",
  "www.billboard.com",
  "www.goodreads.com",
  "www.imdb.com",
  "www.googleapis.com",
  "www.wikidata.org",
  "www.youtube.com",
]);

const limcChannelId = "UCaHT88aobpcvRFEuy4v5Clg";
const spotifyPlaylistId = "37i9dQZF1DXcBWIGoYBM5M";
const newsTrendsUrl = "https://trends.google.com/trending?geo=US&hours=168&sort=search-volume";
const googleNewsHomeUrl = "https://news.google.com/";
const goodreadsMostReadUrl = "https://www.goodreads.com/book/most_read?category=all&country=US&duration=m";
const amazonMoverCategories = [
  ["Toys & Games", "toys-and-games"],
  ["Beauty", "beauty"],
  ["Clothing, Shoes & Jewelry", "clothing"],
  ["Home & Kitchen", "home-garden"],
  ["Electronics", "electronics"],
  ["Sports & Outdoors", "sporting-goods"],
].map(([label, slug]) => ({
  label,
  slug,
  fetchUrl: `https://www.amazon.com/gp/movers-and-shakers/${slug}`,
  url: "https://www.amazon.com/gp/movers-and-shakers",
}));
const productDiscoveryQueries = [
  "viral products",
  "products going viral social media",
  "new product launch high demand",
  "product preorders record demand",
  "product selling out backordered",
  "popular demand limited edition product",
  "viral toys collectibles squishies",
  "viral beauty skincare makeup products",
  "viral fashion bags accessories",
  "viral home kitchen products",
  "viral electronics smartphones gadgets",
  "viral drinks beverages food products",
  "viral unboxing collecting products",
  "viral product restock waitlist",
  "product launch sold out fans",
  "consumer product record sales",
  "viral product social media demand",
  "product craze shoppers collecting",
  "new product viral online this month",
  "popular product sold out social media",
  "viral gadget toy beauty product launch",
  "viral product back in stock shoppers",
  "viral drink product return",
  "viral limited edition drink",
  "viral collectible toy demand",
  "viral beauty product sold out",
  "viral phone preorder product",
  "viral toy collectors restock",
  "viral squishy toy",
  "viral collectible product",
  "viral fashion item sold out",
];
const productDiscoveryUrl = "https://news.google.com/search?q=viral+products+when%3A90d&hl=en-US&gl=US&ceid=US%3Aen";

async function fetchText(rawUrl, options = {}) {
  const { buffer } = await fetchBytes(rawUrl, {
    isAllowedHost: (hostname) => allowedHosts.has(hostname) || hostname.endsWith(".wikimedia.org"),
    kind: "source",
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    method: options.method ?? "GET",
    body: options.body,
    headers: {
      accept: "text/html,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
      ...(options.headers ?? {}),
    },
  });
  return buffer.toString("utf8");
}

async function fetchWikidataJson(rawUrl) {
  const key = String(rawUrl);
  const cached = wikidataResponseCache.get(key);
  if (cached) return cached;
  const request = scheduleWikidataRequest(async () => JSON.parse(await fetchText(rawUrl)));
  wikidataResponseCache.set(key, request);
  try {
    return await request;
  } catch (error) {
    wikidataResponseCache.delete(key);
    throw error;
  }
}

async function safely(name, work) {
  try {
    return { name, ok: true, value: await work(), checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      name,
      ok: false,
      value: null,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
    };
  }
}

function rememberAiDescriptionContext(item, sectionId, snippets) {
  if (!item || typeof item !== "object") return item;
  const normalized = (Array.isArray(snippets) ? snippets : [])
    .map((snippet) => ({
      kind: plainText(snippet?.kind ?? "reference").slice(0, 40) || "reference",
      source: plainText(snippet?.source ?? "Validated context").slice(0, 120) || "Validated context",
      text: plainText(snippet?.text ?? "").slice(0, 900),
      ...(snippet?.publishedAt ? { publishedAt: plainText(snippet.publishedAt).slice(0, 60) } : {}),
    }))
    .filter((snippet) => snippet.text);
  aiDescriptionContexts.set(item, { sectionId, snippets: normalized });
  return item;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&(?:lsquo|rsquo);/gi, "’")
    .replace(/&(?:ldquo|rdquo);/gi, "”")
    .replace(/&hellip;/gi, "…")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "�";
    });
}

function plainText(value) {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value) {
  return normalize(value).replace(/\s+/g, "-").slice(0, 64) || "item";
}

function formatCompact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(Math.round(value));
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function googleTrendsExploreUrl(titles, range) {
  const url = new URL("https://trends.google.com/trends/explore");
  url.searchParams.set("date", range);
  url.searchParams.set("geo", "US");
  url.searchParams.set("q", titles.join(","));
  return url.toString();
}

function parseViewCount(value) {
  const match = String(value).match(/([0-9.]+)\s*([KMB])?\s+views?/i);
  if (!match) return 0;
  return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] ?? 1);
}

function previousCompleteMonth(offset = 0) {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1 - offset);
  return {
    month: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date),
    monthNumber: String(date.getUTCMonth() + 1).padStart(2, "0"),
    year: date.getUTCFullYear(),
  };
}

function percentage(text) {
  const match = text.match(/(?:(just over|about|around|roughly)\s+)?([0-9]+(?:\.[0-9]+)?)\s+percent/i);
  if (!match) return undefined;
  return `${match[1]?.toLowerCase() === "just over" ? ">" : ""}${match[2]}%`;
}

function parseMemeResult(html, month, year, resultUrl) {
  const body = html.slice(html.indexOf('<div class="body">'));
  const winnerLead = body.match(/winner of [^<]{0,80}?with ([^<]+?) percent[^<]*<\/p>/i);
  const winnerEnd = winnerLead ? winnerLead.index + winnerLead[0].length : 0;
  const winnerArea = body.slice(winnerEnd, winnerEnd + 7000);
  const winnerLink = winnerArea.match(/href="(https:\/\/knowyourmeme\.com\/memes\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!winnerLead || !winnerLink) throw new Error("Could not parse the Meme of the Month winner");

  const candidates = [{
    rank: 1,
    title: plainText(winnerLink[2]).replace(/[!?.]+$/, ""),
    url: winnerLink[1],
    vote: percentage(`with ${winnerLead[1]} percent`),
  }];
  const placeRanks = { second: 2, third: 3, fourth: 4, fifth: 5 };
  for (const match of body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>\s*<p>([\s\S]*?)<\/p>/gi)) {
    const title = plainText(match[1]);
    const context = plainText(match[2]);
    const place = context.match(/\b(second|third|fourth|fifth) place\b/i)?.[1]?.toLowerCase();
    const link = match[2].match(/href="(https:\/\/knowyourmeme\.com\/memes\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!place || !link) continue;
    candidates.push({ rank: placeRanks[place], title, url: link[1], vote: percentage(context) });
  }

  const lower = body.match(/<p>In sixth place[\s\S]*?in 10th\.<\/p>/i)?.[0];
  if (lower) {
    const links = [...lower.matchAll(/href="(https:\/\/knowyourmeme\.com\/memes\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    links.slice(0, 5).forEach((link, index) => candidates.push({
      rank: index + 6,
      title: plainText(link[2]),
      url: link[1],
      vote: index === 0 ? percentage(plainText(lower)) : undefined,
    }));
  }

  const remaining = body.match(/<p>Coming in 11th place[\s\S]*?<\/p>/i)?.[0];
  if (remaining) {
    const links = [...remaining.matchAll(/href="(https:\/\/knowyourmeme\.com\/memes\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
    links.forEach((link, index) => candidates.push({
      rank: index + 11,
      title: plainText(link[2]),
      url: link[1],
    }));
  }

  const unique = [...new Map(candidates.sort((a, b) => a.rank - b.rank).map((item) => [item.rank, item])).values()];
  if (unique.length < 5) throw new Error(`Only parsed ${unique.length} Meme of the Month candidates`);
  return { month, year, label: `${month} ${year}`, resultUrl, candidates: unique };
}

async function latestMemeResult() {
  let lastError;
  for (let offset = 0; offset < 3; offset += 1) {
    const { month, year } = previousCompleteMonth(offset);
    const slug = `${month.toLowerCase()}-${year}s-meme-of-the-month`;
    for (const category of ["meme-review", "poll"]) {
      const url = `https://knowyourmeme.com/editorials/${category}/see-the-winner-of-${slug}`;
      try {
        return parseMemeResult(await fetchText(url), month, year, url);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError ?? new Error("No completed Meme of the Month result was available");
}

function collectLockups(rootValue) {
  const videos = [];
  const seen = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    const lockup = value.lockupViewModel;
    if (lockup?.contentId && !seen.has(lockup.contentId)) {
      const metadata = lockup.metadata?.lockupMetadataViewModel;
      const parts = metadata?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap((row) => row.metadataParts?.map((part) => part.text?.content) ?? []) ?? [];
      seen.add(lockup.contentId);
      videos.push({
        id: lockup.contentId,
        title: metadata?.title?.content ?? "",
        views: parseViewCount(parts.join(" ")),
        age: parts.at(-1) ?? "",
      });
    }
    for (const child of Object.values(value)) walk(child);
  };
  walk(rootValue);
  return videos;
}

function continuationToken(value) {
  let token = "";
  const walk = (candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    const next = candidate.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (next?.length > token.length) token = next;
    for (const child of Object.values(candidate)) walk(child);
  };
  walk(value);
  return token;
}

function isWithinTwoMonths(video) {
  return !/(?:3|4|5|6|7|8|9|10|11|12) months? ago|years? ago/i.test(video.age);
}

async function lessonsInMemeCultureRecentHtml() {
  const html = await fetchText("https://www.youtube.com/@LIMC/videos", { headers: { "user-agent": "Mozilla/5.0" } });
  const initialRaw = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1]
    ?? html.match(/window\["ytInitialData"\] = (\{.*?\});/s)?.[1];
  if (!initialRaw) throw new Error("YouTube did not expose its initial video data");
  const initial = JSON.parse(initialRaw);
  const videos = collectLockups(initial);
  let token = continuationToken(initial);
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  for (let page = 0; token && key && version && page < 6; page += 1) {
    const continuation = JSON.parse(await fetchText(`https://www.youtube.com/youtubei/v1/browse?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: version } }, continuation: token }),
    }));
    const pageVideos = collectLockups(continuation);
    videos.push(...pageVideos);
    token = continuationToken(continuation);
    if (pageVideos.length && pageVideos.every((video) => !isWithinTwoMonths(video))) break;
  }
  return [...new Map(videos.filter(isWithinTwoMonths).map((video) => [video.id, video])).values()];
}

async function lessonsInMemeCultureRecentApi(apiKey) {
  const channelUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  channelUrl.search = new URLSearchParams({
    part: "contentDetails",
    id: limcChannelId,
    key: apiKey,
  });
  const channel = JSON.parse(await fetchText(channelUrl));
  const uploads = channel.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("YouTube Data API returned no LIMC uploads playlist");

  const cutoff = Date.now() - 62 * 86_400_000;
  const videos = [];
  let pageToken;
  for (let page = 0; page < 4; page += 1) {
    const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    playlistUrl.search = new URLSearchParams({
      part: "snippet,contentDetails",
      playlistId: uploads,
      maxResults: "50",
      key: apiKey,
      ...(pageToken ? { pageToken } : {}),
    });
    const payload = JSON.parse(await fetchText(playlistUrl));
    const pageItems = (payload.items ?? []).map((item) => ({
      id: item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId,
      title: item.snippet?.title ?? "",
      publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt,
      views: 0,
      age: "",
    })).filter((video) => video.id && Number.isFinite(Date.parse(video.publishedAt)));
    videos.push(...pageItems.filter((video) => Date.parse(video.publishedAt) >= cutoff));
    if (!payload.nextPageToken || pageItems.some((video) => Date.parse(video.publishedAt) < cutoff)) break;
    pageToken = payload.nextPageToken;
  }
  if (!videos.length) throw new Error("YouTube Data API returned no LIMC uploads from the past two months");
  return videos;
}

async function lessonsInMemeCultureRecent() {
  if (process.env.YOUTUBE_API_KEY) {
    try {
      return await lessonsInMemeCultureRecentApi(process.env.YOUTUBE_API_KEY);
    } catch (error) {
      console.warn(`YouTube Data API fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lessonsInMemeCultureRecentHtml();
}

function memeVideoMatch(candidate, videos, context = "") {
  const stop = new Set([
    "about", "also", "based", "became", "character", "during", "example", "from", "image", "images", "internet",
    "late", "laugh", "laughing", "media", "meme", "memes", "month", "online", "people", "refers", "series", "social",
    "spread", "still", "term", "that", "their", "these", "this", "trend", "used", "video", "viral", "with", "yourrage",
  ]);
  const meaningfulTokens = (value) => normalize(value).split(" ").filter((token) => token.length >= 3 && !stop.has(token));
  const titleTokens = meaningfulTokens(candidate.title);
  const contextTokens = meaningfulTokens(context);
  const direct = videos.find((video) => {
    const videoTokens = new Set(meaningfulTokens(video.title));
    const titleShared = titleTokens.filter((token) => videoTokens.has(token));
    return titleShared.length >= 2 || titleShared.some((token) => token.length >= 6) || (titleTokens.length === 1 && titleShared.length === 1);
  });
  if (direct) return direct;
  const contextPhrases = new Set(contextTokens.slice(0, -1)
    .map((token, index) => `${token} ${contextTokens[index + 1]}`)
    .filter((phrase) => phrase.replace(" ", "").length >= 8));
  return videos.find((video) => {
    const videoTokens = meaningfulTokens(video.title);
    return videoTokens.slice(0, -1).some((token, index) => contextPhrases.has(`${token} ${videoTokens[index + 1]}`));
  });
}

function sentenceList(value) {
  return value.match(/[^.!?]+(?:[.!?]+["”']?|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function cleanKymSentence(value) {
  return value
    .replace(/\bTikTokers?\b/gi, "creators")
    .replace(/\bTikTok\b/gi, "social media")
    .replace(/\s*,\s*also known(?: simply)? as[\s\S]*?\s*,\s*(?=refers to|is|are)/i, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function conciseKymDescription(html) {
  const about = html.match(/<h2[^>]*id=['"]about['"][^>]*>[\s\S]*?<\/h2>([\s\S]*?)(?=<h2\b)/i)?.[1];
  if (!about) throw new Error("Know Your Meme entry had no About section");
  const paragraphs = [...about.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => plainText(match[1]))
    .filter((text) => text.length > 20);
  const sentences = paragraphs.flatMap(sentenceList).map(cleanKymSentence);
  const context = sentences[0];
  const usageCandidates = sentences.slice(1);
  const usage = usageCandidates.find((sentence) => /\b(?:used|uses|use|caption|reaction|template|format|joke|parody|inspires?|inspired|inspiring)\b/i.test(sentence))
    ?? usageCandidates.find((sentence) => /\b(?:animation|animations|remix|remixes|edit|edits)\b/i.test(sentence))
    ?? usageCandidates.find((sentence) => /\b(?:meme|memes|fan art|edits)\b/i.test(sentence))
    ?? usageCandidates.find((sentence) => /\b(?:viral|spread)\b/i.test(sentence));
  if (!context) throw new Error("Know Your Meme entry had no usable description");
  return [context, usage && usage !== context ? usage : null].filter(Boolean).join(" ");
}

function acronymDefinitions(title, html) {
  const terms = title.split(/\s+/).filter((term) => /^[A-Z]{2,}$/.test(term));
  if (terms.length < 2) return "";
  const about = plainText(html.match(/<h2[^>]*id=['"]about['"][^>]*>[\s\S]*?<\/h2>([\s\S]*?)(?=<h2\b)/i)?.[1] ?? "");
  const expansions = terms.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = about.match(new RegExp(`\\b${escaped}\\b(?:,\\s+which)?\\s+means\\s+["“]([^"”]+)`, "i"));
    const definition = match?.[1]?.replace(/[,.;:\s]+$/, "");
    return definition ? `${term} means “${definition}”` : null;
  });
  if (expansions.some((definition) => !definition)) return "";
  return `${expansions.length === 2
    ? expansions.join("; and ")
    : `${expansions.slice(0, -1).join("; ")}; and ${expansions.at(-1)}`}.`;
}

function kymMatchContext(html) {
  const about = html.match(/<h2[^>]*id=['"]about['"][^>]*>[\s\S]*?<\/h2>([\s\S]*?)(?=<h2\b)/i)?.[1] ?? "";
  return plainText(about);
}

async function updateMemes(brief, result, videos) {
  const section = brief.sections.find((entry) => entry.id === "memes");
  if (!section) return;
  if (dryRun) console.log(`Recent LIMC uploads: ${videos.map((video) => video.title).join(" | ")}`);
  if (dryRun) console.log(`Poll order: ${result.candidates.map((candidate) => `#${candidate.rank} ${candidate.title}`).join(" | ")}`);
  const currentByUrl = new Map([...section.items, ...(section.moreItems ?? [])].map((item) => [item.url, item]));
  const pollMatches = [];
  for (let index = 0; index < result.candidates.length; index += 4) {
    const batch = await mapConcurrent(result.candidates.slice(index, index + 4), 4, async (candidate) => {
      const html = await fetchText(candidate.url);
      const video = memeVideoMatch(candidate, videos, kymMatchContext(html));
      return video ? { candidate, video, description: conciseKymDescription(html) } : null;
    });
    pollMatches.push(...batch.filter(Boolean));
    if (pollMatches.length >= 10) break;
  }
  pollMatches.length = Math.min(pollMatches.length, 10);
  if (dryRun) console.log(`Poll matches: ${pollMatches.map((entry) => `${entry.candidate.title} ↔ ${entry.video.title}`).join(" | ")}`);
  const ordered = pollMatches.slice(0, 5);
  if (dryRun) console.log(`Meme cross-check: ${ordered.map((entry) => `${entry.candidate.title} ↔ ${entry.video.title}`).join(" | ")}`);
  if (ordered.length < 5) throw new Error(`Only ${ordered.length} poll memes had a matching LIMC upload from the past two months`);
  if (pollMatches.length < 6) throw new Error("No additional poll meme had a matching recent LIMC upload");

  section.eyebrow = `${result.label} · latest complete month`;
  section.description = `The ${result.month} Meme of the Month results, kept in poll order and filtered to memes Lessons in Meme Culture covered in any upload from the past two months.`;
  section.sources = [
    { label: `Know Your Meme · ${result.month} result`, url: result.resultUrl },
    { label: "Lessons in Meme Culture · past 2 months", url: "https://www.youtube.com/@LIMC/videos" },
  ];
  section.items = ordered.map(({ candidate, video, description }, index) => {
    const current = currentByUrl.get(candidate.url);
    const title = candidate.title;
    return {
      rank: index + 1,
      title,
      subtitle: `${result.month} poll finalist · LIMC covered`,
      description,
      image: current?.image ?? `/culture/meme-${slugify(title)}.webp`,
      alt: current?.alt ?? `Visual example of the ${title} meme`,
      url: candidate.url,
      source: "Know Your Meme",
      metric: { label: `${result.month} Meme of the Month`, value: `#${candidate.rank}` },
      evidence: [
        { source: `Know Your Meme ${result.month} result`, url: result.resultUrl },
        { source: "Lessons in Meme Culture", url: `https://www.youtube.com/watch?v=${video.id}` },
      ],
      accent: current?.accent ?? accents[index],
    };
  });
  section.moreItems = pollMatches.slice(5, 10).map(({ candidate, video, description }, index) => {
    const current = currentByUrl.get(candidate.url);
    const title = candidate.title;
    return {
      rank: index + 6,
      title,
      subtitle: `${result.month} poll finalist · LIMC covered`,
      description,
      image: current?.image ?? `/culture/meme-${slugify(title)}.webp`,
      alt: current?.alt ?? `Visual example of the ${title} meme`,
      url: candidate.url,
      source: "Know Your Meme",
      metric: { label: `${result.month} Meme of the Month`, value: `#${candidate.rank}` },
      evidence: [
        { source: `Know Your Meme ${result.month} result`, url: result.resultUrl },
        { source: "Lessons in Meme Culture", url: `https://www.youtube.com/watch?v=${video.id}` },
      ],
      accent: current?.accent ?? accents[(index + 5) % accents.length],
    };
  });
  section.moreLabel = `Show ranks 6–${section.moreItems.at(-1).rank}`;
}

function parseAnnualSlangReview(html) {
  const headings = [...html.matchAll(/<h2\b[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h2>/gi)];
  const candidates = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = plainText(headings[index][2]);
    const body = html.slice((headings[index].index ?? 0) + headings[index][0].length, headings[index + 1]?.index ?? html.length);
    const headingTokens = topicTokens(heading);
    const links = [...body.matchAll(/<a\b[^>]*href=["'](https:\/\/knowyourmeme\.com\/memes\/[^"']+|\/memes\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match, linkIndex) => {
        const text = plainText(match[2]);
        const url = new URL(match[1], "https://knowyourmeme.com").href;
        const overlap = overlapCount(headingTokens, topicTokens(`${text} ${url.split("/").at(-1)}`));
        const exact = normalize(text) === normalize(heading);
        const sectionPenalty = /\/memes\/(?:cultures|people|sites)\//i.test(url) ? 80 : 0;
        return { text, url, linkIndex, score: (exact ? 100 : 0) + overlap * 24 - linkIndex - sectionPenalty };
      })
      .filter((link) => link.text && link.score > 0)
      .sort((left, right) => right.score - left.score);
    const primary = links[0];
    if (!primary) continue;
    const title = !heading.includes("/") && primary.text.split(/\s+/).length > heading.split(/\s+/).length
      ? primary.text
      : heading;
    candidates.push({ title, url: primary.url, urbanTerm: primary.text });
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
  if (unique.length < 5) throw new Error(`Know Your Meme annual review exposed only ${unique.length} slang entries`);
  return unique;
}

async function latestAnnualSlangReview() {
  const year = new Date().getUTCFullYear();
  let lastError;
  for (const candidateYear of [year, year - 1, year - 2]) {
    const url = `https://trending.knowyourmeme.com/editorials/meme-review/kym-review-the-top-slang-terms-of-${candidateYear}`;
    try {
      const html = await fetchText(url);
      return { year: candidateYear, url, candidates: parseAnnualSlangReview(html) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No recent Know Your Meme annual slang review was available");
}

async function verifyUrbanDictionary(items) {
  const pairs = await mapConcurrent(items, 4, async (item) => {
    const words = item.title.split(/\s+/).filter(Boolean);
    const withoutGenericNouns = words.filter((word) => !/^(?:emoji|meme|slang|term)$/i.test(word)).join(" ");
    const variants = [...new Set([
      item.urbanTerm,
      item.title,
      withoutGenericNouns,
      words.slice(0, 2).join(" "),
      words[0],
    ].filter(Boolean))];
    for (const term of variants) {
      const payload = JSON.parse(await fetchText(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`));
      if (Array.isArray(payload.list) && payload.list.length > 0) return [item.title, term];
    }
    return [item.title, null];
  });
  const terms = Object.fromEntries(pairs);
  const missing = items.filter((item) => !terms[item.title]).map((item) => item.title);
  if (missing.length) throw new Error(`Urban Dictionary had no result for: ${missing.join(", ")}`);
  return terms;
}

async function knowYourMemeSlangDetails(items) {
  const pairs = await mapConcurrent(items, 4, async (item) => {
    const html = await fetchText(item.url);
    const raw = html.match(/<dd\s+class=['"]views['"]\s+title=['"]([0-9,]+)\s+Views['"]/i)?.[1];
    if (!raw) throw new Error(`Know Your Meme exposed no page-view count for ${item.title}`);
    const definitions = acronymDefinitions(item.title, html);
    return [item.title, {
      description: conciseSentences(`${definitions} ${conciseKymDescription(html)}`, 320),
      views: Number(raw.replaceAll(",", "")),
    }];
  });
  return Object.fromEntries(pairs);
}

function updateSlang(brief, review, details, urbanTerms) {
  const section = brief.sections.find((entry) => entry.id === "slang");
  if (!section) return;
  const currentItems = [...section.items, ...(section.moreItems ?? [])];
  const currentByTitle = new Map(currentItems.map((item) => [normalize(item.title), item]));
  const currentByUrl = new Map(currentItems.map((item) => [item.url, item]));
  const ranked = review.candidates
    .filter((item) => Number.isFinite(details[item.title]?.views))
    .sort((left, right) => details[right.title].views - details[left.title].views);
  if (ranked.length !== review.candidates.length) {
    throw new Error("At least one annual slang term had no Know Your Meme page-view count");
  }
  const allItems = ranked.map((candidate, index) => {
    const current = currentByUrl.get(candidate.url) ?? currentByTitle.get(normalize(candidate.title));
    const urbanTerm = urbanTerms[candidate.title];
    return {
      rank: index + 1,
      title: candidate.title,
      subtitle: `${review.year} annual review term`,
      description: details[candidate.title].description,
      image: current?.image ?? `/culture/slang-${slugify(candidate.title)}.webp`,
      alt: current?.alt ?? `Visual example of ${candidate.title}`,
      url: candidate.url,
      source: "Know Your Meme",
      metric: { label: "Know Your Meme page views", value: formatInteger(details[candidate.title].views) },
      evidence: [
        { source: "Know Your Meme entry", url: candidate.url },
        { source: "Urban Dictionary", url: `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(urbanTerm)}` },
      ],
      accent: accents[index % accents.length],
    };
  });
  section.eyebrow = `${review.year} annual slang review · by page views`;
  section.description = "Terms from Know Your Meme's latest annual slang review, ranked from most to least lifetime views on their Know Your Meme entries and checked against Urban Dictionary.";
  section.sources = [
    { label: `Know Your Meme · ${review.year} annual slang review`, url: review.url },
    {
      label: `Urban Dictionary · ${ranked[0].title}`,
      url: `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(urbanTerms[ranked[0].title])}`,
    },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = `Show ranks 6–${allItems.length} by page views`;
}

function parseGoodreadsBooks(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*itemscope[^>]*itemtype=["']http:\/\/schema\.org\/Book["'][^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1])
    .map((row) => {
      const rank = Number(plainText(row.match(/<td[^>]*class=["']number["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? ""));
      const title = plainText(row.match(/<a[^>]*class=["']bookTitle["'][^>]*>[\s\S]*?<span[^>]*itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
      const href = row.match(/<a[^>]*class=["']bookTitle["'][^>]*itemprop=['"]url['"][^>]*href=["']([^"']+)/i)?.[1];
      const url = href ? new URL(href, goodreadsMostReadUrl).href : "";
      const author = plainText(row.match(/itemprop=['"]author['"][\s\S]*?itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
      const image = row.match(/<img[^>]*itemprop=["']image["'][^>]*src=["']([^"']+)/i)?.[1] ?? "";
      const rating = Number(plainText(row).match(/([0-5](?:\.\d{1,2})?)\s+avg rating/i)?.[1] ?? "0");
      const readers = Number((plainText(row).match(/([\d,]+)\s+people read it/i)?.[1] ?? "0").replaceAll(",", ""));
      return {
        rank,
        title,
        author,
        rating,
        readers,
        image: image.replace(/\._S(?:Y|X)\d+_\./, "."),
        url,
      };
    })
    .filter((book) => Number.isInteger(book.rank) && book.rank > 0
      && book.title && book.author && book.rating > 0 && book.rating <= 5 && book.readers > 0
      && /^https:\/\/www\.goodreads\.com\/book\/show\//.test(book.url)
      && /^https:\/\/i\.gr-assets\.com\//.test(book.image));
  const unique = [...new Map(rows.map((book) => [book.url, book])).values()]
    .sort((left, right) => left.rank - right.rank);
  if (unique.length < 10) throw new Error(`Goodreads exposed only ${unique.length} usable monthly books`);
  return unique.slice(0, 10);
}

async function goodreadsMostRead() {
  try {
    const html = await fetchText(goodreadsMostReadUrl, {
      headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
    });
    return { url: goodreadsMostReadUrl, books: parseGoodreadsBooks(html) };
  } catch (error) {
    const cached = brief?.sections?.find((section) => section.id === "books");
    const cachedItems = [...(cached?.items ?? []), ...(cached?.moreItems ?? [])];
    if (cachedItems.length < 10) throw error;
    console.warn(`Goodreads unavailable; retaining the last validated books snapshot: ${error instanceof Error ? error.message : String(error)}`);
    return {
      url: goodreadsMostReadUrl,
      stale: true,
      books: cachedItems.map((item) => ({
        title: item.title,
        author: item.subtitle.replace(/^Goodreads\s*·\s*/i, "") || "Unknown author",
        url: item.url,
        image: item.imageSource,
        readers: Number(String(item.metric?.value ?? "0").replaceAll(",", "")),
        rating: Number(item.rating),
      })),
    };
  }
}

function metaContent(html, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const key = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (!wanted.has(key)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return plainText(content);
  }
  return "";
}

function goodreadsPlotDescription(html) {
  const marker = html.search(/data-testid=["']description["']/i);
  const pageDescription = marker >= 0
    ? html.slice(marker, marker + 24_000).match(/<span[^>]*class=["']Formatted["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]
    : "";
  const description = cleanGoodreadsPremise(
    plainText(pageDescription || metaContent(html, ["og:description"]) || metaContent(html, ["description"])).slice(0, 4_000),
  );
  if (!description || description.length < 60
    || /^(?:[^.]{1,100}\s+)?is a book by\b/i.test(description)
    || /\b(?:before I read (?:his|her|their) (?:novels|books?)|I fell in love with (?:creative writing|reading)|read [\d,.]+[km]? reviews?|site is protected|world(?:'|’)?s largest community for readers)\b/i.test(description)) return "";
  return description;
}

function cleanGoodreadsPremise(value) {
  let description = value;
  const quote = description.search(/[“\"]\s*\S/);
  if (quote > 40 && /(?:award|nominee|winner|bestselling|new york times)/i.test(description.slice(0, quote))) {
    description = description.slice(quote).trim();
  }
  description = description
    .replace(/^From\s+[^.!?]{1,180},\s+(?:comes|is)\s+/i, "")
    .replace(/^The acclaimed,?\s+(?:prize-winning\s+)?[^.!?]{1,160}\s+returns with\s+/i, "")
    .replace(/^\s*\*{2,}[^*\n]{10,240}\*{2,}\s*/s, "")
    .replace(/^\s*(?:\*{0,3}["“'])(?=[A-Z])[^\n]{20,320}?(?:["”']\*{0,3})\s*/s, "")
    .trim();
  return description;
}

const bookIdentityPattern = /\b(?:is|was) (?:a|an) (?:novel|book|series|work)\b/i;
const bookBoilerplatePattern = /\b(?:this site is protected|goodreads choice award|nominee|new york times bestselling author|first began writing|joined forces to write|self[- ]published|republished by|published by|the author)\b/i;
const bookMarketingPattern = /^\s*(?:a|an|the)\s+(?:acclaimed|darkly|funny|gripping|haunting|heart|luminous|moving|new|prize|romantic|thrilling|twist)\b/i;
const plotTurnPattern = /\b(?:after|arrives?|but|discovers?|falls?|forced|must|one morning|returns?|sent|stranded|then|until|wakes?|where|while|when)\b/i;
const plotSpecificityPattern = /\b(?:\d{4}|century|dungeon|escape|family|forgiveness|game show|husband|investigat|letters?|marriage|murder|mystery|revolution|social media|surviv|time travel|timeline|wakes? up|war|wife)\b/i;
const plotPriorityPattern = /\b(?:century|escape|game show|murder|sent|surviv|time travel|wakes?|wedding|wife)\b/i;

function plotPremise(value, maxLength = 420) {
  let parts = sentences(value)
    .filter((sentence) => sentence.length >= 24)
    .filter((sentence) => !/^\s*(?:goodreads choice award|nominee|from [^.!?]{1,160}(?:bestselling|new york times))\b/i.test(sentence));
  if (!parts.length) return "";
  if (parts.length > 1 && parts[0].length < 48 && !plotTurnPattern.test(parts[0])) parts = parts.slice(1);
  const narrative = parts.filter((sentence) => !bookIdentityPattern.test(sentence) || plotTurnPattern.test(sentence) || plotSpecificityPattern.test(sentence))
    .filter((sentence) => !bookMarketingPattern.test(sentence) || parts.length === 1)
    .filter((sentence) => !/^\s*["“].*["”]\s*$/.test(sentence) || parts.length === 1);
  const usable = narrative.length ? narrative : parts;
  const turnIndex = usable.slice(1).findIndex((sentence) => plotTurnPattern.test(sentence));
  const specificityIndex = turnIndex < 0
    ? usable.slice(1).findIndex((sentence) => plotSpecificityPattern.test(sentence))
    : -1;
  const pivotIndex = turnIndex >= 0 ? turnIndex + 1 : specificityIndex >= 0 ? specificityIndex + 1 : -1;
  const ordered = [usable[0], ...(pivotIndex >= 0 ? [usable[pivotIndex]] : []), ...usable.slice(1).filter((_, index) => index + 1 !== pivotIndex)];
  const selected = [];
  for (const sentence of ordered) {
    if (selected.includes(sentence)) continue;
    const candidate = `${selected.join(" ")} ${sentence}`.trim();
    if (candidate.length > maxLength && selected.length) continue;
    selected.push(sentence);
    if (selected.length >= 3) break;
  }
  return conciseSentences(selected.join(" "), maxLength);
}

function bookPremiseDescription(...descriptions) {
  const candidates = descriptions
    .map((description, index) => ({
      index,
      premise: plotPremise(cleanGoodreadsPremise(description ?? "")),
    }))
    .filter(({ premise }) => premise.length >= 60
      && !/^\s*(?:goodreads choice award|winner|nominee|from [^.!?]{1,160}(?:bestselling|new york times)|the acclaimed|the prize-winning)\b/i.test(premise))
    .map((candidate) => ({
      ...candidate,
      score: candidate.premise.length
        + ([90, 70, 25, -20][candidate.index] ?? 0)
        + (plotTurnPattern.test(candidate.premise) ? 90 : 0)
        + (plotSpecificityPattern.test(candidate.premise) ? 120 : 0)
        + (plotPriorityPattern.test(candidate.premise) ? 180 : 0)
        + Math.min(sentences(candidate.premise).length, 3) * 8
        - (/^\s*(?:["“]|\*{1,3}["'])/.test(candidate.premise) ? 200 : 0)
        - (bookIdentityPattern.test(candidate.premise) && !plotTurnPattern.test(candidate.premise) ? 220 : 0)
        - (bookBoilerplatePattern.test(candidate.premise) ? 140 : 0),
    }))
    .sort((left, right) => right.score - left.score);
  const best = candidates[0]?.premise ?? "";
  if (!best) return "";
  const detailPattern = /\b(?:century|sent back|time travel)\b/i;
  const detail = candidates
    .map((candidate) => candidate.premise)
    .filter((premise) => !detailPattern.test(best) && detailPattern.test(premise))
    .flatMap((premise) => sentences(premise))
    .find((sentence) => detailPattern.test(sentence));
  const merged = detail ? conciseSentences(`${detail} ${best}`, 420) : best;
  const mergedParts = sentences(merged);
  const unquoted = mergedParts.length > 1 && /^\s*["“]/.test(mergedParts[0])
    ? mergedParts.slice(1).join(" ")
    : merged;
  return unquoted.replace(/^\s*["“][\s\S]*?["”]\s*/s, "").trim();
}

async function goodreadsBookContext(book) {
  try {
    const html = await fetchText(book.url, {
      headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
    });
    const description = goodreadsPlotDescription(html);
    return description ? { description, pageUrl: book.url } : null;
  } catch {
    return null;
  }
}

function goodreadsBodyDescription(body) {
  const marker = body.indexOf("Rate this book");
  const end = marker >= 0 ? body.indexOf("Show more", marker) : -1;
  const block = marker >= 0 ? body.slice(marker + "Rate this book".length, end > marker ? end : marker + 3_000) : body;
  const description = cleanGoodreadsPremise(plainText(block).slice(0, 4_000));
  return description.length >= 60 && !/\b(?:before I read (?:his|her|their) (?:novels|books?)|I fell in love with (?:creative writing|reading)|ratings?|reviews?|want to read|kindle unlimited|genres?|site is protected)\b/i.test(description)
    ? description
    : "";
}

async function goodreadsBookContexts(books) {
  const contexts = await mapConcurrent(books, 3, goodreadsBookContext);
  const missing = books.map((book, index) => ({ book, index })).filter(({ index }) => !contexts[index]);
  if (!missing.length) return contexts;
  try {
    await withHeadlessPage({
      allowedHosts: new Set(["www.goodreads.com"]),
      work: async (page) => {
        for (const { book, index } of missing) {
          try {
            await page.navigate(book.url, 1_000);
          } catch {
            // Goodreads can keep third-party requests open after its content is ready.
          }
          const body = await page.evaluate("document.body?.innerText || \"\"").catch(() => "");
          const description = goodreadsBodyDescription(body);
          if (description) contexts[index] = { description, pageUrl: book.url };
        }
      },
    });
  } catch {
    // Keep the non-browser fallbacks when Goodreads' anti-bot challenge is unavailable.
  }
  return contexts;
}

function googleNewsSearchUrl(query) {
  const url = new URL("https://news.google.com/search");
  url.search = new URLSearchParams({ q: query, hl: "en-US", gl: "US", ceid: "US:en" });
  return url.href;
}

async function bookWikipediaContext(book) {
  const pages = await wikipediaSearch(book.title).catch(() => []);
  const titleKeys = [book.title, book.title.replace(/\s*\([^)]*\)\s*$/, "")]
    .map(normalize)
    .filter(Boolean);
  const exact = pages.find((page) => {
    const pageTitle = normalize(page.title);
    const extract = page.extract ?? "";
    const titleMatch = titleKeys.some((key) => pageTitle === key
      || (pageTitle.startsWith(`${key} `) && /\b(?:book|novel|short story)\b/i.test(pageTitle)));
    const unrelated = /\b(?:may refer to|disambiguation|was a rock band|television sitcom|american actor|is any disturbed state|is a journalist who|is a type of weather)\b/i.test(extract);
    return titleMatch && !unrelated;
  });
  return exact?.extract && exact.fullurl ? { extract: conciseSentences(exact.extract, 240), pageUrl: exact.fullurl } : null;
}

const openLibraryBookCache = new Map();

async function openLibraryBookContext(book) {
  const key = normalize(`${book.title} ${book.author}`);
  if (openLibraryBookCache.has(key)) return openLibraryBookCache.get(key);
  const request = (async () => {
    const searchUrl = new URL("https://openlibrary.org/search.json");
    searchUrl.search = new URLSearchParams({
      title: book.title.replace(/\s*\([^)]*\)\s*$/, ""),
      author: book.author,
      limit: "5",
      fields: "title,author_name,description,first_sentence,key",
    });
    const payload = JSON.parse(await fetchText(searchUrl));
    const titleKey = normalize(book.title.replace(/\s*\([^)]*\)\s*$/, ""));
    const authorKey = normalize(book.author);
    const match = (payload.docs ?? []).find((doc) => normalize(doc.title ?? "") === titleKey
      && (doc.author_name ?? []).some((author) => normalize(author).includes(authorKey) || authorKey.includes(normalize(author))));
    if (!match?.key) return null;
    let description = match.description;
    if (Array.isArray(description)) description = description[0];
    if (description && typeof description === "object") description = description.value;
    let workUrl = `https://openlibrary.org${match.key}`;
    if (!description) {
      const work = JSON.parse(await fetchText(`${workUrl}.json`).catch(() => "{}"));
      description = work.description;
      if (description && typeof description === "object") description = description.value;
      if (!description && work.first_sentence) {
        description = typeof work.first_sentence === "object" ? work.first_sentence.value : work.first_sentence;
      }
    }
    const premise = plainText(description ?? match.first_sentence?.[0] ?? "").slice(0, 4_000);
    return premise.length >= 45 ? { description: premise, pageUrl: workUrl } : null;
  })().catch(() => null);
  openLibraryBookCache.set(key, request);
  return request;
}

function bookDescription(book, wikipedia, context, goodreads, openLibrary, article, fallback) {
  return bookPremiseDescription(
    goodreads?.description,
    openLibrary?.description,
    wikipedia?.extract,
    article?.intro,
    fallback,
  ) || ensureSentence(`${book.title} is a book by ${book.author}`);
}

async function updateBooks(brief, result) {
  const section = brief.sections.find((entry) => entry.id === "books");
  if (!section) return;
  const books = result.books;
  const [contexts, wikipedia, openLibrary] = await Promise.all([
    mapConcurrent(books, 4, (book) => googleNewsContext(`"${book.title}" "${book.author}"`, 90, { requireEvent: true }).catch(() => null)),
    mapConcurrent(books, 4, bookWikipediaContext),
    mapConcurrent(books, 1, openLibraryBookContext),
  ]);
  const goodreads = await goodreadsBookContexts(books);
  // Goodreads, Open Library, and Wikipedia already provide the authoritative
  // plot premise; avoid spending the daily refresh budget resolving unrelated
  // news search results for every book.
  const articles = books.map(() => null);
  const currentByUrl = new Map([...section.items, ...(section.moreItems ?? [])].map((item) => [item.url, item]));
  const currentByTitle = new Map([...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]));
  const allItems = books.map((book, index) => {
    const current = currentByUrl.get(book.url) ?? currentByTitle.get(normalize(book.title));
    const context = contexts[index];
    const wiki = wikipedia[index];
    const goodreadsContext = goodreads[index];
    const openLibraryContext = openLibrary[index];
    const article = articles[index];
    const newsUrl = article?.url ?? context?.link ?? googleNewsSearchUrl(`${book.title} ${book.author}`);
    const item = {
      rank: index + 1,
      title: book.title,
      subtitle: `Goodreads · ${book.author}`,
      description: bookDescription(book, wiki, context, goodreadsContext, openLibraryContext, article, current?.description),
      image: current?.image ?? `/culture/book-${slugify(book.title)}.webp`,
      imageSource: book.image,
      alt: current?.alt ?? `Cover of ${book.title} by ${book.author}`,
      url: book.url,
      source: "Goodreads",
      metric: { label: "Goodreads monthly readers", value: formatInteger(book.readers) },
      rating: book.rating.toFixed(2),
      ratingLabel: "Goodreads",
      evidence: [
        { source: "Goodreads most read this month", url: result.url },
        ...(goodreadsContext ? [{ source: "Goodreads book page", url: goodreadsContext.pageUrl }] : []),
        ...(openLibraryContext ? [{ source: "Open Library book context", url: openLibraryContext.pageUrl }] : []),
        wiki
          ? { source: "Wikipedia book context", url: wiki.pageUrl }
          : { source: "Google News book coverage", url: newsUrl },
        ...(context ? [{ source: article?.context?.source ?? context.source, url: newsUrl }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
    rememberAiDescriptionContext(item, "books", [
      { kind: "premise", source: "Goodreads book page", text: goodreadsContext?.description },
      { kind: "premise", source: "Open Library book record", text: openLibraryContext?.description },
      { kind: "premise", source: "Wikipedia book context", text: wiki?.extract },
      { kind: "current_coverage", source: article?.context?.source ?? context?.source ?? "Current book coverage", text: article?.intro, publishedAt: article?.context?.publishedAt ?? context?.publishedAt },
      { kind: "current_headline", source: article?.context?.source ?? context?.source ?? "Current book headline", text: article?.context?.headline, publishedAt: article?.context?.publishedAt ?? context?.publishedAt },
    ]);
    return item;
  });
  section.eyebrow = "Goodreads · most read this month · U.S.";
  section.title = "Books";
  section.description = "The ten books most read by Goodreads members in the United States during the latest completed month, with context from Wikipedia or current coverage.";
  section.sources = [
    { label: "Goodreads · most read books, U.S., month", url: result.url },
    { label: "Google News · current book coverage", url: googleNewsSearchUrl(`${books[0].title} ${books[0].author}`) },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = `Show ranks 6–${allItems.length}`;
}

function articleTitle(article) {
  try {
    return decodeURIComponent(article.replaceAll("_", " "));
  } catch {
    return article.replaceAll("_", " ");
  }
}

function claimIds(entity, property) {
  return (entity?.claims?.[property] ?? [])
    .map((claim) => claim.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function claimStrings(entity, property) {
  return (entity?.claims?.[property] ?? [])
    .map((claim) => claim.mainsnak?.datavalue?.value)
    .filter((value) => typeof value === "string");
}

async function wikidataEntitiesForTitles(titles) {
  const entities = new Map();
  const unique = [...new Map(titles.map((title) => [normalize(title), title])).values()];
  for (let index = 0; index < unique.length; index += 35) {
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.search = new URLSearchParams({
      action: "wbgetentities",
      sites: "enwiki",
      titles: unique.slice(index, index + 35).join("|"),
      props: "descriptions|claims|sitelinks",
      languages: "en",
      format: "json",
      origin: "*",
    });
    const payload = await fetchWikidataJson(url);
    for (const entity of Object.values(payload.entities ?? {})) {
      const title = entity.sitelinks?.enwiki?.title;
      if (title) entities.set(normalize(title), entity);
    }
  }
  return entities;
}

async function wikipediaPageDetails(titles) {
  const pages = new Map();
  for (let index = 0; index < titles.length; index += 20) {
    const url = new URL("https://en.wikipedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query",
      prop: "extracts|pageimages",
      titles: titles.slice(index, index + 20).join("|"),
      exintro: "1",
      explaintext: "1",
      exsentences: "6",
      piprop: "thumbnail|name",
      pithumbsize: "900",
      redirects: "1",
      format: "json",
      origin: "*",
    });
    const payload = JSON.parse(await fetchText(url));
    for (const page of Object.values(payload.query?.pages ?? {})) {
      if (page.title) pages.set(normalize(page.title), page);
    }
  }
  return pages;
}

function topviewsToolUrl() {
  return "https://pageviews.wmcloud.org/topviews/?project=en.wikipedia.org&platform=all-access&date=last-month&excludes=";
}

async function wikipediaMonthlyTop() {
  const period = previousCompleteMonth();
  const apiUrl = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia.org/all-access/${period.year}/${period.monthNumber}/all-days`;
  const payload = JSON.parse(await fetchText(apiUrl));
  const rows = (payload.items?.[0]?.articles ?? [])
    .filter((row) => typeof row.article === "string" && !row.article.includes(":")
      && Number.isFinite(Number(row.views)) && Number(row.views) > 0)
    .map((row) => ({ ...row, title: articleTitle(row.article), views: Number(row.views) }));
  if (rows.length < 500) throw new Error(`Wikimedia returned only ${rows.length} monthly top pages`);
  const entities = await wikidataEntitiesForTitles(rows.slice(0, 1000).map((row) => row.title));
  return { period, apiUrl, rows, entities };
}

function personCategory(description) {
  const categories = [
    ["social-media", "Social media", /\b(?:influencer|youtuber|streamer|content creator|social media|internet personality)\b/i],
    ["sports", "Sports", /\b(?:association football player|footballer|football player|football manager|football administrator|soccer player|basketball player|baseball player|tennis player|golfer|athlete|boxer|wrestler|fighter|sportsperson|sports manager|sports administrator|sports executive|racing driver|coach)\b/i],
    ["film", "Film", /\b(?:actor|actress|filmmaker|director|screenwriter|film producer|cinematographer)\b/i],
    ["music", "Music", /\b(?:singer|musician|rapper|songwriter|composer|record producer|disc jockey|dj)\b/i],
    ["business", "Business", /\b(?:businessperson|businessman|businesswoman|business magnate|entrepreneur|executive|chief executive|founder|industrialist|investor|billionaire|marketing)\b/i],
    ["media", "Media", /\b(?:journalist|presenter|broadcaster|comedian|television personality|media personality)\b/i],
    ["literature", "Literature", /\b(?:writer|author|novelist|poet|playwright)\b/i],
    ["science-technology", "Science & technology", /\b(?:engineer|scientist|researcher|inventor|physician|academic)\b/i],
  ];
  const matches = categories
    .map(([id, label, pattern], priority) => ({ id, label, priority, index: description.search(pattern) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index || left.priority - right.priority);
  return matches.length ? [matches[0].id, matches[0].label] : ["other", "Other"];
}

function eligiblePerson(entity) {
  const description = entity?.descriptions?.en?.value ?? "";
  if (!claimIds(entity, "P31").includes("Q5")
    || !(entity?.claims?.P569?.length)
    || entity?.claims?.P570?.length) return false;
  if (claimIds(entity, "P106").includes("Q82955")) return false;
  return !/\b(?:politician|president|prime minister|senator|governor|member of parliament|political candidate|monarch|king|queen)\b/i.test(description);
}

function ensureSentence(value) {
  const clean = plainText(value ?? "").replace(/\s+([,.;:!?])/g, "$1");
  if (!clean) return "";
  return /[.!?][\"'’”)]?$/.test(clean) ? clean : `${clean}.`;
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

function sentences(value) {
  const clean = plainText(value ?? "").replace(/([.!?])\s+(?=[a-z])/g, " ");
  return clean ? [...sentenceSegmenter.segment(clean)].map(({ segment }) => segment.trim()).filter(Boolean) : [];
}

function conciseSentences(value, maxLength = 320) {
  const clean = plainText(value ?? "");
  if (!clean) return "";
  const parts = sentences(clean);
  let result = "";
  for (const sentence of parts) {
    const candidate = `${result} ${sentence.trim()}`.trim();
    if (candidate.length > maxLength && result) break;
    if (candidate.length > maxLength) {
      const prefix = candidate.slice(0, maxLength + 1);
      const boundaries = [
        ...[...prefix.matchAll(/[,;:](?=\s)/g)].map((match) => match.index ?? -1),
        ...[...prefix.matchAll(/\s+(?:and|but|while)\s+(?:a|an|the)\b/gi)].map((match) => match.index ?? -1),
      ];
      const boundary = boundaries.filter((index) => index >= maxLength * 0.55).sort((left, right) => left - right).at(-1);
      const clipped = (boundary ? prefix.slice(0, boundary) : prefix.replace(/\s+\S*$/, ""))
        .replace(/\s+\b(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|with)\b$/i, "")
        .replace(/[,:;\s]+$/, "");
      return ensureSentence(clipped);
    }
    result = candidate;
  }
  return ensureSentence(result || clean);
}

const copiedMetricPattern = /\b(?:billboard hot 100|google shopping|google searches?|search volume|spotify(?:'|’)?s today(?:'|’)?s top hits|wikipedia (?:article )?(?:drew|views?))\b|\branking it #\d+|\bplacing it #\d+/i;
const editorialHeadlinePattern = /^(?:forget|inside|meet|why)\b|\b(?:admit it|babygirl|best|cover by|favorite|homerist|hot take|joke on|must-see|opinion|pros? say|pr strategy|reacts?|review|should you|story behind|thank zeus|trojan horse|what to know|worst|worth buying)\b|\beverything (?:else )?(?:you )?need to know\b|\bonly .{0,50} could\b|\b(?:leaving|left) millions on the table\b|\bgets? .{0,30} treatment\b/i;
const personRelevancePattern = /\b(?:meme|memes|viral|internet|online|reaction|fans?|funny|walk(?:ed|ing)?|appearance|clip|joke|parody|mock(?:ed)?|trend(?:ing)?|gesture|look(?:s|ed)?|facial|expression|mannerism|style|celebration)\b/i;
const eventHeadlinePattern = /\b(?:announc|appoint|arrest|appear|award|ban|block|break|buy|cancel|cast|cement|celebrat|charg|clos|confirm|coverage|crash|damag|debut|direct|discount|dismis|feature|file|first look|film|gross|join|launch|leav|lead|let|match|meme|movie|online|open|order|perform|pledge|premier|qualif|recall|reaction|reject|releas|renew|respond|resign|return|reveal|rise|rally|role|say|sell|sign|sicken|spotlight|star|surge|suspend|teas|tournament|tour|trending|unveil|viral|win|won|world cup)\w*\b/i;
const personEditorialPattern = /\b(?:actually|everything (?:we|you) know|family|lookalike|meet|net worth|parents?|siblings?|takes? a closer look|what to know|who is|why you should know|the reason (?:isn['’]?t|is not)|not what you think|explainer|explained|might (?:finally )?(?:have )?come to a close|at home|could|may)\b/i;
const clippedSentencePattern = /(?:^|\s)[a-z]{1,2}\.$/;

function factualHeadline(value, { rejectChartPlacement = false, requireEvent = false, maxLength = 240, allowCultural = false } = {}) {
  const clean = plainText(value ?? "")
    .replace(/^(?:exclusive|opinion|review)\s*[|:]\s*/i, "")
    .replace(/\s+-\s+The Athletic$/i, "")
    .trim();
  const factual = sentences(clean).filter((sentence) => sentence.length >= 24
      && sentence.length <= maxLength
    && !/(?:…|\.\.\.)\s*$/.test(sentence)
    && (!sentence.includes("?") || (allowCultural && personRelevancePattern.test(sentence)))
    && !/\b(?:No|vs)\.$/i.test(sentence)
    && !clippedSentencePattern.test(sentence)
    && !/^\d+\s+(?:and|as|but|in|on|to|with)\b/i.test(sentence)
    && !copiedMetricPattern.test(sentence)
    && (!editorialHeadlinePattern.test(sentence) || (allowCultural && personRelevancePattern.test(sentence)))
    && (!requireEvent || eventHeadlinePattern.test(sentence) || (allowCultural && personRelevancePattern.test(sentence)))
    && !(rejectChartPlacement && /\b(?:billboard|charts?|no\.?\s*\d+|number one|#\d+)\b/i.test(sentence)))
    .map((sentence) => sentence
      .replace(/\s+draws outrage and fears of misuse$/i, " has prompted scrutiny over potential misuse")
      .trim());
  return conciseSentences(factual.join(" "), maxLength);
}

function stripSourceAttribution(value) {
  return plainText(value)
    .replace(/\s+(?:according to|reported by|reports? from|authorities told|officials told|the company said|officials said|experts said)\b[\s\S]*$/i, "")
    .replace(/\s+(?:credit|photo credit|image credit)\s*[:.][\s\S]*$/i, "")
    .trim();
}

function personIdentity(title, description, categoryLabel) {
  const source = plainText(description ?? "");
  const rolePatterns = [
    ["actor|actress", (match) => match.toLowerCase()],
    ["director|filmmaker|screenwriter|film producer|cinematographer", () => "film director"],
    ["footballer|football player|association football player|soccer player|basketball player|baseball player|tennis player|golfer|athlete|boxer|wrestler|fighter|sportsperson", (match) => match
      .replace(/association football player|football player|soccer player/gi, "footballer").toLowerCase()],
    ["singer|musician|rapper|songwriter|composer|record producer|disc jockey|dj", (match) => match.toLowerCase()],
    ["influencer|youtuber|streamer|content creator|social media personality|internet personality", (match) => match.toLowerCase()],
    ["businessperson|businessman|businesswoman|business magnate|entrepreneur|executive|chief executive|founder|industrialist|investor|billionaire", () => "business leader"],
    ["journalist|presenter|broadcaster|comedian|television personality|media personality", (match) => match.toLowerCase()],
    ["writer|author|novelist|poet|playwright", (match) => match.toLowerCase()],
    ["engineer|scientist|researcher|inventor|physician|academic", (match) => match.toLowerCase()],
  ];
  const role = rolePatterns.map(([pattern, format]) => {
    const match = source.match(new RegExp(`\\b(?:${pattern})\\b`, "i"));
    return match ? format(match[0]) : null;
  }).find(Boolean) ?? (categoryLabel === "Film" ? "film director" : categoryLabel === "Media" ? "media personality" : categoryLabel === "Business" ? "business leader" : categoryLabel === "Science & technology" ? "scientist" : categoryLabel.toLowerCase());
  const article = /^[aeiou]/i.test(role) ? "an" : "a";
  return ensureSentence(`${title} is primarily known as ${article} ${role}`);
}

function recentDescription(identity, headline, options = {}) {
  const context = factualHeadline(headline, options);
  if (context) return `${identity} ${context}`;
  return identity;
}

function personRecentDescription(title, identity, article, context) {
  const candidates = [
    ...sentences(article?.intro),
    article?.context?.headline,
    context?.headline,
    ...(context?.alternates ?? []).map((candidate) => candidate.headline),
  ];
  const titleTokens = new Set(normalize(title).split(" ").filter((token) => token.length >= 3));
  const recentCandidates = candidates.map((value) => {
    const raw = plainText(value);
    const neutral = neutralPersonHeadline(title, value);
    const text = neutral || cleanPersonEventContext(title, value);
    const event = Boolean(neutral) || eventHeadlinePattern.test(raw) || personRelevancePattern.test(raw);
    const normalized = normalize(text);
    const overlap = [...titleTokens].filter((token) => normalized.split(" ").includes(token)).length;
    const topical = /\b(?:film|movie|role|cast|box office|premier|trailer|release|album|single|tour|concert|award|world cup|tournament|match|championship|final)\b/i.test(raw)
      || personRelevancePattern.test(raw);
    const causal = /\b(?:after|amid|because|following|return(?:ed|ing)?|re-?released?|viral|meme|reaction|fans?|funny|walk(?:ed|ing)?|appearance|clip|joke|parody|sold out|trending|won|announced|arrested|joined|performed|released?)\b/i.test(raw);
    const cultural = personRelevancePattern.test(raw);
    const mechanism = /\b(?:meme|memes|funny|walk(?:ed|ing)?|appearance|look(?:s|ed)?|expression|joke|parody)\b/i.test(raw);
    const explicitMeme = /\bmemes?\b/i.test(raw);
    const editorial = !neutral && !personRelevancePattern.test(raw)
      && (editorialHeadlinePattern.test(raw) || personEditorialPattern.test(raw));
    return { raw, text, overlap, event, topical: topical || Boolean(neutral), causal, cultural, mechanism, explicitMeme, editorial };
  }).filter((candidate) => candidate.text && !copiedMetricPattern.test(candidate.text)
    && !clippedSentencePattern.test(candidate.text))
    .filter((candidate) => !(normalize(candidate.text).startsWith(`${normalize(title)} is `)
      && candidate.text.length < 180))
    .sort((left, right) => Number(left.editorial) - Number(right.editorial)
      || Number(right.explicitMeme) - Number(left.explicitMeme)
      || Number(right.mechanism) - Number(left.mechanism)
      || Number(right.cultural) - Number(left.cultural)
      || Number(right.causal) - Number(left.causal)
      || Number(right.topical) - Number(left.topical)
      || Number(right.event) - Number(left.event)
      || right.overlap - left.overlap
      || right.text.length - left.text.length);
  const recent = recentCandidates.find((candidate) => candidate.overlap > 0 && candidate.event && !candidate.editorial);
  if (!recent) return "";
  const supportingMechanism = recentCandidates.find((candidate) => candidate !== recent
    && candidate.overlap > 0
    && candidate.event
    && !candidate.editorial
    && /\b(?:funny|walk(?:ed|ing)?|appearance|look(?:s|ed)?|expression|gesture)\b/i.test(candidate.text));
  const mechanismText = `${recent.raw} ${supportingMechanism?.raw ?? ""}`;
  const hasMeme = /\bmemes?\b/i.test(mechanismText);
  const hasWalk = /\bwalk(?:ed|ing)?\b/i.test(mechanismText);
  const hasHumor = /\b(?:funny|laugh(?:s|ed|ing)?|hilarious)\b/i.test(mechanismText);
  const mechanismSummary = hasMeme && hasWalk && hasHumor
    ? "Fans are turning the funny walk into memes."
    : hasMeme && hasWalk
      ? "The meme response centers on the walk."
      : hasMeme && /\b(?:appearance|look(?:s|ed)?|expression|gesture)\b/i.test(mechanismText)
        ? "The meme response centers on the appearance."
        : "";
  // Put the current signal first. The identity sentence is useful context,
  // but it must never be allowed to become the explanation for the trend.
  return conciseSentences(`${recent.text}${mechanismSummary ? ` ${mechanismSummary}` : supportingMechanism ? ` ${supportingMechanism.text}` : ""} ${identity}`, 560);
}

function neutralPersonHeadline(title, value) {
  const raw = plainText(value);
  if (!raw) return "";
  const work = raw.match(/['’]s\s+(.+?)\s+(?=(?:might|may|could|has|have|is|was|were|returns?|premier\w*|opens?|closes?)\b)/i)?.[1]
    ?.replace(/\s+/g, " ").trim();
  const looksLikeWorkTitle = Boolean(work)
    && /^[A-Z0-9][A-Za-z0-9:'’&-]*(?:\s+[A-Z0-9][A-Za-z0-9:'’&-]*){1,8}$/.test(work);
  const hasWorkCue = /\b(?:film|movie|series|album|tour|concert|world cup|tournament|match|championship)\b/i.test(raw);
  if (!hasWorkCue && !looksLikeWorkTitle) return "";
  if (!work) return "";
  return `${title} is drawing attention for a recent role connected to ${work}.`;
}

function cleanPersonEventContext(title, value) {
  let text = factualHeadline(stripSourceAttribution(value), { requireEvent: true, maxLength: 260, allowCultural: true });
  if (!text) return "";
  if (text.includes("?")) return "";
  text = text
    .replace(/\s+(?:according to|reported by|reports? from|the company said|officials said|experts said)\b[\s\S]*$/i, "")
    .replace(/\s+(?:takes? a closer look|everything (?:we|you) know|what you need to know)\b[\s\S]*$/i, "")
    .trim();
  if (/^(?:when|while|although|because)\s+/i.test(text)) {
    const withoutLead = text.replace(/^(?:when|while|although|because)\s+/i, "");
    if (normalize(withoutLead).startsWith(normalize(title))) text = withoutLead;
  }
  return /[.!?]["'’”)]?$/.test(text) ? text : "";
}

function publicationDateLabel(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

const googleNewsCache = new Map();

async function googleNewsContext(query, days = 45, { requireEvent = false, queryVariants = [] } = {}) {
  const variants = [...new Set(queryVariants.map((value) => plainText(value)).filter(Boolean))];
  const key = `${normalize(query)}:${days}:${requireEvent}:${variants.map(normalize).join("|")}`;
  if (googleNewsCache.has(key)) return googleNewsCache.get(key);
  const request = (async () => {
    const queries = [...new Set([query, ...variants])];
    const queryTokens = new Set(normalize(query).split(" ").filter((token) => (token.length >= 3 || /\d/.test(token))
      && !new Set(["and", "for", "from", "news", "film", "movie", "product", "song", "shopping", "the", "with"]).has(token)));
    const variantTokens = new Set(normalize(variants.join(" ")).split(" ").filter((token) => token.length >= 3));
    const feeds = await mapConcurrent(queries, 3, async (searchQuery) => {
      const newsUrl = new URL("https://news.google.com/rss/search");
      newsUrl.search = new URLSearchParams({
        q: `${searchQuery} when:${days}d`,
        hl: "en-US",
        gl: "US",
        ceid: "US:en",
      });
      return { feedUrl: newsUrl.href, rss: await fetchText(newsUrl).catch(() => "") };
    });
    const items = feeds.flatMap(({ feedUrl, rss }, queryIndex) => [...rss.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map((match, index) => {
      const item = match[1];
      const sourceTag = item.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
      const source = plainText(sourceTag?.[2] ?? "");
      const sourceUrl = sourceTag?.[1]?.match(/\burl=["']([^"']+)/i)?.[1] ?? "";
      const rawHeadline = plainText(item.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const headline = (source && rawHeadline.endsWith(` - ${source}`)
        ? rawHeadline.slice(0, -source.length - 3).trim()
        : rawHeadline.replace(/\s+-\s+[^-]{2,80}$/, "").trim())
        .replace(/^(?:opinion|review)\s*\|\s*/i, "")
        .replace(/\s+\|\s+[^|]{1,40}$/, "")
        .trim();
      const link = plainText(item.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "");
      const published = plainText(item.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ?? "");
      const headlineTokens = new Set(normalize(headline).split(" "));
      const overlap = [...queryTokens].filter((token) => headlineTokens.has(token)).length;
      const facetOverlap = [...variantTokens].filter((token) => headlineTokens.has(token)).length;
      let score = overlap * 12 + facetOverlap * 4 - index - queryIndex;
      if (queryIndex > 0 && facetOverlap) score += 8;
      if (headline.length >= 55 && headline.length <= 180) score += 6;
      if (/\b(?:announces?|bankruptcy|blocks?|crashes?|damaged|debut|first look|launches?|lawsuit|lets?|opens?|recall|rejects?|release date|reveals?|rises?|sickens|surges?|trailer|unveils?|without power)\b/i.test(headline)) score += 9;
      if (personRelevancePattern.test(headline)) score += 5;
      if (/^(?:how to|watch|photos?|video)\b/i.test(headline)) score -= 8;
      if (/\b(?:Associated Press|AP News|BBC|Billboard|Bloomberg|Deadline|ESPN|Forbes|Fortune|FOX Sports|The Guardian|Los Angeles Times|NBC News|NPR|New York Times|Reuters|SCOTUSblog|The Athletic|The Hollywood Reporter|The Washington Post|Variety)\b/i.test(source)) score += 12;
      if (/\b(?:Just Jared|Medium|Mshale|Weverse)\b/i.test(source)
        || /^(?:exclusive|opinion)\b|\b(?:cover by|lyrics:)\b/i.test(headline)) score -= 10;
      if ((editorialHeadlinePattern.test(headline) || /\?/.test(headline)) && !personRelevancePattern.test(headline)) score -= 30;
      if (/\b\w{1,3}$/.test(headline) && !/[.!?'’”)]$/.test(headline)) score -= 6;
      const date = new Date(published);
      return {
        headline,
        link: link.startsWith("https://news.google.com/") ? link : feedUrl,
        publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
        source: source || "Google News",
        sourceUrl: /^https:\/\//i.test(sourceUrl) ? sourceUrl : null,
        feedUrl,
        sourceOrder: index,
        queryIndex,
        overlap,
        facetOverlap,
        score,
      };
    }).filter((item) => item.headline));
    const requiredOverlap = Math.min(2, Math.max(1, queryTokens.size));
    const candidates = items.filter((item) => item.overlap >= requiredOverlap
      || (variants.length > 0 && item.queryIndex > 0 && item.overlap >= 1 && item.facetOverlap >= 1));
    const ranked = [...new Map(items.map((item) => [normalize(item.headline), item])).values()]
      .sort((left, right) => right.score - left.score);
    const selected = candidates
      .sort((left, right) => right.score - left.score)
      .find((item) => factualHeadline(item.headline, { requireEvent, allowCultural: variants.length > 0 }));
    return selected ? {
      ...selected,
      alternates: ranked.filter((item) => item !== selected).slice(0, 8),
    } : null;
  })();
  googleNewsCache.set(key, request);
  return request;
}

const bingArticleCache = new Map();

function decodeBingResultUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, "https://www.bing.com");
    if (url.hostname !== "www.bing.com") return publicHttpsUrl(url.href, "search result").href;
    const encoded = url.searchParams.get("u");
    if (!encoded) return null;
    const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    const decoded = Buffer.from(payload.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
    return /^https:\/\//i.test(decoded) ? publicHttpsUrl(decoded, "search result").href : null;
  } catch {
    return null;
  }
}

function sameArticleDomain(left, right) {
  if (!left || !right) return false;
  try {
    const leftHost = new URL(left).hostname.replace(/^www\./i, "").toLowerCase();
    const rightHost = new URL(right).hostname.replace(/^www\./i, "").toLowerCase();
    return leftHost === rightHost || leftHost.endsWith(`.${rightHost}`) || rightHost.endsWith(`.${leftHost}`);
  } catch {
    return false;
  }
}

function usableArticleUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.pathname === "/" || url.pathname.length < 8) return false;
    return !/(?:^|\.)bing\.com$|(?:^|\.)google\.com$|(?:^|\.)wikipedia\.org$|(?:^|\.)youtube\.com$|(?:^|\.)instagram\.com$|(?:^|\.)facebook\.com$|(?:^|\.)linkedin\.com$|(?:^|\.)twitter\.com$|(?:^|\.)x\.com$|(?:^|\.)tiktok\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function retainableNewsUrl(rawUrl) {
  if (!usableArticleUrl(rawUrl)) return false;
  try {
    const path = new URL(rawUrl).pathname;
    return !/(?:^|\/)(?:jobs?|careers?|human[-_ ]?resources?|hurricane[-_ ]?tracker|search|category|tag|author|about|contact|privacy|terms)(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

async function bingSearchArticles(headline, sourceUrl, entityName = "") {
  const sourceHost = (() => {
    try {
      return new URL(sourceUrl).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  })();
  const key = normalize(`${headline} ${sourceHost} ${entityName}`);
  if (bingArticleCache.has(key)) return bingArticleCache.get(key);
  const request = (async () => {
    const quotedEntity = entityName.trim().replace(/["']/g, "");
    const queries = [
      ...(quotedEntity ? [sourceHost ? `site:${sourceHost} "${quotedEntity}"` : `"${quotedEntity}"`] : []),
      sourceHost ? `site:${sourceHost} ${headline}` : headline,
      ...(quotedEntity ? [`"${quotedEntity}" ${headline}`] : []),
      headline,
    ];
    const pages = await mapConcurrent([...new Set(queries)], 2, async (query) => {
      const searchUrl = new URL("https://www.bing.com/search");
      searchUrl.search = new URLSearchParams({ q: query, count: "10", setlang: "en-US" });
      return fetchText(searchUrl, { headers: { "user-agent": "Mozilla/5.0" } }).catch(() => "");
    });
    const headlineTokens = new Set(normalize(`${headline} ${entityName}`).split(" ").filter((token) => token.length >= 4));
    const candidates = [];
    const addCandidate = (rawUrl, title) => {
      if (!rawUrl || !usableArticleUrl(rawUrl)) return;
      const urlTokens = normalize(new URL(rawUrl).pathname).split(" ");
      const titleTokens = normalize(title).split(" ");
      const titleOverlap = [...headlineTokens].filter((token) => titleTokens.includes(token)).length;
      const urlOverlap = [...headlineTokens].filter((token) => urlTokens.includes(token)).length;
      candidates.push({ url: rawUrl, title, overlap: Math.max(titleOverlap, urlOverlap), domainMatch: sameArticleDomain(rawUrl, sourceUrl) });
    };
    for (const html of pages) {
      for (const match of html.matchAll(/<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h2>/gi)) {
        const href = match[1].match(/\bhref\s*=\s*["']([^"']+)/i)?.[1];
        const url = href ? decodeBingResultUrl(decodeHtml(href)) : null;
        if (!url || !usableArticleUrl(url)) continue;
        const title = plainText(match[2]);
        addCandidate(url, title);
      }
    }
    const minimumOverlap = Math.min(2, headlineTokens.size);
    let results = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
      .filter((candidate) => candidate.overlap >= minimumOverlap)
      .sort((left, right) => right.overlap - left.overlap
        || Number(right.domainMatch) - Number(left.domainMatch));
    if (results.length < 3) {
      const fallbackQueries = [...new Set([...(quotedEntity ? [`"${quotedEntity}"`] : []), ...queries.slice(0, 3)])];
      const fallbackPages = await mapConcurrent(fallbackQueries, 2, async (query) => {
        const searchUrl = new URL("https://html.duckduckgo.com/html/");
        searchUrl.search = new URLSearchParams({ q: query });
        return fetchText(searchUrl, { headers: { "user-agent": "Mozilla/5.0" } }).catch(() => "");
      });
      for (const html of fallbackPages) {
        for (const match of html.matchAll(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
          try {
            const link = new URL(decodeHtml(match[1]), "https://html.duckduckgo.com/html/");
            const target = link.searchParams.get("uddg");
            const url = target ? decodeURIComponent(target) : link.href;
            addCandidate(url, plainText(match[2]));
          } catch {
            // Ignore malformed search-result links.
          }
        }
      }
      results = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
        .filter((candidate) => candidate.overlap >= minimumOverlap)
        .sort((left, right) => right.overlap - left.overlap
          || Number(right.domainMatch) - Number(left.domainMatch));
    }
    return results;
  })().catch(() => []);
  bingArticleCache.set(key, request);
  return request;
}

const topicStopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "for", "from", "have", "how", "i", "in", "is", "it",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "latest", "lawsuit", "news", "of", "on", "or", "presentation", "recall", "the", "to", "update", "was", "were", "what", "when", "with",
]);

function topicStem(token) {
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3).replace(/(.)\1$/, "$1");
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2).replace(/(.)\1$/, "$1");
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function topicTokens(value) {
  return new Set(normalize(value).split(" ")
    .filter((token) => (token.length >= 3 || /\d/.test(token)) && !topicStopWords.has(token))
    .map(topicStem));
}

const imageTopicStopWords = new Set([
  ...topicStopWords,
  "came", "come", "day", "days", "hour", "hours", "image", "latest", "minute", "minutes", "month",
  "new", "news", "people", "recent", "support", "thing", "things", "time", "undone", "week", "weeks", "year", "years",
]);

function imageTopicTokens(value) {
  return new Set([...topicTokens(value)].filter((token) => !imageTopicStopWords.has(token)));
}

function overlapCount(left, right) {
  return [...left].filter((token) => right.has(token)).length;
}

async function wikipediaSearch(query) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "6",
    prop: "pageimages|extracts|info",
    piprop: "thumbnail",
    pithumbsize: "1200",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    format: "json",
    origin: "*",
  });
  const wikipedia = JSON.parse(await fetchText(searchUrl));
  return Object.values(wikipedia.query?.pages ?? {}).filter((page) => page.extract && page.fullurl);
}

async function wikipediaTopicContext(queryCandidates) {
  const queries = [...new Map(queryCandidates
    .map((query) => plainText(query ?? "").slice(0, 180))
    .filter(Boolean)
    .map((query) => [normalize(query), query])).values()].slice(0, 4);
  if (!queries.length) return null;
  const results = await mapConcurrent(queries, 3, async (query, queryIndex) => ({
    queryIndex,
    pages: await wikipediaSearch(query),
  }));
  const primaryTokens = topicTokens(queries[0]);
  const sourceTokens = topicTokens(queries.join(" "));
  const candidates = new Map();
  for (const { queryIndex, pages } of results) {
    for (const page of pages) {
      const key = String(page.pageid);
      const occurrence = { queryIndex, rank: Number(page.index) || 7 };
      const current = candidates.get(key);
      if (!current) candidates.set(key, { page, occurrences: [occurrence] });
      else current.occurrences.push(occurrence);
    }
  }
  const currentYear = new Date().getUTCFullYear();
  const scored = [...candidates.values()].map(({ page, occurrences }) => {
    const titleTokens = topicTokens(page.title ?? "");
    const documentTokens = topicTokens(`${page.title ?? ""} ${page.extract ?? ""}`);
    const primaryOverlap = overlapCount(primaryTokens, documentTokens);
    const primaryTitleOverlap = overlapCount(primaryTokens, titleTokens);
    const titleOverlap = overlapCount(sourceTokens, titleTokens);
    const sourceOverlap = overlapCount(sourceTokens, documentTokens);
    const occurrenceScores = occurrences.map((occurrence) => {
      const queryTokens = topicTokens(queries[occurrence.queryIndex]);
      const queryOverlap = overlapCount(queryTokens, documentTokens);
      const rankScore = Math.max(0, 7 - occurrence.rank) * Math.min(8, Math.max(1, queryTokens.size));
      return { ...occurrence, queryOverlap, rankScore };
    });
    const bestOccurrence = [...occurrenceScores].sort((left, right) => right.rankScore - left.rankScore)[0];
    const years = [...String(page.title ?? "").matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
    const stalePenalty = years.some((year) => year < currentYear - 1 && !queries.some((query) => query.includes(String(year)))) ? 80 : 0;
    const genericPenalty = /^(?:list of|outline of)|\(disambiguation\)$|\bmay refer to\b/i.test(`${page.title ?? ""} ${page.extract ?? ""}`) ? 120 : 0;
    const occurrenceScore = occurrenceScores.reduce((total, occurrence) => total + occurrence.rankScore, 0);
    const score = primaryOverlap * 24 + titleOverlap * 10 + sourceOverlap * 2
      + occurrenceScore + occurrences.length * 6
      - stalePenalty - genericPenalty;
    return {
      page,
      bestOccurrence,
      occurrenceScores,
      primaryOverlap,
      primaryTitleOverlap,
      sourceOverlap,
      titleOverlap,
      titleTokens,
      stale: stalePenalty > 0,
      score,
    };
  }).sort((left, right) => right.score - left.score);
  const requiredPrimaryOverlap = Math.min(2, Math.max(1, primaryTokens.size));
  const best = scored.find((candidate) => {
    if (candidate.stale || /\bmay refer to\b/i.test(candidate.page.extract ?? "")) return false;
    const primaryTitleCoverage = candidate.primaryTitleOverlap / Math.max(1, candidate.titleTokens.size);
    return candidate.occurrenceScores.some((occurrence) => occurrence.queryIndex === 0 && occurrence.rank <= 2)
      && candidate.primaryOverlap >= requiredPrimaryOverlap
      && candidate.primaryTitleOverlap >= requiredPrimaryOverlap
      && primaryTitleCoverage >= 0.5;
  });
  if (!best) return null;
  const firstSentence = sentences(best.page.extract)[0] ?? "";
  const subordinate = firstSentence.search(/,\s+(?:which (?:is|was|were)|directed by|produced by|screenplay by|written by)\b/i);
  const definition = subordinate >= 80 ? ensureSentence(firstSentence.slice(0, subordinate)) : firstSentence;
  return {
    title: best.page.title,
    extract: conciseSentences(definition, 220),
    pageUrl: best.page.fullurl,
    imageSource: best.page.thumbnail?.source,
  };
}

async function commonsRepresentativeImage(queryCandidates) {
  const rawQueries = queryCandidates.map((query) => plainText(query ?? "")).filter(Boolean);
  const primaryTokens = [...imageTopicTokens(rawQueries[0] ?? "")];
  const tokenCounts = new Map();
  for (const token of imageTopicTokens(rawQueries.join(" "))) {
    if (token.length < 4) continue;
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }
  const edgeQueries = [...new Set(primaryTokens.slice(0, 4))];
  const tokenQueries = [...tokenCounts.entries()]
    .sort((left, right) => right[0].length - left[0].length || left[1] - right[1])
    .slice(0, 3)
    .map(([token]) => token);
  const queries = [...new Set([...edgeQueries, ...rawQueries.slice(0, 2), ...tokenQueries])].slice(0, 8);
  const sourceTokens = imageTopicTokens(rawQueries.join(" "));
  const results = await mapConcurrent(queries, 3, async (query, queryIndex) => {
    const commonsUrl = new URL("https://commons.wikimedia.org/w/api.php");
    commonsUrl.search = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: query,
      gsrnamespace: "6",
      gsrlimit: "6",
      prop: "imageinfo",
      iiprop: "url|mime",
      iiurlwidth: "1200",
      format: "json",
      origin: "*",
    });
    const commons = JSON.parse(await fetchText(commonsUrl));
    return Object.values(commons.query?.pages ?? {}).map((entry) => ({ ...entry, queryIndex, info: entry.imageinfo?.[0] }));
  });
  const candidates = results.flat().filter((entry) => entry.info?.thumburl
    && /^image\/(?:jpeg|png|webp)$/i.test(entry.info.mime ?? ""))
    .map((entry) => {
      const titleTokens = imageTopicTokens(entry.title ?? "");
      const overlap = overlapCount(sourceTokens, titleTokens);
      const queryOverlap = overlapCount(imageTopicTokens(queries[entry.queryIndex] ?? ""), titleTokens);
      const genericPenalty = /\b(?:coat of arms|diagram|flag|icon|logo|map|seal)\b/i.test(entry.title ?? "") ? 8 : 0;
      return { entry, score: overlap * 18 + queryOverlap * 3 - genericPenalty };
    }).sort((left, right) => right.score - left.score);
  return candidates[0]?.score >= 18 ? {
    imageSource: candidates[0].entry.info.thumburl,
    pageUrl: candidates[0].entry.info.descriptionurl,
    title: candidates[0].entry.title,
  } : null;
}

async function updatePeople(brief, topviews) {
  const section = brief.sections.find((entry) => entry.id === "people");
  if (!section) return;
  const eligible = topviews.rows.slice(0, 1000)
    .map((row) => {
      const entity = topviews.entities.get(normalize(row.title));
      const [category, label] = personCategory(entity?.descriptions?.en?.value ?? "");
      return { ...row, entity, category, label };
    })
    .filter((row) => eligiblePerson(row.entity));
  if (eligible.length < 10) throw new Error(`Wikimedia topviews produced only ${eligible.length} eligible living non-politicians`);
  // A page-view spike identifies attention, but it does not explain why the
  // person is relevant now. Only use candidates with a separately validated,
  // recent event/coverage signal before spending the rest of the enrichment
  // work on the final ten.
  const candidatesWithContext = await mapConcurrent(eligible.slice(0, 80), 4, async (person) => ({
    person,
    context: await googleNewsContext(`"${person.title}"`, 45, {
      requireEvent: true,
      queryVariants: [
        `"${person.title}" meme viral funny`,
        `"${person.title}" reaction fans appearance`,
        `"${person.title}" clip joke walk`,
      ],
    }).catch(() => null),
  }));
  const selected = [];
  const contexts = [];
  const categoryCounts = new Map();
  const validCandidates = candidatesWithContext.filter(({ context }) => context);
  console.log(`People context validation: ${validCandidates.length}/${candidatesWithContext.length} candidates have recent causal coverage`);
  const addCandidate = ({ person, context }) => {
    if (!context || selected.some((entry) => normalize(entry.title) === normalize(person.title))) return false;
    selected.push(person);
    contexts.push(context);
    categoryCounts.set(person.category, (categoryCounts.get(person.category) ?? 0) + 1);
    return true;
  };
  // Prefer a broad mix of person categories, but never let the diversity
  // preference discard otherwise validated current coverage when the monthly
  // topviews are concentrated in one category.
  for (const candidate of validCandidates) {
    const { person, context } = candidate;
    if (!context) continue;
    const count = categoryCounts.get(person.category) ?? 0;
    if (count >= 2) continue;
    addCandidate(candidate);
    if (selected.length === 10) break;
  }
  if (selected.length < 10) {
    for (const candidate of validCandidates) {
      addCandidate(candidate);
      if (selected.length === 10) break;
    }
  }
  if (selected.length < 10) throw new Error("Wikimedia topviews produced fewer than ten category-balanced people with recent relevance evidence");
  const details = await wikipediaPageDetails(selected.map((person) => person.title));
  const articles = await mapConcurrent(contexts, 2, (context, index) => linkedNewsArticle(context, selected[index]?.title));
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = selected.map((person, index) => {
    const page = details.get(normalize(person.title));
    const title = page?.title ?? person.title;
    const current = currentByTitle.get(normalize(title));
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
    const context = contexts[index];
    const article = articles[index];
    const identity = personIdentity(title, person.entity?.descriptions?.en?.value, person.label);
    const description = personRecentDescription(title, identity, article, context);
    const item = {
      rank: index + 1,
      title,
      subtitle: person.label,
      description,
      image: current?.image ?? `/culture/person-${slugify(title)}.webp`,
      imageSource: page?.thumbnail?.source,
      alt: current?.alt ?? `Portrait of ${title}`,
      url: wikipediaUrl,
      source: "Wikipedia",
      metric: { label: `Wikipedia views · ${topviews.period.month}`, value: formatCompact(person.views) },
      evidence: [
        { source: "Wikimedia monthly topviews", url: topviews.apiUrl },
        { source: "Wikipedia article", url: wikipediaUrl },
        ...(article?.url
          ? [{ source: `${article.context?.source ?? context?.source ?? "Current coverage"}`, url: article.url }]
          : context ? [{ source: `${context.source} via Google News`, url: context.link }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
      category: person.category,
    };
    rememberAiDescriptionContext(item, "people", [
      {
        kind: "current_event",
        source: article?.context?.source ?? context?.source ?? "Current coverage",
        text: factualHeadline(article?.intro, { requireEvent: true, maxLength: 320 }),
        publishedAt: article?.context?.publishedAt ?? context?.publishedAt,
      },
      {
        kind: "current_headline",
        source: article?.context?.source ?? context?.source ?? "Current coverage",
        text: factualHeadline(context?.headline, { requireEvent: true, maxLength: 220, allowCultural: true }),
        publishedAt: context?.publishedAt,
      },
      {
        kind: "current_coverage",
        source: "Related current coverage",
        text: (context?.alternates ?? [])
          .map((candidate) => factualHeadline(candidate.headline, { requireEvent: true, maxLength: 220, allowCultural: true }))
          .filter(Boolean)
          .slice(0, 6)
          .join(" "),
        publishedAt: context?.publishedAt,
      },
      { kind: "background", source: "Wikipedia biography", text: page?.extract },
    ]);
    return item;
  });
  section.eyebrow = `${topviews.period.month} ${topviews.period.year} · Wikipedia topviews`;
  section.title = "People";
  section.description = "Last month's most-viewed English Wikipedia pages that represent living people, excluding politicians and preferring a broad mix of primary categories when current coverage supports it.";
  section.sources = [
    { label: `Topviews · ${topviews.period.month} ${topviews.period.year}`, url: topviewsToolUrl() },
    { label: "Wikimedia · monthly top-pages data", url: topviews.apiUrl },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = "Show ranks 6–10 by Wikipedia views";
}

function eligibleMovie(entity) {
  const description = entity?.descriptions?.en?.value ?? "";
  return /\bfilm\b/i.test(description)
    && !/\b(?:film series|filmography|overview|list of films|events in film)\b/i.test(description);
}

function movieTitle(value) {
  return value.replace(/\s+\((?:\d{4}\s+)?film\)$/i, "").trim();
}

async function cinemetaMovieDetails(imdbId) {
  if (!imdbId) return null;
  try {
    const payload = JSON.parse(await fetchText(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`));
    return payload.meta?.name ? {
      rating: String(payload.meta.imdbRating ?? "").trim() || "Not rated",
      description: payload.meta.description ? plainText(payload.meta.description) : null,
      genres: Array.isArray(payload.meta.genres) ? payload.meta.genres.filter(Boolean).slice(0, 3) : [],
    } : null;
  } catch {
    return null;
  }
}

function numericRating(value) {
  const rating = Number.parseFloat(String(value ?? "").trim());
  return Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating.toFixed(1) : null;
}

let imdbRatingsPromise;

async function imdbRatingsFor(ids) {
  const wanted = new Set(ids.filter(Boolean));
  if (!wanted.size) return new Map();
  if (!imdbRatingsPromise) {
    imdbRatingsPromise = (async () => {
      try {
        const { buffer } = await fetchBytes("https://datasets.imdbws.com/title.ratings.tsv.gz", {
          isAllowedHost: (hostname) => allowedHosts.has(hostname),
          kind: "IMDb ratings dataset",
          maxBytes: MAX_BYTES,
          timeoutMs: TIMEOUT_MS,
          attempts: 2,
        });
        const rows = new Map();
        for (const line of gunzipSync(buffer).toString("utf8").split("\n").slice(1)) {
          const [id, rating] = line.split("\t");
          if (wanted.has(id)) rows.set(id, numericRating(rating));
        }
        return rows;
      } catch (error) {
        console.warn(`IMDb ratings fallback unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return new Map();
      }
    })();
  }
  return imdbRatingsPromise;
}

const movieNarrativePattern = /\b(?:about|after|awakens?|cent(?:er|re)s?|contend|discovers?|encounters?|follows?|forced|journey|must|reunite|returns?|set in|stranded|takes? place|tries?|undergoes?|when|where|while|with no memory|wakes?)\b/i;
const movieCreditPattern = /\b(?:written|directed|produced|screenplay|cinematograph|edited|based on|stars?|starring|feature directorial debut|filmed|photography|premiered|released|release)\b/i;

function moviePlotPremise(...descriptions) {
  const candidates = descriptions.flatMap((description) => sentences(description))
    .filter((sentence) => sentence.length >= 35)
    .filter((sentence) => !/^\s*(?:the film|this film) (?:was|is) (?:written|directed|produced|based)\b/i.test(sentence));
  const ranked = [...new Map(candidates.map((sentence) => [normalize(sentence), sentence])).values()]
    .map((sentence) => ({
      sentence,
      score: (movieNarrativePattern.test(sentence) ? 150 : 0)
        + (movieCreditPattern.test(sentence) ? -130 : 0)
        + (/\b(?:story|film) follows?\b/i.test(sentence) ? 45 : 0)
        + (sentence.length >= 70 && movieNarrativePattern.test(sentence) ? 10 : 0),
    }))
    .sort((left, right) => right.score - left.score || right.sentence.length - left.sentence.length);
  const selected = ranked.filter((candidate) => candidate.score > 0).slice(0, 2).map((candidate) => candidate.sentence);
  return conciseSentences(selected.join(" ") || ranked[0]?.sentence || "", 330);
}

function movieDescription(title, cinemeta, wikipediaExtract, recentContext) {
  const genres = cinemeta?.genres?.map((genre) => genre.toLowerCase()).join("/");
  const identity = genres ? `${title} is ${/^[aeiou]/i.test(genres) ? "an" : "a"} ${genres} film.` : `${title} is a film.`;
  const premise = moviePlotPremise(cinemeta?.description, wikipediaExtract, recentContext);
  return `${identity} ${premise}`.trim();
}

async function updateMovies(brief, topviews) {
  const section = brief.sections.find((entry) => entry.id === "movies");
  if (!section) return;
  const selected = topviews.rows.slice(0, 1000)
    .map((row) => ({ ...row, entity: topviews.entities.get(normalize(row.title)) }))
    .filter((row) => eligibleMovie(row.entity))
    .slice(0, 10);
  if (selected.length < 10) throw new Error("Wikimedia topviews produced fewer than ten movie pages");
  const wikipediaTitles = selected.map((movie) => movie.entity?.sitelinks?.enwiki?.title ?? movie.title);
  const details = await wikipediaPageDetails(wikipediaTitles);
  const metadata = await mapConcurrent(selected, 4, async (movie) => {
    const imdbId = claimStrings(movie.entity, "P345").find((value) => /^tt\d{7,9}$/.test(value));
    return { imdbId, cinemeta: await cinemetaMovieDetails(imdbId) };
  });
  const imdbRatings = await imdbRatingsFor(metadata.map(({ imdbId }) => imdbId));
  const recentContexts = await mapConcurrent(selected, 3, (movie) =>
    googleNewsContext(`"${movie.title}" film`, 180, { requireEvent: false }).catch(() => null)
      .then((context) => context?.headline ?? ""));
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = selected.map((movie, index) => {
    const wikipediaTitle = wikipediaTitles[index];
    const page = details.get(normalize(wikipediaTitle)) ?? details.get(normalize(movie.title));
    const title = movieTitle(page?.title ?? movie.title);
    const current = currentByTitle.get(normalize(title));
    const wikipediaPageTitle = page?.title ?? wikipediaTitle;
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikipediaPageTitle.replaceAll(" ", "_"))}`;
    const { imdbId, cinemeta } = metadata[index];
    const item = {
      rank: index + 1,
      title,
      subtitle: movie.entity?.descriptions?.en?.value?.match(/\b((?:19|20)\d{2})\b/)?.[1]
        ? `${movie.entity.descriptions.en.value.match(/\b((?:19|20)\d{2})\b/)[1]} film`
        : "Movie",
      description: movieDescription(title, cinemeta, page?.extract, recentContexts[index]),
      image: current?.image ?? `/culture/movie-${slugify(title)}.webp`,
      imageSource: page?.thumbnail?.source,
      alt: current?.alt ?? `${title} poster or lead image`,
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/` : wikipediaUrl,
      source: imdbId ? "IMDb" : "Wikipedia",
      metric: { label: `Wikipedia views · ${topviews.period.month}`, value: formatCompact(movie.views) },
      rating: numericRating(cinemeta?.rating) ?? imdbRatings.get(imdbId) ?? "Not rated",
      evidence: [
        { source: "Wikimedia monthly topviews", url: topviews.apiUrl },
        { source: "Wikipedia article", url: wikipediaUrl },
        ...(imdbId ? [{ source: "IMDb", url: `https://www.imdb.com/title/${imdbId}/` }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
    rememberAiDescriptionContext(item, "movies", [
      { kind: "premise", source: "Cinemeta film synopsis", text: cinemeta?.description },
      { kind: "premise", source: "Wikipedia film article", text: page?.extract },
      { kind: "current_coverage", source: "Recent film coverage", text: recentContexts[index] },
    ]);
    return item;
  });
  section.eyebrow = `${topviews.period.month} ${topviews.period.year} · Wikipedia topviews`;
  section.title = "Movies";
  section.description = "Movie pages from last month's English Wikipedia topviews, kept in descending page-view order. IMDb ratings are shown as context but do not affect rank.";
  section.sources = [
    { label: `Topviews · ${topviews.period.month} ${topviews.period.year}`, url: topviewsToolUrl() },
    { label: "Wikimedia · monthly top-pages data", url: topviews.apiUrl },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = "Show ranks 6–10 by Wikipedia views";
}

async function billboardHot100() {
  const chartUrl = "https://www.billboard.com/charts/hot-100/";
  const html = await fetchText(chartUrl, { headers: { "user-agent": "Mozilla/5.0" } });
  const rows = [];
  for (const match of html.matchAll(/<ul class="o-chart-results-list-row\b[\s\S]*?<\/ul>\s*<\/li>\s*<\/ul>/g)) {
    const row = match[0];
    const rank = Number(plainText(row.match(/<span class="c-label[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? ""));
    const titleMatch = row.match(/<h3 id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/);
    const title = plainText(titleMatch?.[1] ?? "");
    const afterTitle = titleMatch ? row.slice((titleMatch.index ?? 0) + titleMatch[0].length) : "";
    const artist = plainText(afterTitle.match(/<span[^>]*class="[^"]*a-no-trucate[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "");
    if (Number.isInteger(rank) && rank >= 1 && rank <= 100 && title) rows.push({ this_week: rank, song: title, artist });
  }
  if (rows.length !== 100) throw new Error(`Billboard returned ${rows.length} Hot 100 rows`);
  const date = html.match(/chart-date-picker[^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
  if (!date) throw new Error("Billboard returned no chart date");
  return { date, rows, chartUrl: `https://www.billboard.com/charts/hot-100/${date}/` };
}

async function spotifyApiTracks() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Spotify API credentials are not configured");
  const token = JSON.parse(await fetchText("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })).access_token;
  if (!token) throw new Error("Spotify returned no access token");
  const url = new URL(`https://api.spotify.com/v1/playlists/${spotifyPlaylistId}/items`);
  url.search = new URLSearchParams({ limit: "50", market: "US", additional_types: "track" });
  const payload = JSON.parse(await fetchText(url, { headers: { authorization: `Bearer ${token}` } }));
  const tracks = (payload.items ?? []).map((entry) => entry.item ?? entry.track).filter(Boolean).map((track) => ({
    id: track.id,
    title: track.name,
    artist: (track.artists ?? []).map((artist) => artist.name).join(", "),
    image: track.album?.images?.[0]?.url,
  }));
  if (tracks.length < 20) throw new Error("Spotify API returned an incomplete editorial playlist");
  return tracks;
}

async function spotifyEmbedTracks() {
  const html = await fetchText(`https://open.spotify.com/embed/playlist/${spotifyPlaylistId}?theme=0`, { headers: { "user-agent": "Mozilla/5.0" } });
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!raw) throw new Error("Spotify returned no embedded playlist data");
  const tracks = JSON.parse(raw).props?.pageProps?.state?.data?.entity?.trackList ?? [];
  if (tracks.length < 20) throw new Error("Spotify returned an incomplete editorial playlist");
  return tracks.map((track) => ({
    id: String(track.uri ?? "").split(":").at(-1),
    title: track.title,
    artist: plainText(track.subtitle ?? ""),
    image: track.visualIdentity?.image?.[0]?.url ?? track.visualIdentity?.image,
  }));
}

async function spotifyPlaylistTracks() {
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      return await spotifyApiTracks();
    } catch (error) {
      console.warn(`Spotify Web API fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return spotifyEmbedTracks();
}

async function spotifyTrackDetails(trackId) {
  try {
    const html = await fetchText(`https://open.spotify.com/track/${trackId}`, {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    const released = plainText(html.match(/<meta\s+name="music:release_date"\s+content="([^"]+)"/i)?.[1] ?? "");
    return { released };
  } catch {
    return { released: "" };
  }
}

async function updateMusic(brief, chart, spotifyTracks) {
  const section = brief.sections.find((entry) => entry.id === "music");
  if (!section) return;
  const ignoredArtistTokens = new Set(["and", "feat", "featuring", "the", "with"]);
  const artistTokens = (value) => new Set(normalize(value).split(" ")
    .filter((token) => token.length >= 3 && !ignoredArtistTokens.has(token)));
  const sameArtist = (left, right) => {
    const leftTokens = artistTokens(left);
    return [...artistTokens(right)].some((token) => leftTokens.has(token));
  };
  const billboardByTitle = new Map();
  for (const row of chart.rows) {
    const rank = Number(row.this_week);
    if (!Number.isInteger(rank) || rank < 1 || rank > 100) continue;
    const key = normalize(row.song);
    billboardByTitle.set(key, [...(billboardByTitle.get(key) ?? []), row]);
  }
  const spotifySelected = [];
  const seenTrackIds = new Set();
  for (let index = 0; index < spotifyTracks.length && spotifySelected.length < 10; index += 1) {
    const track = spotifyTracks[index];
    if (!/^[A-Za-z0-9]{22}$/.test(track.id) || seenTrackIds.has(track.id)) continue;
    const row = (billboardByTitle.get(normalize(track.title)) ?? [])
      .find((candidate) => sameArtist(track.artist, candidate.artist));
    if (!row) continue;
    seenTrackIds.add(track.id);
    spotifySelected.push({ track, spotifyRank: index + 1, row });
  }
  if (spotifySelected.length < 10) throw new Error("Fewer than ten songs overlapped Billboard and Spotify");
  const crossovers = [...spotifySelected]
    .sort((left, right) => Number(left.row.this_week) - Number(right.row.this_week));
  const descriptions = await mapConcurrent(crossovers, 4, async ({ track }) => {
    const [candidateContext, details] = await Promise.all([
      googleNewsContext(`"${track.title}" "${track.artist}"`, 30, { requireEvent: true }).catch(() => null),
      spotifyTrackDetails(track.id),
    ]);
    const context = candidateContext && normalize(candidateContext.headline).includes(normalize(track.title))
      ? candidateContext
      : null;
    return { context, details };
  });
  const currentById = new Map(
    [...section.items, ...(section.moreItems ?? [])]
      .filter((item) => item.spotifyId)
      .map((item) => [item.spotifyId, item]),
  );
  section.eyebrow = "Spotify Today’s Top Hits × Billboard";
  section.title = "Music";
  section.description = "The first 10 tracks in Spotify’s Today’s Top Hits that also appear on the Billboard Hot 100 are selected, then all 10 are ordered by Billboard position. Every track remains playable here.";
  section.sources = [
    { label: "Spotify · Today’s Top Hits", url: `https://open.spotify.com/playlist/${spotifyPlaylistId}` },
    { label: `Billboard Hot 100 · ${chart.date}`, url: chart.chartUrl },
  ];
  const allItems = crossovers.map(({ row, track, spotifyRank }, index) => {
    const current = currentById.get(track.id);
    const { context, details } = descriptions[index];
    const released = publicationDateLabel(details.released);
    const identity = ensureSentence(`“${track.title}” is a track by ${track.artist}${released ? `, released ${released}` : ""}`);
    return {
      rank: index + 1,
      title: track.title,
      subtitle: track.artist,
      description: recentDescription(identity, context?.headline, { rejectChartPlacement: true, requireEvent: true }),
      image: current?.image ?? `/culture/song-${slugify(`${track.title}-${track.artist}`)}.webp`,
      imageSource: track.image,
      alt: current?.alt ?? `${track.title} artwork by ${track.artist}`,
      url: `https://open.spotify.com/track/${track.id}`,
      source: "Spotify",
      metric: { label: "Billboard Hot 100", value: `#${row.this_week}` },
      evidence: [
        { source: "Spotify", url: `https://open.spotify.com/playlist/${spotifyPlaylistId}` },
        { source: "Billboard", url: chart.chartUrl },
        ...(context ? [{ source: `${context.source} via Google News`, url: context.link }] : []),
      ],
      accent: accents[index % accents.length],
      spotifyId: track.id,
      spotifyRank,
      ...(released ? { releaseDate: released } : {}),
    };
  });
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5, 10);
  section.moreLabel = `Show ranks 6–${section.moreItems.at(-1).rank}`;
}

function titleCase(value) {
  const preferred = new Map([
    ["gta", "GTA"], ["macbook", "MacBook"], ["iphone", "iPhone"], ["ipad", "iPad"],
    ["llc", "LLC"], ["nba", "NBA"], ["nfl", "NFL"], ["nhl", "NHL"], ["ps5", "PS5"], ["xbox", "Xbox"],
  ]);
  return value.replace(/\b[\w'-]+\b/g, (word) => preferred.get(word.toLowerCase())
    ?? `${word[0].toUpperCase()}${word.slice(1)}`);
}

function queryVariants(value) {
  const words = value.split(/\s+/).filter(Boolean);
  return [...new Set([
    value,
    words.slice(0, 2).join(" "),
    words.slice(0, 3).join(" "),
  ].filter((entry) => entry.length >= 3))];
}

function queryEntityMatch(query, entities, predicate) {
  return queryVariants(query).some((variant) => predicate(entities.get(normalize(variant))));
}

async function wikidataSearchIsPerson(value) {
  const key = normalize(value);
  if (!key) return false;
  if (wikidataPersonCache.has(key)) return wikidataPersonCache.get(key);
  const request = (async () => {
  const words = titleCase(value).split(/\s+/).filter(Boolean);
  const variants = [...new Set([words.slice(0, 2).join(" "), words.join(" ")].filter((entry) => entry.length >= 3))];
  for (const variant of variants) {
    const url = new URL("https://www.wikidata.org/w/api.php");
    url.search = new URLSearchParams({
      action: "wbsearchentities",
      search: variant,
      language: "en",
      uselang: "en",
      limit: "3",
      format: "json",
      origin: "*",
    });
    const results = (await fetchWikidataJson(url)).search ?? [];
    const key = normalize(variant);
    const matches = results.filter((result) => {
      const label = normalize(result.label ?? "");
      return label === key || label.startsWith(key + " ");
    });
    for (const match of matches) {
      if (!match?.id) continue;
      const entityUrl = new URL("https://www.wikidata.org/w/api.php");
      entityUrl.search = new URLSearchParams({
        action: "wbgetentities",
        ids: match.id,
        props: "claims",
        format: "json",
        origin: "*",
      });
      const entity = (await fetchWikidataJson(entityUrl)).entities?.[match.id];
      if (claimIds(entity, "P31").includes("Q5")) return true;
    }
  }
  return false;
  })();
  wikidataPersonCache.set(key, request);
  try {
    return await request;
  } catch (error) {
    wikidataPersonCache.delete(key);
    throw error;
  }
}

function productTokens(value) {
  return normalize(value).split(" ")
    .filter((token) => token.length > 1 && !new Set(["for", "the", "with"]).has(token))
    .map((token) => token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
}

function productFamilyKey(value) {
  const generic = new Set(["a", "an", "and", "best", "buy", "buying", "deal", "deals", "find", "for", "from", "gift", "gifts", "item", "items", "new", "popular", "product", "products", "the", "toy", "toys", "trend", "trending", "viral"]);
  const tokens = normalize(value).split(" ").filter((token) => token.length > 0 && !generic.has(token));
  const singular = tokens.map((token) => token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
  const collapsed = [];
  for (let index = 0; index < singular.length; index += 1) {
    const current = singular[index];
    const next = singular[index + 1];
    if (next && /^[a-z]+$/.test(current) && /^\d+[a-z]*$/.test(next)) {
      collapsed.push(`${current}${next}`);
      index += 1;
    } else {
      collapsed.push(current);
    }
  }
  return collapsed.join(" ");
}

function productGroupKey(value) {
  const family = productFamilyKey(value);
  const descriptorTokens = family.split(" ").filter((token) => /^(?:bag|brush|candle|card|cube|dumpling|gadget|gloss|lip|mascara|mug|phone|plush|serum|skincare|squish|tote|tracker|watch|wearable)$/.test(token));
  return descriptorTokens.length >= 2 ? [...new Set(descriptorTokens)].sort().join(" ") : family;
}

const genericProductWords = new Set([
  "all", "back", "best", "buy", "buying", "day", "deal", "deals", "find", "here", "item", "items",
  "more", "new", "one", "parents", "popular", "prime", "sale", "section", "shop", "starting", "story", "stories",
  "things", "today", "top", "trend", "trending", "viral", "warning", "what", "where", "why", "years", "glow", "latest", "original", "mystery", "craze", "facts", "surprise", "sensation", "legendary", "beer", "cups", "faster", "moment", "far", "so",
  "about", "actually", "collectible", "collectibles", "doctors", "experts", "everything", "how", "hype", "inside", "internet", "job", "just", "know", "officials",
  "again", "after", "air", "america", "away", "award", "back", "bag", "backpack", "before", "beverage", "beverages", "bicycle", "bottle", "bottles", "brand", "brands", "box", "brush", "buys", "cake", "camera", "candle", "candles", "case", "charger", "china", "concern", "concerns", "console", "cup", "down", "dot", "drink", "drinks", "dumpling", "dumplings", "eagle", "earthbound", "earbuds", "exclusive", "fidget", "food", "first", "fold", "foldable", "found", "fragrance", "frappuccino", "full", "get", "give", "good", "great", "headphones", "health", "here", "hit", "hot", "housekeeping", "how", "in", "india", "innovations", "into", "jacket", "jack", "june", "keyboard", "kids", "laptop", "last", "lifestyle", "lip", "look", "make", "make-up", "makes", "many", "market", "mascara", "mattress", "media", "meet", "memorial", "merch", "merchandise", "mister", "minutes", "monitor", "mouse", "mug", "my", "now", "olive", "online", "only", "on", "or", "out", "packaging", "people", "phone", "phones", "picks", "places", "platform", "plush", "price", "products", "psst", "raises", "retailer", "retail", "right", "rms", "router", "report", "serum", "share", "shoppers", "size", "skin", "skincare", "smartphone", "snack", "snacks", "sneaker", "specific", "stock", "still", "switch", "tablet", "target", "things", "throw", "tote", "totes", "toys", "tracker", "tried", "under", "up", "use", "using", "vacuum", "video", "watch", "water", "week", "which", "why", "world", "worth", "wants", "young",
]);
const productIdentityPattern = /\b(?:air\s*fryer|backpack|bag|beverage|bicycle|bottle|brush|camera|candle|card|case|chair|charger|coffee|collectible|console|cube|doll|drink|dumpling|earbuds?|fold(?:able)?|frappuccino|fragrance|gadget|gloss|headphones?|jacket|keyboard|laptop|lip|mascara|mattress|monitor|mouse|mug|phone|plush|router|serum|skincare|smartphone|snack|sneaker|squish(?:y)?|switch|tablet|tote|tracker|toy|tumbler|vacuum|watch|wearable)\b/i;
const genericProductPhrasePattern = /^(?:ahead|beauty product|cocktails?|emerging contemporary bag|fan[- ]favou?rite drink|fans?|i['’]?m|its most drink|korean skincare|line|portable fan|plush|report|results?|shelves?|summer dress|squishy(?: toy)?(?: trend| craze)?|squishy dumpling(?:s|[’']? toys?)?|toy trend|toy craze|tri state parents|viral gadget|viral product|product trend|right now|tote bag nationwide|tote bag|body oil|hair mascara)$/i;
const genericProductTailPattern = /\b(?:beverage|drink|lip|product|products?|serum|skincare|smartphone|phone|toy|toys?)\b$/i;
const productEditorialPattern = /\b(?:best|defining|edit(?:or['’]?s)?|guide|roundup|results?|routine|top|trends?|what to buy|where to buy)\b/i;
const productArticleBoilerplatePattern = /\b(?:affiliate commission|independently reviewed|when you purchase|purchase(?:d)? (?:an|a) .* through a link|links? on this page|shopping editors? (?:picked|selected)|we may earn|earn a commission|sponsored|advertisement|shop (?:our|the) (?:edit|selection)|click (?:here|the link|on links? we provide)|selected independently|editorial independence|shop today|we cover and recommend|learn more)\b/i;
const productAdControversyPattern = /\b(?:beauty routine|brand .*respond|not actually|didn['’]?t use|did not use|tit for tat|ad(?:vertis)?|backlash|scandal)\b/i;
const productCommercePattern = /\b(?:amazon|black friday|coupon|deal(?:s)?|discount|editor(?:s|ial)? pick|faves?|gift guide|k-beauty|last chance|off|prime day|routine|sale|shop(?:ping)?|tested|top pick|we tested)\b/i;
const productComparisonPattern = /\b(?:alongside|another|compared?\s+(?:to|with)|instead of|like|new|next|other|replace(?:ment)?|rather than|rival|similar to|versus|vs\.?)\b/i;
const productReferencePattern = /\b(?:accessories|background|creation|facts|history|trivia|wiki|encyclop(?:edia|a)|kasing lung)\b/i;
const amazonFocusTerms = new Set(["airwrap", "supersonic", "vacuum", "hair", "dryer", "brush", "mask", "serum", "toner", "candle", "tote", "bag", "lip", "skin", "skincare", "beauty", "squish", "squishy", "dumpling", "toy", "plush", "cup", "collectible", "gadget", "phone", "watch", "shoe", "sneaker", "dress", "jacket"]);
const amazonCategoryTerms = new Set(["airfryer", "bag", "bottle", "brush", "camera", "candle", "charger", "coffee", "console", "cube", "drink", "dumpling", "fold", "frappuccino", "fragrance", "gadget", "headphone", "laptop", "lip", "mascara", "mattress", "monitor", "mouse", "mug", "phone", "plush", "serum", "skincare", "smartphone", "snack", "sneaker", "squish", "switch", "tablet", "tote", "toy", "tumbler", "vacuum", "watch"]);
const amazonAccessoryPattern = /\b(?:case|cover|filter|holder|insert|liner|mount|organizer|protector|replacement|screen\s+(?:film|guard|protector)|sleeve|stand|strap|tempered\s+glass|skin)\b/i;
const amazonMerchandisePattern = /\b(?:decals?|hood(?:ie|ies)|keychains?|notebooks?|ornaments?|posters?|prints?|stickers?|sweatshirts?|shirts?|wall\s+art)\b/i;

function amazonCategoryTokens(value) {
  return [...productTokenSet(value)].filter((token) => [...amazonCategoryTerms].some((category) => token === category || token.startsWith(category)));
}

function isGenericProductCandidate(value) {
  const tokens = normalize(value).replace(/\s+s\b/g, "").split(" ").filter(Boolean);
  return !tokens.length
    || genericProductPhrasePattern.test(value)
    || /\b(?:away|brings?|cause|collaboration|could|cult|down|everyone|exclusive|forecast|good housekeeping|gta|india|japanese|largest|market|minutes?|my|over|own|packaging|secrets?|size|signature drink|specific fidget|throw|very specific|week|wants?|world['’]?s largest)\b/i.test(value)
    || (genericProductTailPattern.test(value) && /\b(?:custom|korean|popular|specific|viral)\b/i.test(value))
    || /\b(?:merch(?:andise)?|outfit|shelves?)\b/i.test(value)
    || /^(?:fan[- ]favou?rite|its?|their|this|that|grocery|newest|latest|most|viral|popular|iconic)\b/i.test(value)
    || /\b(?:company['’]?s|grocery company|newest tote|most drink)\b/i.test(value)
    || (productEditorialPattern.test(value) && /\b(?:20\d{2}|products?|skincare|beauty|gifts?|deals?|trends?)\b/i.test(value))
    || /^(?:\w+\s+){0,3}(?:20\d{2})\s+(?:skincare|beauty|products?|trends?)$/i.test(value)
    || (tokens.length <= 2 && /\b(?:award|coffee|fidget)\b/i.test(value))
    || (tokens.length === 1 && genericProductWords.has(tokens[0]))
    || (tokens.length <= 2 && tokens.every((token) => genericProductWords.has(token) || ["product", "products", "squishy", "toy", "toys"].includes(token)));
}

function hasSpecificProductName(value) {
  const tokens = productFamilyKey(value).split(" ").filter(Boolean);
  return productIdentityPattern.test(value)
    || tokens.some((token) => /^[a-z]{2,}\d+[a-z]*$/i.test(token));
}

const productContextPattern = /\b(?:air\s*fryer|apparel|bag|beauty|beverage|bicycle|bottle|brush|camera|candle|coffee|collectible|console|cosmetic|cube|doll|drink|dumpling|electronics?|food|fold(?:able)?|frappuccino|fragrance|gadget|headphones?|kitchen|laptop|lip|makeup|merch(?:andise)?|phone|plush|product|serum|skincare|smartphone|snack|sneaker|squish(?:y)?|switch|tablet|toy|tumbler|vacuum|wearable)\b/i;

function hasProductContext(candidate) {
  return productContextPattern.test(candidate.name)
    || candidate.observations.some((observation) => productContextPattern.test(observation.headline));
}

function hasProductNameEvidence(candidate) {
  if (hasSpecificProductName(candidate.name)) return true;
  const target = normalize(candidate.name);
  const targetTokens = target.split(" ").filter(Boolean);
  const categoryPattern = /\b(?:air\s*fryer|apparel|bag|beauty|beverage|bicycle|bottle|brush|camera|candle|coffee|collectible|console|cosmetic|cube|doll|drink|dumpling|electronics?|food|fold(?:able)?|frappuccino|fragrance|gadget|headphones?|kitchen|laptop|lip|makeup|phone|plush|product|serum|skincare|smartphone|snack|sneaker|squish(?:y)?|switch|tablet|toy|tumbler|vacuum|wearable)\b/i;
  const qualifying = candidate.observations.filter((observation) => {
    const text = plainText(observation.headline ?? "");
    if (/\b(?:accessories|background|creation|facts|history|trivia|wiki|encyclop(?:edia|a)|brand(?:s)?|retailer)\b/i.test(text)) return false;
    const normalizedText = normalize(text);
    const index = normalizedText.indexOf(target);
    if (index < 0) return false;
    const nearby = normalizedText.slice(Math.max(0, index - 48), index + target.length + 64);
    return categoryPattern.test(nearby) && targetTokens.every((token) => nearby.includes(token)) && productDemandScore(text) > 0;
  });
  return qualifying.length >= 2;
}

function productEvidenceOverlap(left, right) {
  const leftLinks = new Set((left.evidence ?? []).map((entry) => entry.directUrl ?? entry.link).filter(Boolean));
  const rightLinks = new Set((right.evidence ?? []).map((entry) => entry.directUrl ?? entry.link).filter(Boolean));
  return [...leftLinks].filter((link) => rightLinks.has(link)).length;
}

function isBrandLikeProductName(value) {
  const tokens = productFamilyKey(value).split(" ").filter(Boolean);
  return tokens.length >= 1 && tokens.length <= 2
    && tokens.every((token) => /^[a-z][a-z0-9'’-]*$/i.test(token) && !genericProductWords.has(token));
}

function usableProductIntro(value) {
  const text = sanitizeSocialText(value);
  return text.length >= 45
    && !productArticleBoilerplatePattern.test(text)
    && (!productCommercePattern.test(text) || productDemandScore(text) >= 2)
    && !productAdControversyPattern.test(text) ? text : "";
}

function usableProductHeadline(value) {
  const text = sanitizeSocialText(value);
  return text.length >= 35
    && (!productCommercePattern.test(text) || productDemandScore(text) >= 2)
    && !productArticleBoilerplatePattern.test(text)
    && !productAdControversyPattern.test(text)
    && !/:\s*(?:what to know|where to buy|the details)\b/i.test(text)
    && !/^(?:how to|what to know|best|where to buy|review|editors?\b)/i.test(text) ? text : "";
}

function productViralPhrase(value) {
  const text = sanitizeSocialText(value);
  const match = text.match(/\b(?:viral|trending|going viral|frenzy|craze|obsessed|collectors?|restock(?:ed)?|sold out|selling out|unboxing|hunting|popular)\b[\s\S]{0,180}/i);
  const phrase = match?.[0]
    ?.replace(/\s*,?\s*(?:starting at|up to|from)\s+\$?[\d,.]+(?:\s*(?:off|each))?[^.!?]*$/i, "")
    .replace(/\s*[–—-]\s*[^.!?]*(?:what to know|worth it|sale|deal)[^.!?]*$/i, "")
    .replace(/\s*:\s*(?:what to know|where to buy|the details)[^.!?]*[.!?]?$/i, "")
    .trim();
  return phrase ? conciseSentences(phrase, 220) : "";
}

function lowerFirst(value) {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}

function productNameCandidate(value, source = "") {
  let candidate = plainText(value)
    .replace(/\b(?:amazon|announc(?:e|ed|es|ing)?|back|back[- ]?orders?|best|bring(?:s|ing)?|buy|deals?|demand|find|from|just|launch(?:es|ed|ing)?|new|officially|popular|pre[- ]?orders?|products?|record|releas(?:e|ed|es|ing)?|return(?:s|ed|ing)?|revea(?:l|led|ls|ling)|sales|selling|sold|the|this|tiktok|units?|viral|trend(?:ing)?|what|when|where)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,'"“”‘’()-]+|[\s:,'"“”‘’()-]+$/g, "")
    .trim();
  if (/^(?:\d{1,4}|\d{4}[a-z]?)$/i.test(candidate)
    || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|performance|parents?|burn|risks?)\b/i.test(candidate)) return "";
  candidate = candidate.replace(/([A-Za-z])['’]s\b/gi, "$1's")
    .replace(/^(?:expand|explains?|inside|introducing|meet|shop|the|unbox(?:ing)?|where(?: to)? buy)\s+/i, "");
  candidate = candidate.replace(/^(?:legendary|original|latest|new|viral)\s+(?:20\d{2}\s+)?/i, "").trim();
  candidate = candidate.replace(/\s+(?:blended\s+)?beverage$/i, "").trim();
  candidate = candidate.split(/\b(?:a|about|according|after|an|and|any|are|as|at|before|but|can|changed|favorite|for|from|has|have|in|is|many|of|on|or|our|that|their|these|to|videos?|went|which|with|you)\b/i)[0]
    .replace(/[\s:,'"“”‘’()-]+$/, "")
    .trim();
  if (isGenericProductCandidate(candidate)) return "";
  const key = productFamilyKey(candidate);
  if (!key || key.length < 3 || key.split(" ").length > 7
    || /\b(?:amazon|beauty|clothing|deals?|gadgets?|home|kitchen|products?|shoes|social|summer|tiktok|toys?|viral)\b/i.test(key)
    || productFamilyKey(source) === key) return "";
  return candidate;
}

function productNamesFromHeadline(headline, source) {
  const names = [];
  const clean = plainText(headline).replace(/[–—]/g, " - ");
  const addNameVariants = (raw) => {
    const words = plainText(raw).split(/\s+/).filter(Boolean);
    for (let start = Math.max(0, words.length - 5); start < words.length; start += 1) {
      const candidate = productNameCandidate(words.slice(start).join(" "), source);
      if (candidate) names.push(candidate);
    }
  };
  const titleToken = String.raw`(?:[A-Z][A-Za-z0-9’'&-]{1,}|[A-Z](?=\s+[A-Z0-9])|\d+[A-Za-z0-9-]*)`;
  for (const match of clean.matchAll(new RegExp(`\\b${titleToken}(?:\\s+${titleToken}){0,5}\\b`, "g"))) {
    const candidate = productNameCandidate(match[0], source);
    if (candidate) names.push(candidate);
  }
  for (const match of clean.matchAll(/\b(?:[A-Za-z0-9][A-Za-z0-9’'&-]*\s+){1,5}(?:air\s*fryer|backpack|bag|beverage|bicycle|bottle|brush|camera|candle|card|case|chair|charger|coffee|collectible|console|cube|doll|drink|dumpling|earbuds?|foldable|frappuccino|fragrance|gadget|gloss|headphones?|jacket|keyboard|laptop|lip|mascara|mattress|monitor|mouse|mug|phone|plush|router|serum|skincare|smartphone|snack|sneaker|squish(?:y)?|switch|tablet|tote|tracker|toy|tumbler|vacuum|watch|wearable)\b/gi)) {
    addNameVariants(match[0]);
  }
  for (const match of clean.matchAll(/\b(?:collectible|frenzy|hunting|popular|restock(?:ed)?|sold out|unboxing|viral|trending)\s+(?:the\s+)?([^:?!-]{2,70})/gi)) {
    addNameVariants(match[1]);
  }
  const normalizedHeadline = normalize(clean);
  return [...new Map(names
    .filter((name) => {
      if (hasSpecificProductName(name)) return true;
      const target = normalize(name);
      const index = normalizedHeadline.indexOf(target);
      if (index < 0) return false;
      const nearby = normalizedHeadline.slice(Math.max(0, index - 64), index + target.length + 96);
      return productIdentityPattern.test(nearby) && productDemandScore(clean) > 0;
    })
    .map((name) => [productFamilyKey(name), name])).values()];
}

function productNamesFromIntro(intro, source) {
  const names = [];
  const text = plainText(intro);
  const addNameVariants = (raw) => {
    const words = plainText(raw).split(/\s+/).filter(Boolean);
    for (let start = Math.max(0, words.length - 4); start < words.length; start += 1) {
      const candidate = productNameCandidate(words.slice(start).join(" "), source);
      if (candidate && hasSpecificProductName(candidate)) names.push(candidate);
    }
  };
  const token = String.raw`(?:[A-Z][A-Za-z0-9’'&-]{1,}|\d+[A-Za-z0-9-]*)`;
  const category = String.raw`(?:air\s*fryer|backpack|bag|beverage|bicycle|bottle|brush|camera|candle|card|case|chair|charger|coffee|collectible|console|cube|doll|drink|dumpling|earbuds?|foldable|frappuccino|fragrance|gadget|gloss|headphones?|jacket|keyboard|laptop|lip|mascara|mattress|monitor|mouse|mug|phone|plush|router|serum|skincare|smartphone|snack|sneaker|squish(?:y)?|switch|tablet|tote|tracker|toy|tumbler|vacuum|watch|wearable)`;
  for (const match of text.matchAll(new RegExp(`\\b${token}(?:\\s+${token}){0,5}\\s+${category}\\b`, "gi"))) {
    addNameVariants(match[0]);
  }
  for (const candidate of productNamesFromHeadline(text, source)) {
    if (hasSpecificProductName(candidate)) names.push(candidate);
  }
  for (const match of text.matchAll(/[“"]([^“”"\n]{2,80})[”"]/g)) {
    const candidate = productNameCandidate(match[1], source);
    if (candidate && hasSpecificProductName(candidate)) names.push(candidate);
  }
  return [...new Map(names.map((name) => [productFamilyKey(name), name])).values()];
}

function productEvidenceSpecificTo(productName, evidence) {
  const headline = plainText(evidence?.headline ?? "");
  const intro = plainText(evidence?.intro ?? "");
  const text = `${headline} ${intro}`.trim();
  if (!text || productTokenOverlap(productName, text) <= 0 || productReferencePattern.test(text)) return false;
  const distinctiveTokens = productTokens(productName)
    .filter((token) => token.length > 2 && !genericProductWords.has(token) && !amazonCategoryTerms.has(token));
  const distinctiveMatches = distinctiveTokens.filter((token) => productTokenSet(text).has(token)).length;
  if (distinctiveTokens.length && distinctiveMatches < Math.min(2, distinctiveTokens.length)) return false;
  const target = normalize(productName);
  const mentions = [...new Set([
    ...productNamesFromHeadline(headline, evidence?.source ?? ""),
    ...productNamesFromIntro(intro, evidence?.source ?? ""),
    ...[...text.matchAll(/\b[A-Z][A-Za-z0-9'’-]{2,}(?:\s+[A-Z][A-Za-z0-9'’-]{2,})*/g)].map((match) => match[0]),
  ])].filter((name) => normalize(name) && normalize(name) !== target
    && !/^(?:The|This|That|These|Those|From|Latest|Today|When|What|Why|New|Viral|Recent|Amazon|Google|News|Products?)$/i.test(name)
    && (hasSpecificProductName(name) || isBrandLikeProductName(name)));
  if (!mentions.length || !productComparisonPattern.test(text)) return true;
  const normalizedText = normalize(text);
  const targetTokens = target.split(" ").filter(Boolean);
  const targetPattern = targetTokens.map((token) => escapeRegExp(token)).join("\\s+");
  return !mentions.some((mention) => {
    const mentionTokens = normalize(mention).split(" ").filter(Boolean);
    if (!mentionTokens.length || productTokenOverlap(productName, mention) >= 0.5) return false;
    const mentionPattern = mentionTokens.map((token) => escapeRegExp(token)).join("\\s+");
    const nearTarget = new RegExp(`(?:${mentionPattern})(?:\\s+\\w+){0,8}\\s+(?:${targetPattern})|(?:${targetPattern})(?:\\s+\\w+){0,8}\\s+(?:${mentionPattern})`, "i").test(normalizedText);
    if (!nearTarget) return false;
    const segmentPattern = new RegExp(`(?:${mentionPattern})(?:.{0,64})(?:${targetPattern})|(?:${targetPattern})(?:.{0,64})(?:${mentionPattern})`, "i");
    return segmentPattern.test(normalizedText) && productComparisonPattern.test(normalizedText);
  });
}

function productIdentityTokens(value) {
  return productTokens(value)
    .filter((token) => token.length > 2 && !genericProductWords.has(token) && !amazonCategoryTerms.has(token));
}

function productEvidenceContextText(productName, evidence) {
  const intro = usableProductIntro(evidence?.intro);
  const headline = usableProductHeadline(evidence?.headline);
  const identityTokens = productIdentityTokens(productName);
  const requiredMatches = Math.min(2, identityTokens.length);
  const introSentences = sentences(intro);
  const introMatches = identityTokens.filter((token) => productTokenSet(intro).has(token)).length;
  if (intro && (requiredMatches === 0 || introMatches >= requiredMatches)) {
    const matchingSentences = introSentences
      .map((sentence, index) => ({
        sentence,
        index,
        identityMatches: identityTokens.filter((token) => productTokenSet(sentence).has(token)).length,
        demand: productDemandScore(sentence),
      }))
      .filter((entry) => entry.identityMatches > 0);
    if (matchingSentences.length && matchingSentences.length < introSentences.length) {
      const selected = matchingSentences
        .sort((left, right) => right.identityMatches - left.identityMatches
          || right.demand - left.demand
          || left.index - right.index)
        .slice(0, 2);
      if (!selected.some((entry) => entry.demand > 0 || productScarcitySignal(entry.sentence))) {
        const selectedIndexes = new Set(selected.map((entry) => entry.index));
        const context = introSentences
          .map((sentence, index) => ({
            sentence,
            index,
            demand: productDemandScore(sentence),
            scarcity: productScarcitySignal(sentence),
            distance: Math.min(...selected.map((entry) => Math.abs(entry.index - index))),
          }))
          .filter((entry) => !selectedIndexes.has(entry.index)
            && entry.distance <= 1
            && (entry.demand > 0 || entry.scarcity))
          .sort((left, right) => right.demand - left.demand
            || Number(right.scarcity) - Number(left.scarcity)
            || left.distance - right.distance
            || left.index - right.index)[0];
        if (context) selected.splice(Math.min(selected.length, 1), 0, context);
      }
      return conciseSentences(selected
        .sort((left, right) => left.index - right.index)
        .map((entry) => entry.sentence)
        .join(" "), 280);
    }
    return intro;
  }
  return headline;
}

function productTypePhrase(value) {
  const text = normalize(value);
  if (/\b(?:frappuccino|beverage|coffee|drink|latte|refresh(?:er|ment))\b/.test(text)) return "a blended drink";
  if (/\b(?:fold(?:able)?|flip)\b/.test(text) && /\b(?:phone|smartphone|mobile|galaxy)\b/.test(text)) return "a foldable smartphone";
  if (/\b(?:phone|smartphone|mobile)\b/.test(text)) return "a smartphone";
  if (/\b(?:vacuum|hoover)\b/.test(text)) return "a cordless vacuum";
  if (/\b(?:serum|essence|toner|moisturizer|moisturiser|sunscreen|skincare|skin care|pdrn|collagen)\b/.test(text)) {
    return /\bserum\b/.test(text) ? "a skincare serum" : "a skincare product";
  }
  if (/\b(?:plush|figure|collectible|doll|squish(?:y)?|toy|blind box)\b/.test(text)) return "a collectible toy";
  if (/\b(?:lipstick|lip gloss|mascara|makeup|cosmetic|beauty)\b/.test(text)) return "a beauty product";
  if (/\b(?:snack|candy|chocolate|food)\b/.test(text)) return "a snack";
  if (/\b(?:headphones?|earbuds?|earphones?)\b/.test(text)) return "a pair of headphones";
  if (/\b(?:camera|laptop|tablet|console|keyboard|monitor|router|charger|gadget|electronics?)\b/.test(text)) return "an electronic device";
  if (/\b(?:bag|tote|backpack|jacket|sneaker|shoe|dress|apparel|clothing)\b/.test(text)) return "a fashion item";
  if (/\b(?:candle|mug|tumbler|mattress|chair|bottle|brush)\b/.test(text)) return "a household item";
  return "a consumer product";
}

function amazonListingType(value) {
  const text = normalize(value);
  if (amazonAccessoryPattern.test(text)) return "an accessory";
  if (amazonMerchandisePattern.test(text)
    || /\b(?:mug|tumbler|glass|powder|mix|syrup)\b/.test(text)
    && !/\b(?:drink|beverage|coffee|latte)\b/.test(text)) return "merchandise";
  return productTypePhrase(text);
}

function amazonListingMatchesProduct(query, listingTitle, listingText = "") {
  const title = plainText(listingTitle);
  if (!title) return false;
  const queryTokens = productTokens(query);
  const titleTokens = new Set(productTokens(title));
  if (queryTokens.length && !queryTokens.every((token) => titleTokens.has(token))) return false;
  const queryIsAccessory = amazonAccessoryPattern.test(query);
  if (!queryIsAccessory && amazonAccessoryPattern.test(title)) return false;
  const queryType = amazonListingType(query);
  const listingType = amazonListingType(title);
  if (queryType !== "a consumer product" && listingType !== "a consumer product" && queryType !== listingType) return false;
  if (!queryIsAccessory && /\b(?:merchandise|mug|powder|syrup|tumbler)\b/i.test(title)
    && /\b(?:drink|beverage|coffee|latte|frappuccino)\b/i.test(query)) return false;
  if (!/\$\s?\d|\b(?:add to cart|buy now|in stock)\b/i.test(listingText)) return false;
  return true;
}

function amazonDetailMatchesProduct(query, listingTitle, listingText = "") {
  const title = plainText(listingTitle);
  if (!title) return false;
  const queryIsAccessory = amazonAccessoryPattern.test(query);
  if (!queryIsAccessory && amazonAccessoryPattern.test(title)) return false;
  const queryType = amazonListingType(query);
  const listingType = amazonListingType(title);
  if (queryType !== "a consumer product" && listingType !== "a consumer product" && queryType !== listingType) return false;
  const identityTokens = productTokens(query)
    .filter((token) => token.length > 2 && !genericProductWords.has(token) && !amazonCategoryTerms.has(token));
  const titleTokens = new Set(productTokens(title));
  const identityMatch = identityTokens.some((token) => titleTokens.has(token)
    || [...titleTokens].some((titleToken) => titleToken.startsWith(token) || token.startsWith(titleToken)));
  if (identityTokens.length && !identityMatch) return false;
  return /\$\s?\d|\b(?:add to cart|buy now|in stock|currently unavailable)\b/i.test(listingText);
}

const productDemandPatterns = [
  [/\b(?:buy|buying|collect|collector|collecting|hunting|obsessed|recommend|unbox|unboxing)\b/i, 1],
  [/\b(?:viral|went viral|going viral|trending|social media|internet|frenzy|craze|popular demand)\b/i, 2],
  [/\b(?:demand|high demand|surging|soaring|record(?:-breaking)?|hit|smash hit|fan favorite|customer favorite)\b/i, 2],
  [/\b(?:preorder|pre-orders?|backorder(?:ed)?|wait[- ]?list|shipments? delayed|orders? delayed|sold out|selling out|sell out|restock(?:ed)?|shortage)\b/i, 2],
  [/\b(?:\d[\d,.]*\s*(?:million|thousand|m)\s+(?:units?|sales|orders?|beverages?))\b/i, 3],
];

function productDemandScore(value) {
  return productDemandPatterns.reduce((score, [pattern, weight]) => score + (pattern.test(value) ? weight : 0), 0);
}

function productDemandSignal(value) {
  return productDemandScore(value) > 0;
}

function productControversySignal(value) {
  return /\b(?:controvers|danger|explod|fake|fraud|hospital|injur|lawsuit|recall|scam|safety|warning|backlash|scandal|brand .*respond|beauty routine|ad(?:vertis)?|not actually|didn['’]?t use|did not use)\b/i.test(value);
}

function productScarcitySignal(value) {
  return /\b(?:back in stock|backordered?|hard to find|limited|restock|sold out|waitlist|wait-list|shipments? delayed|orders? delayed|shortage)\b/i.test(value);
}

function productFreshness(publishedAt) {
  const age = (Date.now() - Date.parse(publishedAt)) / 86_400_000;
  return Number.isFinite(age) ? Math.max(0, Math.min(1, 1 - age / 90)) : 0;
}

const productHistoryPattern = /\b(?:first introduced|introduced|debut(?:ed)?|original(?:ly)?|return(?:ed|ing)?|re-?released?|reintroduced|revived|brought back|bring(?:s|ing)? back|returned to|comeback|nostalgia|classic|relaunch(?:ed)?|from\s+20\d{2}|in\s+20\d{2}|earlier version|original launch)\b/i;

function productBackgroundEvidenceSpecificTo(productName, evidence) {
  const text = `${plainText(evidence?.headline ?? "")} ${plainText(evidence?.intro ?? "")}`.trim();
  if (!text || productTokenOverlap(productName, text) <= 0) return false;
  const identityTokens = productIdentityTokens(productName);
  const matches = identityTokens.filter((token) => productTokenSet(text).has(token)).length;
  return matches >= Math.min(2, Math.max(1, identityTokens.length));
}

const productBackgroundCache = new Map();

async function productBackgroundContext(productName) {
  const key = productFamilyKey(productName);
  if (!key) return [];
  if (productBackgroundCache.has(key)) return productBackgroundCache.get(key);
  const request = (async () => {
    const quoted = `"${plainText(productName).replace(/["']/g, "")}"`;
    const queries = [`${quoted} history introduced original return re-release`];
    const searchResults = (await mapConcurrent(queries, 2, (query) =>
      bingSearchArticles(query, "", productName).catch(() => []))).flat();
    const candidates = [...new Map(searchResults.map((result) => [result.url, result])).values()]
      .filter((result) => usableArticleUrl(result.url))
      .slice(0, 4);
    const contexts = await mapConcurrent(candidates, 3, async (candidate) => {
      const metadata = await linkedArticleMetadata(candidate.url, { allowMissingImage: true }).catch(() => null);
      const evidence = {
        headline: candidate.title,
        intro: metadata?.intro ?? "",
      };
      if (!metadata || !productBackgroundEvidenceSpecificTo(productName, evidence)) return null;
      const text = conciseSentences(stripSourceAttribution(`${candidate.title}. ${metadata.intro}`), 420);
      if (!text || !productHistoryPattern.test(text)) return null;
      let source = "Background context";
      try { source = new URL(metadata.url).hostname.replace(/^www\./i, ""); } catch { /* source label remains generic */ }
      return {
        source,
        url: metadata.url,
        text,
        publishedAt: candidate.publishedAt ?? null,
      };
    });
    return contexts.filter(Boolean)
      .sort((left, right) => Number(productHistoryPattern.test(right.text)) - Number(productHistoryPattern.test(left.text))
        || right.text.length - left.text.length)
      .slice(0, 3);
  })().catch((error) => {
    console.warn(`Product background context unavailable for ${productName}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  });
  productBackgroundCache.set(key, request);
  return request;
}

function sanitizeSocialText(value) {
  return plainText(value ?? "")
    .replace(/\bTikTok\b/gi, "social media")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeBriefSocialMentions(brief) {
  for (const section of brief.sections ?? []) {
    section.eyebrow = sanitizeSocialText(section.eyebrow);
    section.title = sanitizeSocialText(section.title);
    section.description = sanitizeSocialText(section.description);
    for (const item of [...(section.items ?? []), ...(section.moreItems ?? [])]) {
      for (const field of ["title", "subtitle", "description", "alt", "source"]) {
        item[field] = sanitizeSocialText(item[field]);
      }
      for (const evidence of item.evidence ?? []) evidence.source = sanitizeSocialText(evidence.source);
    }
    for (const source of section.sources ?? []) source.label = sanitizeSocialText(source.label);
  }
  for (const question of brief.quiz?.questions ?? []) {
    question.topic = sanitizeSocialText(question.topic);
    question.itemTitle = sanitizeSocialText(question.itemTitle);
    question.prompt = sanitizeSocialText(question.prompt);
    question.answers = question.answers.map((answer) => sanitizeSocialText(answer));
    question.correctAnswer = sanitizeSocialText(question.correctAnswer);
  }
}

function capLinkedSources(brief) {
  for (const section of brief.sections ?? []) {
    section.sources = [...new Map((section.sources ?? []).map((source) => [source.url, source])).values()].slice(0, 3);
    for (const item of [...(section.items ?? []), ...(section.moreItems ?? [])]) {
      const entries = [...new Map((item.evidence ?? []).map((entry) => [`${entry.source}\u0000${entry.url}`, entry])).values()];
      const selected = [];
      const hosts = new Set();
      for (const entry of entries) {
        let host = "";
        try { host = new URL(entry.url).hostname; } catch { /* validation reports malformed links */ }
        if (selected.length < 3 && host && !hosts.has(host)) {
          selected.push(entry);
          hosts.add(host);
        }
      }
      for (const entry of entries) {
        if (selected.length >= 3 || selected.includes(entry)) continue;
        selected.push(entry);
      }
      item.evidence = selected.slice(0, 3);
    }
  }
}

function parseAmazonMoverHtml(html, category) {
  const rows = [];
  for (const match of html.matchAll(/data-asin=["']([A-Z0-9]{10})["']/gi)) {
    const scope = html.slice(Math.max(0, match.index - 1_000), (match.index ?? 0) + 8_000);
    const asin = match[1];
    const title = plainText(scope.match(/(?:p13n-sc-truncated|a-size-medium|a-size-base-plus)[^>]*>([\s\S]{8,500}?)<\//i)?.[1] ?? "");
    if (!title) continue;
    const image = scope.match(/<img[^>]+(?:src|data-src)=["']([^"']*m\.media-amazon\.com[^"']*)/i)?.[1] ?? "";
    const currentRank = Number(scope.match(/(?:rank|position)\D{0,20}(\d{1,4})/i)?.[1] ?? 0);
    const gain = Number((scope.match(/(?:up|gained|moved|sales rank)\D{0,30}(\d[\d,]*)/i)?.[1] ?? "0").replaceAll(",", ""));
    rows.push({ asin, title, image, currentRank, gain, category });
  }
  return [...new Map(rows.map((row) => [row.asin, row])).values()];
}

async function amazonMoversAndShakers() {
  const snapshot = process.env.PRODUCT_MOVERS_SNAPSHOT ?? process.env.PRODUCT_TRENDS_SNAPSHOT;
  if (snapshot) {
    const rows = JSON.parse(snapshot);
    if (!Array.isArray(rows)) throw new Error("PRODUCT_MOVERS_SNAPSHOT is invalid");
    return rows.filter((row) => row && typeof row.query === "string").map((row) => ({
      ...row,
      category: String(row.category ?? "Amazon Movers & Shakers"),
      sourceUrl: String(row.sourceUrl ?? amazonMoverCategories[0].url),
    }));
  }
  const rows = [];
  for (const category of amazonMoverCategories) {
    const html = await fetchText(category.fetchUrl, { headers: { "user-agent": "Mozilla/5.0" } }).catch(() => "");
    rows.push(...parseAmazonMoverHtml(html, category.label).map((row) => ({
      ...row,
      query: row.title,
      sourceUrl: category.url,
    })));
  }
  return rows;
}

function googleNewsItemValue(item, tag) {
  return plainText(item.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? "");
}

function parseProductNewsFeed(rss, query) {
  return [...rss.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 40).map((match) => {
    const item = match[1];
    const sourceTag = item.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
    const source = plainText(sourceTag?.[2] ?? "") || "Google News";
    const sourceUrl = sourceTag?.[1]?.match(/\burl=["']([^"']+)/i)?.[1] ?? "";
    const rawHeadline = googleNewsItemValue(item, "title");
    const headline = rawHeadline.endsWith(` - ${source}`)
      ? rawHeadline.slice(0, -source.length - 3).trim()
      : rawHeadline.replace(/\s+-\s+[^-]{2,80}$/, "").trim();
    const link = googleNewsItemValue(item, "link");
    const published = googleNewsItemValue(item, "pubDate");
    const publishedAt = new Date(published);
    return {
      headline,
      source,
      ...(sourceUrl ? { sourceUrl } : {}),
      link,
      publishedAt: Number.isNaN(publishedAt.getTime()) ? null : publishedAt.toISOString(),
      query,
    };
  }).filter((item) => item.headline && item.link && item.publishedAt);
}

function productExpansionSeeds(observations, movers = []) {
  const groups = new Map();
  for (const observation of observations) {
    for (const name of productNamesFromHeadline(observation.headline, observation.source)) {
      if (isGenericProductCandidate(name)) continue;
      const key = productFamilyKey(name);
      if (!key) continue;
      const entry = groups.get(key) ?? { name, sources: new Set(), score: 0, context: 0 };
      entry.sources.add(normalize(observation.source));
      entry.context += Number(hasProductContext({ name, observations: [{ headline: observation.headline }] }));
      entry.score += productDemandScore(observation.headline) + productFreshness(observation.publishedAt)
        + (hasProductContext({ name, observations: [{ headline: observation.headline }] }) ? 2 : 0);
      if (name.length > entry.name.length) entry.name = name;
      groups.set(key, entry);
    }
  }
  for (const mover of movers) {
    const name = productNameCandidate(mover.query ?? mover.title ?? "");
    if (!name || isGenericProductCandidate(name)) continue;
    const key = productFamilyKey(name);
    const entry = groups.get(key) ?? { name, sources: new Set(), score: 0, context: 0 };
    entry.score += Math.max(1, Number(mover.gain ?? 0) / 25);
    if (name.length > entry.name.length) entry.name = name;
    groups.set(key, entry);
  }
  return [...groups.values()]
    .filter((entry) => (hasSpecificProductName(entry.name) || isBrandLikeProductName(entry.name)) && (entry.context > 0 || hasSpecificProductName(entry.name)))
    .sort((left, right) => right.context - left.context || right.score - left.score || right.sources.size - left.sources.size)
    .slice(0, 20)
    .map((entry) => entry.name);
}

async function productNewsFeed(query) {
  const feedUrl = new URL("https://news.google.com/rss/search");
  feedUrl.search = new URLSearchParams({ q: `${query} when:90d`, hl: "en-US", gl: "US", ceid: "US:en" });
  return parseProductNewsFeed(await fetchText(feedUrl), query);
}

async function viralProductNewsItems(movers = []) {
  const feeds = await mapConcurrent(productDiscoveryQueries, 3, productNewsFeed);
  const initial = feeds.flat();
  const seeds = productExpansionSeeds(initial, movers);
  const expansionQueries = [...new Set(seeds.flatMap((seed) => [
    `"${seed}" viral`,
    `"${seed}" trending product`,
  ]))];
  const expandedFeeds = await mapConcurrent(expansionQueries, 3, productNewsFeed);
  return [...initial, ...expandedFeeds.flat()];
}

function productTokenSet(value) {
  return new Set(productFamilyKey(value).split(" ").filter((token) => token.length > 1));
}

function isBlockedSocialUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const hostname = url.hostname.toLowerCase();
    return /tiktok/i.test(url.href)
      || hostname === "tiktok.com"
      || hostname.endsWith(".tiktok.com")
      || hostname.includes("tiktok");
  } catch {
    return false;
  }
}

const productArticleResolutionCache = new Map();

async function resolveProductArticle(rawUrl) {
  if (!rawUrl) return rawUrl;
  let parsed;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }
  if (parsed.hostname !== "news.google.com") return parsed.href;
  if (!productArticleResolutionCache.has(parsed.href)) {
    const request = resolveGoogleNewsArticle(parsed.href).catch((error) => {
      productArticleResolutionCache.delete(parsed.href);
      throw error;
    });
    productArticleResolutionCache.set(parsed.href, request);
  }
  return productArticleResolutionCache.get(parsed.href);
}

function productTokenOverlap(left, right) {
  const leftTokens = productTokenSet(left);
  const rightTokens = productTokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function productTokenSubset(shorter, longer) {
  const shortTokens = productTokenSet(shorter);
  const longTokens = productTokenSet(longer);
  return shortTokens.size > 0 && shortTokens.size < longTokens.size
    && [...shortTokens].every((token) => longTokens.has(token));
}

function bestProductMover(group, movers) {
  const exact = movers.find((mover) => productFamilyKey(mover.query ?? mover.title ?? "") === group.key);
  if (exact) return exact;
  return movers
    .map((mover) => ({ mover, overlap: productTokenOverlap(group.name, mover.query ?? mover.title ?? "") }))
    .filter((entry) => entry.overlap >= 0.6)
    .sort((left, right) => right.overlap - left.overlap || Number(right.mover.gain ?? 0) - Number(left.mover.gain ?? 0))[0]?.mover;
}

async function viralProductCandidates(movers) {
  const observations = await viralProductNewsItems(movers);
  const groups = new Map();
  for (const observation of observations) {
    if ((Date.now() - Date.parse(observation.publishedAt)) > 90 * 86_400_000) continue;
    const names = productNamesFromHeadline(observation.headline, observation.source);
    for (const name of names) {
      const key = productGroupKey(name);
      if (!key) continue;
      const group = groups.get(key) ?? { key, name, observations: [] };
      group.observations.push({
        ...observation,
        name,
        demand: productDemandSignal(observation.headline),
        controversy: productControversySignal(observation.headline),
        scarcity: productScarcitySignal(observation.headline),
      });
      if (name.length > group.name.length
        || (name[0] === name[0]?.toUpperCase() && group.name[0] === group.name[0]?.toLowerCase())) group.name = name;
      groups.set(key, group);
    }
  }
  const namedGroups = [...groups.values()];
  const personCheckGroups = namedGroups
    .filter((group) => !productIdentityPattern.test(group.name)
      && group.name.trim().split(/\s+/).length >= 2
      && new Set(group.observations.map((item) => normalize(item.source))).size >= 2)
    .slice(0, 24);
  const personFlags = new Map(await mapConcurrent(personCheckGroups, 1, async (group) => [
    group.key,
    await wikidataSearchIsPerson(group.name).catch(() => false),
  ]));
  const candidates = namedGroups.filter((group) => !personFlags.get(group.key)).map((group) => {
    const sources = new Set(group.observations.map((item) => normalize(item.source)));
    const positive = group.observations.filter((item) => item.demand);
    const controversy = group.observations.filter((item) => item.controversy).length;
    const organicPositive = group.observations.filter((item) => item.demand && !item.controversy);
    const scarcity = group.observations.filter((item) => item.scarcity).length;
    const adControversy = group.observations.some((item) => productAdControversyPattern.test(item.headline));
    const controversyOnly = (adControversy || controversy > 0) && organicPositive.length < 2 && scarcity === 0;
    const mover = bestProductMover(group, movers);
    const social = Math.min(1, positive.reduce((total, item) => total + productDemandScore(item.headline), 0) / 8);
    const confirming = Math.min(1, sources.size / 4);
    const freshness = Math.max(...group.observations.map((item) => productFreshness(item.publishedAt)), 0);
    const retailGain = Number(mover?.gain ?? 0);
    const retail = mover && retailGain > 0 ? Math.min(1, Math.max(0.25, retailGain / 100)) : 0;
    const scarcityScore = Math.min(1, scarcity / 2);
    const score = 35 * social + 30 * retail + 20 * freshness + 10 * confirming + 5 * scarcityScore
      - controversy * 8 - (adControversy ? 15 : 0);
    const best = [...group.observations].sort((left, right) => productDemandScore(right.headline) - productDemandScore(left.headline)
      || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0];
    return {
      ...group,
      mover,
      score,
      sourceCount: sources.size,
      observations: group.observations,
      best,
      qualifies: organicPositive.length > 0 && !controversyOnly
        && ((mover && retailGain > 0) || sources.size >= 2),
    };
  }).filter((candidate) => {
    const repeated = new Set(candidate.observations.map((item) => normalize(item.source))).size >= 2;
    const identifiable = productIdentityPattern.test(candidate.name)
      || (repeated && isBrandLikeProductName(candidate.name) && hasProductNameEvidence(candidate));
    return candidate.qualifies && !isGenericProductCandidate(candidate.name) && identifiable;
  })
    .sort((left, right) => right.score - left.score || right.sourceCount - left.sourceCount)
    .slice(0, 24);
  if (candidates.length < 5) throw new Error(`Only ${candidates.length} products had qualifying recent viral evidence`);
  const enriched = await mapConcurrent(candidates, 3, async (candidate, candidateIndex) => {
    const prioritizedObservations = [...candidate.observations]
      .sort((left, right) => productDemandScore(right.headline) - productDemandScore(left.headline)
        || Number(productIdentityPattern.test(right.headline)) - Number(productIdentityPattern.test(left.headline))
        || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
      .slice(0, 8);
    const evidence = (await mapConcurrent(prioritizedObservations, 2, async (item) => {
      let directUrl = await resolveProductArticle(item.link).catch(() => null);
      const directCandidates = [directUrl, ...(directUrl && usableArticleUrl(directUrl) ? [] : await bingSearchArticles(item.headline, item.sourceUrl ?? "", candidate.name).then((results) => results.map((result) => result.url)).catch(() => []))];
      directUrl = directCandidates.find((candidate) => {
        try {
          return usableArticleUrl(candidate) && !isBlockedSocialUrl(candidate);
        } catch {
          return false;
        }
      }) ?? null;
      if (!directUrl) return null;
      const metadata = await linkedArticleMetadata(directUrl, { allowMissingImage: true }).catch(() => null);
      return {
        ...item,
        directUrl: metadata?.url ?? directUrl,
        intro: metadata?.intro ?? "",
        ...(metadata?.imageSource ? { imageSource: metadata.imageSource, imageAlt: metadata.imageAlt, imageSourcePageUrl: metadata.url } : {}),
      };
    })).filter((item) => item && !isBlockedSocialUrl(item.directUrl))
      .filter((item) => productEvidenceSpecificTo(candidate.name, item));
    const bestEvidence = [...evidence].sort((left, right) => (
      Number(Boolean(usableProductIntro(right.intro))) - Number(Boolean(usableProductIntro(left.intro)))
      || productDemandScore(right.intro || right.headline) - productDemandScore(left.intro || left.headline)
      || Number(right.scarcity) - Number(left.scarcity)
      || Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
    ))[0];
    const contextNames = evidence.flatMap((item) => productNamesFromIntro(item.intro ?? "", item.source ?? ""));
    const headlineNames = candidate.observations.flatMap((item) => productNamesFromHeadline(item.headline ?? "", item.source ?? ""));
    const moverName = productNameCandidate(candidate.mover?.query ?? candidate.mover?.title ?? "");
    const strongerName = [moverName, ...contextNames, ...headlineNames]
      .filter((name) => hasSpecificProductName(name))
      .sort((left, right) => Number(hasSpecificProductName(right) && productFamilyKey(right).split(" ").some((token) => /[a-z]\d|\d[a-z]/i.test(token)))
        - Number(hasSpecificProductName(left) && productFamilyKey(left).split(" ").some((token) => /[a-z]\d|\d[a-z]/i.test(token)))
        || Number(productIdentityPattern.test(right)) - Number(productIdentityPattern.test(left))
        || right.length - left.length)[0];
    const candidateKey = productFamilyKey(candidate.name);
    const canUpgradeName = strongerName && (!hasSpecificProductName(candidate.name)
      || (productTokenSubset(candidate.name, strongerName)
        && !candidateKey.split(" ").some((token) => /[a-z]\d|\d[a-z]/i.test(token))));
    const resolvedName = canUpgradeName ? strongerName : candidate.name;
    const relevantEvidence = evidence.filter((item) => productEvidenceSpecificTo(resolvedName, item));
    const backgroundEvidence = candidateIndex < 8
      ? await productBackgroundContext(resolvedName)
      : [];
    const relevantHosts = new Set(relevantEvidence.map((item) => {
      try { return new URL(item.directUrl).hostname.replace(/^www\./i, ""); } catch { return normalize(item.source); }
    }));
    return {
      ...candidate,
      ...(canUpgradeName ? { name: strongerName } : {}),
      evidence: relevantEvidence,
      sourceCount: relevantHosts.size,
      bestEvidence: relevantEvidence.includes(bestEvidence) ? bestEvidence : relevantEvidence[0],
      backgroundEvidence,
    };
  });
  const dedupedMap = new Map();
  for (const candidate of enriched) {
    const key = productFamilyKey(candidate.name);
    const previous = dedupedMap.get(key);
    if (!previous || candidate.evidence.length > previous.evidence.length
      || (candidate.evidence.length === previous.evidence.length
        && (candidate.sourceCount > previous.sourceCount
          || (candidate.sourceCount === previous.sourceCount && candidate.score > previous.score)))) {
      dedupedMap.set(key, candidate);
    }
  }
  const deduped = [...dedupedMap.values()];
  const distinctProducts = deduped.filter((candidate, index, all) => !all.slice(0, index).some((earlier) => {
    if (productEvidenceOverlap(earlier, candidate) < 1) return false;
    if (productTypePhrase(earlier.name) !== productTypePhrase(candidate.name)) return false;
    const candidateEvidence = candidate.bestEvidence ?? candidate.evidence?.[0];
    const earlierEvidence = earlier.bestEvidence ?? earlier.evidence?.[0];
    return !productEvidenceSpecificTo(candidate.name, candidateEvidence)
      || !productEvidenceSpecificTo(earlier.name, earlierEvidence)
      || productTokenOverlap(candidate.name, earlier.name) >= 0.5;
  }));
  const filtered = distinctProducts
    .filter((candidate) => candidate.evidence.length >= 1 && (candidate.mover || candidate.sourceCount >= 2))
    .filter((candidate) => (hasSpecificProductName(candidate.name) || isBrandLikeProductName(candidate.name))
      && hasProductContext(candidate)
      && hasProductNameEvidence(candidate)
      && candidate.evidence.some((evidence) => productEvidenceContextText(candidate.name, evidence)))
    .sort((left, right) => right.score - left.score || right.sourceCount - left.sourceCount
      || right.name.length - left.name.length);
  const uniqueFiltered = [];
  for (const candidate of filtered) {
    const duplicate = uniqueFiltered.find((earlier) => {
      const sharedEvidence = productEvidenceOverlap(earlier, candidate) > 0;
      const subset = productTokenSubset(earlier.name, candidate.name) || productTokenSubset(candidate.name, earlier.name);
      return sharedEvidence && subset && productTypePhrase(earlier.name) === productTypePhrase(candidate.name);
    });
    if (!duplicate) uniqueFiltered.push(candidate);
    if (uniqueFiltered.length >= 18) break;
  }
  const filteredCandidates = uniqueFiltered;
  return filteredCandidates;
}

async function sourcePageProductMatch(row, excludedHost = "") {
  const candidates = [row.bestEvidence, ...(row.evidence ?? []), row.best].filter(Boolean);
  for (const candidate of candidates) {
    const rawUrl = candidate.directUrl ?? candidate.link;
    const rawUrls = [rawUrl, candidate.sourceUrl];
    let requiresSearch = true;
    try { requiresSearch = new URL(rawUrl).hostname === "news.google.com"; } catch { /* Bing can still recover a malformed feed URL. */ }
    if (requiresSearch) {
      const searchResults = await mapConcurrent([...new Set([candidate.headline, row.query].filter(Boolean))], 2, (query) =>
        bingSearchArticles(query, "", row.query));
      rawUrls.push(...searchResults.flat().map((result) => result.url));
    }
    for (const rawCandidate of rawUrls) {
      if (!rawCandidate) continue;
      let rawUrl = rawCandidate;
      try {
        const parsed = new URL(rawUrl);
        if (parsed.hostname === "news.google.com") rawUrl = await resolveProductArticle(rawUrl);
      } catch { continue; }
      let url;
      try { url = new URL(rawUrl); } catch { continue; }
      if (url.protocol !== "https:" || url.hostname === "news.google.com" || isBlockedSocialUrl(url.href)
        || !usableArticleUrl(url.href) || (excludedHost && sameArticleDomain(url.href, excludedHost))) continue;
      return {
        ...row,
        title: row.query,
        url: url.href,
        searchUrl: url.href,
        commerceSource: "Recent source page",
        image: candidate.imageSource,
        ...(candidate.imageSource ? {
          imageSourceKind: "article",
          imageSourcePageUrl: candidate.imageSourcePageUrl ?? url.href,
        } : {}),
      };
    }
  }
  return null;
}

async function productImageFromEvidence(row, excludedHost = "") {
  const candidates = [
    ...(row.evidence ?? []),
    row.bestEvidence,
    row.best,
  ].filter(Boolean).slice(0, 8);
  for (const candidate of candidates) {
    let rawUrl = candidate.directUrl ?? candidate.link ?? candidate.url;
    if (!rawUrl) continue;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.hostname === "news.google.com") rawUrl = await resolveProductArticle(rawUrl);
    } catch {
      continue;
    }
    let url;
    try { url = new URL(rawUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.hostname === "news.google.com" || isBlockedSocialUrl(url.href)
      || !usableArticleUrl(url.href) || (excludedHost && sameArticleDomain(url.href, excludedHost))) continue;
    if (candidate.imageSource && candidate.imageSourcePageUrl) {
      return {
        image: candidate.imageSource,
        imageSourcePageUrl: candidate.imageSourcePageUrl,
      };
    }
    const metadata = await linkedArticleMetadata(url.href, { allowMissingImage: true }).catch(() => null);
    if (metadata?.imageSource) {
      return {
        image: metadata.imageSource,
        imageSourcePageUrl: metadata.url,
      };
    }
  }
  return null;
}

function isAmazonListingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.amazon.com"
      && /^\/(?:dp|gp\/product)\/[A-Z0-9]{10}\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function amazonProducts(rows) {
  let amazonMatches = [];
  try {
    amazonMatches = await withHeadlessPage({
      allowedHosts: new Set(["www.amazon.com"]),
      work: async (page) => {
        const products = [];
        for (const row of rows.slice(0, 20)) {
          const contextText = [
            row.best?.headline,
            row.bestEvidence?.headline,
            ...(row.observations ?? []).map((item) => item.headline),
          ].filter(Boolean).join(" ");
          const focusTerms = [...new Set(productTokens(contextText).filter((token) => amazonFocusTerms.has(token)))];
          // Search only the curated product identity. Article context can mention
          // accessories (for example, a screen protector) and must not steer the
          // purchase match away from the product itself.
          const amazonQuery = row.query;
          const searchUrl = new URL("https://www.amazon.com/s");
          searchUrl.search = new URLSearchParams({ k: amazonQuery, s: "exact-aware-popularity-rank" });
          await page.navigate(searchUrl, 1_600);
          const cards = await page.evaluate(`Array.from(document.querySelectorAll("[data-asin]")).map((card) => { const asin = card.getAttribute("data-asin"); const links = Array.from(card.querySelectorAll('a[href*="/dp/"]')); const titleLink = links.find((link) => (link.innerText || "").trim().length > 8); return { asin, title: (titleLink?.innerText || "").replace(/\\s+/g, " ").trim(), text: (card.innerText || "").replace(/\\s+/g, " ").trim(), image: card.querySelector("img.s-image")?.src || "" }; }).filter((card) => /^[A-Z0-9]{10}$/.test(card.asin) && card.title)`);
          const tokens = productTokens(row.query);
          const specificTokens = tokens.filter((token) => !genericProductWords.has(token));
          const categoryTokens = amazonCategoryTokens(row.query);
          const beautyContext = /\b(?:beauty|skincare|skin care|makeup|hair)\b/i.test(contextText);
          const match = cards.filter((card) => {
            const cardTitleTokens = new Set(productTokens(card.title));
            const cardTokens = new Set(productTokens(`${card.title} ${card.text}`));
            if (specificTokens.length && !specificTokens.every((token) => cardTitleTokens.has(token))) return false;
            if (categoryTokens.length && !categoryTokens.some((token) => cardTitleTokens.has(token))) return false;
            if (!amazonListingMatchesProduct(row.query, card.title, card.text)) return false;
            const required = specificTokens.length ? specificTokens.length : Math.max(1, tokens.length - (tokens.length >= 3 ? 1 : 0));
            return tokens.filter((token) => cardTokens.has(token)).length >= required;
          }).sort((left, right) => {
            const score = (card) => {
              const cardTokens = new Set(productTokens(`${card.title} ${card.text}`));
              const focusMatches = focusTerms.filter((term) => cardTokens.has(term)).length;
              const unsuitable = beautyContext && /\b(?:toy|kids?|children|role[- ]play)\b/i.test(card.text) ? 20 : 0;
              return focusMatches * 10 - unsuitable;
            };
            return score(right) - score(left);
          })[0];
          if (!match) continue;
          const listingUrl = `https://www.amazon.com/dp/${match.asin}`;
          if (!isAmazonListingUrl(listingUrl)) continue;
          // Search cards can expose a keyword-matched ASIN whose detail page is
          // a different item (for example a sticker pack named after a drink).
          // Verify the canonical detail page before publishing the destination.
          let detail = null;
          try {
            await page.navigate(listingUrl, 1_300);
            detail = await page.evaluate(`(() => {
              const title = (document.querySelector("#productTitle")?.innerText
                || document.querySelector("h1")?.innerText
                || document.title || "").replace(/\\s+/g, " ").trim();
              const text = (document.body?.innerText || "").replace(/\\s+/g, " ").trim();
              const image = document.querySelector("#landingImage")?.src
                || document.querySelector("#imgTagWrapperId img")?.src
                || document.querySelector("img[data-old-hires]")?.getAttribute("data-old-hires")
                || "";
              return { title, text, image };
            })()`);
          } catch {
            continue;
          }
          if (!detail?.title || !amazonDetailMatchesProduct(row.query, detail.title, detail.text)) continue;
          products.push({
            ...row,
            ...match,
            title: detail.title,
            ...(detail.image ? { image: detail.image } : {}),
            commerceSource: "Amazon listing",
            url: listingUrl,
            searchUrl: searchUrl.href,
          });
          if (products.length === 10) break;
        }
        return products;
      },
    });
  } catch (error) {
    console.warn(`Amazon product matching unavailable; using validated source pages where possible: ${error instanceof Error ? error.message : String(error)}`);
  }

  const matches = [...amazonMatches];
  const matchedKeys = new Set(amazonMatches.map((row) => productFamilyKey(row.query)));
  for (const row of rows) {
    if (matches.length >= 10 || matchedKeys.has(productFamilyKey(row.query))) continue;
    const fallback = await sourcePageProductMatch(row);
    if (fallback) {
      matches.push({
        ...fallback,
        commerceSource: "Recent source page",
      });
      matchedKeys.add(productFamilyKey(row.query));
      continue;
    }
    // A search-results page is not evidence that the product is sold there.
    // Keep the candidate out rather than publishing an irrelevant destination.
  }
  if (matches.length < 5) throw new Error(`Only ${matches.length} qualifying products had a matching Amazon or validated source page`);
  const enrichedMatches = await mapConcurrent(matches, 3, async (row) => {
    let excludedHost = "";
    try { excludedHost = new URL(row.url).hostname; } catch { /* validation will reject malformed commerce URLs. */ }
    const sourcePage = await sourcePageProductMatch(row, excludedHost);
    const sourceImage = await productImageFromEvidence(row, excludedHost);
    return sourcePage ? {
      ...row,
      recentSourceUrl: sourcePage.url,
      ...(sourcePage.image ? { recentSourceImage: sourcePage.image, recentSourceImagePageUrl: sourcePage.imageSourcePageUrl } : {}),
      ...(sourceImage ? { recentSourceImage: sourceImage.image, recentSourceImagePageUrl: sourceImage.imageSourcePageUrl } : {}),
    } : sourceImage ? {
      ...row,
      recentSourceImage: sourceImage.image,
      recentSourceImagePageUrl: sourceImage.imageSourcePageUrl,
    } : row;
  });
  const directEvidence = enrichedMatches.filter((row) => (isAmazonListingUrl(row.url)
    || row.commerceSource === "Recent source page")
    && ((row.evidence ?? []).some((entry) => usableProductEvidenceUrl(entry)) || row.recentSourceUrl));
  if (directEvidence.length < 5) throw new Error(`Only ${directEvidence.length} products had a direct publisher evidence link`);
  // Destination availability must not change the candidate ranking. Amazon
  // matches and article fallbacks are merged back into discovery order.
  return directEvidence.sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
}

async function productLeaderboard() {
  const movers = await amazonMoversAndShakers();
  const candidates = await viralProductCandidates(movers);
  console.log(`Product candidates: ${candidates.map((candidate) => `${candidate.name} (${candidate.sourceCount} sources)`).join(" | ")}`);
  const products = await amazonProducts(candidates.map((candidate, index) => ({
    ...candidate,
    query: candidate.name,
    rank: index + 1,
    growth: candidate.mover ? `+${candidate.mover.gain ?? 0} ranks` : "Social discovery",
  })));
  if (products.length < 5) throw new Error("Viral product discovery produced fewer than five commerce matches");
  return products;
}

function amazonProductIdentity(query, listingTitle) {
  let product = plainText(listingTitle ?? "")
    .replace(/^Amazon\.com\s*:\s*/i, "")
    .replace(/\s*:\s*Amazon\.com\s*:?\s*$/i, "")
    .split("|")[0]
    .trim();
  product = product.split(/\s+[–—]\s+/)[0].split(/;\s*/)[0].trim();
  const colon = product.indexOf(":");
  if (colon >= 12) product = product.slice(0, colon).trim();
  product = product.length > 120
    ? product.slice(0, 121).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")
    : product;
  product = product.replace(/\s+\b(?:for|with|and|or|of|to|in|the)$/i, "").trim();
  const title = titleCase(query);
  const type = productTypePhrase(`${title} ${product}`);
  if (!product || normalize(product) === normalize(title)) return ensureSentence(`${title} is ${type}`);
  return ensureSentence(`${title} is ${type}`);
}

function productDisplayTitle(value) {
  return titleCase(value).replace(/\b([A-Za-z]{2,})(\d{1,3}[A-Za-z]*)\b/g, "$1 $2");
}

function productRecentDescription(product, identity) {
  const candidates = [product.bestEvidence, ...(product.evidence ?? []), product.best]
    .filter(Boolean)
    .map((candidate) => {
      const sourceText = productEvidenceContextText(product.query, candidate);
      const distinctive = productIdentityTokens(product.query);
      const text = neutralProductContext(sourceText);
      return {
        source: candidate,
        text,
        identityMatches: distinctive.filter((token) => productTokenSet(sourceText).has(token)).length,
        overlap: productTokenOverlap(product.query, `${candidate.headline ?? ""} ${candidate.intro ?? ""}`),
        demand: productDemandScore(text),
        scarcity: productScarcitySignal(text),
        controversy: productControversySignal(text),
        freshness: productFreshness(candidate.publishedAt),
        reference: productReferencePattern.test(`${candidate.headline ?? ""} ${candidate.intro ?? ""}`),
      };
    })
    .filter((candidate) => candidate.text && candidate.overlap > 0 && !candidate.controversy && !candidate.reference
      && productEvidenceSpecificTo(product.query, candidate.source))
    .sort((left, right) => right.identityMatches - left.identityMatches
      || right.overlap - left.overlap
      || right.demand - left.demand
      || Number(right.scarcity) - Number(left.scarcity)
      || right.freshness - left.freshness
      || right.text.length - left.text.length);
  const recent = candidates.find((candidate) => candidate.demand)?.text ?? candidates[0]?.text;
  const fallbackPhrase = [product.bestEvidence, product.best, ...(product.observations ?? [])]
    .filter((candidate) => productEvidenceSpecificTo(product.query, candidate)
      && !productReferencePattern.test(`${candidate.headline ?? ""} ${candidate.intro ?? ""}`))
    .map((candidate) => productViralPhrase(candidate.headline))
    .find(Boolean);
  const background = (product.backgroundEvidence ?? [])
    .filter((context) => context.text && productHistoryPattern.test(context.text))
    .sort((left, right) => right.text.length - left.text.length)[0]?.text;
  const distinctBackground = background && recent && productTokenOverlap(recent, background) < 0.78 ? background : "";
  if (!recent && !fallbackPhrase && !background) return identity;
  if (!recent && background) return conciseSentences(`${identity} ${background}`, 560);
  if (!recent) return conciseSentences(`${identity} Recent coverage places it among ${lowerFirst(fallbackPhrase)}.`, 560);
  return conciseSentences(`${identity} ${recent}${distinctBackground ? ` ${distinctBackground}` : ""}`, 560);
}

function neutralProductContext(value) {
  const text = factualHeadline(stripSourceAttribution(value), { maxLength: 320 })
    .replace(/\s+(?:however|although|but)\b[\s\S]*$/i, "")
    .replace(/\s+(?:according to|the company said|officials said|experts said)\b[\s\S]*$/i, "")
    .trim();
  return conciseSentences(text, 280);
}

function usableProductEvidenceUrl(entry) {
  const rawUrl = entry?.directUrl ?? entry?.link ?? entry?.url;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && url.hostname !== "news.google.com" && !isBlockedSocialUrl(url.href)
      && usableArticleUrl(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

async function updateProducts(brief, products) {
  const section = brief.sections.find((entry) => entry.id === "products");
  if (!section) return;
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = products.map((product, index) => {
    const title = productDisplayTitle(product.query);
    const current = currentByTitle.get(normalize(title));
    const identity = amazonProductIdentity(product.query, `${product.title ?? ""} ${product.bestEvidence?.headline ?? ""} ${product.bestEvidence?.intro ?? ""}`);
    const description = productRecentDescription(product, identity);
    const socialEvidence = (product.evidence ?? []).map((item) => {
      const url = usableProductEvidenceUrl(item);
      return url ? { source: item.source ?? "Recent product coverage", url } : null;
    }).filter(Boolean)
      .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.url === entry.url) === index)
      .slice(0, 3);
    const moverEvidence = product.mover
      ? [{ source: `Amazon Movers & Shakers · ${product.mover.category}`, url: product.mover.sourceUrl }]
      : [];
    const commerceEvidence = /^Amazon\b/i.test(product.commerceSource ?? "")
      ? [{ source: product.commerceSource, url: product.url }]
      : [];
    const item = {
      rank: index + 1,
      title,
      subtitle: "Product",
      description: description.slice(0, 600),
      image: current?.image ?? `/culture/product-${slugify(title)}.webp`,
      ...(product.image ? {
        imageSource: product.image,
        imageSourceKind: product.imageSourceKind ?? "commerce",
        imageSourcePageUrl: product.imageSourcePageUrl ?? product.url,
      } : product.recentSourceImage ? {
        imageSource: product.recentSourceImage,
        imageSourceKind: "article",
        imageSourcePageUrl: product.recentSourceImagePageUrl ?? product.recentSourceUrl,
      } : {}),
      ...(product.imageSourceKind ? { imageSourceKind: product.imageSourceKind } : {}),
      ...(product.imageSourcePageUrl ? { imageSourcePageUrl: product.imageSourcePageUrl } : {}),
      alt: current?.alt ?? `${title} product listing image`,
      url: product.url,
      source: product.commerceSource ?? "Amazon",
      metric: product.sourceCount >= 2
        ? { label: "Independent viral sources", value: `${product.sourceCount} sources` }
        : { label: "Recent viral source + Amazon velocity", value: "1 source + Amazon velocity" },
      evidence: [
        ...commerceEvidence,
        ...moverEvidence,
        ...socialEvidence,
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
    const productContext = [
      { kind: "identity", source: "Amazon listing", text: product.title },
      ...(product.bestEvidence && productEvidenceSpecificTo(product.query, product.bestEvidence)
        ? [{ kind: "current_demand", source: product.bestEvidence.source ?? "Best recent product coverage", text: productEvidenceContextText(product.query, product.bestEvidence) }]
        : []),
      ...(product.evidence ?? []).filter((evidence) => productEvidenceSpecificTo(product.query, evidence)).map((evidence) => ({
        kind: "current_demand",
        source: evidence.source ?? "Recent product coverage",
        text: productEvidenceContextText(product.query, evidence),
      })).filter((evidence) => evidence.text),
      ...(product.backgroundEvidence ?? []).map((evidence) => ({
        kind: "background_context",
        source: evidence.source ?? "Background product context",
        text: evidence.text,
        publishedAt: evidence.publishedAt ?? undefined,
      })).filter((evidence) => evidence.text),
    ];
    rememberAiDescriptionContext(item, "products", productContext);
    return item;
  });
  section.eyebrow = "Social trend evidence · past 90 days";
  section.title = "Products";
  section.description = "Products with recent, explicit demand evidence and a validated purchase or source page. Amazon listings are preferred; candidates combine social evidence, retail velocity when available, freshness, independent confirmations, and scarcity signals; retail movement alone never qualifies a product.";
  const verifiedCommerce = products.find((product) => product.commerceSource === "Amazon listing" && isAmazonListingUrl(product.url));
  const verifiedDestination = verifiedCommerce ?? products.find((product) => product.commerceSource === "Recent source page" && product.url) ?? products[0];
  section.sources = [
    { label: "Amazon Movers & Shakers", url: amazonMoverCategories[0].url },
    { label: "Google News · viral product coverage, 90 days", url: productDiscoveryUrl },
    { label: verifiedCommerce ? "Amazon · verified product listing" : "Validated product source page", url: verifiedDestination.url },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = allItems.length > 5 ? `Show ranks 6–${allItems.length}` : undefined;
}

function repairProductSnapshot(brief) {
  const section = brief.sections.find((entry) => entry.id === "products");
  if (!section) return;
  const allItems = [...(section.items ?? []), ...(section.moreItems ?? [])];
  const kept = [];
  const rejected = [];
  for (const item of allItems) {
    if (!isAmazonListingUrl(item.url)) {
      const articleFallback = (item.evidence ?? []).find((entry) => {
        const url = usableProductEvidenceUrl(entry);
        return url && !/^https:\/\/www\.amazon\.com\//i.test(url);
      });
      if (!articleFallback) {
        rejected.push(`${item.title}: no direct article fallback for ${item.url}`);
        continue;
      }
      item.url = usableProductEvidenceUrl(articleFallback);
      item.source = "Recent source page";
    }
    if (isGenericProductCandidate(item.title)) {
      rejected.push(`${item.title}: generic candidate`);
      continue;
    }
    const descriptionContext = sentences(item.description).join(" ");
    // Identity wording can legitimately use a normalized variant or alias; the
    // selected evidence and the final description validator provide the stronger
    // source/context checks. Do not discard a valid candidate solely because its
    // concise description omits one title token.
    if (!descriptionContext) {
      rejected.push(`${item.title}: empty description`);
      continue;
    }
    const evidenceUrls = new Set((item.evidence ?? []).map((entry) => entry.url).filter(Boolean));
    const duplicate = kept.find((previous) => {
      const previousUrls = new Set((previous.evidence ?? []).map((entry) => entry.url).filter(Boolean));
      const sharedEvidence = [...evidenceUrls].some((url) => previousUrls.has(url));
      return sharedEvidence && productTypePhrase(item.title) === productTypePhrase(previous.title)
        && productTokenOverlap(item.title, previous.title) >= 0.5;
    });
    if (!duplicate) kept.push(item);
    else rejected.push(`${item.title}: duplicate of ${duplicate.title}`);
  }
  if (kept.length < 5) {
    throw new Error(`Product snapshot retained only ${kept.length} entries after generic/noisy candidates were removed${rejected.length ? ` (${rejected.join(" | ")})` : ""}`);
  }
  kept.forEach((item, index) => { item.rank = index + 1; });
  section.items = kept.slice(0, 5);
  section.moreItems = kept.slice(5, 20);
  section.moreLabel = section.moreItems.length ? `Show ranks 6–${kept.length}` : undefined;
}

function searchVolume(value) {
  const match = String(value).match(/([\d.]+)\s*([KMB])?\+/i);
  if (!match) return 0;
  return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] ?? 1);
}

function balancedJsonArray(source, fromIndex) {
  const start = source.indexOf("[", fromIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function googleSearchVolumeLabel(value) {
  return Number.isFinite(value) && value > 0 ? `${formatCompact(value)}+` : "";
}

function embeddedGoogleTrendingRows(html) {
  const callback = /AF_initDataCallback\(\{\s*key:\s*['"]ds:0['"][\s\S]*?\bdata\s*:\s*/i.exec(html);
  if (!callback) return [];
  const rawData = balancedJsonArray(html, callback.index + callback[0].length);
  if (!rawData) return [];
  let data;
  try {
    data = JSON.parse(rawData);
  } catch {
    return [];
  }
  const entries = Array.isArray(data?.[1]) ? data[1] : [];
  return entries.map((entry, sourceOrder) => {
    const title = plainText(entry?.[0] ?? "");
    const searches = Number(entry?.[6]);
    const relatedTerms = [...new Map((Array.isArray(entry?.[9]) ? entry[9] : [])
      .map((term) => plainText(term))
      .filter((term) => term && normalize(term) !== normalize(title))
      .map((term) => [normalize(term), term])).values()].slice(0, 5);
    return {
      title,
      volume: googleSearchVolumeLabel(searches),
      relatedTerms,
      searches,
      sourceOrder,
    };
  }).filter((row) => row.title && row.volume && row.searches > 0);
}

function tableGoogleTrendingRows(html) {
  const rows = [];
  for (const match of html.matchAll(/<tr\b[^>]*class="[^"]*enOdEe-wZVHld-xMbwt[^"]*"[^>]*>[\s\S]*?<\/tr>/g)) {
    const rowHtml = match[0];
    const title = plainText(rowHtml.match(/class="mZ3RIc">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const volume = plainText(rowHtml.match(/class="lqv0Cb">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const relatedTerms = [...new Map([...rowHtml.matchAll(/\bdata-term=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)]
      .map((term) => plainText(term[1] ?? term[2] ?? term[3] ?? ""))
      .filter((term) => term && normalize(term) !== normalize(title))
      .map((term) => [normalize(term), term])).values()].slice(0, 5);
    if (title && searchVolume(volume)) {
      rows.push({ title, volume, relatedTerms, searches: searchVolume(volume), sourceOrder: rows.length });
    }
  }
  return rows;
}

async function googleTrendingNews() {
  const html = await fetchText(newsTrendsUrl, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" } });
  const rows = [...new Map([
    ...embeddedGoogleTrendingRows(html),
    ...tableGoogleTrendingRows(html),
  ].map((row) => [normalize(row.title), row])).values()];
  if (rows.length < 20) throw new Error(`Google Trending Now returned only ${rows.length} topics`);
  // Google embeds the complete ranked feed, while the visible table is only a
  // short window. Resolve enough of the highest-volume rows to remove people
  // and sports without issuing thousands of metadata requests.
  const discoveryRows = rows
    .slice()
    .sort((left, right) => right.searches - left.searches || left.sourceOrder - right.sourceOrder)
    .slice(0, 300);
  const entities = await wikidataEntitiesForTitles(discoveryRows.flatMap((row) => queryVariants(titleCase(row.title))));
  const sports = /\b(?:vs\.?|score|game|match|cup|league|nfl|nba|mlb|nhl|wnba|open 20\d{2}|warriors|fever|dream)\b/i;
  const personClue = /\b(?:actor|actress|author|director|founder|founding member|musician|player|rapper|singer|social-media star|streamer|youtuber)\b/i;
  const candidates = discoveryRows.filter((row) => !sports.test(row.title) && !personClue.test(row.title)
    && !queryEntityMatch(titleCase(row.title), entities, (entity) => claimIds(entity, "P31").includes("Q5")));
  const personCheckCandidates = candidates
    .slice()
    .sort((left, right) => right.searches - left.searches || left.sourceOrder - right.sourceOrder)
    .slice(0, 120);
  const searchPersonFlags = await mapConcurrent(personCheckCandidates, 4, (row) => wikidataSearchIsPerson(row.title));
  const filtered = personCheckCandidates.filter((_, index) => !searchPersonFlags[index])
    .sort((left, right) => right.searches - left.searches || left.sourceOrder - right.sourceOrder)
    .slice(0, 10);
  if (filtered.length < 6) throw new Error(`Only ${filtered.length} non-person, non-sports news topics remained`);
  const topics = await mapConcurrent(filtered, 4, async (row) => {
    const rowTopicTokens = topicTokens(row.title);
    const anchorTokens = [...rowTopicTokens].filter((token) => token.length >= 4 && !/^\d+$/.test(token)).slice(0, 3);
    const primaryContext = await googleNewsContext(row.title, 14, { requireEvent: true }).catch(() => null)
      ?? await googleNewsContext(row.title, 14, { requireEvent: false }).catch(() => null);
    const compactTokens = [...rowTopicTokens];
    const broaderQuery = compactTokens.length > 2
      ? `${compactTokens[1]} ${compactTokens.at(-1)}`
      : compactTokens.join(" ");
    const broaderContext = broaderQuery && normalize(broaderQuery) !== normalize(row.title)
      ? await googleNewsContext(broaderQuery, 14, { requireEvent: false }).catch(() => null)
      : null;
    const isRelevant = (candidate) => {
      const candidateTokens = topicTokens(candidate.headline);
      const overlap = overlapCount(rowTopicTokens, candidateTokens);
      const anchorOverlap = overlapCount(new Set(anchorTokens), candidateTokens);
      return overlap >= 2 || (overlap >= 1 && anchorOverlap >= 1);
    };
    const alternateCandidates = [
      ...(primaryContext?.alternates ?? []),
      ...(broaderContext ? [broaderContext, ...(broaderContext.alternates ?? [])] : []),
    ].filter(isRelevant);
    const context = primaryContext
      ? {
        ...primaryContext,
        alternates: [...new Map(alternateCandidates.map((candidate) => [candidate.link, candidate])).values()]
          .filter((candidate) => candidate.link !== primaryContext.link)
          .slice(0, 8),
      }
      : broaderContext && isRelevant(broaderContext) ? broaderContext : null;
    const topicQueries = [
      context?.headline,
      ...(context?.alternates ?? []).map((candidate) => candidate.headline),
      row.title,
      ...row.relatedTerms,
      broaderQuery,
    ].filter(Boolean);
    const [topicSummary, article] = await Promise.all([
      wikipediaTopicContext(topicQueries).catch(() => null),
      linkedNewsArticle(context, row.title),
    ]);
    const commonsFallback = article?.imageSource || topicSummary?.imageSource
      ? null
      : await commonsRepresentativeImage(topicQueries).catch(() => {
        return null;
      });
    const representative = article?.imageSource ? {
      imageSource: article.imageSource,
      title: article.imageAlt,
      kind: "article",
      sourcePageUrl: article.url,
    } : topicSummary?.imageSource ? {
      imageSource: topicSummary.imageSource,
      pageUrl: topicSummary.pageUrl,
      title: topicSummary.title,
    } : commonsFallback;
    const relatedHeadline = context?.alternates
      ?.slice()
      .sort((left, right) => left.sourceOrder - right.sourceOrder)
      .map((candidate) => factualHeadline(candidate.headline))
      .find(Boolean);
    const fallbackUrl = new URL("https://news.google.com/search");
    fallbackUrl.search = new URLSearchParams({ q: row.title, hl: "en-US", gl: "US", ceid: "US:en" });
    return {
      ...row,
      headline: context?.headline ?? row.title,
      relatedHeadline,
      link: article?.url ?? context?.link ?? fallbackUrl.href,
      publishedAt: article?.context?.publishedAt ?? context?.publishedAt ?? null,
      newsSource: article?.context?.source ?? context?.source ?? "Google News",
      imageSource: representative?.imageSource,
      imageSourceKind: representative?.kind,
      imageSourcePageUrl: representative?.sourcePageUrl,
      imagePageUrl: representative?.pageUrl,
      imageTitle: representative?.title,
      articleIntro: article?.intro,
      topicSummary: topicSummary?.extract,
      topicPageUrl: topicSummary?.pageUrl,
    };
  });
  const linkedTopics = topics.filter((topic) => retainableNewsUrl(topic.link));
  if (linkedTopics.length < 4) throw new Error(`Only ${linkedTopics.length} news topics resolved to direct publisher articles`);
  if (linkedTopics.length < topics.length) console.warn(`News retained ${topics.length - linkedTopics.length} prior entries because their current article links could not be resolved.`);
  return linkedTopics;
}

function articleMatchesEntity(candidate, metadata, entityName = "") {
  const targetTokens = topicTokens(entityName || candidate.headline);
  const articleTokens = topicTokens(`${candidate.headline ?? ""} ${metadata?.intro ?? ""}`);
  const required = Math.min(2, Math.max(1, targetTokens.size));
  return overlapCount(targetTokens, articleTokens) >= required
    || (entityName && normalize(`${candidate.headline ?? ""} ${metadata?.intro ?? ""}`).includes(normalize(entityName)));
}

async function linkedNewsArticle(context, entityName = "") {
  if (!context) return null;
  const unusableIntroPattern = /\b(?:we delve into|what it means for you|let['’]s explore|fascinating topic|in today['’]s fast-paced|discover how a .* lawsuit)\b/i;
  const usableImage = (value) => Boolean(value) && !/(?:gravatar|avatar|favicon|sprite|placeholder|default[-_ ]?image|\blogo\b)/i.test(value);
  const candidates = [];
  // Inspect the primary result plus a small set of relevance-checked alternates.
  // The first headline is often the ranking or announcement, while an alternate
  // carries the cultural mechanism that explains why attention spread.
  for (const candidate of [context, ...(context.alternates ?? []).slice(0, 6)]) {
    const resolvedUrl = await resolveGoogleNewsArticle(candidate.link).catch(() => null);
    const inspect = async (searchResults) => {
      for (const result of [...new Map(searchResults.map((entry) => [entry.url, entry])).values()].slice(0, 4)) {
        const articleUrl = result.url;
        const metadata = await linkedArticleMetadata(articleUrl, { allowMissingImage: true }).catch(() => null);
        if (!metadata || !articleMatchesEntity(candidate, metadata, entityName)) continue;
        const intro = metadata.intro && !unusableIntroPattern.test(metadata.intro) ? metadata.intro : "";
        const article = { context: candidate, ...metadata, intro, imageSource: usableImage(metadata.imageSource) ? metadata.imageSource : undefined };
        const articleTokens = topicTokens(`${candidate.headline ?? ""} ${intro}`);
        const entityTokens = topicTokens(entityName || candidate.headline);
        const overlap = overlapCount(entityTokens, articleTokens);
        const event = Number(eventHeadlinePattern.test(candidate.headline ?? "") || eventHeadlinePattern.test(intro));
        const sourceMatch = Number(sameArticleDomain(article.url, candidate.sourceUrl));
        candidates.push({ article, score: overlap * 24 + event * 10 + sourceMatch * 8 + Number(Boolean(intro)) * 6 + Number(Boolean(article.imageSource)) * 2 });
      }
    };
    if (resolvedUrl) await inspect([{ url: resolvedUrl }]);
    if (!candidates.length) {
      const fallbackResults = await bingSearchArticles(candidate.headline, candidate.sourceUrl, entityName);
      await inspect(fallbackResults);
    }
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.article ?? null;
}

const newsBoilerplatePattern = /\b(?:check out what['’]s clicking|subscribe|sign up for (?:our|the)|get the week['’]s news|newsletter|investigative stories and local news updates|award[- ]winning in-depth reports|featured on-going series|read more|follow us)\b/i;
const newsCaptionPattern = /^(?:a|an|the) (?:sign|photo|image|file photo|screenshot|caption)\b|\b(?:stands amid|pictured|poses for|file photo|illustration by)\b|\b(?:U\.?S\.?|UK),?\s+[A-Z][a-z]+\s+\d{1,2}\b/i;

function newsDescription(topic, title) {
  const event = factualHeadline(topic.headline, { maxLength: 190 });
  const articleSentences = sentences(topic.articleIntro)
    .filter((sentence) => !newsBoilerplatePattern.test(sentence) && !newsCaptionPattern.test(sentence))
    .map((sentence) => stripSourceAttribution(sentence)
      .replace(/^\s*\([^)]{1,30}\)\s*[—-]\s*/u, "").trim())
    .filter(Boolean);
  const articleIntroText = articleSentences.join(" ");
  const articleIntro = articleMatchesEntity({ headline: topic.headline }, { intro: articleIntroText }, topic.title)
    ? conciseSentences(articleIntroText, 320)
    : "";
  const definition = conciseSentences(topic.topicSummary, 220);
  const repeatsHeadline = (text) => {
    const eventTokens = normalize(event).split(" ").filter((token) => token.length >= 4);
    const textTokens = new Set(normalize(text).split(" "));
    return eventTokens.length >= 3 && eventTokens.filter((token) => textTokens.has(token)).length / eventTokens.length >= 0.35;
  };
  if (articleIntro && event && !repeatsHeadline(articleIntro)) {
    return conciseSentences(`${articleIntro} ${event}`, 360);
  }
  if (articleIntro) return articleIntro;
  if (definition && event && !repeatsHeadline(definition)) {
    return conciseSentences(`${definition} ${event}`, 360);
  }
  const related = factualHeadline(topic.relatedHeadline);
  if (related && event && !repeatsHeadline(related)) {
    return conciseSentences(`${related} ${event}`, 360);
  }
  return event || definition || related || conciseSentences(topic.headline, 260) || ensureSentence(title);
}

function newsCardTitle(topic) {
  const headline = factualHeadline(topic.headline, { maxLength: 150 });
  const fallback = plainText(topic.title ?? "");
  const title = headline || fallback;
  return title.length > 155 ? `${title.slice(0, 152).replace(/\s+\S*$/, "")}…` : title;
}

function updateNews(brief, topics) {
  const section = brief.sections.find((entry) => entry.id === "news");
  if (!section) return;
  const currentTopics = [...section.items, ...(section.moreItems ?? [])]
    .filter((item) => retainableNewsUrl(item.url))
    .map((item) => ({
      title: item.title,
      headline: item.title,
      volume: item.metric?.value ?? "0+",
      searches: searchVolume(item.metric?.value),
      link: item.url,
      newsSource: item.source,
      publishedAt: null,
      imageSource: item.imageSource,
      imageSourceKind: item.imageSourceKind,
      imageSourcePageUrl: item.imageSourcePageUrl,
      imageTitle: item.alt,
      articleIntro: item.description,
    }));
  const topicKeys = new Set(topics.map((topic) => normalize(newsCardTitle(topic))));
  const seenTitles = new Set();
  const completeTopics = [...topics, ...currentTopics.filter((topic) => !topicKeys.has(normalize(newsCardTitle(topic))))]
    .sort((left, right) => (right.searches ?? searchVolume(right.volume)) - (left.searches ?? searchVolume(left.volume)))
    .filter((topic) => {
      const key = normalize(newsCardTitle(topic));
      if (!key || seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, 10);
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = completeTopics.map((topic, index) => {
    const title = newsCardTitle(topic);
    const current = currentByTitle.get(normalize(title));
    const trendUrl = googleTrendsExploreUrl([topic.title], "now 7-d");
    const published = publicationDateLabel(topic.publishedAt);
    const item = {
      rank: index + 1,
      title,
      subtitle: published ? `News · ${published}` : "News",
      description: sanitizeSocialText(newsDescription(topic, title)),
      image: current?.image ?? `/culture/news-${slugify(title)}.webp`,
      imageSource: topic.imageSource,
      imageSourceKind: topic.imageSourceKind,
      imageSourcePageUrl: topic.imageSourcePageUrl,
      alt: topic.imageTitle || (topic.imageSourceKind === "article"
        ? `Lead image from ${topic.newsSource}'s coverage of ${title}`
        : `Representative image for ${title}`),
      url: topic.link,
      source: topic.newsSource,
      metric: { label: "Google search volume", value: topic.volume },
      evidence: [
        { source: "Google Trending Now", url: trendUrl },
        { source: `${topic.newsSource} via Google News`, url: topic.link },
        ...(topic.topicPageUrl ? [{ source: "Wikipedia topic context", url: topic.topicPageUrl }] : []),
        ...(topic.imagePageUrl ? [{ source: "Wikimedia image context", url: topic.imagePageUrl }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
    rememberAiDescriptionContext(item, "news", [
      { kind: "current_event", source: topic.newsSource ?? "Publisher article", text: topic.articleIntro, publishedAt: topic.publishedAt },
      { kind: "current_headline", source: "Publisher headline", text: topic.headline, publishedAt: topic.publishedAt },
      { kind: "background", source: "Wikipedia topic context", text: topic.topicSummary },
      { kind: "current_coverage", source: "Related current coverage", text: topic.relatedHeadline },
    ]);
    return item;
  });
  section.eyebrow = "U.S. Google Trends · past 7 days";
  section.title = "News";
  section.description = "The largest seven-day U.S. search-volume topics after removing people and sports, ranked by Google’s displayed search volume and linked to current coverage.";
  section.sources = [
    { label: "Google Trending Now · 7 days, search volume", url: newsTrendsUrl },
    { label: "Google News · article context", url: googleNewsHomeUrl },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = `Show ranks 6–${allItems.length}`;
}

function currentProductSignal(item) {
  const genericPrefix = `${normalize(item.title)} is `;
  return conciseSentences(sentences(item.description)
    .filter((sentence) => !normalize(sentence).startsWith(genericPrefix))
    .join(" "), 180);
}

async function refreshCurrentContext(brief, now) {
  const peopleSection = brief.sections.find((section) => section.id === "people");
  const people = peopleSection ? [...peopleSection.items, ...(peopleSection.moreItems ?? [])] : [];
  const peopleResults = await mapConcurrent(people, 3, async (item) => {
    const context = await googleNewsContext(`"${item.title}"`, 45, {
      requireEvent: true,
      queryVariants: [
        `"${item.title}" meme viral funny`,
        `"${item.title}" reaction fans appearance`,
        `"${item.title}" clip joke walk`,
      ],
    }).catch(() => null);
    if (!context) return false;
    const identity = personIdentity(item.title, item.description, item.subtitle);
    const description = personRecentDescription(item.title, identity, null, context);
    if (!description) return false;
    const sourceSnippets = [
      { kind: "current_headline", source: context.source ?? "Current coverage", text: factualHeadline(context.headline, { requireEvent: true, allowCultural: true }), publishedAt: context.publishedAt },
      {
        kind: "current_coverage",
        source: "Related current coverage",
        text: (context.alternates ?? [])
          .map((candidate) => factualHeadline(candidate.headline, { requireEvent: true, allowCultural: true }))
          .filter(Boolean)
          .slice(0, 6)
          .join(" "),
        publishedAt: context.publishedAt,
      },
    ];
    if (!isDescriptionUsable("people", description, { title: item.title, sourceSnippets }, { allowHeadlineReuse: true })) return false;
    item.description = description;
    rememberAiDescriptionContext(item, "people", [
      ...sourceSnippets,
      { kind: "background", source: "Existing biography context", text: identity },
    ]);
    return true;
  });

  const productsSection = brief.sections.find((section) => section.id === "products");
  const products = productsSection ? [...productsSection.items, ...(productsSection.moreItems ?? [])] : [];
  const productResults = await mapConcurrent(products, 3, async (item) => {
    const [context, linkedContext] = await Promise.all([
      googleNewsContext(`"${item.title}"`, 3_650, {
        queryVariants: [
          `"${item.title}" first introduced original history`,
          `"${item.title}" returned brought back re-release`,
        ],
      }).catch(() => null),
      item.url ? linkedArticleMetadata(item.url, { allowMissingImage: true }).catch(() => null) : Promise.resolve(null),
    ]);
    const searchedHistory = [...(context ? [context.headline, ...(context.alternates ?? []).map((candidate) => candidate.headline)] : [])];
    const linkedHistory = linkedContext?.intro ? conciseSentences(linkedContext.intro, 260) : "";
    const history = linkedHistory
      ? [linkedHistory]
      : searchedHistory
        .map((headline) => factualHeadline(headline, { maxLength: 260 }))
        .filter((headline) => headline && productHistoryPattern.test(headline) && productTokenOverlap(item.title, headline) > 0);
    const historicalContext = conciseSentences([...new Set(history)].join(" "), 360);
    const current = currentProductSignal(item);
    if (!historicalContext || !current) return false;
    item.description = conciseSentences(`${current} ${historicalContext}`, 560);
    rememberAiDescriptionContext(item, "products", [
      { kind: "current_demand", source: "Existing current demand context", text: current },
      { kind: "background_context", source: "Current historical context", text: historicalContext },
    ]);
    return true;
  });

  const refreshedPeople = peopleResults.filter(Boolean).length;
  const refreshedProducts = productResults.filter(Boolean).length;
  brief.generatedAt = now.toISOString();
  brief.status = "Checked today";
  sanitizeBriefSocialMentions(brief);
  validateBrief(brief);
  const output = `${JSON.stringify(brief, null, 2)}\n`;
  if (dryRun) {
    console.log(`Context refresh dry run: ${refreshedPeople} people, ${refreshedProducts} products`);
    return;
  }
  const temporaryPath = `${dataPath}.${process.pid}.next`;
  try {
    await writeFile(temporaryPath, output, { mode: 0o644, flag: "wx" });
    await rename(temporaryPath, dataPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  console.log(`Context refresh wrote ${refreshedPeople} people and ${refreshedProducts} products.`);
}

const aiDescriptionSectionIds = ["people", "movies", "books", "products", "news"];
const unusableAiDescriptionPattern = /\b(?:as an ai|i cannot|i can’t|insufficient information|source snippets|ranking metric|page views|search volume|billboard hot 100|know your meme|goodreads monthly readers|according to|reported by|reports? say|as reported|authorities told|officials told|in an article (?:by|from)|via [A-Z]|takes? a closer look|everything (?:we|you) know|what you need to know|not what you think|click here|publisher|source says|credit)\b|(?:\b(?:daily|weekly|news|times|post|journal|wire|gazette|herald)\s+(?:[A-Z][A-Za-z-]+\b|says?\b))|(?:…|\.\.\.)\s*$/i;

function usableAiDescription(sectionId, description) {
  const text = plainText(description);
  if (!text || unusableAiDescriptionPattern.test(text)) return false;
  if (sectionId === "people") {
    return true;
  }
  if (sectionId === "movies" || sectionId === "books") {
    return /\b(?:about|after|before|cent(?:er|re)s?|discovers?|encounters?|follows?|forced|journey|must|reunite|returns?|set|stranded|takes?|tries?|undergoes?|when|where|while|wakes?|story|film|movie|novel|book|character|family|mystery|conflict)\b/i.test(text);
  }
  if (sectionId === "news") return eventHeadlinePattern.test(text);
  return true;
}

function usableProductAiDescription(description, item, siblings) {
  const text = plainText(description);
  if (!text || /\bis a consumer product\b|\brefers here\b/i.test(text)) return false;
  const titleTokens = productTokens(item.title)
    .filter((token) => token.length > 2 && !genericProductWords.has(token) && !amazonCategoryTerms.has(token));
  if (titleTokens.length && titleTokens.filter((token) => productTokenSet(text).has(token)).length < Math.min(1, titleTokens.length)) return false;
  if (!/\b(?:buying|collect(?:ing|or)?|craze|demand|frenzy|launch|popular|pre[- ]?order|recommend|release|restock|return|selling|sold out|trend(?:ing)?|unbox(?:ing)?|viral)\b/i.test(text)) return false;
  return !siblings.some((sibling) => {
    if (sibling === item) return false;
    const siblingTokens = productTokens(sibling.title)
      .filter((token) => token.length > 3 && !genericProductWords.has(token) && !amazonCategoryTerms.has(token));
    const mentionsSibling = siblingTokens.some((token) => productTokenSet(text).has(token));
    const sharedIdentityToken = siblingTokens.some((token) => titleTokens.includes(token));
    return mentionsSibling && !sharedIdentityToken;
  });
}

async function updateAiDescriptions(brief) {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    console.log("AI descriptions skipped: OPENAI_API_KEY is not configured; deterministic descriptions remain active.");
    return { enabled: false, applied: 0, sections: 0 };
  }
  const jobs = aiDescriptionSectionIds.map((sectionId) => {
    const section = brief.sections.find((entry) => entry.id === sectionId);
    const items = section ? [...section.items, ...(section.moreItems ?? [])] : [];
    const records = items.map((item) => {
      const context = aiDescriptionContexts.get(item);
      const sourceSnippets = context?.sectionId === sectionId && context.snippets.length
        ? context.snippets
        : [{ kind: "card_context", source: "Validated card context", text: item.description }];
      return {
        id: `${sectionId}-${item.rank}`,
        title: item.title,
        role: item.subtitle,
        purpose: sectionId === "people" ? "current_relevance" : "section_description",
        sourceSnippets,
      };
    });
    return { sectionId, items, records };
  }).filter((job) => job.items.length && job.records.length);
  const results = await mapConcurrent(jobs, 2, async (job) => {
    try {
      const generated = await generateDescriptionBatch(job.sectionId, job.records);
      let applied = 0;
      for (const record of job.records) {
        const description = generated.get(record.id);
        if (!isDescriptionUsable(job.sectionId, description, record)
          || !usableAiDescription(job.sectionId, description)) continue;
        const item = job.items.find((candidate) => `${job.sectionId}-${candidate.rank}` === record.id);
        if (!item) continue;
        if (job.sectionId === "products" && !usableProductAiDescription(description, item, job.items)) continue;
        item.description = description;
        applied += 1;
      }
      if (applied < job.items.length) {
        console.warn(`AI descriptions returned ${applied}/${job.items.length} usable ${job.sectionId} entries; deterministic fallbacks retained for the rest.`);
      }
      return { sectionId: job.sectionId, applied, ok: true };
    } catch (error) {
      console.warn(`AI descriptions unavailable for ${job.sectionId}; deterministic fallbacks retained: ${error instanceof Error ? error.message : String(error)}`);
      return { sectionId: job.sectionId, applied: 0, ok: false };
    }
  });
  const applied = results.reduce((total, result) => total + result.applied, 0);
  console.log(`AI descriptions applied to ${applied} entries across ${results.filter((result) => result.applied > 0).length} boards.`);
  return { enabled: true, applied, sections: results.filter((result) => result.applied > 0).length };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactQuizTitle(value, title) {
  // Redact the complete answer label only. Removing individual title words
  // used to turn ordinary prose into fragments such as “non-it” and “the it”.
  const phrases = [title.trim()];
  const marker = "__QUIZ_TITLE__";
  const redacted = [...new Set(phrases.filter(Boolean))].sort((left, right) => right.length - left.length)
    .reduce((result, phrase) => {
      const words = phrase.split(/\s+/).filter(Boolean);
      const pattern = words.length > 1
        ? words.map((word) => escapeRegExp(word)).join("[^A-Za-z0-9]+")
        : `\\b${escapeRegExp(phrase)}\\b`;
      const flags = words.length > 1 ? "gi" : "g";
      return result.replace(new RegExp(pattern, flags), marker);
    }, value)
    .replace(new RegExp(`${marker}(?:\\s+(?:or|and|/)\\s*${marker})+`, "g"), marker)
    .replaceAll(marker, "it")
    .replace(/^\s*["'“”‘’]+\s*/g, "")
    .replace(/\bnamed\s+it\s+(?=arrives?\b)/gi, "")
    .replace(/\bvirtual singer\s+it\b/gi, "virtual singer")
    .replace(/\b((?:Dutch\s+)?YouTuber|streamer|singer|artist|creator)\s+it\b/gi, (_match, role) => {
      const replacementRole = /youtuber/i.test(role) ? "creator" : role.toLowerCase();
      return `another ${replacementRole}`;
    })
    .replace(/\b(viral|trending)\s+it\s+products?\b/gi, "$1 products")
    .replace(/\bfrom\s+(?:it['’]s|['’]s)\b/gi, "from her")
    .replace(/[“”‘’]it[“”‘’]/gi, "it")
    .replace(/["“”‘’]\s*["“”‘’]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return redacted;
}

const quizRecentSignalPattern = /\b(?:recent|recently|currently|now|today|this\s+(?:week|month|year)|in\s+20\d{2}|during|after|following|since|coverage|focus|attention|viral|trending|spread|became|emerged|prompted|respond(?:ed|ing)|popular|reaches?|reached|released|opening|premier\w*|outbreak|recall\w*|disappear\w*|classif\w*|hurricane|flood\w*|hunker\w*|restock\w*|sold\s+out|world\s+cup|social\s+media)\b/gi;
// Movie quiz clues must contain a plot-premise cue, not only the genre sentence
// that many source descriptions place first. The vocabulary is intentionally
// generic so it works for newly ingested films without naming any title.
const quizMoviePlotSignalPattern = /\b(?:about|after|before|character|conflict|creator|discovers?|dimension|encounters?|family|follows?|forced|friendship|happens?|home|journey|king|memory|mission|mystery|plot|premise|reunite|returns?|set|sister|story|stranded|takes?|tries?|undergoes?|wakes?|when|where|while|world)\b/i;
const quizMovieGenreOnlyPattern = /\bis\s+(?:an?\s+)?(?:[\w-]+(?:\/[\w-]+)*\s+)?film\.?$/i;

function moviePlotSentence(parts) {
  return parts
    .map((sentence, index) => ({
      sentence,
      index,
      isGenreOnly: quizMovieGenreOnlyPattern.test(sentence),
      hasPlotSignal: quizMoviePlotSignalPattern.test(sentence),
    }))
    .filter((entry) => !entry.isGenreOnly && entry.hasPlotSignal)
    .sort((left, right) => right.hasPlotSignal - left.hasPlotSignal || left.index - right.index)
    .at(0)?.sentence;
}

function quizContextFor(description, topicId) {
  const parts = sentences(description);
  if (!parts.length) return ensureSentence(description);
  if (topicId === "movies") {
    const plot = moviePlotSentence(parts);
    const nonGenre = parts.find((sentence) => !quizMovieGenreOnlyPattern.test(sentence));
    return ensureSentence(plot ?? nonGenre ?? parts[0]);
  }
  if (topicId === "books") {
    return ensureSentence(parts[0]);
  }
  const ranked = parts
    .map((sentence, index) => ({ sentence, index, score: (sentence.match(quizRecentSignalPattern) ?? []).length }))
    .sort((left, right) => right.score - left.score || right.index - left.index);
  const topScore = ranked[0]?.score ?? 0;
  const selected = topScore
    ? ranked.filter((entry) => entry.score === topScore).sort((left, right) => left.index - right.index)[0]?.sentence
    : parts.at(-1);
  return conciseSentences(selected ?? parts[0], 420);
}

function quizDescriptionClue(description, title, topicId) {
  const context = conciseSentences(description, 420) || ensureSentence(description);
  let redacted = redactQuizTitle(context, title)
    .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
  const subject = {
    memes: "This meme",
    people: "This person",
    movies: "This film",
    books: "This book",
    news: "This story",
  }[topicId] ?? "This entry";
  if (/^it\b/i.test(redacted)) redacted = `${subject} ${redacted.slice(2).trim()}`;

  // Redacting a headline can leave a dependent phrase such as “about 15 miles”.
  // Keep the original complete sentence in that case instead of surfacing a
  // fragment. For ordinary noun phrases, add a neutral subject so the clue
  // still reads naturally without revealing the answer title.
  const dependentStart = /^(?:about|after|before|because|from|in|near|of|on|or|to|under|when|where|while|with|and|but|for)\b/i;
  if (dependentStart.test(redacted)) {
    redacted = context.trim();
  } else if (/^[a-z]/.test(redacted)) {
    redacted = `${subject} ${redacted}`;
  }
  return ensureSentence(redacted || context);
}

function quizPromptFallback(description, title, topicId, answerChoices = []) {
  const labels = {
    memes: "meme",
    people: "person",
    movies: "film",
    books: "book",
    music: "track",
    products: "product",
    news: "story",
  };
  return {
    prompt: `${quizDescriptionClue(description, title, topicId)} Which ${labels[topicId] ?? "entry"} matches this description?`,
    answers: [...answerChoices],
    correctAnswer: title,
  };
}

const unusableQuizPromptPattern = /\b(?:page views?|search volume|ranking|ranked|billboard hot 100|source list|know your meme|goodreads monthly readers|spotify today['’]s top hits)\b/i;

function usableQuizPrompt(prompt) {
  if (!prompt || unusableQuizPromptPattern.test(prompt)) return false;
  if (/[.!?]\s+[a-z]/.test(prompt)) return false;
  const sentenceCount = sentences(prompt).length;
  return prompt.trim().endsWith("?")
    && sentenceCount >= 1 && sentenceCount <= 2
    && prompt.trim().length >= 40 && prompt.trim().length <= 480
    && !/\.\.\.|…/.test(prompt);
}

function usableGeneratedQuizQuestion(candidate, record) {
  if (!candidate || typeof candidate !== "object") return false;
  const answers = Array.isArray(candidate.answers) ? candidate.answers : [];
  if (record.topicId === "movies" && !quizMoviePlotSignalPattern.test(candidate.prompt ?? "")) return false;
  return usableQuizPrompt(candidate.prompt)
    && answers.length === 4
    && new Set(answers).size === 4
    && answers.every((answer) => typeof answer === "string" && answer.trim().length >= 1 && answer.length <= 160)
    && typeof candidate.correctAnswer === "string"
    && answers.includes(candidate.correctAnswer)
    && normalize(candidate.correctAnswer) === normalize(record.title);
}

function quizRecords(brief) {
  const records = [];
  for (const sectionId of quizSectionIds) {
    const section = brief.sections.find((entry) => entry.id === sectionId);
    if (!section) throw new Error(`Quiz source board ${sectionId} is missing`);
    const allItems = [...section.items, ...(section.moreItems ?? [])];
    for (const item of allItems.slice(0, 3)) {
      const distractors = allItems
        .filter((candidate) => candidate.title !== item.title)
        .map((candidate) => candidate.title);
      const answerChoices = [...new Set([item.title, ...distractors])].slice(0, 4);
      if (answerChoices.length < 4) throw new Error(`${section.title} does not have four quiz choices`);
      records.push({
        id: `${sectionId}-${item.rank}`,
        topicId: sectionId,
        topic: section.title,
        title: item.title,
        quizContext: quizContextFor(item.description, sectionId),
        focus: {
          memes: "Use the concrete recent spread, format, or cultural moment in the supplied context, not a generic description of the subject.",
          people: "Use the concrete recent event, appearance, response, or coverage in the supplied context, not the person's generic occupation.",
          movies: "Use a specific plot-premise detail from the supplied context.",
          books: "Use a specific plot-premise detail from the supplied context.",
          news: "Use the concrete recent event or development in the supplied context, including its consequence when present.",
        }[sectionId],
        answerChoices,
      });
    }
  }
  if (records.length !== quizQuestionCount) throw new Error(`Quiz must contain ${quizQuestionCount} source records, received ${records.length}`);
  return records;
}

async function updateQuiz(brief) {
  const records = quizRecords(brief);
  let generated = new Map();
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      generated = await generateQuizBatch(records);
    } catch (error) {
      console.warn(`AI quiz prompts unavailable; deterministic prompts retained: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const questions = records.map((record) => ({
    ...(() => {
      const generatedQuestion = generated.get(record.id);
      if (usableGeneratedQuizQuestion(generatedQuestion, record)) return generatedQuestion;
      return quizPromptFallback(record.quizContext, record.title, record.topicId, record.answerChoices);
    })(),
    id: record.id,
    topicId: record.topicId,
    topic: record.topic,
    itemTitle: record.title,
  }));
  brief.quiz = { durationSeconds: quizDurationSeconds, questions };
  console.log(`Quiz questions prepared: ${questions.length} (${generated.size ? `${generated.size} AI prompts` : "deterministic prompts"}).`);
}

function validateBrief(brief) {
  const expected = ["people", "movies", "books", "music", "products", "news", "memes", "slang"];
  if (brief.sections.length !== expected.length
    || brief.sections.some((section, index) => section.id !== expected[index])) {
    throw new Error("Brief must contain the eight boards in the documented order");
  }
  const validateItems = (section, items, startRank) => items.forEach((item, index) => {
    if (item.rank !== index + startRank) throw new Error(`${section.title} has non-sequential ranks`);
    if (!item.description?.trim() || !item.alt?.trim() || !item.image?.startsWith("/culture/")
      || !/^#[0-9a-f]{6}$/i.test(item.accent) || !item.url || new URL(item.url).protocol !== "https:") {
      throw new Error(`${item.title} lacks complete card information`);
    }
    if (section.id === "people") {
      const context = aiDescriptionContexts.get(item);
      if (context && !isDescriptionUsable("people", item.description, {
        title: item.title,
        sourceSnippets: context.snippets,
      }, { allowHeadlineReuse: true })) {
        throw new Error(`${item.title} lacks a first-sentence, recent-relevance explanation`);
      }
    }
    if (section.id === "news" && new URL(item.url).hostname === "news.google.com") {
      throw new Error(`${item.title} still points to a Google News redirect`);
    }
    if (section.id === "products" && item.evidence.some((entry) => new URL(entry.url).hostname === "news.google.com")) {
      throw new Error(`${item.title} still has a Google News redirect in its evidence`);
    }
    if (section.id === "products") {
      const productUrl = new URL(item.url);
      const directArticle = productUrl.hostname !== "www.amazon.com"
        && item.evidence.some((entry) => entry.url === item.url);
      if (!isAmazonListingUrl(item.url) && !directArticle) {
        throw new Error(`${item.title} must link to a verified Amazon listing or related article`);
      }
    }
    if (item.imageSource) {
      const imageUrl = new URL(item.imageSource);
      const articleImage = item.imageSourceKind === "article"
        && (section.id === "news" || section.id === "products")
        && item.imageSourcePageUrl
        && publicHttpsUrl(item.imageSourcePageUrl, "article image source page").hostname !== "news.google.com";
      if (articleImage) publicHttpsUrl(imageUrl, "article image");
      else if (imageUrl.protocol !== "https:" || !imageUrl.hostname.match(/(?:\.gr-assets\.com|\.wikimedia\.org|\.media-amazon\.com|\.scdn\.co)$/)) {
        throw new Error(`${item.title} has an invalid source image`);
      }
    }
    if (!Array.isArray(item.evidence) || item.evidence.length > 3
      || new Set(item.evidence.map((entry) => entry.source)).size < 2
      || new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size < 2) {
      throw new Error(`${item.title} lacks two distinct sources`);
    }
  });
  for (const section of brief.sections) {
    if (section.items.length !== 5) throw new Error(`${section.title} must have five entries`);
    if (!Array.isArray(section.sources) || section.sources.length < 2 || section.sources.length > 3) {
      throw new Error(`${section.title} must list two to three linked sources`);
    }
    for (const source of section.sources) {
      if (!source?.label || !source?.url || new URL(source.url).protocol !== "https:") {
        throw new Error(`${section.title} has an invalid linked source`);
      }
    }
    validateItems(section, section.items, 1);
    if (!Array.isArray(section.moreItems) || section.moreItems.length > 15) throw new Error(`${section.title} has an invalid continuation`);
    const topTitles = new Set(section.items.map((item) => normalize(item.title)));
    validateItems(section, section.moreItems, 6);
    section.moreItems.forEach((item) => {
      if (topTitles.has(normalize(item.title))) throw new Error(`${section.title} continuation repeats ${item.title}`);
    });
  }
  const memes = brief.sections.find((section) => section.id === "memes");
  const allMemes = [...memes.items, ...memes.moreItems];
  const memePollRanks = allMemes.map((item) => Number(item.metric?.value?.slice(1)));
  if (memePollRanks.some((rank) => !Number.isInteger(rank))
    || memePollRanks.some((rank, index) => index > 0 && rank <= memePollRanks[index - 1])) {
    throw new Error("Memes must preserve the published Meme of the Month order");
  }
  const people = brief.sections.find((section) => section.id === "people");
  const peopleCategoryCounts = new Map();
  for (const item of [...people.items, ...people.moreItems]) {
    const count = (peopleCategoryCounts.get(item.category) ?? 0) + 1;
    peopleCategoryCounts.set(item.category, count);
    if (!item.category || count > 2 || !item.metric?.label.startsWith("Wikipedia views · ")) {
      throw new Error("People must use one capped primary category and monthly Wikipedia views");
    }
  }
  const slang = brief.sections.find((section) => section.id === "slang");
  const allSlang = [...(slang?.items ?? []), ...(slang?.moreItems ?? [])];
  for (const item of allSlang) {
    if (item.metric?.label !== "Know Your Meme page views"
      || !/^\d{1,3}(?:,\d{3})*$/.test(item.metric.value)) {
      throw new Error(`${item.title} must show exact Know Your Meme page views`);
    }
  }
  const slangViews = allSlang.map((item) => Number(item.metric.value.replaceAll(",", "")));
  if (slangViews.some((views, index) => index > 0 && views > slangViews[index - 1])) {
    throw new Error("Slang must be ordered by Know Your Meme page views");
  }
  const movies = brief.sections.find((section) => section.id === "movies");
  for (const item of [...movies.items, ...movies.moreItems]) {
    if (!item.metric?.label.startsWith("Wikipedia views · ") || !item.rating) {
      throw new Error(`${item.title} must show monthly Wikipedia views and an IMDb rating state`);
    }
  }
  const books = brief.sections.find((section) => section.id === "books");
  const allBooks = [...books.items, ...books.moreItems];
  const bookReaders = allBooks.map((item) => Number(item.metric?.value.replaceAll(",", "")));
  if (allBooks.some((item) => item.metric?.label !== "Goodreads monthly readers"
      || !/^\d{1,3}(?:,\d{3})*$/.test(item.metric.value)
      || !/Goodreads/.test(item.subtitle)
      || item.ratingLabel !== "Goodreads"
      || !/^\d(?:\.\d{2})$/.test(item.rating))
    || bookReaders.some((readers, index) => !Number.isFinite(readers)
      || (index > 0 && readers > bookReaders[index - 1]))) {
    throw new Error("Books must preserve Goodreads monthly reader order");
  }
  const music = brief.sections.find((section) => section.id === "music");
  const allMusic = [...music.items, ...music.moreItems];
  const billboardRanks = allMusic.map((item) => Number(item.metric?.value?.slice(1)));
  if (billboardRanks.some((rank) => !Number.isInteger(rank))
    || billboardRanks.some((rank, index) => index > 0 && rank < billboardRanks[index - 1])) {
    throw new Error("Music must be ordered by Billboard Hot 100 position");
  }
  if (allMusic.some((item) => !/^[A-Za-z0-9]{22}$/.test(item.spotifyId ?? ""))) {
    throw new Error("Every music entry must include a playable Spotify track ID");
  }
  const products = brief.sections.find((section) => section.id === "products");
  const allProducts = [...products.items, ...products.moreItems];
  const invalidProducts = allProducts.filter((item) => !(
    (item.metric?.label === "Independent viral sources"
      && /^\d+ sources?$/.test(item.metric.value)
      && Number(item.metric.value.match(/^\d+/)?.[0]) >= 2)
    || (item.metric?.label === "Recent viral source + Amazon velocity"
      && item.metric.value === "1 source + Amazon velocity")
  )
    || item.subtitle !== "Product"
    || /\bis a consumer product\./i.test(item.description)
    || !/\b(?:attention|backorder|buying|collect(?:ing|or)?|craze|demand|expansion|frenzy|global|interest|launch|opening|popular|pre[- ]?order|recommend|release|restock|return|rollout|sales?|selling|sold out|trend(?:ing)?|unbox(?:ing)?|viral)\b/i.test(item.description));
  if (invalidProducts.length) {
    throw new Error(`Products must have at least two recent independent viral sources and recent context: ${invalidProducts.map((item) => `${item.title} (${item.description})`).join(" | ")}`);
  }
  const news = brief.sections.find((section) => section.id === "news");
  const allNews = [...news.items, ...news.moreItems];
  const newsVolumes = allNews.map((item) => searchVolume(item.metric?.value));
  if (allNews.some((item) => item.metric?.label !== "Google search volume"
      || !/^News(?: · [A-Z][a-z]{2} \d{1,2}, \d{4})?$/.test(item.subtitle))
    || newsVolumes.some((volume) => !volume)
    || newsVolumes.some((volume, index) => index > 0 && volume > newsVolumes[index - 1])) {
    throw new Error("News must be ordered by seven-day Google search volume");
  }
  if (!brief.quiz || brief.quiz.durationSeconds !== quizDurationSeconds
      || !Array.isArray(brief.quiz.questions) || brief.quiz.questions.length !== quizQuestionCount) {
    throw new Error(`Quiz must contain ${quizQuestionCount} questions and a 15-second duration per question`);
  }
  const quizCounts = new Map();
  const quizIds = new Set();
  for (const question of brief.quiz.questions) {
    if (!question || typeof question !== "object" || quizIds.has(question.id)
        || typeof question.id !== "string" || typeof question.topicId !== "string"
        || !quizSectionIds.includes(question.topicId) || typeof question.topic !== "string"
        || typeof question.itemTitle !== "string" || typeof question.prompt !== "string"
        || question.prompt.length < 20 || question.prompt.length > 360
        || !Array.isArray(question.answers) || question.answers.length !== 4
        || new Set(question.answers).size !== 4 || question.answers.some((answer) => typeof answer !== "string" || !answer.trim())
        || typeof question.correctAnswer !== "string" || !question.answers.includes(question.correctAnswer)) {
      throw new Error("Quiz contains an invalid question");
    }
    quizIds.add(question.id);
    quizCounts.set(question.topicId, (quizCounts.get(question.topicId) ?? 0) + 1);
    const section = brief.sections.find((entry) => entry.id === question.topicId);
    const sourceItems = section ? [...section.items, ...(section.moreItems ?? [])].slice(0, 3) : [];
    const sourceItem = sourceItems.find((item) => item.title === question.itemTitle);
    if (!sourceItem
        || !usableQuizPrompt(question.prompt)
        || (question.topicId === "movies" && !quizMoviePlotSignalPattern.test(question.prompt))
        || normalize(question.correctAnswer) !== normalize(question.itemTitle)
        || question.topic !== section?.title) {
      throw new Error(`Quiz question ${question.id} is not grounded in one of the board's first three entries`);
    }
  }
  if (quizSectionIds.some((sectionId) => quizCounts.get(sectionId) !== 3)) {
    throw new Error("Quiz must contain three questions from every non-slang board");
  }
  const serialized = JSON.stringify(brief);
  if (/tiktok/i.test(serialized)) throw new Error("The briefing must not contain TikTok data");
  if (/socialblade|socialcounts/i.test(serialized)) throw new Error("The briefing must not contain platform-growth ranking data");
  if (/"(?:signal|score)":/.test(serialized)) throw new Error("The briefing must not contain opaque score fields");
  if (/"caution":|b\*{2,}|a\*{2,}/i.test(serialized)) throw new Error("The briefing must not add profanity warnings or censorship");
}

const brief = JSON.parse(await readFile(dataPath, "utf8"));
const renames = new Map([["creators", "people"], ["watch", "movies"], ["songs", "music"]]);
for (const section of brief.sections) {
  if (renames.has(section.id)) section.id = renames.get(section.id);
}
const emptySection = (id, title, layout) => ({
  id,
  eyebrow: "Pending first 48-hour refresh",
  title,
  description: "This board is populated by the validated 48-hour ingestion job.",
  sources: [
    { label: id === "products" ? "Amazon Movers & Shakers" : "Google Trends", url: id === "products" ? amazonMoverCategories[0].url : newsTrendsUrl },
    { label: id === "products" ? "Google News viral coverage" : "Google News", url: id === "products" ? productDiscoveryUrl : googleNewsHomeUrl },
  ],
  layout,
  items: [],
  moreItems: [],
});
if (!brief.sections.some((section) => section.id === "books")) brief.sections.push(emptySection("books", "Books", "poster"));
if (!brief.sections.some((section) => section.id === "products")) brief.sections.push(emptySection("products", "Products", "square"));
if (!brief.sections.some((section) => section.id === "news")) brief.sections.push(emptySection("news", "News", "landscape"));
const order = ["people", "movies", "books", "music", "products", "news", "memes", "slang"];
brief.sections.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
for (const section of brief.sections) {
  if (section.id === "people") {
    section.title = "People";
    section.layout = "square";
  } else if (section.id === "movies") {
    section.title = "Movies";
    section.layout = "poster";
  } else if (section.id === "books") {
    section.title = "Books";
    section.layout = "poster";
  } else if (section.id === "music") {
    section.title = "Music";
    section.layout = "square";
  }
}
for (const section of brief.sections) {
  if (section.sources.every((source) => typeof source === "string")) {
    const evidence = section.items[0]?.evidence ?? [];
    section.sources = section.sources.map((label, index) => ({
      label,
      url: evidence[index % Math.max(evidence.length, 1)]?.url ?? section.items[0].url,
    }));
  }
}

if (quizOnly) {
  await updateQuiz(brief);
  sanitizeBriefSocialMentions(brief);
  validateBrief(brief);
  const output = `${JSON.stringify(brief, null, 2)}\n`;
  const temporaryPath = `${dataPath}.${process.pid}.next`;
  try {
    await writeFile(temporaryPath, output, { mode: 0o644, flag: "wx" });
    await rename(temporaryPath, dataPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  process.exit(0);
}

const now = new Date();
if (refreshContextOnly) {
  await refreshCurrentContext(brief, now);
  process.exit(0);
}
if (!force && !dryRun && brief.generatedAt.slice(0, 10) === now.toISOString().slice(0, 10)) {
  console.log(`Already refreshed on ${now.toISOString().slice(0, 10)}; use --force to run again.`);
  process.exit(0);
}

const independentSourcePromises = [
  safely("Know Your Meme result", latestMemeResult),
  safely("Lessons in Meme Culture", lessonsInMemeCultureRecent),
  safely("Wikimedia monthly topviews", wikipediaMonthlyTop),
  safely("Billboard Hot 100", billboardHot100),
  safely("Spotify Today’s Top Hits", spotifyPlaylistTracks),
  safely("Goodreads monthly most read", goodreadsMostRead),
  safely("Viral product discovery", productLeaderboard),
  safely("Google Trending Now / News", googleTrendingNews),
];
const slangReviewResult = await safely("Know Your Meme annual slang review", latestAnnualSlangReview);
const slangCandidates = slangReviewResult.value?.candidates ?? [];
const [memeResult, limcResult, topviewsResult, billboardResult, spotifyResult, booksResult, productsResult, newsResult,
  slangDetailsResult, urbanDictionaryResult] = await Promise.all([
  ...independentSourcePromises,
  safely("Know Your Meme slang pageviews", () => knowYourMemeSlangDetails(slangCandidates)),
  safely("Urban Dictionary", () => verifyUrbanDictionary(slangCandidates)),
]);
const sourceResults = [
  memeResult,
  limcResult,
  slangReviewResult,
  slangDetailsResult,
  urbanDictionaryResult,
  topviewsResult,
  billboardResult,
  spotifyResult,
  booksResult,
  productsResult,
  newsResult,
];
const byName = Object.fromEntries(sourceResults.map((result) => [result.name, result]));
for (const result of sourceResults) console.log(`${result.ok ? "ok" : "failed"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
const optionalSources = new Set(["Viral product discovery"]);
const failedSources = sourceResults.filter((result) => !result.ok && !optionalSources.has(result.name));
if (failedSources.length) {
  console.error(`No snapshot was written because ${failedSources.length} required source check${failedSources.length === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

await updateMemes(brief, byName["Know Your Meme result"].value, byName["Lessons in Meme Culture"].value);
updateSlang(
  brief,
  byName["Know Your Meme annual slang review"].value,
  byName["Know Your Meme slang pageviews"].value,
  byName["Urban Dictionary"].value,
);
await updatePeople(brief, byName["Wikimedia monthly topviews"].value);
await updateMovies(brief, byName["Wikimedia monthly topviews"].value);
await updateMusic(brief, byName["Billboard Hot 100"].value, byName["Spotify Today’s Top Hits"].value);
await updateBooks(brief, byName["Goodreads monthly most read"].value);
if (byName["Viral product discovery"].ok) await updateProducts(brief, byName["Viral product discovery"].value);
repairProductSnapshot(brief);
updateNews(brief, byName["Google Trending Now / News"].value);
await updateAiDescriptions(brief);
await updateQuiz(brief);
for (const item of brief.sections.flatMap((section) => [...section.items, ...(section.moreItems ?? [])])) delete item.caution;
delete brief.pulse;

brief.sourceHealth = sourceResults.map(({ name, ok, checkedAt, error }) => ({
  name,
  ok,
  checkedAt,
  ...(error ? { error } : {}),
}));
brief.generatedAt = now.toISOString();
brief.edition = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(now);
brief.status = "Checked today";
brief.summary = "A five-minute, two-source briefing on the people, movies, books, music, products, news, memes, and slang shaping internet culture right now.";
brief.window = "Memes: latest complete poll · People and Movies: last month · Books: latest Goodreads month · Products: past 90 days · News: past 7 days · Music: current charts";
sanitizeBriefSocialMentions(brief);
capLinkedSources(brief);
validateBrief(brief);
await generateNicheSnapshot(brief, { now, dryRun });

const output = `${JSON.stringify(brief, null, 2)}\n`;
if (dryRun) {
  console.log("Dry run; no files changed.");
  for (const section of brief.sections) {
    console.log(`${section.id}: ${section.items.map((item) => `${item.rank}. ${item.title}${item.metric ? ` (${item.metric.value})` : ""}`).join(" | ")}`);
  }
} else {
  const temporaryPath = `${dataPath}.${process.pid}.next`;
  try {
    await writeFile(temporaryPath, output, { mode: 0o644, flag: "wx" });
    await rename(temporaryPath, dataPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
