import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "data", "trends.json");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 18_000;
const accents = ["#ffc857", "#9b8cff", "#57d5a4", "#5ab0ff", "#ff6b57"];

const allowedHosts = new Set([
  "api.urbandictionary.com",
  "knowyourmeme.com",
  "open.spotify.com",
  "raw.githubusercontent.com",
  "trends.google.com",
  "trending.knowyourmeme.com",
  "wikimedia.org",
  "pageviews.wmcloud.org",
  "www.imdb.com",
  "www.boxofficemojo.com",
  "www.youtube.com",
]);

const cultureMakers = [
  { title: "MrBeast", article: "MrBeast", category: "digital", subtitle: "Digital creator", description: "The large-scale video creator and entrepreneur remains a useful benchmark for mainstream internet attention." },
  { title: "IShowSpeed", article: "IShowSpeed", category: "digital", subtitle: "Streamer", description: "The streamer and entertainer draws attention across gaming, sports, music, and live-event culture." },
  { title: "Kai Cenat", article: "Kai_Cenat", category: "digital", subtitle: "Streamer", description: "The streamer is measured alongside established film and music figures rather than in a short-form-only list." },
  { title: "PewDiePie", article: "PewDiePie", category: "digital", subtitle: "Digital creator", description: "One of online video's most established creators remains in the field so sustained attention counts alongside sudden spikes." },
  { title: "Markiplier", article: "Markiplier", category: "digital", subtitle: "Digital creator", description: "The creator and filmmaker bridges internet-native work and more traditional entertainment." },
  { title: "KSI", article: "KSI", category: "digital", subtitle: "Digital creator", description: "The creator, musician, boxer, and entrepreneur represents attention that moves between several media." },
  { title: "Emma Chamberlain", article: "Emma_Chamberlain", category: "digital", subtitle: "Digital creator", description: "The creator and podcaster represents internet-native influence outside gaming and spectacle channels." },
  { title: "Marques Brownlee", article: "Marques_Brownlee", category: "digital", subtitle: "Technology creator", description: "The technology creator provides a durable benchmark for online attention outside entertainment fandoms." },
  { title: "Christopher Nolan", article: "Christopher_Nolan", category: "filmmaker", subtitle: "Film director", description: "The Odyssey's record-setting theatrical run has put its director back at the center of film conversation." },
  { title: "Zendaya", article: "Zendaya", category: "actor", subtitle: "Actor", description: "Her starring roles in the current releases Spider-Man: Brand New Day and The Odyssey are driving renewed attention." },
  { title: "Tom Holland", article: "Tom_Holland", category: "actor", subtitle: "Actor", description: "His starring turns in Spider-Man: Brand New Day and The Odyssey are both in theaters now." },
  { title: "Matt Damon", article: "Matt_Damon", category: "actor", subtitle: "Actor", description: "His lead performance as Odysseus in Christopher Nolan's The Odyssey is driving current interest." },
  { title: "Dwayne Johnson", article: "Dwayne_Johnson", category: "actor", subtitle: "Actor", description: "His return as Maui in the live-action Moana has brought him back into current movie conversation." },
  { title: "James Gunn", article: "James_Gunn", category: "filmmaker", subtitle: "Film director", description: "His continuing work leading DC Studios keeps his upcoming film and television slate in public discussion." },
  { title: "Greta Gerwig", article: "Greta_Gerwig", category: "filmmaker", subtitle: "Film director", description: "Interest in her next directing project keeps the filmmaker in current movie conversation." },
  { title: "Jordan Peele", article: "Jordan_Peele", category: "filmmaker", subtitle: "Film director", description: "Anticipation around his next film keeps the director and writer in current genre-film conversation." },
  { title: "Shakira", article: "Shakira", category: "musician", subtitle: "Musician", description: "Her ongoing Las Mujeres Ya No Lloran World Tour and new World Cup song “Dai Dai” are driving fresh global attention." },
  { title: "Ariana Grande", article: "Ariana_Grande", category: "musician", subtitle: "Musician", description: "Her new album Petal and its Billboard #2 single “hate that i made you love me” are driving her current interest." },
  { title: "Taylor Swift", article: "Taylor_Swift", category: "musician", subtitle: "Singer-songwriter", description: "New music activity and sustained catalog attention continue to generate unusually high public interest." },
  { title: "Justin Bieber", article: "Justin_Bieber", category: "musician", subtitle: "Musician", description: "Current music and public appearances have brought the singer back into widespread conversation." },
  { title: "Olivia Rodrigo", article: "Olivia_Rodrigo", category: "musician", subtitle: "Musician", description: "Her current chart activity is keeping the singer-songwriter prominent across music coverage and fan discussion." },
  { title: "Bad Bunny", article: "Bad_Bunny", category: "musician", subtitle: "Musician", description: "His current music and live appearances continue to drive global, Spanish-language attention." },
  { title: "Bruno Mars", article: "Bruno_Mars", category: "musician", subtitle: "Musician", description: "Current charting collaborations and live performances are driving renewed interest in the musician." },
  { title: "Morgan Wallen", article: "Morgan_Wallen", category: "musician", subtitle: "Singer-songwriter", description: "His current chart and touring activity keeps him near the center of country-music conversation." },
];

