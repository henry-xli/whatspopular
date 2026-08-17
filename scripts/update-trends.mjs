import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { withHeadlessPage } from "./lib/headless-browser.mjs";
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
  "v3-cinemeta.strem.io",
  "trending.knowyourmeme.com",
  "trends.google.com",
  "wikimedia.org",
  "pageviews.wmcloud.org",
  "www.amazon.com",
  "www.billboard.com",
  "www.imdb.com",
  "www.googleapis.com",
  "www.wikidata.org",
  "www.youtube.com",
]);

const annualSlangReviewUrl = "https://trending.knowyourmeme.com/editorials/meme-review/kym-review-the-top-slang-terms-of-2025";
const annualSlangCandidates = [
  {
    title: "67 / six-seven",
    subtitle: "A deliberately ambiguous number catchphrase",
    description: "A call-and-response built around saying “six-seven,” often with a palms-up gesture. Its lack of one fixed meaning is the joke, so people use it as a deliberately contextless reply.",
    url: "https://knowyourmeme.com/memes/67-meme",
    urbanTerm: "67",
  },
  {
    title: "Clanker",
    subtitle: "A derogatory word for robots",
    description: "A Star Wars insult for battle droids that returned as a joking slur for robots and AI. People use it to mock a machine, chatbot, or conspicuously automated behavior.",
    url: "https://knowyourmeme.com/memes/clanker",
    urbanTerm: "clanker",
  },
  {
    title: "Chopped",
    subtitle: "Unattractive, damaged, or badly done",
    description: "Calling someone or something “chopped” means it looks unattractive, damaged, or badly put together. It appears in blunt reactions, appearance jokes, and before-and-after comparisons.",
    url: "https://knowyourmeme.com/memes/chopped-slang",
    urbanTerm: "Chopped",
  },
  {
    title: "Aura farming",
    subtitle: "Performing effortless cool for status",
    description: "Aura farming means doing something calculated to look effortlessly cool and build imaginary social status. The phrase captions dramatic entrances, poses, edits, and knowingly over-styled behavior.",
    url: "https://knowyourmeme.com/memes/aura-farming",
    urbanTerm: "aurafarming",
  },
  {
    title: "SYBAU",
    subtitle: "An aggressive request to be quiet",
    description: "SYBAU expands to “shut your bitch ass up.” It is used as a blunt dismissal or exaggerated reaction, often as an acronym so the punchline lands only after someone decodes it.",
    url: "https://knowyourmeme.com/memes/sybau",
    urbanTerm: "sybau",
  },
  {
    title: "TS PMO ICL",
    subtitle: "An intentionally overloaded slang acronym",
    description: "TS PMO ICL expands to “this shit pisses me off, I can’t lie.” People use it sincerely, or pile it into deliberately overloaded captions that parody compressed internet slang.",
    url: "https://knowyourmeme.com/memes/ts-pmo-icl",
    urbanTerm: "TS PMO ICL",
  },
  {
    title: "Performative Male",
    subtitle: "Someone visibly curating an appealing persona",
    description: "A performative male conspicuously reads feminist books, drinks matcha, carries a tote bag, or wears wired earbuds to appear sensitive and attractive. The label mocks an obviously curated personality.",
    url: "https://knowyourmeme.com/memes/performative-male",
    urbanTerm: "Performative Male",
  },
  {
    title: "Dead Rose Emoji",
    subtitle: "The wilted rose used as ironic punctuation",
    description: "The wilted rose emoji 🥀 became an ironic alternative to the broken-heart emoji. People append it to dramatic, embarrassing, disappointed, or mock-heartbroken remarks.",
    url: "https://knowyourmeme.com/memes/dead-rose-emoji",
    urbanTerm: "dead rose",
  },
  {
    title: "Labubu Matcha Dubai Chocolate",
    subtitle: "A pileup of 2025 consumer-trend buzzwords",
    description: "Labubu is a toothy collectible toy, matcha is a powdered green-tea drink, and Dubai chocolate is a pistachio-filled chocolate bar. Stringing them together parodies algorithm-driven consumer trends.",
    url: "https://knowyourmeme.com/memes/labubu-matcha-dubai-chocolate",
    urbanTerm: "labubu",
  },
];

