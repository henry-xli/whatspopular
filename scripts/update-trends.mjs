import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { withHeadlessPage } from "./lib/headless-browser.mjs";
import { linkedArticleMetadata, publicHttpsUrl, resolveGoogleNewsArticle } from "./lib/news-article.mjs";
import { fetchBytes, mapConcurrent } from "./lib/runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "data", "trends.json");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 18_000;
const accents = ["#ffc857", "#9b8cff", "#57d5a4", "#5ab0ff", "#ff6b57"];

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
const goodreadsMostReadUrl = "https://www.goodreads.com/book/most_read?category=all&country=US&duration=m";
const amazonMoverCategories = [
  ["Toys & Games", "toys"],
  ["Beauty", "beauty"],
  ["Clothing, Shoes & Jewelry", "clothing"],
  ["Home & Kitchen", "home-garden"],
  ["Electronics", "electronics"],
  ["Sports & Outdoors", "sporting-goods"],
].map(([label, slug]) => ({
  label,
  slug,
  url: `https://www.amazon.com/gp/movers-and-shakers/${slug}`,
}));
const productDiscoveryQueries = [
  "viral products",
  "viral toys",
  "viral beauty products",
  "viral gadgets",
  "viral fashion products",
  "viral home products",
  "viral collector products",
  "viral unboxing products",
  "viral product restock",
  "viral squishy toys",
  "viral collectibles",
  "viral skincare products",
  "viral bags and accessories",
  "squishy dumpling toys",
  "viral dumpling squishies",
  "viral restock handbags",
  "viral Amazon beauty",
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

function decodeHtml(value) {
  return value
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
  const html = await fetchText(goodreadsMostReadUrl, {
    headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" },
  });
  return { url: goodreadsMostReadUrl, books: parseGoodreadsBooks(html) };
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
  const description = cleanGoodreadsPremise(conciseSentences(metaContent(html, ["og:description"])
    || metaContent(html, ["description"]), 300));
  if (!description || description.length < 60
    || /^(?:[^.]{1,100}\s+)?is a book by\b/i.test(description)
    || /\b(?:read [\d,.]+[km]? reviews?|world(?:'|’)?s largest community for readers)\b/i.test(description)) return "";
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
    .trim();
  return description;
}

function bookPremiseDescription(...descriptions) {
  const usable = descriptions.map((description) => conciseSentences(description, 320)).filter((description) => description.length >= 60);
  const premise = usable.find((description) => !/^\s*(?:goodreads choice award|winner|nominee|from [^.!?]{1,160}(?:bestselling|new york times)|the acclaimed|the prize-winning)\b/i.test(description));
  return premise ?? usable[0] ?? "";
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
  const description = cleanGoodreadsPremise(conciseSentences(block, 320));
  return description.length >= 60 && !/\b(?:ratings?|reviews?|want to read|kindle unlimited|genres?)\b/i.test(description)
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
    const titleMatch = titleKeys.some((key) => pageTitle === key);
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
    const premise = conciseSentences(plainText(description ?? match.first_sentence?.[0] ?? ""), 300);
    return premise.length >= 45 ? { description: premise, pageUrl: workUrl } : null;
  })().catch(() => null);
  openLibraryBookCache.set(key, request);
  return request;
}

function bookDescription(book, wikipedia, context, goodreads, openLibrary, article) {
  const identity = bookPremiseDescription(
    goodreads?.description,
    openLibrary?.description,
    wikipedia?.extract,
    article?.intro,
  )
    || ensureSentence(`${book.title} is a book by ${book.author}`);
  return recentDescription(identity, context?.headline, { requireEvent: true });
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
  const articles = await mapConcurrent(contexts, 2, (context) => context
    ? linkedNewsArticle({ ...context, alternates: [] }).catch(() => null)
    : null);
  const currentByUrl = new Map([...section.items, ...(section.moreItems ?? [])].map((item) => [item.url, item]));
  const currentByTitle = new Map([...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]));
  const allItems = books.map((book, index) => {
    const current = currentByUrl.get(book.url) ?? currentByTitle.get(normalize(book.title));
    const context = contexts[index];
    const wiki = wikipedia[index];
    const goodreadsContext = goodreads[index];
    const openLibraryContext = openLibrary[index];
    const article = articles[index];
    const newsUrl = context?.link ?? googleNewsSearchUrl(`${book.title} ${book.author}`);
    return {
      rank: index + 1,
      title: book.title,
      subtitle: `Goodreads · ${book.author}`,
      description: bookDescription(book, wiki, context, goodreadsContext, openLibraryContext, article),
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
        ...(context ? [{ source: `${context.source} via Google News`, url: context.link }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
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
    const payload = JSON.parse(await fetchText(url));
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
      exsentences: "2",
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
  const clean = plainText(value ?? "");
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
const editorialHeadlinePattern = /^(?:forget|inside|meet|why)\b|\b(?:admit it|babygirl|best|cover by|favorite|hot take|joke on|must-see|opinion|review|should you|story behind|thank zeus|trojan horse|what to know|worst|worth buying)\b|\beverything (?:else )?(?:you )?need to know\b|\bonly .{0,50} could\b|\bgets? .{0,30} treatment\b/i;
const eventHeadlinePattern = /\b(?:announc|appoint|arrest|ban|block|buy|cancel|cement|charg|clos|confirm|crash|damag|debut|discount|dismis|file|first look|join|launch|leav|let|open|order|recall|reject|releas|renew|resign|return|reveal|rise|rally|sell|sign|sicken|surge|suspend|teas|unveil|win|won)\w*\b/i;

function factualHeadline(value, { rejectChartPlacement = false, requireEvent = false } = {}) {
  const clean = plainText(value ?? "")
    .replace(/^(?:exclusive|opinion|review)\s*[|:]\s*/i, "")
    .replace(/\s+-\s+The Athletic$/i, "")
    .trim();
  const factual = sentences(clean).filter((sentence) => sentence.length >= 24
    && sentence.length <= 240
    && !sentence.includes("?")
    && !/\b(?:No|vs)\.$/i.test(sentence)
    && !/^\d+\s+(?:and|as|but|in|on|to|with)\b/i.test(sentence)
    && !copiedMetricPattern.test(sentence)
    && !editorialHeadlinePattern.test(sentence)
    && (!requireEvent || eventHeadlinePattern.test(sentence))
    && !(rejectChartPlacement && /\b(?:billboard|charts?|no\.?\s*\d+|number one|#\d+)\b/i.test(sentence)))
    .map((sentence) => sentence
      .replace(/\s+draws outrage and fears of misuse$/i, " has prompted scrutiny over potential misuse")
      .trim());
  return conciseSentences(factual.join(" "), 240);
}

function personIdentity(title, description, categoryLabel) {
  let identity = plainText(description ?? "")
    .replace(/\s*\((?:born|b\.)[^)]*\)/gi, "")
    .replace(/\bassociation football player\b/gi, "footballer")
    .replace(/[.;,\s]+$/, "")
    .trim();
  if (!identity) identity = `person primarily known for work in ${categoryLabel.toLowerCase()}`;
  const article = /^[aeiou]/i.test(identity) ? "an" : "a";
  return ensureSentence(`${title} is ${article} ${identity}`);
}

function recentDescription(identity, headline, options = {}) {
  const context = factualHeadline(headline, options);
  if (context) return `${identity} ${context}`;
  return identity;
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

async function googleNewsContext(query, days = 45, { requireEvent = false } = {}) {
  const key = `${normalize(query)}:${days}:${requireEvent}`;
  if (googleNewsCache.has(key)) return googleNewsCache.get(key);
  const request = (async () => {
    const newsUrl = new URL("https://news.google.com/rss/search");
    newsUrl.search = new URLSearchParams({
      q: `${query} when:${days}d`,
      hl: "en-US",
      gl: "US",
      ceid: "US:en",
    });
    const rss = await fetchText(newsUrl);
    const queryTokens = new Set(normalize(query).split(" ").filter((token) => (token.length >= 3 || /\d/.test(token))
      && !new Set(["and", "for", "from", "news", "film", "movie", "product", "song", "shopping", "the", "with"]).has(token)));
    const items = [...rss.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map((match, index) => {
      const item = match[1];
      const source = plainText(item.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i)?.[1] ?? "");
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
      let score = overlap * 12 - index;
      if (headline.length >= 55 && headline.length <= 180) score += 6;
      if (/\b(?:announces?|bankruptcy|blocks?|crashes?|damaged|debut|first look|launches?|lawsuit|lets?|opens?|recall|rejects?|release date|reveals?|rises?|sickens|surges?|trailer|unveils?|without power)\b/i.test(headline)) score += 9;
      if (/^(?:how to|watch|photos?|video)\b/i.test(headline)) score -= 8;
      if (/\b(?:Associated Press|AP News|BBC|Billboard|Bloomberg|Deadline|ESPN|Forbes|Fortune|FOX Sports|The Guardian|Los Angeles Times|NBC News|NPR|New York Times|Reuters|SCOTUSblog|The Athletic|The Hollywood Reporter|The Washington Post|Variety)\b/i.test(source)) score += 12;
      if (/\b(?:Just Jared|Medium|Mshale|Weverse)\b/i.test(source)
        || /^(?:exclusive|opinion)\b|\b(?:cover by|lyrics:)\b/i.test(headline)) score -= 10;
      if (editorialHeadlinePattern.test(headline) || /\?/.test(headline)) score -= 30;
      if (/\b\w{1,3}$/.test(headline) && !/[.!?'’”)]$/.test(headline)) score -= 6;
      const date = new Date(published);
      return {
        headline,
        link: link.startsWith("https://news.google.com/") ? link : newsUrl.href,
        publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
        source: source || "Google News",
        feedUrl: newsUrl.href,
        sourceOrder: index,
        overlap,
        score,
      };
    }).filter((item) => item.headline);
    const candidates = items.filter((item) => item.overlap >= Math.min(2, Math.max(1, queryTokens.size)));
    const ranked = items.sort((left, right) => right.score - left.score);
    const selected = candidates.find((item) => factualHeadline(item.headline, { requireEvent }));
    return selected ? {
      ...selected,
      alternates: ranked.filter((item) => item !== selected).slice(0, 5),
    } : null;
  })();
  googleNewsCache.set(key, request);
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
  const selected = [];
  const categoryCounts = new Map();
  for (const person of eligible) {
    const count = categoryCounts.get(person.category) ?? 0;
    if (count >= 2) continue;
    selected.push(person);
    categoryCounts.set(person.category, count + 1);
    if (selected.length === 10) break;
  }
  if (selected.length < 10) throw new Error("Wikimedia topviews produced fewer than ten category-balanced people");
  const details = await wikipediaPageDetails(selected.map((person) => person.title));
  const contexts = await mapConcurrent(selected, 4, (person) =>
    googleNewsContext(`"${person.title}"`, 45, { requireEvent: true }).catch(() => null));
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = selected.map((person, index) => {
    const page = details.get(normalize(person.title));
    const title = page?.title ?? person.title;
    const current = currentByTitle.get(normalize(title));
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
    const context = contexts[index];
    const identity = personIdentity(title, person.entity?.descriptions?.en?.value, person.label);
    return {
      rank: index + 1,
      title,
      subtitle: person.label,
      description: recentDescription(identity, context?.headline, { requireEvent: true }),
      image: current?.image ?? `/culture/person-${slugify(title)}.webp`,
      imageSource: page?.thumbnail?.source,
      alt: current?.alt ?? `Portrait of ${title}`,
      url: wikipediaUrl,
      source: "Wikipedia",
      metric: { label: `Wikipedia views · ${topviews.period.month}`, value: formatCompact(person.views) },
      evidence: [
        { source: "Wikimedia monthly topviews", url: topviews.apiUrl },
        { source: "Wikipedia article", url: wikipediaUrl },
        ...(context ? [{ source: `${context.source} via Google News`, url: context.link }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
      category: person.category,
    };
  });
  section.eyebrow = `${topviews.period.month} ${topviews.period.year} · Wikipedia topviews`;
  section.title = "People";
  section.description = "Last month's most-viewed English Wikipedia pages that represent living people, excluding politicians and allowing at most two people from each broad primary category.";
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

function movieDescription(title, cinemeta, wikipediaExtract) {
  const genres = cinemeta?.genres?.map((genre) => genre.toLowerCase()).join("/");
  const identity = genres ? `${title} is ${/^[aeiou]/i.test(genres) ? "an" : "a"} ${genres} film.` : "";
  const premise = conciseSentences(cinemeta?.description ?? wikipediaExtract, 260);
  return `${identity} ${premise}`.trim() || `${title} is a film.`;
}

async function updateMovies(brief, topviews) {
  const section = brief.sections.find((entry) => entry.id === "movies");
  if (!section) return;
  const selected = topviews.rows.slice(0, 1000)
    .map((row) => ({ ...row, entity: topviews.entities.get(normalize(row.title)) }))
    .filter((row) => eligibleMovie(row.entity))
    .slice(0, 10);
  if (selected.length < 10) throw new Error("Wikimedia topviews produced fewer than ten movie pages");
  const details = await wikipediaPageDetails(selected.map((movie) => movie.title));
  const metadata = await mapConcurrent(selected, 4, async (movie) => {
    const imdbId = claimStrings(movie.entity, "P345").find((value) => /^tt\d{7,9}$/.test(value));
    return { imdbId, cinemeta: await cinemetaMovieDetails(imdbId) };
  });
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = selected.map((movie, index) => {
    const page = details.get(normalize(movie.title));
    const title = movieTitle(page?.title ?? movie.title);
    const current = currentByTitle.get(normalize(title));
    const wikipediaTitle = page?.title ?? movie.title;
    const wikipediaUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikipediaTitle.replaceAll(" ", "_"))}`;
    const { imdbId, cinemeta } = metadata[index];
    return {
      rank: index + 1,
      title,
      subtitle: movie.entity?.descriptions?.en?.value?.match(/\b((?:19|20)\d{2})\b/)?.[1]
        ? `${movie.entity.descriptions.en.value.match(/\b((?:19|20)\d{2})\b/)[1]} film`
        : "Movie",
      description: movieDescription(title, cinemeta, page?.extract),
      image: current?.image ?? `/culture/movie-${slugify(title)}.webp`,
      imageSource: page?.thumbnail?.source,
      alt: current?.alt ?? `${title} poster or lead image`,
      url: imdbId ? `https://www.imdb.com/title/${imdbId}/` : wikipediaUrl,
      source: imdbId ? "IMDb" : "Wikipedia",
      metric: { label: `Wikipedia views · ${topviews.period.month}`, value: formatCompact(movie.views) },
      rating: cinemeta?.rating ?? "Not rated",
      evidence: [
        { source: "Wikimedia monthly topviews", url: topviews.apiUrl },
        { source: "Wikipedia article", url: wikipediaUrl },
        ...(imdbId ? [{ source: "IMDb", url: `https://www.imdb.com/title/${imdbId}/` }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
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
    const results = JSON.parse(await fetchText(url)).search ?? [];
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
      const entity = JSON.parse(await fetchText(entityUrl)).entities?.[match.id];
      if (claimIds(entity, "P31").includes("Q5")) return true;
    }
  }
  return false;
}

function productTokens(value) {
  return normalize(value).split(" ")
    .filter((token) => token.length > 1 && !new Set(["for", "the", "with"]).has(token))
    .map((token) => token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
}

function productFamilyKey(value) {
  const generic = new Set(["a", "an", "and", "best", "buy", "buying", "deal", "deals", "find", "for", "from", "gift", "gifts", "item", "items", "new", "popular", "product", "products", "the", "toy", "toys", "trend", "trending", "viral"]);
  const tokens = normalize(value).split(" ").filter((token) => token.length > 1 && !generic.has(token));
  const singular = tokens.map((token) => token.length > 4 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
  return singular.join(" ");
}

function productGroupKey(value) {
  const family = productFamilyKey(value);
  const descriptorTokens = family.split(" ").filter((token) => /^(?:bag|brush|candle|card|cube|dumpling|gadget|gloss|lip|mascara|mug|phone|plush|serum|skincare|squish|tote|tracker|watch|wearable)$/.test(token));
  return descriptorTokens.length >= 2 ? [...new Set(descriptorTokens)].sort().join(" ") : family;
}

const genericProductWords = new Set([
  "all", "back", "best", "buy", "buying", "day", "deal", "deals", "find", "here", "item", "items",
  "more", "new", "one", "parents", "popular", "prime", "sale", "section", "shop", "starting", "story", "stories",
  "things", "today", "top", "trend", "trending", "viral", "warning", "what", "where", "why", "years",
  "about", "actually", "collectible", "collectibles", "doctors", "experts", "everything", "how", "hype", "inside", "internet", "job", "just", "know", "officials",
  "again", "america", "bag", "box", "cake", "china", "cup", "dot", "eagle", "found", "jack", "june", "kids", "knicks", "meet", "memorial", "now", "olive", "online", "only", "people", "picks", "places", "products", "psst", "retailer", "retail", "right", "rms", "shoppers", "skin", "skincare", "stock", "target", "toys", "tried", "under", "video", "world", "worth", "young",
]);
const productIdentityPattern = /\b(?:bag|brush|candle|card|cube|dumpling|gadget|gloss|lip|mascara|mug|phone|plush|serum|skincare|squish(?:y)?|toy|tote|tracker|watch|wearable)\b/i;
const genericProductPhrasePattern = /^(?:beauty product|portable fan|summer dress|squishy(?: toy)?(?: trend| craze)?|squishy dumpling(?:s|[’']? toys?)?|toy trend|toy craze|tri state parents|viral gadget|viral product|product trend|right now|tote bag nationwide|tote bag|body oil|hair mascara)$/i;
const productArticleBoilerplatePattern = /\b(?:affiliate commission|independently reviewed|when you purchase|purchase(?:d)? (?:an|a) .* through a link|links? on this page|shopping editors? (?:picked|selected)|we may earn|earn a commission|sponsored|advertisement|shop (?:our|the) (?:edit|selection)|click (?:here|the link|on links? we provide)|selected independently|editorial independence|shop today|we cover and recommend|learn more)\b/i;
const productAdControversyPattern = /\b(?:beauty routine|brand .*respond|not actually|didn['’]?t use|did not use|tit for tat|ad(?:vertis)?|backlash|scandal)\b/i;
const amazonFocusTerms = new Set(["airwrap", "supersonic", "vacuum", "hair", "dryer", "brush", "mask", "serum", "toner", "candle", "tote", "bag", "lip", "skin", "skincare", "beauty", "squish", "squishy", "dumpling", "toy", "plush", "cup", "collectible", "gadget", "phone", "watch", "shoe", "sneaker", "dress", "jacket"]);

function isGenericProductCandidate(value) {
  const tokens = normalize(value).replace(/\s+s\b/g, "").split(" ").filter(Boolean);
  return !tokens.length
    || genericProductPhrasePattern.test(value)
    || (tokens.length <= 2 && tokens.every((token) => genericProductWords.has(token) || ["product", "products", "squishy", "toy", "toys"].includes(token)));
}

function usableProductIntro(value) {
  const text = sanitizeSocialText(value);
  return text.length >= 45 && !productArticleBoilerplatePattern.test(text) ? text : "";
}

function productNameCandidate(value, source = "") {
  let candidate = plainText(value)
    .replace(/\b(?:amazon|best|buy|deals?|find|from|new|popular|products?|the|this|tiktok|viral|trending|what|when|where)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,'"“”‘’()-]+|[\s:,'"“”‘’()-]+$/g, "")
    .trim();
  candidate = candidate.replace(/([A-Za-z])['’]s\b/gi, "$1's")
    .replace(/^(?:expand|explains?|inside|introducing|meet|shop|the|unbox(?:ing)?|where(?: to)? buy)\s+/i, "");
  candidate = candidate.split(/\b(?:according|are|as|at|before|but|can|for|from|has|have|in|is|on|that|their|these|to|went|which|with|you)\b/i)[0]
    .replace(/[\s:,'"“”‘’()-]+$/, "")
    .trim();
  if (isGenericProductCandidate(candidate)) return "";
  const key = productFamilyKey(candidate);
  if (!key || key.length < 3 || key.split(" ").length > 6
    || /\b(?:amazon|beauty|clothing|deals?|gadgets?|home|kitchen|products?|shoes|social|summer|tiktok|toys?|viral)\b/i.test(key)
    || productFamilyKey(source) === key) return "";
  return candidate;
}

function productNamesFromHeadline(headline, source) {
  const names = [];
  const clean = plainText(headline).replace(/[–—]/g, " - ");
  for (const match of clean.matchAll(/\b(?:[A-Z][A-Za-z0-9’'&-]{2,}|[A-Z]{2,})(?:\s+(?:[A-Z][A-Za-z0-9’'&-]{2,}|[A-Z]{2,})){0,4}\b/g)) {
    const candidate = productNameCandidate(match[0], source);
    if (candidate) names.push(candidate);
  }
  for (const match of clean.matchAll(/\b(?:collectible|frenzy|hunting|popular|restock(?:ed)?|sold out|unboxing|viral|trending)\s+(?:the\s+)?([^:?!-]{2,70})/gi)) {
    const candidate = productNameCandidate(match[1], source);
    if (candidate) names.push(candidate);
  }
  return [...new Map(names.map((name) => [productFamilyKey(name), name])).values()];
}

function productDemandSignal(value) {
  return /\b(?:buy|buying|collect|collector|demand|everyone|frenzy|hunting|obsessed|popular|recommend|restock|selling out|sold out|unbox|viral|went viral|going viral|trending|social media|internet)\b/i.test(value);
}

function productControversySignal(value) {
  return /\b(?:controvers|danger|explod|fake|fraud|hospital|injur|lawsuit|recall|scam|safety|warning|backlash|scandal|brand .*respond|beauty routine|ad(?:vertis)?|not actually|didn['’]?t use|did not use)\b/i.test(value);
}

function productScarcitySignal(value) {
  return /\b(?:back in stock|hard to find|limited|restock|sold out|waitlist|wait-list)\b/i.test(value);
}

function productFreshness(publishedAt) {
  const age = (Date.now() - Date.parse(publishedAt)) / 86_400_000;
  return Number.isFinite(age) ? Math.max(0, Math.min(1, 1 - age / 90)) : 0;
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
  if (process.env.PRODUCT_MOVERS_SNAPSHOT) {
    const rows = JSON.parse(process.env.PRODUCT_MOVERS_SNAPSHOT);
    if (!Array.isArray(rows)) throw new Error("PRODUCT_MOVERS_SNAPSHOT is invalid");
    return rows.filter((row) => row && typeof row.query === "string").map((row) => ({
      ...row,
      category: String(row.category ?? "Amazon Movers & Shakers"),
      sourceUrl: String(row.sourceUrl ?? amazonMoverCategories[0].url),
    }));
  }
  const rows = [];
  for (const category of amazonMoverCategories) {
    const html = await fetchText(category.url, { headers: { "user-agent": "Mozilla/5.0" } }).catch(() => "");
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

async function viralProductNewsItems() {
  const feeds = await mapConcurrent(productDiscoveryQueries, 3, async (query) => {
    const feedUrl = new URL("https://news.google.com/rss/search");
    feedUrl.search = new URLSearchParams({ q: `${query} when:90d`, hl: "en-US", gl: "US", ceid: "US:en" });
    const rss = await fetchText(feedUrl);
    return [...rss.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 40).map((match) => {
      const item = match[1];
      const source = googleNewsItemValue(item, "source") || "Google News";
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
        link,
        publishedAt: Number.isNaN(publishedAt.getTime()) ? null : publishedAt.toISOString(),
        query,
      };
    }).filter((item) => item.headline && item.link && item.publishedAt);
  });
  return feeds.flat();
}

async function viralProductCandidates(movers) {
  const observations = await viralProductNewsItems();
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
    .slice(0, 80);
  const personFlags = new Map(await mapConcurrent(personCheckGroups, 4, async (group) => [
    group.key,
    await wikidataSearchIsPerson(group.name).catch(() => false),
  ]));
  const moverMap = new Map(movers.map((mover) => [productGroupKey(mover.query ?? mover.title ?? ""), mover]));
  const candidates = namedGroups.filter((group) => !personFlags.get(group.key)).map((group) => {
    const sources = new Set(group.observations.map((item) => normalize(item.source)));
    const positive = group.observations.filter((item) => item.demand);
    const controversy = group.observations.filter((item) => item.controversy).length;
    const organicPositive = group.observations.filter((item) => item.demand && !item.controversy);
    const scarcity = group.observations.filter((item) => item.scarcity).length;
    const adControversy = group.observations.some((item) => productAdControversyPattern.test(item.headline));
    const controversyOnly = adControversy && organicPositive.length < 2 && scarcity === 0;
    const mover = moverMap.get(group.key)
      ?? movers.find((item) => productGroupKey(item.title ?? "").startsWith(group.key) || group.key.startsWith(productGroupKey(item.title ?? "")));
    const social = Math.min(1, positive.length / 4);
    const confirming = Math.min(1, sources.size / 4);
    const freshness = Math.max(...group.observations.map((item) => productFreshness(item.publishedAt)), 0);
    const retail = mover ? Math.min(1, Math.max(0.25, Number(mover.gain ?? 0) / 100)) : 0;
    const scarcityScore = Math.min(1, scarcity / 2);
    const score = 35 * social + 30 * retail + 20 * freshness + 10 * confirming + 5 * scarcityScore
      - controversy * 8 - (adControversy ? 15 : 0);
    const best = [...group.observations].sort((left, right) => Number(right.demand) - Number(left.demand)
      || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0];
    return {
      ...group,
      mover,
      score,
      sourceCount: sources.size,
      observations: group.observations,
      best,
      qualifies: organicPositive.length > 0 && !controversyOnly && (Boolean(mover) || sources.size >= 2),
    };
  }).filter((candidate) => {
    const repeated = new Set(candidate.observations.map((item) => normalize(item.source))).size >= 2;
    const identifiable = productIdentityPattern.test(candidate.name) || repeated;
    return candidate.qualifies && !isGenericProductCandidate(candidate.name) && identifiable;
  })
    .sort((left, right) => right.score - left.score || right.sourceCount - left.sourceCount)
    .slice(0, 24);
  if (candidates.length < 5) throw new Error(`Only ${candidates.length} products had qualifying recent viral evidence`);
  const enriched = await mapConcurrent(candidates, 3, async (candidate) => {
    const evidence = await mapConcurrent(candidate.observations.slice(0, 5), 2, async (item) => {
      const directUrl = await resolveGoogleNewsArticle(item.link).catch(() => item.link);
      const metadata = directUrl === item.link
        ? null
        : await linkedArticleMetadata(directUrl, { allowMissingImage: true }).catch(() => null);
      return { ...item, directUrl, intro: metadata?.intro ?? "" };
    });
    const publisherHosts = new Set(evidence.map((item) => {
      try { return new URL(item.directUrl).hostname; } catch { return normalize(item.source); }
    }));
    const bestEvidence = [...evidence].sort((left, right) => Number(Boolean(usableProductIntro(right.intro))) - Number(Boolean(usableProductIntro(left.intro)))
      || Number(right.demand) - Number(left.demand)
      || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0];
    const rssSourceCount = new Set(candidate.observations.map((item) => normalize(item.source))).size;
    return { ...candidate, evidence, sourceCount: Math.max(publisherHosts.size, rssSourceCount), bestEvidence };
  });
  const specificNames = enriched.filter((candidate) => productIdentityPattern.test(candidate.name));
  const filtered = enriched
    .filter((candidate) => candidate.sourceCount >= 2)
    .filter((candidate) => !specificNames.some((specific) => specific.key !== candidate.key
      && normalize(specific.name).startsWith(`${normalize(candidate.name)} `)
      && specific.score >= candidate.score * 0.8))
    .slice(0, 18);
  return (filtered.length >= 5
    ? filtered
    : enriched.filter((candidate) => candidate.sourceCount >= 2).slice(0, 18));
}

async function amazonProducts(rows) {
  return withHeadlessPage({
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
        const amazonQuery = [row.query, ...focusTerms.slice(0, 2)].join(" ");
        const searchUrl = new URL("https://www.amazon.com/s");
        searchUrl.search = new URLSearchParams({ k: amazonQuery, s: "exact-aware-popularity-rank" });
        await page.navigate(searchUrl, 1_600);
        const cards = await page.evaluate(`Array.from(document.querySelectorAll("[data-asin]")).map((card) => { const asin = card.getAttribute("data-asin"); const links = Array.from(card.querySelectorAll('a[href*="/dp/"]')); const titleLink = links.find((link) => (link.innerText || "").trim().length > 8); return { asin, title: (titleLink?.innerText || "").replace(/\\s+/g, " ").trim(), text: (card.innerText || "").replace(/\\s+/g, " ").trim(), image: card.querySelector("img.s-image")?.src || "" }; }).filter((card) => /^[A-Z0-9]{10}$/.test(card.asin) && card.title)`);
        const tokens = productTokens(row.query);
        const required = Math.max(1, tokens.length - (tokens.length >= 3 ? 1 : 0));
        const beautyContext = /\b(?:beauty|skincare|skin care|makeup|hair)\b/i.test(contextText);
        const match = cards.filter((card) => {
          const cardTokens = new Set(productTokens(card.text));
          return tokens.filter((token) => cardTokens.has(token)).length >= required;
        }).sort((left, right) => {
          const score = (card) => {
            const cardTokens = new Set(productTokens(card.text));
            const focusMatches = focusTerms.filter((term) => cardTokens.has(term)).length;
            const unsuitable = beautyContext && /\b(?:toy|kids?|children|role[- ]play)\b/i.test(card.text) ? 20 : 0;
            return focusMatches * 10 - unsuitable;
          };
          return score(right) - score(left);
        })[0];
        if (!match) {
          console.warn(`Amazon match unavailable: #${row.rank} ${row.query}`);
          continue;
        }
        products.push({
          ...row,
          ...match,
          url: `https://www.amazon.com/dp/${match.asin}`,
          searchUrl: searchUrl.href,
        });
        if (products.length === 10) break;
      }
      if (products.length < 5) throw new Error(`Only ${products.length} viral products had a matching Amazon listing`);
      return products;
    },
  });
}

async function productLeaderboard() {
  const movers = await amazonMoversAndShakers();
  const candidates = await viralProductCandidates(movers);
  const products = await amazonProducts(candidates.map((candidate, index) => ({
    ...candidate,
    query: candidate.name,
    rank: index + 1,
    growth: candidate.mover ? `+${candidate.mover.gain ?? 0} ranks` : "Social discovery",
  })));
  if (products.length < 5) throw new Error("Viral product discovery produced fewer than five Amazon matches");
  return products;
}

function amazonProductIdentity(query, listingTitle) {
  let product = plainText(listingTitle ?? "")
    .replace(/^Amazon\.com\s*:\s*/i, "")
    .replace(/\s*:\s*Amazon\.com\s*:?\s*$/i, "")
    .split("|")[0]
    .trim();
  const colon = product.indexOf(":");
  if (colon >= 12) product = product.slice(0, colon).trim();
  product = product.length > 170
    ? product.slice(0, 171).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")
    : product;
  const title = titleCase(query);
  if (!product || normalize(product) === normalize(title)) return ensureSentence(`${title} is a consumer product`);
  return ensureSentence(`${title} refers here to the ${product}`);
}

async function updateProducts(brief, products) {
  const section = brief.sections.find((entry) => entry.id === "products");
  if (!section) return;
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = products.map((product, index) => {
    const title = titleCase(product.query);
    const current = currentByTitle.get(normalize(title));
    const identity = amazonProductIdentity(product.query, product.title);
    const intro = conciseSentences(usableProductIntro(product.bestEvidence?.intro), 300);
    const headline = sanitizeSocialText(product.bestEvidence?.headline);
    const description = intro || (headline ? `${identity} ${headline}` : identity);
    const socialEvidence = (product.evidence ?? []).slice(0, 3).map((item) => ({
      source: `${item.source} via Google News`,
      url: item.link,
    }));
    const moverEvidence = product.mover
      ? [{ source: `Amazon Movers & Shakers · ${product.mover.category}`, url: product.mover.sourceUrl }]
      : [];
    return {
      rank: index + 1,
      title,
      subtitle: "Viral product · Amazon match",
      description: description.slice(0, 600),
      image: current?.image ?? `/culture/product-${slugify(title)}.webp`,
      imageSource: product.image,
      alt: current?.alt ?? `${title} product listing image`,
      url: product.url,
      source: "Amazon",
      metric: { label: "Independent viral sources", value: `${product.sourceCount} sources` },
      evidence: [
        { source: "Amazon listing", url: product.url },
        ...moverEvidence,
        ...socialEvidence,
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
  });
  section.eyebrow = "Social trend evidence · past 90 days";
  section.title = "Products";
  section.description = "Products with recent, explicit viral-demand coverage and a matching Amazon listing. Candidates combine social evidence, Amazon Movers & Shakers velocity when available, freshness, independent confirmations, and scarcity signals; retail movement alone never qualifies a product.";
  section.sources = [
    ...amazonMoverCategories.map((category) => ({
      label: "Amazon Movers & Shakers · " + category.label,
      url: category.url,
    })),
    { label: "Google News · viral product coverage, 90 days", url: productDiscoveryUrl },
    { label: "Amazon · best-selling match", url: products[0].searchUrl ?? products[0].url },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = allItems.length > 5 ? `Show ranks 6–${allItems.length}` : undefined;
}

function searchVolume(value) {
  const match = String(value).match(/([\d.]+)\s*([KMB])?\+/i);
  if (!match) return 0;
  return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] ?? 1);
}

async function googleTrendingNews() {
  const html = await fetchText(newsTrendsUrl, { headers: { "user-agent": "Mozilla/5.0", "accept-language": "en-US,en;q=0.9" } });
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
  if (rows.length < 20) throw new Error(`Google Trending Now returned only ${rows.length} topics`);
  const entities = await wikidataEntitiesForTitles(rows.flatMap((row) => queryVariants(titleCase(row.title))));
  const sports = /\b(?:vs\.?|score|game|match|cup|league|nfl|nba|mlb|nhl|wnba|open 20\d{2}|warriors|fever|dream)\b/i;
  const personClue = /\b(?:actor|actress|author|director|founder|founding member|musician|player|rapper|singer|social-media star|streamer|youtuber)\b/i;
  const candidates = rows.filter((row) => !sports.test(row.title) && !personClue.test(row.title)
    && !queryEntityMatch(titleCase(row.title), entities, (entity) => claimIds(entity, "P31").includes("Q5")));
  const searchPersonFlags = await mapConcurrent(candidates, 4, (row) => wikidataSearchIsPerson(row.title));
  const filtered = candidates.filter((_, index) => !searchPersonFlags[index])
    .sort((left, right) => right.searches - left.searches || left.sourceOrder - right.sourceOrder)
    .slice(0, 10);
  if (filtered.length < 6) throw new Error(`Only ${filtered.length} non-person, non-sports news topics remained`);
  return mapConcurrent(filtered, 4, async (row) => {
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
      linkedNewsArticle(context),
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
}

async function linkedNewsArticle(context) {
  if (!context) return null;
  let primary = null;
  for (const candidate of [context, ...(context.alternates ?? [])]) {
    const articleUrl = await resolveGoogleNewsArticle(candidate.link).catch(() => null);
    if (!articleUrl) continue;
    if (!primary) primary = { context, url: articleUrl };
    const metadata = await linkedArticleMetadata(articleUrl, { allowMissingImage: true }).catch(() => null);
    if (candidate === context && metadata?.imageSource) return { context: candidate, ...metadata };
    if (candidate === context && metadata?.intro) primary = { context: candidate, ...metadata };
  }
  return primary;
}

function newsDescription(topic, title) {
  const articleIntro = conciseSentences(topic.articleIntro, 320);
  const definition = conciseSentences(topic.topicSummary, 220);
  const event = factualHeadline(topic.headline);
  if (articleIntro && event && !normalize(articleIntro).includes(normalize(event).slice(0, 48))) {
    return conciseSentences(`${articleIntro} ${event}`, 360);
  }
  if (articleIntro) return articleIntro;
  if (definition && event && !normalize(definition).includes(normalize(event).slice(0, 48))) {
    return conciseSentences(`${definition} ${event}`, 360);
  }
  const related = factualHeadline(topic.relatedHeadline);
  if (related && event && !normalize(related).includes(normalize(event).slice(0, 48))) {
    return conciseSentences(`${related} ${event}`, 360);
  }
  return event || definition || related || conciseSentences(topic.headline, 260) || ensureSentence(title);
}

function updateNews(brief, topics) {
  const section = brief.sections.find((entry) => entry.id === "news");
  if (!section) return;
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = topics.map((topic, index) => {
    const title = titleCase(topic.title);
    const current = currentByTitle.get(normalize(title));
    const trendUrl = googleTrendsExploreUrl([topic.title], "now 7-d");
    const published = publicationDateLabel(topic.publishedAt);
    return {
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
  });
  section.eyebrow = "U.S. Google Trends · past 7 days";
  section.title = "News";
  section.description = "The largest seven-day U.S. search-volume topics after removing people and sports, ranked by Google’s displayed search volume and linked to current coverage.";
  section.sources = [
    { label: "Google Trending Now · 7 days, search volume", url: newsTrendsUrl },
    { label: "Google News · current coverage", url: topics[0].link },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = `Show ranks 6–${allItems.length}`;
}

function validateBrief(brief) {
  const expected = ["memes", "slang", "people", "movies", "books", "music", "products", "news"];
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
    if (item.imageSource) {
      const imageUrl = new URL(item.imageSource);
      const articleImage = item.imageSourceKind === "article"
        && section.id === "news"
        && item.imageSourcePageUrl
        && publicHttpsUrl(item.imageSourcePageUrl, "article image source page").hostname === new URL(item.url).hostname;
      if (articleImage) publicHttpsUrl(imageUrl, "article image");
      else if (imageUrl.protocol !== "https:" || !imageUrl.hostname.match(/(?:\.gr-assets\.com|\.wikimedia\.org|\.media-amazon\.com|\.scdn\.co)$/)) {
        throw new Error(`${item.title} has an invalid source image`);
      }
    }
    if (!Array.isArray(item.evidence)
      || new Set(item.evidence.map((entry) => entry.source)).size < 2
      || new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size < 2) {
      throw new Error(`${item.title} lacks two distinct sources`);
    }
  });
  for (const section of brief.sections) {
    if (section.items.length !== 5) throw new Error(`${section.title} must have five entries`);
    if (!Array.isArray(section.sources) || section.sources.length < 2) {
      throw new Error(`${section.title} must list at least two linked sources`);
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
  if (allProducts.some((item) => item.metric?.label !== "Independent viral sources"
      || !/^\d+ sources?$/.test(item.metric.value)
      || Number(item.metric.value.match(/^\d+/)?.[0]) < 2
      || !/Viral product/i.test(item.subtitle))) {
    throw new Error("Products must have at least two recent independent viral sources");
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
  eyebrow: "Pending first daily refresh",
  title,
  description: "This board is populated by the validated daily ingestion job.",
  sources: [
    { label: id === "products" ? "Amazon Movers & Shakers" : "Google Trends", url: id === "products" ? amazonMoverCategories[0].url : newsTrendsUrl },
    { label: id === "products" ? "Google News viral coverage" : "Google News", url: id === "products" ? productDiscoveryUrl : "https://news.google.com/" },
  ],
  layout,
  items: [],
  moreItems: [],
});
if (!brief.sections.some((section) => section.id === "books")) brief.sections.push(emptySection("books", "Books", "poster"));
if (!brief.sections.some((section) => section.id === "products")) brief.sections.push(emptySection("products", "Products", "square"));
if (!brief.sections.some((section) => section.id === "news")) brief.sections.push(emptySection("news", "News", "landscape"));
const order = ["memes", "slang", "people", "movies", "books", "music", "products", "news"];
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
const now = new Date();
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
updateNews(brief, byName["Google Trending Now / News"].value);
for (const item of brief.sections.flatMap((section) => [...section.items, ...(section.moreItems ?? [])])) delete item.caution;
delete brief.pulse;

brief.sourceHealth = sourceResults.map(({ name, ok, checkedAt }) => ({ name, ok, checkedAt }));
brief.generatedAt = now.toISOString();
brief.edition = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(now);
brief.status = "Checked today";
brief.summary = "A five-minute, two-source briefing on the memes, slang, people, movies, books, music, products, and news shaping internet culture right now.";
brief.window = "Memes: latest complete poll · People and Movies: last month · Books: latest Goodreads month · Products: past 90 days · News: past 7 days · Music: current charts";
sanitizeBriefSocialMentions(brief);
validateBrief(brief);

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
