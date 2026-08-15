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
  "api.socialcounts.org",
  "api.urbandictionary.com",
  "knowyourmeme.com",
  "open.spotify.com",
  "raw.githubusercontent.com",
  "socialblade.com",
  "trends.google.com",
  "trending.knowyourmeme.com",
  "wikimedia.org",
  "www.imdb.com",
  "www.socialblade.com",
  "www.youtube.com",
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

function fullMonthRange(month, year) {
  const monthIndex = new Date(`${month} 1, ${year}`).getMonth();
  const number = String(monthIndex + 1).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return `${year}-${number}-01%20${year}-${number}-${lastDay}`;
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
  const stop = new Set(["meme", "memes", "laugh", "laughing", "yourrage", "the", "this", "that", "with", "world", "month"]);
  const tokens = normalize(candidate.title).split(" ").filter((token) => token.length >= 4 && !stop.has(token));
  return videos.find((video) => {
    const title = normalize(video.title);
    const shared = tokens.filter((token) => title.includes(token));
    return shared.length >= Math.min(2, Math.max(1, tokens.length));
  });
}

function updateMemes(brief, result, videos) {
  const section = brief.sections.find((entry) => entry.id === "memes");
  if (!section) return;
  const currentByUrl = new Map(section.items.map((item) => [item.url, item]));
  const winner = result.candidates[0];
  const matches = result.candidates.slice(1).map((candidate) => ({ candidate, video: memeVideoMatch(candidate, videos) })).filter((entry) => entry.video);
  const ordered = [
    { candidate: winner, video: memeVideoMatch(winner, videos) },
    ...matches,
    ...result.candidates.slice(1).filter((candidate) => !matches.some((entry) => entry.candidate.rank === candidate.rank)).map((candidate) => ({ candidate })),
  ].slice(0, 5);

  section.eyebrow = `${result.label} · latest complete month`;
  section.description = `${result.month}'s poll winner comes first. Then we prioritize memes also found among Lessons in Meme Culture's 20 most-viewed videos from the past two months and fill any open spots from the ${result.month} poll.`;
  section.items = ordered.map(({ candidate, video }, index) => {
    const current = currentByUrl.get(candidate.url);
    const title = current?.title ?? candidate.title;
    return {
      rank: index + 1,
      title,
      subtitle: current?.subtitle ?? (index === 0 ? `${result.month}'s Meme of the Month` : video ? "Verified in both monthly lists" : `${result.month} poll finalist`),
      description: current?.description ?? `${title} placed in Know Your Meme's ${result.month} community poll${video ? " and also reached Lessons in Meme Culture's recent top 20 by views" : " and was checked against Google search interest"}.`,
      image: current?.image ?? `/culture/meme-${slugify(title)}.webp`,
      alt: current?.alt ?? `Visual example of the ${title} meme`,
      url: candidate.url,
      source: "Know Your Meme",
      ...(candidate.vote ? { metric: { label: `${result.month} community vote`, value: candidate.vote } } : {}),
      evidence: [
        { source: `Know Your Meme ${result.month} result`, url: result.resultUrl },
        video
          ? { source: "Lessons in Meme Culture", url: `https://www.youtube.com/watch?v=${video.id}` }
          : { source: "Google Trends", url: `https://trends.google.com/trends/explore?date=${fullMonthRange(result.month, result.year)}&geo=US&q=${encodeURIComponent(title)}` },
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

async function socialCountsCreators() {
  const payload = JSON.parse(await fetchText("https://api.socialcounts.org/channel-analytics/ranks?sort=subs&page=1&limit=100&period=last_30_days"));
  const blocked = /official|\btv\b|kids?|nursery|records?|music|label|bank|fifa|caz[eé]|state bank/i;
  const rows = (payload.rows ?? []).filter((row) => !row.made_for_kids && !blocked.test(row.title ?? "") && Number(row.subscriber_gain) > 0).slice(0, 5);
  if (rows.length < 5) throw new Error("SocialCounts returned fewer than five eligible creator channels");
  return rows;
}

async function socialBladeAudit(rows) {
  const audits = await Promise.allSettled(rows.map((row) => fetchText(`https://socialblade.com/youtube/channel/${row.channel_id}`)));
  const succeeded = audits.filter((result) => result.status === "fulfilled").length;
  if (!succeeded) throw new Error("Social Blade blocked all five profile checks");
  return succeeded;
}

function updateCreators(brief, rows) {
  const section = brief.sections.find((entry) => entry.id === "creators");
  if (!section) return;
  const currentByTitle = new Map(section.items.map((item) => [normalize(item.title), item]));
  section.items = rows.map((row, index) => {
    const current = currentByTitle.get(normalize(row.title));
    const url = `https://www.youtube.com/channel/${row.channel_id}`;
    const titleSlug = slugify(row.title);
    const imageSlug = titleSlug === "item" ? `channel-${normalize(row.channel_id).replaceAll(" ", "").slice(-8)}` : titleSlug;
    return {
      rank: index + 1,
      title: row.title,
      subtitle: current?.subtitle ?? "YouTube creator channel",
      description: current?.description ?? `${row.title} is one of the fastest-growing human-led YouTube channels in SocialCounts' current 30-day subscriber table.`,
      image: current?.image && current.image !== "/culture/creator-item.webp" ? current.image : `/culture/creator-${imageSlug}.webp`,
      alt: current?.alt ?? `${row.title}'s YouTube profile image`,
      url,
      source: "YouTube",
      metric: { label: "Subscribers gained · 30 days", value: `+${formatCompact(Number(row.subscriber_gain))}` },
      evidence: [
        { source: "Social Blade", url: `https://socialblade.com/youtube/channel/${row.channel_id}` },
        { source: "SocialCounts", url: "https://socialcounts.org/top/channels?by=subs_gained&period=last_30_days" },
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

async function wikipediaPageviews(items) {
  const range = pageviewRange();
  const values = {};
  await Promise.all(items.map(async (item) => {
    const evidence = item.evidence.find((entry) => entry.source === "Wikipedia");
    if (!evidence) return;
    const article = decodeURIComponent(new URL(evidence.url).pathname.replace(/^\/wiki\//, ""));
    const payload = JSON.parse(await fetchText(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/${encodeURIComponent(article)}/daily/${range.start}/${range.end}`));
    values[item.title] = (payload.items ?? []).reduce((total, day) => total + Number(day.views ?? 0), 0);
  }));
  return values;
}

async function imdbRatings(items) {
  const ratings = {};
  await Promise.all(items.map(async (item) => {
    try {
      const html = await fetchText(item.url, { headers: { "accept-language": "en-US,en;q=0.9", "user-agent": "Mozilla/5.0" } });
      const match = html.match(/"aggregateRating"\s*:\s*\{[^}]*?"ratingValue"\s*:\s*([0-9.]+)/i)
        ?? html.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/i);
      if (match) ratings[item.title] = Number(match[1]).toFixed(1);
    } catch {}
  }));
  if (!Object.keys(ratings).length) throw new Error("IMDb returned no parseable ratings");
  return ratings;
}

function updateWatch(brief, pageviews, ratings) {
  const section = brief.sections.find((entry) => entry.id === "watch");
  if (!section || !pageviews) return;
  for (const item of section.items) {
    const views = pageviews[item.title];
    if (Number.isFinite(views)) item.metric = { label: "Wikipedia views · 30 days", value: formatCompact(views) };
    if (ratings?.[item.title]) item.rating = ratings[item.title];
  }
  section.items.sort((a, b) => (pageviews[b.title] ?? -1) - (pageviews[a.title] ?? -1));
  section.items.forEach((item, index) => { item.rank = index + 1; item.accent = accents[index]; });
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
  const html = await fetchText("https://open.spotify.com/embed/playlist/37i9dQZEVXbLRQDuF5jeBp?theme=0", { headers: { "user-agent": "Mozilla/5.0" } });
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
  const spotifyByTitle = new Map(spotifyTracks.map((track) => [normalize(track.title), track]));
  const crossovers = chart.rows.map((row) => ({ row, track: spotifyByTitle.get(normalize(row.song)) })).filter((entry) => entry.track).slice(0, 5);
  if (crossovers.length < 5) throw new Error("Fewer than five songs overlapped Billboard and Spotify");
  const currentById = new Map(section.items.map((item) => [item.spotifyId, item]));
  section.items = crossovers.map(({ row, track }, index) => {
    const current = currentById.get(track.id);
    return {
      rank: index + 1,
      title: track.title,
      subtitle: track.artist,
      description: current?.description ?? `${track.title} clears both Billboard's Hot 100 and Spotify's current U.S. Top 50.`,
      image: current?.image ?? `/culture/song-${slugify(`${track.title}-${track.artist}`)}.webp`,
      alt: current?.alt ?? `${track.title} artwork by ${track.artist}`,
      url: `https://open.spotify.com/track/${track.id}`,
      source: "Spotify",
      metric: { label: "Billboard Hot 100", value: `#${row.this_week}` },
      evidence: [
        { source: "Billboard", url: `https://www.billboard.com/charts/hot-100/${chart.date}/` },
        { source: "Spotify", url: "https://open.spotify.com/playlist/37i9dQZEVXbLRQDuF5jeBp" },
      ],
      accent: accents[index],
      spotifyId: track.id,
    };
  });
}

function updatePulse(brief) {
  const definitions = [
    ["memes", "Latest meme winner"],
    ["slang", "Yearly slang"],
    ["creators", "30-day creator"],
    ["songs", "Chart crossover"],
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
  if (/"(?:signal|score)":/.test(serialized)) throw new Error("The briefing must not contain opaque score fields");
}

const brief = JSON.parse(await readFile(dataPath, "utf8"));
const now = new Date();
if (!force && !dryRun && brief.generatedAt.slice(0, 10) === now.toISOString().slice(0, 10)) {
  console.log(`Already refreshed on ${now.toISOString().slice(0, 10)}; use --force to run again.`);
  process.exit(0);
}

const slang = brief.sections.find((section) => section.id === "slang")?.items ?? [];
const watch = brief.sections.find((section) => section.id === "watch")?.items ?? [];
const sourceResults = await Promise.all([
  safely("Know Your Meme result", latestMemeResult),
  safely("Lessons in Meme Culture", lessonsInMemeCultureTop20),
  safely("Know Your Meme annual slang review", () => fetchText("https://trending.knowyourmeme.com/editorials/meme-review/kym-review-the-top-slang-terms-of-2025")),
  safely("Urban Dictionary", () => verifyUrbanDictionary(slang)),
  safely("Google Trends", () => googleTrendsSlang(slang)),
  safely("SocialCounts", socialCountsCreators),
  safely("Wikipedia pageviews", () => wikipediaPageviews(watch)),
  safely("IMDb ratings", () => imdbRatings(watch)),
  safely("Billboard Hot 100", billboardHot100),
  safely("Spotify Top 50 USA", spotifyTop50),
]);
const byName = Object.fromEntries(sourceResults.map((result) => [result.name, result]));

if (byName["Know Your Meme result"].ok && byName["Lessons in Meme Culture"].ok) {
  updateMemes(brief, byName["Know Your Meme result"].value, byName["Lessons in Meme Culture"].value);
}
updateSlang(brief, byName["Google Trends"].value);
if (byName.SocialCounts.ok) updateCreators(brief, byName.SocialCounts.value);
updateWatch(brief, byName["Wikipedia pageviews"].value, byName["IMDb ratings"].value);
if (byName["Billboard Hot 100"].ok && byName["Spotify Top 50 USA"].ok) {
  updateSongs(brief, byName["Billboard Hot 100"].value, byName["Spotify Top 50 USA"].value);
}
updatePulse(brief);

const socialBladeResult = await safely("Social Blade", () => socialBladeAudit(byName.SocialCounts.value ?? []));
sourceResults.splice(6, 0, socialBladeResult);
const successfulSources = sourceResults.filter((result) => result.ok).length;
brief.sourceHealth = sourceResults.map(({ name, ok, checkedAt, error }) => ({ name, ok, checkedAt, ...(error ? { error } : {}) }));
if (successfulSources >= 5) {
  brief.generatedAt = now.toISOString();
  brief.edition = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(now);
  brief.status = "Checked today";
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
if (successfulSources < 5) {
  console.error("Fewer than five source checks succeeded; the last-known-good timestamp was preserved.");
  process.exitCode = 1;
}
