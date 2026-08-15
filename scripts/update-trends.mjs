import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const dataPath = path.join(root, "data", "trends.json");
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

const sourceUrls = {
  google: "https://trends.google.com/trending/rss?geo=US",
  tiktok: "https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en",
  tiktokEditorial: "https://www.socialpilot.co/blog/tiktok-trends",
  knowYourMeme: "https://knowyourmeme.com/memes",
  lessonsInMemeCulture: "https://www.youtube.com/feeds/videos.xml?channel_id=UCaHT88aobpcvRFEuy4v5Clg",
};

const allowedHosts = new Set([
  "ads.tiktok.com",
  "api.urbandictionary.com",
  "knowyourmeme.com",
  "trends.google.com",
  "wikimedia.org",
  "www.imdb.com",
  "www.socialpilot.co",
  "www.youtube.com",
]);

const aliases = {
  "The Odyssey sirens": ["odysseus", "siren song", "the odyssey"],
  "Sirens Scene": ["odysseus", "siren song", "the odyssey"],
  "Whipping up in a kettle": ["whipping up", "kettle", "boiling poo"],
  "Whipping Up Shi in a Kettle": ["whipping up", "kettle", "boiling poo"],
  "The Other Cavaliers": ["other cavaliers", "cavaliers"],
  "Realistic Brewstew": ["realistic brewstew", "brewstew"],
  "Eminem Brisk Commercial": ["eminem brisk", "brisk commercial"],
  "Eminem's Brisk ad": ["eminem brisk", "brisk commercial"],
  "The Kumar Method": ["kumar method", "thekumarmethod"],
  "Saxophones Getting Louder": ["saxophones getting louder", "saxophone"],
  "Not Very Nonchalant": ["not very nonchalant", "nonchalant"],
  "Not very nonchalant": ["not very nonchalant", "nonchalant"],
  "Netflix Documentary": ["netflix documentary"],
  "Netflix documentary": ["netflix documentary"],
  "I'm in Pain / Spain": ["i'm in pain", "in spain", "without the s"],
  "I'm in pain — I'm in Spain": ["i'm in pain", "in spain", "without the s"],
  IYO: ["iyo", "in your opinion"],
  Neegy: ["neegy"],
  "Mbappé Special": ["mbappe special", "mbappé special"],
  "Mbappé special": ["mbappe special", "mbappé special"],
  TLPUR: ["tlpur"],
  "Boy Kibble": ["boy kibble"],
  IShowSpeed: ["ishowspeed", "speed"],
  "Ian McConnell": ["ian mcconnell", "bangladesh"],
  Aora: ["aora", "aora dj"],
  "Aora.DJ": ["aora", "aora dj"],
  "Lessons in Meme Culture": ["lessons in meme culture", "limc"],
  "Spider-Man: Brand New Day": ["spider-man brand new day", "brand new day"],
  "The Odyssey": ["the odyssey", "odyssey movie"],
  "End of Oak Street": ["end of oak street", "oak street"],
  "The End of Oak Street": ["end of oak street", "oak street"],
  "Toy Story 5": ["toy story 5"],
  "Jujutsu Kaisen": ["jujutsu kaisen", "jjk"],
  "Jujutsu Kaisen · S3": ["jujutsu kaisen", "jjk"],
  Bangladesh: ["bangladesh ian mcconnell", "bangladesh"],
  "Choosin’ Texas": ["choosin texas", "choosin’ texas"],
  "Choosin' Texas": ["choosin texas", "choosin’ texas"],
  "hate that i made you love me": ["hate that i made you love me"],
  "u + me = <3": ["u + me", "olivia rodrigo"],
  SS26: ["ss26", "charli xcx"],
};

const wikipediaTitles = {
  IShowSpeed: "IShowSpeed",
  "Ian McConnell": "Ian_McConnell_(musician)",
  "Lessons in Meme Culture": "Internet_meme",
  "Spider-Man: Brand New Day": "Spider-Man:_Brand_New_Day",
  "The Odyssey": "The_Odyssey_(2026_film)",
  "The End of Oak Street": "End_of_Oak_Street",
  "Toy Story 5": "Toy_Story_5",
  "Jujutsu Kaisen": "Jujutsu_Kaisen",
  "Jujutsu Kaisen · S3": "Jujutsu_Kaisen",
  Bangladesh: "Bangladesh",
  "Choosin’ Texas": "Ella_Langley",
  "Choosin' Texas": "Ella_Langley",
  "hate that i made you love me": "Ariana_Grande",
  "u + me = <3": "Olivia_Rodrigo",
  SS26: "Charli_XCX",
};