const limcChannelId = "UCaHT88aobpcvRFEuy4v5Clg";
const spotifyPlaylistId = "37i9dQZF1DXcBWIGoYBM5M";
const shoppingTrendsUrl = "https://trends.google.com/trends/explore?date=now%207-d&gprop=froogle&geo=US";
const newsTrendsUrl = "https://trends.google.com/trending?geo=US&hours=168&sort=search-volume";

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

async function verifyUrbanDictionary(items) {
  const results = await mapConcurrent(items, 4, async (item) => {
    const payload = JSON.parse(await fetchText(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(item.urbanTerm ?? item.title)}`));
    return Array.isArray(payload.list) && payload.list.length > 0;
  });
  if (!results.every(Boolean)) throw new Error("At least one slang term had no Urban Dictionary result");
  return results.length;
}

async function knowYourMemeSlangPageviews(items) {
  const pairs = await mapConcurrent(items, 4, async (item) => {
    const html = await fetchText(item.url);
    const raw = html.match(/<dd\s+class=['"]views['"]\s+title=['"]([0-9,]+)\s+Views['"]/i)?.[1];
    if (!raw) throw new Error(`Know Your Meme exposed no page-view count for ${item.title}`);
    return [item.title, Number(raw.replaceAll(",", ""))];
  });
  return Object.fromEntries(pairs);
}

function updateSlang(brief, pageviews) {
  const section = brief.sections.find((entry) => entry.id === "slang");
  if (!section) return;
  if (!pageviews) return;
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const ranked = annualSlangCandidates
    .filter((item) => Number.isFinite(pageviews[item.title]))
    .sort((left, right) => pageviews[right.title] - pageviews[left.title]);
  if (ranked.length !== annualSlangCandidates.length) {
    throw new Error("At least one annual slang term had no Know Your Meme page-view count");
  }
  const allItems = ranked.map((candidate, index) => {
    const current = currentByTitle.get(normalize(candidate.title));
    return {
      rank: index + 1,
      title: candidate.title,
      subtitle: candidate.subtitle,
      description: candidate.description,
      image: current?.image ?? `/culture/slang-${slugify(candidate.title)}.webp`,
      alt: current?.alt ?? `Visual example of ${candidate.title}`,
      url: candidate.url,
      source: "Know Your Meme",
      metric: { label: "Know Your Meme page views", value: formatInteger(pageviews[candidate.title]) },
      evidence: [
        { source: "Know Your Meme entry", url: candidate.url },
        { source: "Urban Dictionary", url: `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(candidate.urbanTerm)}` },
      ],
      accent: accents[index % accents.length],
    };
  });
  section.eyebrow = "Annual slang review · by page views";
  section.description = "Terms from Know Your Meme's annual slang review, ranked from most to least lifetime views on their Know Your Meme entries and checked against Urban Dictionary.";
  section.sources = [
    {
      label: "Know Your Meme · annual slang review",
      url: annualSlangReviewUrl,
    },
    {
      label: `Urban Dictionary · ${ranked[0].title}`,
      url: `https://www.urbandictionary.com/define.php?term=${encodeURIComponent(ranked[0].urbanTerm)}`,
    },
  ];
  section.items = allItems.slice(0, 5);
  section.moreItems = allItems.slice(5);
  section.moreLabel = `Show ranks 6–${allItems.length} by page views`;
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

function conciseSentences(value, maxLength = 320) {
  const clean = plainText(value ?? "");
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?][\"'’”)]?/g) ?? [ensureSentence(clean)];
  let result = "";
  for (const sentence of sentences) {
    const candidate = `${result} ${sentence.trim()}`.trim();
    if (candidate.length > maxLength && result) break;
    if (candidate.length > maxLength) {
      const clipped = candidate.slice(0, maxLength + 1).replace(/\s+\S*$/, "").replace(/[,:;\s]+$/, "");
      return ensureSentence(clipped);
    }
    result = candidate;
  }
  return ensureSentence(result || clean);
}

const copiedMetricPattern = /\b(?:billboard hot 100|google shopping|google searches?|search volume|spotify(?:'|’)?s today(?:'|’)?s top hits|wikipedia (?:article )?(?:drew|views?))\b|\branking it #\d+|\bplacing it #\d+/i;
const editorialHeadlinePattern = /\b(?:babygirl|best|favorite|hot take|machine|must-see|opinion|review|should you|story behind|thank zeus|trojan horse|what to know|worst|worth buying)\b|\bonly .{0,50} could\b|\bgets? .{0,30} treatment\b/i;

function factualHeadline(value, { rejectChartPlacement = false } = {}) {
  let clean = plainText(value ?? "")
    .replace(/^(?:exclusive|opinion|review)\s*[|:]\s*/i, "")
    .replace(/\s+-\s+The Athletic$/i, "")
    .trim();
  if (!clean || clean.length < 24 || clean.length > 240 || copiedMetricPattern.test(clean)
    || editorialHeadlinePattern.test(clean) || /\?/.test(clean)) return "";
  if (rejectChartPlacement && /\b(?:billboard|charts?|no\.?\s*\d+|number one|#\d+)\b/i.test(clean)) return "";
  clean = clean
    .replace(/\s+draws outrage and fears of misuse$/i, " has prompted scrutiny over potential misuse")
    .replace(/\s+stormed the charts in parallel$/i, " released music at the same time")
    .trim();
  return conciseSentences(clean, 240);
}

function reusableDescription(item) {
  const description = item?.description?.trim() ?? "";
  return description && !copiedMetricPattern.test(description) && !editorialHeadlinePattern.test(description)
    ? description
    : "";
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

function recentDescription(identity, headline, existing, options = {}) {
  const { preferExisting = false, ...headlineOptions } = options;
  const previous = reusableDescription(existing);
  if (preferExisting && previous) return previous;
  const context = factualHeadline(headline, headlineOptions);
  if (context) return `${identity} ${context}`;
  return previous || identity;
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

async function googleNewsContext(query, days = 45) {
  const key = `${normalize(query)}:${days}`;
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
        overlap,
        score,
      };
    }).filter((item) => item.headline && item.overlap >= Math.min(2, Math.max(1, queryTokens.size)));
    return items.sort((left, right) => right.score - left.score)[0] ?? null;
  })();
  googleNewsCache.set(key, request);
  return request;
}

