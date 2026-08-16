import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "public", "culture");
const force = process.argv.includes("--force");
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 18_000;

const pageHosts = new Set([
  "en.wikipedia.org",
  "knowyourmeme.com",
  "open.spotify.com",
  "www.boxofficemojo.com",
  "www.imdb.com",
  "www.youtube.com",
]);

const imageHosts = new Set([
  "animotaku.fr",
  "cdn.kinocheck.com",
  "m.media-amazon.com",
  "s.movieinsider.com",
  "www.nfbio.dk",
]);

const allowedImageSuffixes = [
  ".cdninstagram.com",
  ".fbcdn.net",
  ".googleusercontent.com",
  ".ggpht.com",
  ".kym-cdn.com",
  ".scdn.co",
  ".ytimg.com",
  ".wikimedia.org",
];

const assets = [
  { file: "meme-kwebbelkop.webp", title: "Kwebbelkop Laugh", page: "https://knowyourmeme.com/memes/kwebbelkop-laughing-yourrage-laugh", shape: "landscape" },
  { file: "meme-john-rod.webp", title: "John Rod", page: "https://knowyourmeme.com/memes/john-rod", shape: "landscape" },
  { file: "meme-miku-custody.webp", title: "Hatsune Miku World Cup Custody Battle", page: "https://knowyourmeme.com/memes/hatsune-miku-world-cup-custody-battle", shape: "landscape" },
  { file: "slang-67.webp", title: "67", page: "https://knowyourmeme.com/memes/67-meme", shape: "landscape" },
  { file: "slang-clanker.webp", title: "Clanker", page: "https://knowyourmeme.com/memes/clanker", shape: "landscape" },
  { file: "slang-chopped.webp", title: "Chopped", page: "https://knowyourmeme.com/memes/chopped-slang", shape: "landscape" },
  { file: "slang-aura-farming.webp", title: "Aura Farming", page: "https://knowyourmeme.com/memes/aura-farming", shape: "landscape" },
  { file: "slang-sybau.webp", title: "SYBAU", page: "https://knowyourmeme.com/memes/sybau", shape: "landscape" },
  { file: "creator-zhong.webp", title: "Zhong", page: "https://www.youtube.com/@zhong", shape: "square" },
  { file: "creator-mrbeast.webp", title: "MrBeast", page: "https://www.youtube.com/@MrBeast", shape: "square" },
  { file: "creator-speed.webp", title: "IShowSpeed", page: "https://www.youtube.com/@IShowSpeed", shape: "square" },
  { file: "creator-celine.webp", title: "Celine Dept", page: "https://www.youtube.com/@celinedept", shape: "square" },
  { file: "creator-jesser.webp", title: "Jesser", page: "https://www.youtube.com/@Jesser", shape: "square" },
  { file: "media-spider-man.webp", title: "Spider-Man Brand New Day", direct: "https://s.movieinsider.com/images/p/964462_m1773880192.jpg", shape: "poster" },
  { file: "media-odyssey.webp", title: "The Odyssey", direct: "https://www.nfbio.dk/sites/nfbio.dk/files/styles/movie_poster/public/media-images/2025-12/gmnt-b41983b128-1529119-vst-694521bb7da8f.jpeg?itok=kUouQPma", shape: "poster" },
  { file: "media-toy-story.webp", title: "Toy Story 5", direct: "https://m.media-amazon.com/images/M/MV5BMTBlNTEwYmQtNjE1OC00NDRlLWI3M2YtYmRkODVmZTljYWRiXkEyXkFqcGc%40._V1_.jpg", shape: "poster" },
  { file: "media-minions-monsters.webp", title: "Minions & Monsters", page: "https://www.boxofficemojo.com/release/rl779714561/", shape: "poster" },
  { file: "media-moana.webp", title: "Moana", page: "https://en.wikipedia.org/wiki/Moana_(2026_film)", shape: "poster" },
  { file: "media-jujutsu.webp", title: "Jujutsu Kaisen", direct: "https://animotaku.fr/wp-content/uploads/2024/12/anime-jujutsu-kaisen-saison-3-visuel-1.jpg", shape: "poster" },
  { file: "song-choosin-texas.webp", title: "Choosin Texas", page: "https://open.spotify.com/track/7scFxt9VhL4FJwuPSfRlfN", shape: "square" },
  { file: "song-hate-love.webp", title: "hate that i made you love me", page: "https://open.spotify.com/track/3iy2QuCtCzpWnR6tia39AB", shape: "square" },
  { file: "song-been-by-now.webp", title: "Been By Now", page: "https://open.spotify.com/track/3xwMjQriBVW0OGEvNKo9c0", shape: "square" },
  { file: "song-petal.webp", title: "petal", page: "https://open.spotify.com/track/70pVCVMGjmIWPbWXDwf11e", shape: "square" },
  { file: "song-boston.webp", title: "Boston", page: "https://open.spotify.com/track/36idurZmYRjJ56KQ8JD9bN", shape: "square" },
];