const imdbIds = {
  "Spider-Man: Brand New Day": "tt22084616",
  "The Odyssey": "tt33764258",
  "End of Oak Street": "tt27165187",
  "The End of Oak Street": "tt27165187",
  "Toy Story 5": "tt29355505",
  "Jujutsu Kaisen": "tt12343534",
  "Jujutsu Kaisen · S3": "tt12343534",
};

function assertAllowed(rawUrl) {
  const url = new URL(rawUrl);
  const hostAllowed = allowedHosts.has(url.hostname) || url.hostname.endsWith(".wikimedia.org");
  if (url.protocol !== "https:" || !hostAllowed) {
    throw new Error(`Refusing unapproved URL: ${url.origin}`);
  }
  return url;
}

async function fetchText(rawUrl) {
  const url = assertAllowed(rawUrl);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      accept: "text/html,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
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

function plainText(value) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function termsFor(item) {
  return (aliases[item.title] ?? [item.title]).map(normalize).filter((term) => term.length > 2);
}

function hitCount(haystack, item) {
  const normalized = normalize(haystack);
  return termsFor(item).reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
}

function clampScore(value) {
  return Math.max(50, Math.min(99, Math.round(value)));
}

async function safely(name, work) {
  try {
    const value = await work();
    return { name, ok: true, value, checkedAt: new Date().toISOString() };
  } catch (error) {
    return {
      name,
      ok: false,
      value: null,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
    };
  }
}

async function urbanDictionarySignals(items) {
  const signals = {};
  for (const item of items) {
    const response = await fetchText(`https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(item.title)}`);
    const payload = JSON.parse(response);
    const definitions = Array.isArray(payload.list) ? payload.list.slice(0, 5) : [];
    signals[item.title] = definitions.reduce((total, entry) => total + Number(entry.thumbs_up ?? 0), 0);
  }
  return signals;
}

function pageviewRange() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const stamp = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  return { start: stamp(start), end: stamp(end) };
}

async function wikipediaSignals(items) {
  const { start, end } = pageviewRange();
  const signals = {};
  for (const item of items) {
    const article = wikipediaTitles[item.title];
    if (!article) continue;
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/${encodeURIComponent(article)}/daily/${start}/${end}`;
    try {
      const payload = JSON.parse(await fetchText(url));
      signals[item.title] = (payload.items ?? []).reduce((total, day) => total + Number(day.views ?? 0), 0);
    } catch {
      signals[item.title] = 0;
    }
  }
  return signals;
}

async function imdbRatings(items) {
  const ratings = {};
  for (const item of items) {
    const id = imdbIds[item.title];
    if (!id) continue;
    try {
      const html = await fetchText(`https://www.imdb.com/title/${id}/`);
      const match = html.match(/"aggregateRating"\s*:\s*\{[^}]*?"ratingValue"\s*:\s*([0-9.]+)/i)
        ?? html.match(/"ratingValue"\s*:\s*"?([0-9.]+)"?/i);
      if (match) ratings[item.title] = Number(match[1]).toFixed(1);
    } catch {}
  }
  return ratings;
}

const brief = JSON.parse(await readFile(dataPath, "utf8"));
const lastRun = new Date(brief.generatedAt);
const now = new Date();
if (!force && !dryRun && lastRun.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
  console.log(`Already refreshed on ${now.toISOString().slice(0, 10)}; use --force to run again.`);
  process.exit(0);
}

const allItems = brief.sections.flatMap((section) => section.items);
const slangItems = brief.sections.find((section) => section.id === "slang")?.items ?? [];
const watchItems = brief.sections.find((section) => section.id === "watch")?.items ?? [];