async function wikipediaRepresentativeImage(query) {
  const imageQuery = query.replace(/\bGTA\s*6\b/i, "Grand Theft Auto VI");
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: imageQuery,
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
  const queryTokens = new Set(normalize(imageQuery).split(" ")
    .filter((token) => token.length >= 3 || /\d/.test(token))
    .filter((token) => !new Set(["august", "been", "have", "lawsuit", "presentation", "recall"]).has(token)));
  const wikipedia = JSON.parse(await fetchText(searchUrl));
  const pages = Object.values(wikipedia.query?.pages ?? {}).filter((page) => page.thumbnail?.source);
  const pageScores = (page) => {
    const titleTokens = new Set(normalize(page.title ?? "").split(" "));
    const extractTokens = new Set(normalize(page.extract ?? "").split(" "));
    const titleOverlap = [...queryTokens].filter((token) => titleTokens.has(token)).length;
    const score = [...queryTokens].reduce((total, token) => total
      + (titleTokens.has(token) ? 12 : 0) + (extractTokens.has(token) ? 1 : 0), 0);
    return { titleOverlap, score };
  };
  const page = pages.sort((left, right) => pageScores(right).score - pageScores(left).score)[0];
  const requiredTitleOverlap = Math.min(2, Math.max(1, queryTokens.size));
  if (page && pageScores(page).titleOverlap >= requiredTitleOverlap) {
    return { imageSource: page.thumbnail.source, pageUrl: page.fullurl, title: page.title };
  }

  const sequelBase = imageQuery.match(/^(.+?)\s+\d+$/)?.[1];
  if (sequelBase) return wikipediaRepresentativeImage(`${sequelBase} franchise`);

  if (![...queryTokens].some((token) => /^(?:court|egg|hurricane|storm)$/.test(token))) return null;

  const commonsUrl = new URL("https://commons.wikimedia.org/w/api.php");
  commonsUrl.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: imageQuery,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|mime",
    iiurlwidth: "1200",
    format: "json",
    origin: "*",
  });
  const commons = JSON.parse(await fetchText(commonsUrl));
  const files = Object.values(commons.query?.pages ?? {}).map((entry) => ({
    ...entry,
    info: entry.imageinfo?.[0],
  })).filter((entry) => entry.info?.thumburl && /^image\/(?:jpeg|png|webp)$/i.test(entry.info.mime ?? ""));
  const scoredFiles = files.map((entry) => {
    const titleTokens = new Set(normalize(entry.title ?? "").split(" "));
    const overlap = [...queryTokens].filter((token) => titleTokens.has(token)).length;
    const genericPenalty = /\b(?:coat of arms|diagram|flag|icon|logo|map|seal)\b/i.test(entry.title ?? "") ? 5 : 0;
    return { entry, score: overlap * 10 - genericPenalty };
  }).sort((left, right) => right.score - left.score);
  return scoredFiles[0]?.score >= requiredTitleOverlap * 10
    ? { imageSource: scoredFiles[0].entry.info.thumburl, pageUrl: scoredFiles[0].entry.info.descriptionurl, title: scoredFiles[0].entry.title }
    : null;
}

