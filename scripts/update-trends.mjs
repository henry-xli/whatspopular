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
  "www.imdb.com",
  "www.boxofficemojo.com",
  "www.youtube.com",
]);

const cultureMakers = [
  { title: "Christopher Nolan", article: "Christopher_Nolan", subtitle: "Film director · producer", description: "The filmmaker behind The Odyssey is included in the same comparison field as musicians and digital-native creators." },
  { title: "Zendaya", article: "Zendaya", subtitle: "Actor · producer", description: "A major presence in Spider-Man: Brand New Day and The Odyssey keeps Zendaya central to current screen culture." },
  { title: "Shakira", article: "Shakira", subtitle: "Musician · performer", description: "A global chart presence and major live appearances keep Shakira in the wider culture conversation." },
  { title: "Ariana Grande", article: "Ariana_Grande", subtitle: "Musician · actor", description: "Multiple current chart entries make Ariana Grande one of the most visible music figures in this comparison." },
  { title: "Ella Langley", article: "Ella_Langley", subtitle: "Singer-songwriter", description: "A high Hot 100 position and global streaming crossover have sharply raised attention around Ella Langley." },
  { title: "IShowSpeed", article: "IShowSpeed", subtitle: "Streamer · entertainer", description: "IShowSpeed represents established digital-native creators without limiting the board to short-form channels." },
  { title: "Taylor Swift", article: "Taylor_Swift", subtitle: "Singer-songwriter", description: "Taylor Swift remains in the broad comparison field so enduring attention is measured alongside newer spikes." },
  { title: "Justin Bieber", article: "Justin_Bieber", subtitle: "Musician", description: "Renewed streaming interest keeps Justin Bieber in the current cross-platform comparison." },
  { title: "Olivia Rodrigo", article: "Olivia_Rodrigo", subtitle: "Singer-songwriter · actor", description: "Current releases put Olivia Rodrigo back near the center of music and fan conversation." },
  { title: "Olivia Dean", article: "Olivia_Dean", subtitle: "Singer-songwriter", description: "A global Spotify and Billboard crossover gives Olivia Dean a measurable current-interest signal." },
  { title: "MrBeast", article: "MrBeast", subtitle: "Digital creator · entrepreneur", description: "MrBeast remains a useful established-digital benchmark in a field that also includes filmmakers and musicians." },
  { title: "Bruno Mars", article: "Bruno_Mars", subtitle: "Musician · producer", description: "Sustained streaming and chart activity keep Bruno Mars in the broad culture-maker comparison." },
  { title: "Morgan Wallen", article: "Morgan_Wallen", subtitle: "Singer-songwriter", description: "Several charting songs keep Morgan Wallen in the current music conversation." },
  { title: "Bad Bunny", article: "Bad_Bunny", subtitle: "Musician · actor", description: "Bad Bunny supplies another global, cross-language benchmark for current popular attention." },
  { title: "Tom Holland", article: "Tom_Holland", subtitle: "Actor · producer", description: "Two major current theatrical releases make Tom Holland a relevant screen-culture candidate." },
  { title: "Matt Damon", article: "Matt_Damon", subtitle: "Actor · producer", description: "Leading The Odyssey places Matt Damon in the current film-driven culture conversation." },
  { title: "Dwayne Johnson", article: "Dwayne_Johnson", subtitle: "Actor · producer", description: "Moana keeps Dwayne Johnson visible across film, music, and mainstream internet discussion." },
  { title: "James Gunn", article: "James_Gunn", subtitle: "Film director · producer", description: "James Gunn provides another filmmaker benchmark for attention that is not tied to a social platform." },
  { title: "Greta Gerwig", article: "Greta_Gerwig", subtitle: "Film director · writer", description: "Greta Gerwig keeps the comparison field broad enough to include major filmmakers, not just performers." },
  { title: "Pierre Coffin", article: "Pierre_Coffin", subtitle: "Film director · animator", description: "The director and voice performer behind Minions & Monsters is included alongside other current filmmakers." },
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

async function lessonsInMemeCultureTop20() {
  const html = await fetchText("https://www.youtube.com/@LIMC/videos", { headers: { "user-agent": "Mozilla/5.0" } });
  const initialRaw = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1]
    ?? html.match(/window\["ytInitialData"\] = (\{.*?\});/s)?.[1];
  if (!initialRaw) throw new Error("YouTube did not expose its initial video data");
  const initial = JSON.parse(initialRaw);
  const videos = collectLockups(initial);
  let token = "";
  const findToken = (value) => {
    if (!value || typeof value !== "object") return;
    const candidate = value.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (candidate?.length > token.length) token = candidate;
    for (const child of Object.values(value)) findToken(child);
  };
  findToken(initial);
  const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
  if (token && key && version) {
    const continuation = JSON.parse(await fetchText(`https://www.youtube.com/youtubei/v1/browse?key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: version } }, continuation: token }),
    }));
    videos.push(...collectLockups(continuation));
  }
  const recent = videos.filter((video) => !/(?:3|4|5|6|7|8|9|10|11|12) months? ago/i.test(video.age));
  return [...new Map(recent.map((video) => [video.id, video])).values()]
    .sort((a, b) => b.views - a.views)
    .slice(0, 20);
}

function memeVideoMatch(candidate, videos) {
  const stop = new Set(["meme", "memes", "laugh", "laughing", "yourrage", "the", "this", "that", "with", "world", "month", "still", "from", "gets", "just"]);
  const tokens = normalize(candidate.title).split(" ").filter((token) => token.length >= 3 && !stop.has(token));
  return videos.find((video) => {
    const title = normalize(video.title);
    const shared = tokens.filter((token) => title.includes(token));
    return shared.length >= 2 || shared.some((token) => token.length >= 6) || (tokens.length === 1 && shared.length === 1);
  });
}

function relatedTitles(left, right) {
  const stop = new Set(["the", "and", "are", "still", "this", "that", "with", "from", "into", "kinda", "meme", "memes"]);
  const leftTokens = new Set(normalize(left).split(" ").filter((token) => token.length >= 3 && !stop.has(token)));
  const rightTokens = normalize(right).split(" ").filter((token) => token.length >= 3 && !stop.has(token));
  const shared = rightTokens.filter((token) => leftTokens.has(token));
  return shared.length >= 2 || shared.some((token) => token.length >= 7);
}

async function knowYourMemeSearch(video) {
  const searchStop = new Set(["the", "and", "this", "that", "with", "from", "still", "into", "kinda", "just", "video", "meme", "memes", "are", "is", "was", "were", "works", "art", "passed", "away", "ruined", "algorithm", "show", "years", "late", "might", "lose", "company", "fever", "dream", "situation", "insane", "when", "youre", "minutes", "work", "incredible"]);
  const query = normalize(video.title).split(" ").filter((token) => token.length >= 3 && !searchStop.has(token)).slice(0, 6).join(" ");
  const html = await fetchText(`https://knowyourmeme.com/search?q=${encodeURIComponent(query || video.title)}`);
  const galleryIndex = html.indexOf('<section class="gallery"');
  if (galleryIndex < 0) return null;
  const gallery = html.slice(galleryIndex);
  const match = gallery.match(/<a class="item"[^>]*data-title=(['"])(.*?)\1[^>]*href=(['"])(\/memes\/[^'"?#]+)\3/i);
  if (!match) return null;
  const title = plainText(match[2]);
  if (dryRun) console.log(`KYM search: ${video.title} → ${title}`);
  if (!relatedTitles(video.title, title)) return null;
  return { title, url: `https://knowyourmeme.com${match[4]}` };
}

async function updateMemes(brief, result, videos) {
  const section = brief.sections.find((entry) => entry.id === "memes");
  if (!section) return;
  if (dryRun) console.log(`LIMC top 20: ${videos.map((video) => video.title).join(" | ")}`);
  const currentByUrl = new Map(section.items.map((item) => [item.url, item]));
  const pollMatches = result.candidates
    .map((candidate) => ({ candidate, video: memeVideoMatch(candidate, videos), fromPoll: true }))
    .filter((entry) => entry.video);
  if (dryRun) console.log(`Poll matches: ${pollMatches.map((entry) => `${entry.candidate.title} ↔ ${entry.video.title}`).join(" | ")}`);
  const usedVideos = new Set(pollMatches.map((entry) => entry.video.id));
  const fillers = [];
  for (const video of videos) {
    if (pollMatches.length + fillers.length >= 5) break;
    if (usedVideos.has(video.id)) continue;
    const candidate = await knowYourMemeSearch(video);
    if (!candidate || pollMatches.some((entry) => entry.candidate.url === candidate.url) || fillers.some((entry) => entry.candidate.url === candidate.url)) continue;
    fillers.push({ candidate, video, fromPoll: false });
    usedVideos.add(video.id);
  }
  const ordered = [...pollMatches, ...fillers].slice(0, 5);
  if (dryRun) console.log(`Meme cross-check: ${ordered.map((entry) => `${entry.candidate.title} ↔ ${entry.video.title}`).join(" | ")}`);
  if (ordered.length < 5) throw new Error(`Only ${ordered.length} memes cleared both Know Your Meme and LIMC's recent top 20`);

  section.eyebrow = `${result.label} · latest complete month`;
  section.description = `Starts with ${result.month} poll entries that also made Lessons in Meme Culture's 20 most-viewed videos posted in the past two months. If that overlap is short of five, remaining spots are recent LIMC top-20 subjects with a matching Know Your Meme entry. The poll winner is not exempt from the cross-check.`;
  section.sources = [`Know Your Meme · ${result.month} result`, "Lessons in Meme Culture · recent top 20"];
  section.items = ordered.map(({ candidate, video, fromPoll }, index) => {
    const current = currentByUrl.get(candidate.url);
    const title = current?.title ?? candidate.title;
    return {
      rank: index + 1,
      title,
      subtitle: current?.subtitle ?? (fromPoll ? `${result.month} poll × recent LIMC top 20` : "KYM entry × recent LIMC top 20"),
      description: current?.description ?? `${title} ${fromPoll ? `placed in Know Your Meme's ${result.month} community poll and ` : "has a Know Your Meme entry and "}reached Lessons in Meme Culture's 20 most-viewed uploads from the past two months.`,
      image: current?.image ?? `/culture/meme-${slugify(title)}.webp`,
      alt: current?.alt ?? `Visual example of the ${title} meme`,
      url: candidate.url,
      source: "Know Your Meme",
      metric: { label: "LIMC views · past 2 months", value: formatCompact(video.views) },
      evidence: [
        { source: fromPoll ? `Know Your Meme ${result.month} result` : "Know Your Meme", url: fromPoll ? result.resultUrl : candidate.url },
        { source: "Lessons in Meme Culture", url: `https://www.youtube.com/watch?v=${video.id}` },
      ],
      accent: current?.accent ?? accents[index],
      ...(current?.caution ? { caution: current.caution } : {}),
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

function updateSlang(brief, interest) {
  if (!interest) return;
  const section = brief.sections.find((entry) => entry.id === "slang");
  if (!section) return;
  section.items.sort((a, b) => (interest[b.title] ?? -1) - (interest[a.title] ?? -1));
  section.items.forEach((item, index) => { item.rank = index + 1; item.accent = accents[index]; });
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

function updateCreators(brief, trendInterest, pageviews) {
  const section = brief.sections.find((entry) => entry.id === "creators");
  if (!section) return;
  const currentByTitle = new Map(section.items.map((item) => [normalize(item.title), item]));
  const ranking = trendInterest ?? pageviews;
  if (!ranking) return;
  const usesTrends = Boolean(trendInterest);
  const leaders = cultureMakers
    .filter((item) => Number.isFinite(ranking[item.title]))
    .sort((left, right) => ranking[right.title] - ranking[left.title])
    .slice(0, 5);
  if (leaders.length < 5) throw new Error("Fewer than five culture-makers had a direct popularity measure");
  section.eyebrow = "People · past 30 days";
  section.description = usesTrends
    ? "Directors, musicians, actors, streamers, and other culture-makers are compared in Google Trends over 30 days. The displayed 0–100 interest index is normalized only within this broad candidate field."
    : "Directors, musicians, actors, streamers, and other culture-makers are checked in Google Trends. When its automated comparison is rate-limited, this edition ranks the same broad field by transparent 30-day English Wikipedia views.";
  section.sources = ["Google Trends · 30 days", "Wikipedia · 30-day views"];
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
      metric: usesTrends
        ? { label: "Google Trends interest · 30 days", value: `${ranking[person.title]}/100` }
        : { label: "Wikipedia views · 30 days", value: formatCompact(ranking[person.title]) },
      evidence: [
        { source: "Google Trends", url: `https://trends.google.com/trends/explore?date=today%201-m&geo=US&q=${encodeURIComponent(person.title)}` },
        { source: "Wikipedia", url },
      ],
      accent: accents[index],
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
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
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
  section.sources = ["IMDb · box office top 10", "Box Office Mojo · total gross"];
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
  const crossovers = spotifyTracks
    .map((track, index) => ({ track, spotifyRank: index + 1, row: billboardByTitle.get(normalize(track.title)) }))
    .filter((entry) => {
      if (!entry.row) return false;
      const spotifyArtists = new Set(normalize(entry.track.artist).split(" ").filter((token) => token.length >= 3));
      return normalize(entry.row.artist).split(" ").some((token) => token.length >= 3 && spotifyArtists.has(token));
    })
    .slice(0, 5);
  if (crossovers.length < 5) throw new Error("Fewer than five songs overlapped Billboard and Spotify");
  const currentById = new Map(section.items.map((item) => [item.spotifyId, item]));
  section.eyebrow = "Spotify Global × Billboard";
  section.description = "The highest songs in Spotify's current Top 50 Global that also appear on the Billboard Hot 100. Spotify order decides the rank; Billboard is the required second check. Press play for Spotify's official embed.";
  section.sources = ["Spotify Top 50 · Global", "Billboard Hot 100"];
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
      metric: { label: "Spotify Top 50 · Global", value: `#${spotifyRank}` },
      evidence: [
        { source: "Spotify", url: "https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF" },
        { source: "Billboard", url: `https://www.billboard.com/charts/hot-100/${chart.date}/` },
      ],
      accent: accents[index],
      spotifyId: track.id,
    };
  });
}

function updatePulse(brief) {
  const definitions = [
    ["memes", "Cross-verified meme"],
    ["slang", "Yearly slang"],
    ["creators", "30-day culture-maker"],
    ["songs", "Spotify crossover"],
  ];
  brief.pulse = definitions.map(([sectionId, label]) => {
    const item = brief.sections.find((section) => section.id === sectionId)?.items[0];
    if (!item) throw new Error(`Missing pulse source board: ${sectionId}`);
    return { label, value: item.title, image: item.image, url: item.url };
  });
}

function validateBrief(brief) {
  if (brief.sections.length !== 5) throw new Error("Brief must have five boards");
  for (const section of brief.sections) {
    if (section.items.length !== 5) throw new Error(`${section.title} must have five entries`);
    section.items.forEach((item, index) => {
      if (item.rank !== index + 1) throw new Error(`${section.title} has non-sequential ranks`);
      if (!Array.isArray(item.evidence)
        || new Set(item.evidence.map((entry) => entry.source)).size < 2
        || new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size < 2) {
        throw new Error(`${item.title} lacks two distinct sources`);
      }
    });
  }
  const serialized = JSON.stringify(brief);
  if (/tiktok/i.test(serialized)) throw new Error("The briefing must not contain TikTok data");
  if (/socialblade|socialcounts/i.test(serialized)) throw new Error("The briefing must not contain platform-growth ranking data");
  if (/"(?:signal|score)":/.test(serialized)) throw new Error("The briefing must not contain opaque score fields");
}

const brief = JSON.parse(await readFile(dataPath, "utf8"));
const now = new Date();
if (!force && !dryRun && brief.generatedAt.slice(0, 10) === now.toISOString().slice(0, 10)) {
  console.log(`Already refreshed on ${now.toISOString().slice(0, 10)}; use --force to run again.`);
  process.exit(0);
}

const slang = brief.sections.find((section) => section.id === "slang")?.items ?? [];
const sourceResults = await Promise.all([
  safely("Know Your Meme result", latestMemeResult),
  safely("Lessons in Meme Culture", lessonsInMemeCultureTop20),
  safely("Know Your Meme annual slang review", () => fetchText("https://trending.knowyourmeme.com/editorials/meme-review/kym-review-the-top-slang-terms-of-2025")),
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
updateSlang(brief, byName["Google Trends slang"].value);
updateCreators(brief, byName["Google Trends creators"].value, byName["Wikipedia creator pageviews"].value);
if (byName["IMDb / Box Office Mojo"].ok) updateMovies(brief, byName["IMDb / Box Office Mojo"].value);
if (byName["Billboard Hot 100"].ok && byName["Spotify Top 50 Global"].ok) {
  updateSongs(brief, byName["Billboard Hot 100"].value, byName["Spotify Top 50 Global"].value);
}
updatePulse(brief);

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