const sourceResults = await Promise.all([
  safely("Google Trends", () => fetchText(sourceUrls.google)),
  safely("TikTok Creative Center", () => fetchText(sourceUrls.tiktok)),
  safely("TikTok editorial fallback", () => fetchText(sourceUrls.tiktokEditorial)),
  safely("Know Your Meme", () => fetchText(sourceUrls.knowYourMeme)),
  safely("Lessons in Meme Culture", () => fetchText(sourceUrls.lessonsInMemeCulture)),
  safely("Urban Dictionary", () => urbanDictionarySignals(slangItems)),
  safely("Wikipedia pageviews", () => wikipediaSignals(allItems)),
  safely("IMDb ratings", () => imdbRatings(watchItems)),
]);

const byName = Object.fromEntries(sourceResults.map((result) => [result.name, result]));
const text = {
  google: plainText(byName["Google Trends"].value ?? ""),
  tiktok: plainText(`${byName["TikTok Creative Center"].value ?? ""} ${byName["TikTok editorial fallback"].value ?? ""}`),
  kym: plainText(byName["Know Your Meme"].value ?? ""),
  limc: plainText(byName["Lessons in Meme Culture"].value ?? ""),
};
const urban = byName["Urban Dictionary"].value ?? {};
const pageviews = byName["Wikipedia pageviews"].value ?? {};
const ratings = byName["IMDb ratings"].value ?? {};

for (const section of brief.sections) {
  for (const item of section.items) {
    const hits = {
      google: hitCount(text.google, item),
      tiktok: hitCount(text.tiktok, item),
      kym: hitCount(text.kym, item),
      limc: hitCount(text.limc, item),
    };
    const wikiBoost = pageviews[item.title] ? Math.min(12, Math.log10(pageviews[item.title] + 1) * 2) : 0;
    const urbanBoost = urban[item.title] ? Math.min(12, Math.log10(urban[item.title] + 1) * 3) : 0;
    const weights = section.id === "memes"
      ? { google: 3, tiktok: 3, kym: 7, limc: 8 }
      : section.id === "formats"
        ? { google: 3, tiktok: 8, kym: 2, limc: 2 }
        : section.id === "slang"
          ? { google: 2, tiktok: 6, kym: 5, limc: 2 }
          : { google: 5, tiktok: 5, kym: 2, limc: 2 };
    const sourceBoost = Object.entries(weights).reduce((total, [name, weight]) => total + Math.min(2, hits[name]) * weight, 0);
    const freshnessTiebreak = (6 - item.rank) * 0.25;
    item.score = clampScore(53 + sourceBoost + wikiBoost + urbanBoost + freshnessTiebreak);
    const matched = Object.entries(hits).filter(([, count]) => count > 0).map(([name]) => name.toUpperCase());
    if (matched.length) item.signal = `${matched.slice(0, 3).join(" + ")} signal`;
    if (ratings[item.title]) item.rating = ratings[item.title];
  }
  section.items.sort((a, b) => b.score - a.score || a.rank - b.rank);
  section.items.forEach((item, index) => { item.rank = index + 1; });
}

const successfulCoreSources = sourceResults.filter((result) => result.ok).length;
brief.sourceHealth = sourceResults.map(({ name, ok, checkedAt, error }) => ({ name, ok, checkedAt, ...(error ? { error } : {}) }));
if (successfulCoreSources >= 3) {
  brief.generatedAt = now.toISOString();
  brief.edition = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(now);
  brief.status = `${new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(now)}, so far`;
}

const output = `${JSON.stringify(brief, null, 2)}\n`;
if (dryRun) {
  console.log("Dry run; no files changed.");
  for (const section of brief.sections) {
    console.log(`${section.id}: ${section.items.map((item) => `${item.rank}. ${item.title} (${item.score})`).join(" | ")}`);
  }
} else {
  const temporaryPath = `${dataPath}.next`;
  await writeFile(temporaryPath, output, { mode: 0o644 });
  await rename(temporaryPath, dataPath);
}

for (const result of sourceResults) {
  console.log(`${result.ok ? "ok" : "failed"} ${result.name}${result.error ? `: ${result.error}` : ""}`);
}
if (successfulCoreSources < 3) {
  console.error("Fewer than three sources succeeded; the last-known-good timestamp was preserved.");
  process.exitCode = 1;
}