async function wikipediaTopicSummary(query) {
  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "6",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    inprop: "url",
    format: "json",
    origin: "*",
  });
  const tokens = new Set(normalize(query).split(" ").filter((token) => token.length >= 3 || /\d/.test(token)));
  const wikipedia = JSON.parse(await fetchText(searchUrl));
  const pages = Object.values(wikipedia.query?.pages ?? {}).filter((page) => page.extract && page.fullurl);
  const scored = pages.map((page) => {
    const titleTokens = new Set(normalize(page.title ?? "").split(" "));
    const extractTokens = new Set(normalize(page.extract ?? "").split(" "));
    const titleOverlap = [...tokens].filter((token) => titleTokens.has(token)).length;
    const score = [...tokens].reduce((total, token) => total
      + (titleTokens.has(token) ? 12 : 0) + (extractTokens.has(token) ? 1 : 0), 0);
    return { page, titleOverlap, score };
  }).sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.titleOverlap < Math.min(2, Math.max(1, tokens.size))) return null;
  return {
    title: best.page.title,
    extract: conciseSentences(best.page.extract, 220),
    pageUrl: best.page.fullurl,
  };
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
    googleNewsContext(`"${person.title}"`, 45).catch(() => null));
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
      description: recentDescription(identity, context?.headline, current, {
        preferExisting: current?.evidence?.some((entry) => entry.url === context?.link),
      }),
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
    const [context, details] = await Promise.all([
      googleNewsContext(`"${track.title}" "${track.artist}"`, 30).catch(() => null),
      spotifyTrackDetails(track.id),
    ]);
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
      description: recentDescription(identity, context?.headline, current, {
        preferExisting: current?.evidence?.some((entry) => entry.url === context?.link),
        rejectChartPlacement: true,
      }),
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

function parseShoppingRow(value) {
  const match = String(value).replace(/\s+/g, " ").trim().match(/^(\d+)\s+(.+?)\s+(Breakout|\+[\d,]+%)$/i);
  if (!match) return null;
  return { rank: Number(match[1]), query: match[2].trim(), growth: match[3] };
}

async function googleShoppingRising() {
  if (process.env.PRODUCT_TRENDS_SNAPSHOT) {
    const rows = JSON.parse(process.env.PRODUCT_TRENDS_SNAPSHOT);
    if (!Array.isArray(rows) || rows.length < 5) throw new Error("PRODUCT_TRENDS_SNAPSHOT is invalid");
    return rows.map((row) => ({ rank: Number(row.rank), query: String(row.query), growth: String(row.growth) }));
  }
  return withHeadlessPage({
    allowedHosts: new Set(["trends.google.com"]),
    work: async (page) => {
      await page.navigate(shoppingTrendsUrl, 5_000);
      const firstText = await page.evaluate("document.body.innerText.slice(0, 180)");
      if (/429|too many requests/i.test(firstText)) throw new Error("Google Shopping Trends rate-limited the daily browser");
      const rows = [];
      for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
        const values = await page.evaluate(`Array.from(document.querySelectorAll('a[href*="/trends/explore?q="]')).map((link) => link.innerText.replace(/\\s+/g, " ").trim()).filter(Boolean)`);
        rows.push(...values.map(parseShoppingRow).filter(Boolean));
        const advanced = await page.evaluate(`(() => { const button = Array.from(document.querySelectorAll("button")).find((entry) => entry.getAttribute("aria-label") === "Next" && !entry.disabled); if (!button) return false; button.click(); return true; })()`);
        if (!advanced) break;
        await page.wait(700);
      }
      const unique = [...new Map(rows.map((row) => [row.rank, row])).values()].sort((left, right) => left.rank - right.rank);
      if (unique.length < 5) throw new Error(`Google Shopping Trends returned only ${unique.length} rising queries`);
      return unique;
    },
  });
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
    const match = results.find((result) => {
      const label = normalize(result.label ?? "");
      return label === key || label.startsWith(`${key} `);
    });
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
  return false;
}