const movieDetails = new Map([
  ["Spider-Man: Brand New Day", { rating: "8.2", image: "/culture/media-spider-man.webp", subtitle: "Movie · in theaters", description: "The current Spider-Man release leads the weekend chart's cumulative North American grosses." }],
  ["Toy Story 5", { rating: "7.5", image: "/culture/media-toy-story.webp", subtitle: "Movie · in theaters", description: "Eight weeks of ticket sales put Toy Story 5 ahead of newer weekend debuts when ranked by total gross." }],
  ["The Odyssey", { rating: "8.3", image: "/culture/media-odyssey.webp", subtitle: "Movie · in theaters", description: "Christopher Nolan's epic remains one of the largest cumulative earners still present in the weekend top ten." }],
  ["Minions & Monsters", { rating: "6.5", image: "/culture/media-minions-monsters.webp", subtitle: "Movie · in theaters", description: "The animated holdover outranks smaller new releases once the chart is sorted by total gross." }],
  ["Moana", { rating: "5.6", image: "/culture/media-moana.webp", subtitle: "Movie · in theaters", description: "The live-action musical rounds out the five largest cumulative grosses in the current weekend pool." }],
]);

function assertAllowed(rawUrl) {
  const url = new URL(rawUrl);
  const allowed = allowedHosts.has(url.hostname) || url.hostname.endsWith(".wikimedia.org");
  if (url.protocol !== "https:" || !allowed) throw new Error(`Refusing unapproved URL: ${url.origin}`);
  return url;
}