const brief = JSON.parse(await readFile(path.join(root, "data", "trends.json"), "utf8"));
const referencedFiles = new Set(brief.sections.flatMap((section) => section.items.map((item) => path.basename(item.image))));
for (let index = assets.length - 1; index >= 0; index -= 1) {
  if (!referencedFiles.has(assets[index].file)) assets.splice(index, 1);
}
const knownFiles = new Set(assets.map((asset) => asset.file));
for (const section of brief.sections) {
  for (const item of section.items) {
    const file = path.basename(item.image);
    if (knownFiles.has(file)) continue;
    assets.push({ file, title: item.title, page: item.url, shape: section.layout });
    knownFiles.add(file);
  }
}

function assertUrl(rawUrl, kind) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS ${kind} URL`);
  const allowed = kind === "page"
    ? pageHosts.has(url.hostname)
    : imageHosts.has(url.hostname) || allowedImageSuffixes.some((suffix) => url.hostname.endsWith(suffix));
  if (!allowed) throw new Error(`Refusing unapproved ${kind} host: ${url.hostname}`);
  return url;
}

async function fetchLimited(rawUrl, kind) {
  const requested = assertUrl(rawUrl, kind);
  const response = await fetch(requested, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
      accept: kind === "page" ? "text/html,application/xhtml+xml" : "image/avif,image/webp,image/*,*/*;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`${response.status} from ${requested.hostname}`);
  assertUrl(response.url, kind);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new Error(`Asset exceeds ${MAX_BYTES} bytes`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response had no body");
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeded ${MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return { buffer: Buffer.concat(chunks), contentType: response.headers.get("content-type") ?? "", finalUrl: response.url };
}

function extractOgImage(html, baseUrl) {
  const tags = html.match(/<meta\s+[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const property = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (property !== "og:image" && property !== "twitter:image" && property !== "twitter:image:src") continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (content) return new URL(content.replaceAll("&amp;", "&"), baseUrl).href;
  }
  throw new Error("No social preview image was found");
}

async function resolveImage(asset) {
  if (asset.direct) return asset.direct;
  const page = await fetchLimited(asset.page, "page");
  return extractOgImage(page.buffer.toString("utf8"), page.finalUrl);
}

function dimensions(shape) {
  if (shape === "poster") return { width: 520, height: 780 };
  if (shape === "square") return { width: 640, height: 640 };
  return { width: 720, height: 520 };
}

function fallbackCard(title, shape) {
  const { width, height } = dimensions(shape);
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const fontSize = Math.max(36, Math.min(72, Math.round(width / Math.max(7, title.length * 0.55))));
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#6f48e5"/><circle cx="${width * 0.8}" cy="${height * 0.15}" r="${width * 0.2}" fill="#d4f163"/><path d="M0 ${height * 0.68} Q ${width * 0.4} ${height * 0.43} ${width} ${height * 0.72} V ${height} H0Z" fill="#ff765f"/><text x="${width * 0.08}" y="${height * 0.5}" width="${width * 0.8}" fill="#fff" font-size="${fontSize}" font-family="Georgia,serif" font-weight="700">${escaped}</text></svg>`);
}

async function processAsset(asset) {
  const destination = path.join(outputRoot, asset.file);
  if (!force) {
    try {
      if ((await stat(destination)).size > 5000) return { asset, state: "cached" };
    } catch {}
  }

  let input;
  let state = "downloaded";
  try {
    const imageUrl = await resolveImage(asset);
    const image = await fetchLimited(imageUrl, "image");
    if (!image.contentType.startsWith("image/")) throw new Error(`Unexpected content type ${image.contentType}`);
    input = image.buffer;
  } catch (error) {
    state = `fallback (${error instanceof Error ? error.message : String(error)})`;
    input = fallbackCard(asset.title, asset.shape);
  }

  const { width, height } = dimensions(asset.shape);
  await sharp(input)
    .rotate()
    .resize(width, height, { fit: "cover", position: "attention" })
    .webp({ quality: 78, effort: 5, smartSubsample: true })
    .toFile(destination);
  return { asset, state };
}

async function buildIcon() {
  const icon = Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="124" fill="#6f48e5"/><text x="256" y="325" text-anchor="middle" fill="#fff" font-size="260" font-family="Arial,sans-serif" font-weight="800" letter-spacing="-30">w?</text></svg>`);
  await sharp(icon).png({ compressionLevel: 9 }).toFile(path.join(root, "public", "icon.png"));
}

await mkdir(outputRoot, { recursive: true });
const results = [];
for (const asset of assets) results.push(await processAsset(asset));
await buildIcon();
const currentFiles = new Set(assets.map((asset) => asset.file));
const removedFiles = [];
for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".webp") || currentFiles.has(entry.name)) continue;
  await unlink(path.join(outputRoot, entry.name));
  removedFiles.push(entry.name);
}

const fallbacks = results.filter(({ state }) => state.startsWith("fallback"));
for (const { asset, state } of results) console.log(`${state.padEnd(42)} ${asset.file}`);
console.log(`Prepared ${results.length} images; ${fallbacks.length} used generated fallbacks.`);
if (removedFiles.length) console.log(`Removed ${removedFiles.length} obsolete cached images.`);
if (fallbacks.length > 4) process.exitCode = 1;