async function filterProductQueries(rows) {
  const entities = await wikidataEntitiesForTitles(rows.flatMap((row) => queryVariants(titleCase(row.query))));
  const singleWordDescriptions = new Map(await mapConcurrent(
    [...new Set(rows.filter((row) => !row.query.includes(" ")).map((row) => row.query))],
    4,
    async (query) => {
      const url = new URL("https://www.wikidata.org/w/api.php");
      url.search = new URLSearchParams({
        action: "wbsearchentities",
        search: query,
        language: "en",
        uselang: "en",
        limit: "1",
        format: "json",
        origin: "*",
      });
      const result = (JSON.parse(await fetchText(url)).search ?? [])[0];
      return [normalize(query), result?.description ?? ""];
    },
  ));
  const generic = new Set(["books", "clothing", "facebook", "food", "shoes", "toys"]);
  const seen = new Set();
  return rows.filter((row) => {
    const key = normalize(row.query).split(" ").sort().join(" ");
    if (!key || key === "undefined" || seen.has(key)) return false;
    seen.add(key);
    if (generic.has(key) || /\b(?:marketplace|powerball|lottery|movie|film|trailer)\b/i.test(row.query)) return false;
    if (queryEntityMatch(titleCase(row.query), entities, (entity) => claimIds(entity, "P31").includes("Q5") || eligibleMovie(entity))) return false;
    if (!row.query.includes(" ")) {
      const entity = entities.get(normalize(titleCase(row.query)));
      const description = entity?.descriptions?.en?.value ?? singleWordDescriptions.get(normalize(row.query)) ?? "";
      const productLike = /\b(?:computers?|devices?|products?|models?|consoles?|phones?|laptops?|vehicles?|beverages?|toys?|games?|books?|cameras?|watches|shoes|clothing)\b/i.test(description);
      if (/\b(?:company|corporation|website|social network|online marketplace)\b/i.test(description)
        || (/\bbrand\b/i.test(description) && !productLike)
        || !productLike) return false;
    }
    return true;
  });
}

function productTokens(value) {
  return normalize(value).split(" ").filter((token) => token.length > 1 && !new Set(["for", "the", "with"]).has(token));
}