async function fetchText(rawUrl, options = {}) {
  const url = assertAllowed(rawUrl);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...options,
    headers: {
      accept: "text/html,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} from ${url.hostname}`);
  assertAllowed(response.url);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error(`${url.hostname} response was too large`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${url.hostname} returned no body`);
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`${url.hostname} response exceeded ${MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function plainText(value) {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
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

function isoPageviewStamp(stamp) {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
}

function pageviewsComparisonUrl(people) {
  const range = pageviewRange();
  const url = new URL("https://pageviews.wmcloud.org/");
  url.searchParams.set("project", "en.wikipedia.org");
  url.searchParams.set("platform", "all-access");
  url.searchParams.set("agent", "user");
  url.searchParams.set("redirects", "0");
  url.searchParams.set("start", isoPageviewStamp(range.start));
  url.searchParams.set("end", isoPageviewStamp(range.end));
  url.searchParams.set("pages", people.map((person) => person.article).join("|"));
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

async function lessonsInMemeCultureRecent() {
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
  return value.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function cleanKymSentence(value) {
  return value
    .replace(/\bTikTokers?\b/gi, "creators")
    .replace(/\bTikTok\b/gi, "social media")
    .replace(/\s*,\s*also known as[\s\S]*?\s*,\s*(?=refers to|is|are)/i, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenWords(value, limit) {
  const words = value.split(/\s+/);
  if (words.length <= limit) return value;
  return `${words.slice(0, limit).join(" ").replace(/[,:;\s]+$/, "")}…`;
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
  const usage = usageCandidates.find((sentence) => /\b(?:used|uses|use|caption|reaction|template|format|joke|parody)\b/i.test(sentence))
    ?? usageCandidates.find((sentence) => /\b(?:meme|memes|fan art|edits)\b/i.test(sentence))
    ?? usageCandidates.find((sentence) => /\b(?:viral|spread)\b/i.test(sentence));
  if (!context) throw new Error("Know Your Meme entry had no usable description");
  return [shortenWords(context, 22), usage && usage !== context ? shortenWords(usage, 22) : null].filter(Boolean).join(" ");
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
  const currentByUrl = new Map(section.items.map((item) => [item.url, item]));
  const pollMatches = [];
  for (const candidate of result.candidates) {
    const html = await fetchText(candidate.url);
    const video = memeVideoMatch(candidate, videos, kymMatchContext(html));
    if (video) pollMatches.push({ candidate, video, description: conciseKymDescription(html) });
    if (pollMatches.length === 5) break;
  }
  if (dryRun) console.log(`Poll matches: ${pollMatches.map((entry) => `${entry.candidate.title} ↔ ${entry.video.title}`).join(" | ")}`);
  const ordered = pollMatches.slice(0, 5);
  if (dryRun) console.log(`Meme cross-check: ${ordered.map((entry) => `${entry.candidate.title} ↔ ${entry.video.title}`).join(" | ")}`);
  if (ordered.length < 5) throw new Error(`Only ${ordered.length} poll memes had a matching LIMC upload from the past two months`);

  section.eyebrow = `${result.label} · latest complete month`;
  section.description = `The ${result.month} Meme of the Month results, kept in poll order and filtered to memes Lessons in Meme Culture covered in any upload from the past two months.`;
  section.sources = [
    { label: `Know Your Meme · ${result.month} result`, url: result.resultUrl },
    { label: "Lessons in Meme Culture · past 2 months", url: "https://www.youtube.com/@LIMC/videos" },
  ];
  section.items = ordered.map(({ candidate, video, description }, index) => {
    const current = currentByUrl.get(candidate.url);
    const title = current?.title ?? candidate.title;
    return {
      rank: index + 1,
      title,
      subtitle: `${result.month} poll finalist · LIMC covered`,
      description: current?.description ?? description,
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
}

async function verifyUrbanDictionary(items) {
  const results = await Promise.all(items.map(async (item) => {
    const payload = JSON.parse(await fetchText(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(item.title)}`));
    return Array.isArray(payload.list) && payload.list.length > 0;
  }));
  if (!results.every(Boolean)) throw new Error("At least one slang term had no Urban Dictionary result");
  return results.length;
}

async function knowYourMemeSlangPageviews(items) {
  const pairs = await Promise.all(items.map(async (item) => {
    const html = await fetchText(item.url);
    const raw = html.match(/<dd\s+class=['"]views['"]\s+title=['"]([0-9,]+)\s+Views['"]/i)?.[1];
    if (!raw) throw new Error(`Know Your Meme exposed no page-view count for ${item.title}`);
    return [item.title, Number(raw.replaceAll(",", ""))];
  }));
  return Object.fromEntries(pairs);
}

function parseGooglePayload(text) {
  return JSON.parse(text.replace(/^\)\]\}',?\s*/, ""));
}

async function googleTrendsSlang(items) {
  const request = {
    comparisonItem: items.map((item) => ({ keyword: item.title, geo: "US", time: "today 12-m" })),
    category: 0,
    property: "",
  };
  const explore = parseGooglePayload(await fetchText(`https://trends.google.com/trends/api/explore?hl=en-US&tz=240&req=${encodeURIComponent(JSON.stringify(request))}`));
  const widget = explore.widgets?.find((entry) => entry.id === "TIMESERIES");
  if (!widget) throw new Error("Google Trends returned no time-series widget");
  const series = parseGooglePayload(await fetchText(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=240&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`));
  const totals = Array(items.length).fill(0);
  const points = series.default?.timelineData ?? [];
  for (const point of points) point.value?.forEach((value, index) => { totals[index] += Number(value) || 0; });
  if (!points.length) throw new Error("Google Trends returned an empty time series");
  return Object.fromEntries(items.map((item, index) => [item.title, totals[index] / points.length]));
}

function updateSlang(brief, interest, pageviews) {
  const section = brief.sections.find((entry) => entry.id === "slang");
  if (!section) return;
  if (interest) {
    section.items.sort((a, b) => (interest[b.title] ?? -1) - (interest[a.title] ?? -1));
    section.items.forEach((item, index) => { item.rank = index + 1; item.accent = accents[index]; });
  }
  if (pageviews) {
    for (const item of section.items) {
      const views = pageviews[item.title];
      if (Number.isFinite(views)) item.metric = { label: "Know Your Meme page views", value: formatInteger(views) };
    }
  }
  section.description = "These five terms come from Know Your Meme's annual slang review and are checked against Urban Dictionary. Their order follows the latest successful 12-month U.S. Google Trends comparison; lifetime Know Your Meme entry views are shown below.";
  section.sources = [
    {
      label: "Know Your Meme · annual slang review",
      url: "https://trending.knowyourmeme.com/editorials/meme-review/kym-review-the-top-slang-terms-of-2025",
    },
    {
      label: `Urban Dictionary · ${section.items[0].title}`,
      url: `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(section.items[0].title)}`,
    },
    {
      label: "Google Trends · these five, 12 months",
      url: googleTrendsExploreUrl(section.items.map((item) => item.title), "today 12-m"),
    },
  ];
}

async function googleTrendsCreators(items) {
  const anchor = items.find((item) => item.title === "Taylor Swift") ?? items[0];
  const ratios = new Map([[anchor.title, 1]]);
  const candidates = items.filter((item) => item !== anchor);
  for (let index = 0; index < candidates.length; index += 4) {
    const group = [anchor, ...candidates.slice(index, index + 4)];
    const request = {
      comparisonItem: group.map((item) => ({ keyword: item.title, geo: "US", time: "today 1-m" })),
      category: 0,
      property: "",
    };
    const explore = parseGooglePayload(await fetchText(`https://trends.google.com/trends/api/explore?hl=en-US&tz=240&req=${encodeURIComponent(JSON.stringify(request))}`));
    const widget = explore.widgets?.find((entry) => entry.id === "TIMESERIES");
    if (!widget) throw new Error("Google Trends returned no creator time-series widget");
    const series = parseGooglePayload(await fetchText(`https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=240&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${encodeURIComponent(widget.token)}`));
    const totals = Array(group.length).fill(0);
    const points = series.default?.timelineData ?? [];
    for (const point of points) point.value?.forEach((value, valueIndex) => { totals[valueIndex] += Number(value) || 0; });
    if (!points.length || totals[0] <= 0) throw new Error("Google Trends returned an unusable creator comparison");
    group.slice(1).forEach((item, itemIndex) => ratios.set(item.title, totals[itemIndex + 1] / totals[0]));
  }
  const maximum = Math.max(...ratios.values());
  return Object.fromEntries([...ratios].map(([title, ratio]) => [title, Math.round((ratio / maximum) * 100)]));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function wikipediaCreatorPageviews(items) {
  const range = pageviewRange();
  const values = {};
  for (const item of items) {
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/${encodeURIComponent(item.article)}/daily/${range.start}/${range.end}`;
    let payload;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        payload = JSON.parse(await fetchText(url));
        break;
      } catch (error) {
        if (attempt === 2 || !String(error).includes("429")) throw error;
        await sleep(500 * (attempt + 1));
      }
    }
    values[item.title] = (payload?.items ?? []).reduce((total, day) => total + Number(day.views ?? 0), 0);
    await sleep(100);
  }
  return values;
}

function updateCreators(brief, pageviews) {
  const section = brief.sections.find((entry) => entry.id === "creators");
  if (!section) return;
  const currentByTitle = new Map(section.items.map((item) => [normalize(item.title), item]));
  if (!pageviews) return;
  const ranked = cultureMakers
    .filter((item) => Number.isFinite(pageviews[item.title]))
    .sort((left, right) => pageviews[right.title] - pageviews[left.title]);
  const selected = [];
  const categoryCounts = new Map();
  for (const person of ranked) {
    const count = categoryCounts.get(person.category) ?? 0;
    if (count >= 2) continue;
    selected.push(person);
    categoryCounts.set(person.category, count + 1);
    if (selected.length === 5) break;
  }
  const leaders = selected;
  if (leaders.length < 5) throw new Error("Fewer than five culture-makers had a direct popularity measure");
  const pageviewsUrl = pageviewsComparisonUrl(leaders);
  const trendsUrl = googleTrendsExploreUrl(leaders.map((person) => person.title), "today 1-m");
  section.eyebrow = "People · past 30 days";
  section.description = "People are ranked by 30-day English Wikipedia views, with no more than two actors, musicians, filmmakers, or digital creators in the five.";
  section.sources = [
    { label: "Wikipedia Pageviews · these five, 30 days", url: pageviewsUrl },
    { label: "Google Trends · these five, 30 days", url: trendsUrl },
  ];
  section.items = leaders.map((person, index) => {
    const current = currentByTitle.get(normalize(person.title));
    const url = `https://en.wikipedia.org/wiki/${person.article}`;
    return {
      rank: index + 1,
      title: person.title,
      subtitle: person.subtitle,
      description: person.description,
      image: current?.image ?? `/culture/creator-${slugify(person.title)}.webp`,
      alt: current?.alt ?? `Portrait of ${person.title}`,
      url,
      source: "Wikipedia",
      metric: { label: "Wikipedia views · 30 days", value: formatCompact(pageviews[person.title]) },
      evidence: [
        { source: "Google Trends", url: googleTrendsExploreUrl([person.title], "today 1-m") },
        { source: "Wikipedia Pageviews", url: pageviewsUrl },
      ],
      accent: accents[index],
      category: person.category,
    };
  });
}

function pageviewRange() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const stamp = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  return { start: stamp(start), end: stamp(end) };
}

function previousCompletedSunday(offset = 0) {
  const date = new Date();
  const daysSinceSunday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - daysSinceSunday - (offset * 7));
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

function isoWeekCode(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - day + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((target - firstThursday) / 604_800_000);
  return `${isoYear}W${String(week).padStart(2, "0")}`;
}

function weekendLabel(sunday) {
  const friday = new Date(sunday);
  friday.setUTCDate(friday.getUTCDate() - 2);
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(friday);
  return `${month} ${friday.getUTCDate()}–${sunday.getUTCDate()}, ${sunday.getUTCFullYear()}`;
}

function parseMoney(value) {
  const amount = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function formatMoney(value) {
  const units = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  const unit = units.find(([threshold]) => value >= threshold);
  if (!unit) return `$${Math.round(value)}`;
  const [threshold, suffix] = unit;
  const scaled = value / threshold;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `$${scaled.toFixed(digits).replace(/\.0+$/, "")}${suffix}`;
}

function parseWeekendRows(html) {
  const table = html.match(/<table[^>]*mojo-body-table[^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error("Box Office Mojo returned no weekend table");
  const rows = [];
  for (const match of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => plainText(cell[1]));
    const releasePath = match[1].match(/href="(\/release\/[^"?]+)[^\"]*"/i)?.[1];
    if (cells.length < 10 || !releasePath) continue;
    rows.push({
      weekendRank: Number(cells[0]),
      title: cells[2],
      weekendGross: parseMoney(cells[3]),
      totalGross: parseMoney(cells[8]),
      releaseUrl: `https://www.boxofficemojo.com${releasePath}`,
    });
  }
  if (rows.length < 10) throw new Error(`Box Office Mojo returned only ${rows.length} weekend titles`);
  return rows;
}

async function boxOfficeWeekend() {
  let lastError;
  for (let offset = 0; offset < 3; offset += 1) {
    const sunday = previousCompletedSunday(offset);
    const chartUrl = `https://www.boxofficemojo.com/weekend/${isoWeekCode(sunday)}/`;
    try {
      const rows = parseWeekendRows(await fetchText(chartUrl, { headers: { "user-agent": "Mozilla/5.0" } }))
        .slice(0, 10)
        .sort((left, right) => right.totalGross - left.totalGross)
        .slice(0, 5);
      const enriched = await Promise.all(rows.map(async (row) => {
        const html = await fetchText(row.releaseUrl, { headers: { "user-agent": "Mozilla/5.0" } });
        const imdbId = html.match(/\/title\/(tt[0-9]{7,9})/i)?.[1];
        if (!imdbId) throw new Error(`No IMDb title ID found for ${row.title}`);
        return { ...row, imdbUrl: `https://www.imdb.com/title/${imdbId}/` };
      }));
      return { chartUrl, imdbChartUrl: "https://www.imdb.com/chart/boxoffice/", label: weekendLabel(sunday), rows: enriched };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No completed box-office weekend was available");
}

function updateMovies(brief, chart) {
  const section = brief.sections.find((entry) => entry.id === "watch");
  if (!section) return;
  const currentByTitle = new Map(section.items.map((item) => [normalize(item.title), item]));
  section.eyebrow = `IMDb U.S. box office · ${chart.label}`;
  section.title = "Movies";
  section.description = "The five largest cumulative U.S. and Canada grosses among IMDb's current weekend box-office top 10, re-sorted by total gross rather than weekend earnings.";
  section.sources = [
    { label: "IMDb · box office top 10", url: chart.imdbChartUrl },
    { label: "Box Office Mojo · total gross", url: chart.chartUrl },
  ];
  section.items = chart.rows.map((row, index) => {
    const current = currentByTitle.get(normalize(row.title));
    const details = movieDetails.get(row.title);
    return {
      rank: index + 1,
      title: row.title,
      subtitle: details?.subtitle ?? current?.subtitle ?? "Movie · in theaters",
      description: details?.description ?? `${row.title} is one of the five largest cumulative grosses still appearing in IMDb's current weekend box-office top 10.`,
      image: details?.image ?? current?.image ?? `/culture/media-${slugify(row.title)}.webp`,
      alt: current?.alt ?? `${row.title} theatrical poster`,
      url: row.imdbUrl,
      source: "IMDb",
      metric: { label: "U.S. & Canada total gross", value: formatMoney(row.totalGross) },
      rating: details?.rating ?? current?.rating ?? "New",
      evidence: [
        { source: "IMDb box office chart", url: chart.imdbChartUrl },
        { source: "Box Office Mojo", url: row.releaseUrl },
      ],
      accent: accents[index],
    };
  });
}

function saturdayOnOrBefore(date) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 1) % 7));
  return result.toISOString().slice(0, 10);
}

async function billboardHot100() {
  let date = new Date();
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stamp = saturdayOnOrBefore(date);
    try {
      const payload = JSON.parse(await fetchText(`https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/date/${stamp}.json`));
      if (!Array.isArray(payload.data) || payload.data.length < 20) throw new Error("Billboard mirror returned an incomplete chart");
      return { date: payload.date ?? stamp, rows: payload.data };
    } catch (error) {
      lastError = error;
      date.setUTCDate(date.getUTCDate() - 7);
    }
  }
  throw lastError ?? new Error("No recent Billboard chart was available");
}

async function spotifyTop50() {
  const html = await fetchText("https://open.spotify.com/embed/playlist/37i9dQZEVXbMDoHDwVN2tF?theme=0", { headers: { "user-agent": "Mozilla/5.0" } });
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!raw) throw new Error("Spotify returned no embedded playlist data");
  const tracks = JSON.parse(raw).props?.pageProps?.state?.data?.entity?.trackList ?? [];
  if (tracks.length < 20) throw new Error("Spotify returned an incomplete Top 50 playlist");
  return tracks.map((track) => ({
    id: String(track.uri ?? "").split(":").at(-1),
    title: track.title,
    artist: plainText(track.subtitle ?? ""),
  }));
}

function updateSongs(brief, chart, spotifyTracks) {
  const section = brief.sections.find((entry) => entry.id === "songs");
  if (!section) return;
  const billboardByTitle = new Map(chart.rows.map((row) => [normalize(row.song), row]));
  const spotifySelected = spotifyTracks
    .map((track, index) => ({ track, spotifyRank: index + 1, row: billboardByTitle.get(normalize(track.title)) }))
    .filter((entry) => {
      if (!entry.row) return false;
      const spotifyArtists = new Set(normalize(entry.track.artist).split(" ").filter((token) => token.length >= 3));
      return normalize(entry.row.artist).split(" ").some((token) => token.length >= 3 && spotifyArtists.has(token));
    })
    .slice(0, 5);
  const crossovers = spotifySelected
    .sort((left, right) => Number(left.row.this_week) - Number(right.row.this_week));
  if (crossovers.length < 5) throw new Error("Fewer than five songs overlapped Billboard and Spotify");
  const currentById = new Map(section.items.map((item) => [item.spotifyId, item]));
  section.eyebrow = "Spotify Global × Billboard";
  section.description = "The first five Spotify Global Top 50 tracks that also appear on the Billboard Hot 100 are selected; Billboard position then orders only those five. Press play for Spotify's official embed.";
  section.sources = [
    { label: "Spotify · Global Top 50", url: "https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF" },
    { label: `Billboard Hot 100 · ${chart.date}`, url: `https://www.billboard.com/charts/hot-100/${chart.date}/` },
  ];
  section.items = crossovers.map(({ row, track, spotifyRank }, index) => {
    const current = currentById.get(track.id);
    return {
      rank: index + 1,
      title: track.title,
      subtitle: track.artist,
      description: `${track.title} is #${spotifyRank} in Spotify's current global playlist and #${row.this_week} on the current Billboard Hot 100.`,
      image: current?.image ?? `/culture/song-${slugify(`${track.title}-${track.artist}`)}.webp`,
      alt: current?.alt ?? `${track.title} artwork by ${track.artist}`,
      url: `https://open.spotify.com/track/${track.id}`,
      source: "Spotify",
      metric: { label: "Billboard Hot 100", value: `#${row.this_week}` },
      evidence: [
        { source: "Spotify", url: "https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF" },
        { source: "Billboard", url: `https://www.billboard.com/charts/hot-100/${chart.date}/` },
      ],
      accent: accents[index],
      spotifyId: track.id,
      spotifyRank,
    };
  });
}

function validateBrief(brief) {
  if (brief.sections.length !== 5) throw new Error("Brief must have five boards");
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
    section.items.forEach((item, index) => {
      if (item.rank !== index + 1) throw new Error(`${section.title} has non-sequential ranks`);
      if (!Array.isArray(item.evidence)
        || new Set(item.evidence.map((entry) => entry.source)).size < 2
        || new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size < 2) {
        throw new Error(`${item.title} lacks two distinct sources`);
      }
    });
  }
  const memes = brief.sections.find((section) => section.id === "memes");
  const memePollRanks = memes?.items.map((item) => Number(item.metric?.value?.slice(1))) ?? [];
  if (memePollRanks.some((rank) => !Number.isInteger(rank))
    || memePollRanks.some((rank, index) => index > 0 && rank <= memePollRanks[index - 1])) {
    throw new Error("Memes must preserve the published Meme of the Month order");
  }
  const creators = brief.sections.find((section) => section.id === "creators");
  const creatorCategoryCounts = new Map();
  for (const item of creators?.items ?? []) {
    const count = (creatorCategoryCounts.get(item.category) ?? 0) + 1;
    creatorCategoryCounts.set(item.category, count);
    if (!item.category || count > 2) throw new Error("No creator category may take more than two places");
    if (item.metric?.label !== "Wikipedia views · 30 days") {
      throw new Error("Creators must be ranked by Wikipedia views");
    }
    if (item.subtitle.includes("·")) {
      throw new Error(`${item.title} must have one primary creator role`);
    }
  }
  const slang = brief.sections.find((section) => section.id === "slang");
  for (const item of slang?.items ?? []) {
    if (item.metric?.label !== "Know Your Meme page views"
      || !/^\d{1,3}(?:,\d{3})*$/.test(item.metric.value)) {
      throw new Error(`${item.title} must show exact Know Your Meme page views`);
    }
  }
  const songs = brief.sections.find((section) => section.id === "songs");
  const billboardRanks = songs?.items.map((item) => Number(item.metric?.value?.slice(1))) ?? [];
  if (billboardRanks.some((rank) => !Number.isInteger(rank))
    || billboardRanks.some((rank, index) => index > 0 && rank < billboardRanks[index - 1])) {
    throw new Error("Songs must be ordered by Billboard Hot 100 position");
  }
  const serialized = JSON.stringify(brief);
  if (/tiktok/i.test(serialized)) throw new Error("The briefing must not contain TikTok data");
  if (/socialblade|socialcounts/i.test(serialized)) throw new Error("The briefing must not contain platform-growth ranking data");
  if (/"(?:signal|score)":/.test(serialized)) throw new Error("The briefing must not contain opaque score fields");
  if (/"caution":|b\*{2,}|a\*{2,}/i.test(serialized)) throw new Error("The briefing must not add profanity warnings or censorship");
}

const brief = JSON.parse(await readFile(dataPath, "utf8"));
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

const slang = brief.sections.find((section) => section.id === "slang")?.items ?? [];
const sourceResults = await Promise.all([
  safely("Know Your Meme result", latestMemeResult),
  safely("Lessons in Meme Culture", lessonsInMemeCultureRecent),
  safely("Know Your Meme annual slang review", () => fetchText("https://trending.knowyourmeme.com/editorials/meme-review/kym-review-the-top-slang-terms-of-2025")),
  safely("Know Your Meme slang pageviews", () => knowYourMemeSlangPageviews(slang)),
  safely("Urban Dictionary", () => verifyUrbanDictionary(slang)),
  safely("Google Trends slang", () => googleTrendsSlang(slang)),
  safely("Google Trends creators", () => googleTrendsCreators(cultureMakers)),
  safely("Wikipedia creator pageviews", () => wikipediaCreatorPageviews(cultureMakers)),
  safely("IMDb / Box Office Mojo", boxOfficeWeekend),
  safely("Billboard Hot 100", billboardHot100),
  safely("Spotify Top 50 Global", spotifyTop50),
]);
const byName = Object.fromEntries(sourceResults.map((result) => [result.name, result]));

if (byName["Know Your Meme result"].ok && byName["Lessons in Meme Culture"].ok) {
  await updateMemes(brief, byName["Know Your Meme result"].value, byName["Lessons in Meme Culture"].value);
}
updateSlang(brief, byName["Google Trends slang"].value, byName["Know Your Meme slang pageviews"].value);
updateCreators(brief, byName["Wikipedia creator pageviews"].value);
if (byName["IMDb / Box Office Mojo"].ok) updateMovies(brief, byName["IMDb / Box Office Mojo"].value);
if (byName["Billboard Hot 100"].ok && byName["Spotify Top 50 Global"].ok) {
  updateSongs(brief, byName["Billboard Hot 100"].value, byName["Spotify Top 50 Global"].value);
}
for (const item of brief.sections.flatMap((section) => section.items)) delete item.caution;
delete brief.pulse;

const successfulSources = sourceResults.filter((result) => result.ok).length;
brief.sourceHealth = sourceResults.map(({ name, ok, checkedAt, error }) => ({ name, ok, checkedAt, ...(error ? { error } : {}) }));
if (successfulSources >= 6) {
  brief.generatedAt = now.toISOString();
  brief.edition = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(now);
  brief.status = "Checked today";
  brief.window = "Memes: latest complete month · other boards: rolling";
}
validateBrief(brief);

const output = `${JSON.stringify(brief, null, 2)}\n`;
if (dryRun) {
  console.log("Dry run; no files changed.");
  for (const section of brief.sections) {
    console.log(`${section.id}: ${section.items.map((item) => `${item.rank}. ${item.title}${item.metric ? ` (${item.metric.value})` : ""}`).join(" | ")}`);
  }
} else {
  const temporaryPath = `${dataPath}.next`;
  await writeFile(temporaryPath, output, { mode: 0o644 });
  await rename(temporaryPath, dataPath);
}

for (const result of sourceResults) console.log(`${result.ok ? "ok" : "failed"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
if (successfulSources < 6) {
  console.error("Fewer than six source checks succeeded; the last-known-good timestamp was preserved.");
  process.exitCode = 1;
}