async function amazonProducts(rows) {
  return withHeadlessPage({
    allowedHosts: new Set(["www.amazon.com"]),
    work: async (page) => {
      const products = [];
      for (const row of rows.slice(0, 20)) {
        const searchUrl = new URL("https://www.amazon.com/s");
        searchUrl.search = new URLSearchParams({ k: row.query, s: "exact-aware-popularity-rank" });
        await page.navigate(searchUrl, 1_600);
        const cards = await page.evaluate(`Array.from(document.querySelectorAll("[data-asin]")).map((card) => { const asin = card.getAttribute("data-asin"); const links = Array.from(card.querySelectorAll('a[href*="/dp/"]')); const titleLink = links.find((link) => (link.innerText || "").trim().length > 8); return { asin, title: (titleLink?.innerText || "").replace(/\\s+/g, " ").trim(), text: (card.innerText || "").replace(/\\s+/g, " ").trim(), image: card.querySelector("img.s-image")?.src || "" }; }).filter((card) => /^[A-Z0-9]{10}$/.test(card.asin) && card.title)`);
        const tokens = productTokens(row.query);
        const required = Math.max(1, tokens.length - (tokens.length >= 3 ? 1 : 0));
        const match = cards.find((card) => tokens.filter((token) => normalize(card.text).split(" ").includes(token)).length >= required);
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
      if (products.length < 5) throw new Error(`Only ${products.length} rising queries had a matching Amazon product`);
      return products;
    },
  });
}

async function productLeaderboard() {
  const rising = await googleShoppingRising();
  const filtered = await filterProductQueries(rising);
  console.log(`Eligible product queries: ${filtered.map((row) => `#${row.rank} ${row.query}`).join(" | ")}`);
  return amazonProducts(filtered);
}

async function updateProducts(brief, products) {
  const section = brief.sections.find((entry) => entry.id === "products");
  if (!section) return;
  const contexts = await mapConcurrent(products, 4, (product) => {
    const queryKey = normalize(product.query);
    const queryTerms = queryKey.split(" ").filter(Boolean);
    const qualifiers = queryTerms.length === 1
      ? [...new Set(plainText(product.title).match(/\b(?:20\d{2}|[a-z]+\d[a-z0-9-]*|\d+[a-z][a-z0-9-]*)\b/gi) ?? [])]
        .filter((token) => !queryKey.includes(normalize(token)))
        .slice(0, 2)
        .map((token) => `"${token}"`)
        .join(" ")
      : "";
    return googleNewsContext(`"${product.query}" ${qualifiers} product`, 30).catch(() => null);
  });
  const currentByTitle = new Map(
    [...section.items, ...(section.moreItems ?? [])].map((item) => [normalize(item.title), item]),
  );
  const allItems = products.map((product, index) => {
    const title = titleCase(product.query);
    const current = currentByTitle.get(normalize(title));
    const context = contexts[index];
    const definitions = [
      [/rechargeable laptop battery/i, "A rechargeable laptop battery is a portable power bank that can charge a laptop away from an outlet."],
      [/electric shock gloves/i, "Electric shock gloves are wearable devices designed to deliver an electric charge."],
      [/alani potion pack/i, "Alani Nu’s Potion Pack is a limited variety pack of flavored energy drinks."],
      [/madden\s*(?:nfl\s*)?27/i, "Madden NFL 27 is EA Sports’ current American-football video game."],
      [/\bmacbook\b/i, "A MacBook is a laptop computer made by Apple."],
      [/switch\s*2/i, "Nintendo Switch 2 is Nintendo’s current hybrid game console."],
    ];
    const identity = definitions.find(([pattern]) => pattern.test(product.query))?.[1]
      ?? conciseSentences(`The linked Amazon product is ${product.title}`, 180);
    return {
      rank: index + 1,
      title,
      subtitle: "Product · Amazon match",
      description: recentDescription(identity, context?.headline, current, {
        preferExisting: current?.evidence?.some((entry) => entry.url === context?.link),
      }),
      image: current?.image ?? `/culture/product-${slugify(title)}.webp`,
      imageSource: product.image,
      alt: current?.alt ?? `${title} product listing image`,
      url: product.url,
      source: "Amazon",
      metric: { label: "Google Shopping rising rank", value: `#${product.rank} · ${product.growth}` },
      evidence: [
        { source: "Google Shopping Trends", url: shoppingTrendsUrl },
        { source: "Amazon listing", url: product.url },
        ...(context ? [{ source: `${context.source} via Google News`, url: context.link }] : []),
      ],
      accent: current?.accent ?? accents[index % accents.length],
    };
  });
  section.eyebrow = "U.S. Google Shopping · past 7 days";
  section.title = "Products";
  section.description = "Rising U.S. Google Shopping queries in source order, after removing people, media, brand-only terms, duplicates, and queries without a relevant Amazon product listing.";
  section.sources = [
    { label: "Google Shopping · rising queries, U.S., 7 days", url: shoppingTrendsUrl },
    { label: "Amazon · best-selling match", url: products[0].searchUrl },
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
    const title = plainText(match[0].match(/class="mZ3RIc">([\s\S]*?)<\/div>/)?.[1] ?? "");
    const volume = plainText(match[0].match(/class="lqv0Cb">([\s\S]*?)<\/div>/)?.[1] ?? "");
    if (title && searchVolume(volume)) rows.push({ title, volume, searches: searchVolume(volume), sourceOrder: rows.length });
  }
  if (rows.length < 20) throw new Error(`Google Trending Now returned only ${rows.length} topics`);
  const entities = await wikidataEntitiesForTitles(rows.flatMap((row) => queryVariants(titleCase(row.title))));
  const sports = /\b(?:vs\.?|score|game|match|cup|league|nfl|nba|mlb|nhl|wnba|open 20\d{2}|warriors|fever|dream)\b/i;
  const candidates = rows.filter((row) => !sports.test(row.title)
    && !queryEntityMatch(titleCase(row.title), entities, (entity) => claimIds(entity, "P31").includes("Q5")));
  const searchPersonFlags = await mapConcurrent(candidates, 4, (row) => wikidataSearchIsPerson(row.title));
  const filtered = candidates.filter((_, index) => !searchPersonFlags[index])
    .sort((left, right) => right.searches - left.searches || left.sourceOrder - right.sourceOrder)
    .slice(0, 10);
  if (filtered.length < 6) throw new Error(`Only ${filtered.length} non-person, non-sports news topics remained`);
  return mapConcurrent(filtered, 4, async (row) => {
    const context = await googleNewsContext(row.title, 14).catch(() => null);
    const summaryQuery = /have i been flocked/i.test(row.title)
      ? "Flock Safety"
      : /\bGTA\s*6\b/i.test(row.title)
        ? "Grand Theft Auto VI"
        : /^D23$/i.test(row.title)
          ? "D23 Disney"
          : /^(?:Frozen|Coco)\s*\d+$/i.test(row.title)
            ? `${row.title.replace(/\s*\d+$/, "")} franchise`
            : /^Supreme Court$/i.test(row.title)
              ? "Supreme Court of the United States"
              : context?.headline?.match(/\bHurricane\s+[A-Z][a-z]+\b/)?.[0] ?? null;
    const [topicRepresentative, topicSummary] = await Promise.all([
      wikipediaRepresentativeImage(row.title).catch(() => null),
      summaryQuery ? wikipediaTopicSummary(summaryQuery).catch(() => null) : null,
    ]);
    const contextImageQuery = context?.headline && /license plate/i.test(context.headline)
      ? "automatic license plate recognition"
      : context?.headline && /ice cream/i.test(context.headline)
        ? "ice cream"
        : context?.headline;
    const representative = topicRepresentative ?? (contextImageQuery
      ? await wikipediaRepresentativeImage(contextImageQuery).catch(() => null)
      : null);
    const fallbackUrl = new URL("https://news.google.com/search");
    fallbackUrl.search = new URLSearchParams({ q: row.title, hl: "en-US", gl: "US", ceid: "US:en" });
    return {
      ...row,
      headline: context?.headline ?? row.title,
      link: context?.link ?? fallbackUrl.href,
      publishedAt: context?.publishedAt ?? null,
      newsSource: context?.source ?? "Google News",
      imageSource: representative?.imageSource,
      imagePageUrl: representative?.pageUrl,
      imageTitle: representative?.title,
      topicSummary: topicSummary?.extract,
      topicPageUrl: topicSummary?.pageUrl,
    };
  });
}

function newsDescription(topic, title, existing) {
  if (/have i been flocked/i.test(title)) {
    return "Have I Been Flocked is a public-records search site that lets people check whether their license plate appears in released Flock Safety logs. Flock Safety is a surveillance technology company facing scrutiny over its automated license-plate network and documented misuse.";
  }
  const previous = reusableDescription(existing);
  if (previous && existing.evidence?.some((entry) => entry.url === topic.link)) return previous;
  const definition = topic.topicSummary && normalize(topic.topicSummary).includes(normalize(title).split(" ")[0])
    ? conciseSentences(topic.topicSummary, 220)
    : "";
  const event = factualHeadline(topic.headline);
  if (definition && event && !normalize(definition).includes(normalize(event).slice(0, 60))) {
    return conciseSentences(`${definition} ${event}`, 360);
  }
  return event || definition || previous || ensureSentence(title);
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
      description: newsDescription(topic, title, current),
      image: current?.image ?? `/culture/news-${slugify(title)}.webp`,
      imageSource: topic.imageSource,
      alt: topic.imageTitle ? `${topic.imageTitle}, representing ${title}` : `Representative image for ${title}`,
      url: topic.link,
      source: "Google News",
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
  const expected = ["memes", "slang", "people", "movies", "music", "products", "news"];
  if (brief.sections.length !== expected.length
    || brief.sections.some((section, index) => section.id !== expected[index])) {
    throw new Error("Brief must contain the seven boards in the documented order");
  }
  const validateItems = (section, items, startRank) => items.forEach((item, index) => {
    if (item.rank !== index + startRank) throw new Error(`${section.title} has non-sequential ranks`);
    if (!item.description?.trim() || !item.alt?.trim() || !item.image?.startsWith("/culture/")
      || !/^#[0-9a-f]{6}$/i.test(item.accent) || !item.url || new URL(item.url).protocol !== "https:") {
      throw new Error(`${item.title} lacks complete card information`);
    }
    if (item.imageSource) {
      const imageUrl = new URL(item.imageSource);
      if (imageUrl.protocol !== "https:" || !imageUrl.hostname.match(/(?:\.wikimedia\.org|\.media-amazon\.com|\.scdn\.co)$/)) {
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
  const productRanks = [...products.items, ...products.moreItems]
    .map((item) => Number(item.metric?.value?.match(/^#(\d+)/)?.[1]));
  if (productRanks.some((rank) => !Number.isInteger(rank))
    || productRanks.some((rank, index) => index > 0 && rank <= productRanks[index - 1])) {
    throw new Error("Products must preserve Google Shopping rising-query order");
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
    { label: "Google Trends", url: id === "products" ? shoppingTrendsUrl : newsTrendsUrl },
    { label: id === "products" ? "Amazon" : "Google News", url: id === "products" ? "https://www.amazon.com/" : "https://news.google.com/" },
  ],
  layout,
  items: [],
  moreItems: [],
});
if (!brief.sections.some((section) => section.id === "products")) brief.sections.push(emptySection("products", "Products", "square"));
if (!brief.sections.some((section) => section.id === "news")) brief.sections.push(emptySection("news", "News", "landscape"));
const order = ["memes", "slang", "people", "movies", "music", "products", "news"];
brief.sections.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
for (const section of brief.sections) {
  if (section.id === "people") {
    section.title = "People";
    section.layout = "square";
  } else if (section.id === "movies") {
    section.title = "Movies";
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

const sourceResults = await Promise.all([
  safely("Know Your Meme result", latestMemeResult),
  safely("Lessons in Meme Culture", lessonsInMemeCultureRecent),
  safely("Know Your Meme annual slang review", () => fetchText(annualSlangReviewUrl)),
  safely("Know Your Meme slang pageviews", () => knowYourMemeSlangPageviews(annualSlangCandidates)),
  safely("Urban Dictionary", () => verifyUrbanDictionary(annualSlangCandidates)),
  safely("Wikimedia monthly topviews", wikipediaMonthlyTop),
  safely("Billboard Hot 100", billboardHot100),
  safely("Spotify Today’s Top Hits", spotifyPlaylistTracks),
  safely("Google Shopping / Amazon", productLeaderboard),
  safely("Google Trending Now / News", googleTrendingNews),
]);
const byName = Object.fromEntries(sourceResults.map((result) => [result.name, result]));
for (const result of sourceResults) console.log(`${result.ok ? "ok" : "failed"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
const optionalSources = new Set(["Google Shopping / Amazon"]);
const failedSources = sourceResults.filter((result) => !result.ok && !optionalSources.has(result.name));
if (failedSources.length) {
  console.error(`No snapshot was written because ${failedSources.length} required source check${failedSources.length === 1 ? "" : "s"} failed.`);
  process.exit(1);
}

await updateMemes(brief, byName["Know Your Meme result"].value, byName["Lessons in Meme Culture"].value);
updateSlang(brief, byName["Know Your Meme slang pageviews"].value);
await updatePeople(brief, byName["Wikimedia monthly topviews"].value);
await updateMovies(brief, byName["Wikimedia monthly topviews"].value);
await updateMusic(brief, byName["Billboard Hot 100"].value, byName["Spotify Today’s Top Hits"].value);
if (byName["Google Shopping / Amazon"].ok) await updateProducts(brief, byName["Google Shopping / Amazon"].value);
else if (brief.sections.find((section) => section.id === "products")?.items.length !== 5) {
  console.error("No previous Products snapshot is available to preserve.");
  process.exit(1);
}
updateNews(brief, byName["Google Trending Now / News"].value);
for (const item of brief.sections.flatMap((section) => [...section.items, ...(section.moreItems ?? [])])) delete item.caution;
delete brief.pulse;

brief.sourceHealth = sourceResults.map(({ name, ok, checkedAt }) => ({ name, ok, checkedAt }));
brief.generatedAt = now.toISOString();
brief.edition = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(now);
brief.status = "Checked today";
brief.summary = "A five-minute, two-source briefing on the memes, slang, people, movies, music, products, and news shaping internet culture right now.";
brief.window = "Memes: latest complete poll · People and Movies: last month · Products and News: past 7 days · Music: current charts";
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
