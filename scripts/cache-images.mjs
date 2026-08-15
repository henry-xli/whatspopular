import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "public", "culture");
const force = process.argv.includes("--force");
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 18_000;

const pageHosts = new Set([
  "knowyourmeme.com",
  "open.spotify.com",
  "www.distractify.com",
  "www.hercampus.com",
  "www.instagram.com",
  "www.youtube.com",
]);

const imageHosts = new Set([
  "animotaku.fr",
  "cdn.hercampus.com",
  "cdn.kinocheck.com",
  "images.unsplash.com",
  "m.media-amazon.com",
  "media.distractify.com",
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
];

const assets = [
  { file: "jimothy.webp", title: "Jimothy", page: "https://knowyourmeme.com/memes/jimothy-the-raccoon", shape: "landscape" },
  { file: "meme-sirens.webp", title: "Odyssey sirens", page: "https://knowyourmeme.com/memes/sirens-scene-what-odysseus-actually-heard-during-the-siren-song", shape: "landscape" },
  { file: "meme-kettle.webp", title: "Whipping up shi in a kettle", page: "https://knowyourmeme.com/memes/he-was-whipping-up-shit-in-a-kettle-boiling-poo-in-a-kettle", shape: "landscape" },
  { file: "meme-cavaliers.webp", title: "The Other Cavaliers", page: "https://knowyourmeme.com/memes/the-other-cavaliers", shape: "landscape" },
  { file: "meme-brewstew.webp", title: "Realistic Brewstew", page: "https://knowyourmeme.com/memes/realistic-brewstew", shape: "landscape" },
  { file: "meme-eminem-brisk.webp", title: "Eminem Brisk", page: "https://knowyourmeme.com/memes/eminem-brisk-commercial", shape: "landscape" },
  { file: "kumar-method.webp", title: "The Kumar Method", page: "https://knowyourmeme.com/memes/kumar-method", shape: "landscape" },
  { file: "format-saxophones.webp", title: "Saxophones getting louder", page: "https://www.distractify.com/p/what-does-the-saxophone-getting-louder-mean-on-tiktok", shape: "landscape" },
  { file: "format-nonchalant.webp", title: "Not very nonchalant", direct: "https://images.unsplash.com/photo-1505236858219-8359eb29e329?auto=format&fit=crop&w=1200&q=85", shape: "landscape" },
  { file: "format-documentary.webp", title: "Netflix documentary", page: "https://www.hercampus.com/culture/netflix-documentary-tiktok-trend-explainer/", shape: "landscape" },
  { file: "format-spain.webp", title: "I am in Spain without the S", direct: "https://images.unsplash.com/photo-1539037116277-4db20889f2d4?auto=format&fit=crop&w=1200&q=85", shape: "landscape" },
  { file: "slang-iyo.webp", title: "IYO", page: "https://knowyourmeme.com/memes/iyo-tiktok-sound", shape: "landscape" },
  { file: "slang-neegy.webp", title: "Neegy", page: "https://knowyourmeme.com/memes/neegy", shape: "landscape" },
  { file: "slang-mbappe.webp", title: "Mbappe Special", page: "https://knowyourmeme.com/memes/mbappe-special", shape: "landscape" },
  { file: "slang-tlpur.webp", title: "TLPUR", page: "https://knowyourmeme.com/memes/tlpur-slang", shape: "landscape" },
  { file: "slang-boy-kibble.webp", title: "Boy kibble", page: "https://knowyourmeme.com/memes/boy-kibble", shape: "landscape" },
  { file: "creator-speed.webp", title: "IShowSpeed", page: "https://www.youtube.com/@IShowSpeed", shape: "square" },
  { file: "creator-ian.webp", title: "Ian McConnell", page: "https://open.spotify.com/track/1lENTiHBIkczAsB0vYE1Xd", shape: "square" },
  { file: "creator-aora.webp", title: "Aora", page: "https://www.instagram.com/aora.dj/", shape: "square" },
  { file: "creator-limc.webp", title: "Lessons in Meme Culture", page: "https://www.youtube.com/@LIMC", shape: "square" },
  { file: "media-spider-man.webp", title: "Spider-Man Brand New Day", direct: "https://s.movieinsider.com/images/p/964462_m1773880192.jpg", shape: "poster" },
  { file: "media-odyssey.webp", title: "The Odyssey", direct: "https://www.nfbio.dk/sites/nfbio.dk/files/styles/movie_poster/public/media-images/2025-12/gmnt-b41983b128-1529119-vst-694521bb7da8f.jpeg?itok=kUouQPma", shape: "poster" },
  { file: "media-oak-street.webp", title: "End of Oak Street", direct: "https://cdn.kinocheck.com/i/w%3D1200/vsgfjl6w42.jpg", shape: "poster" },
  { file: "media-toy-story.webp", title: "Toy Story 5", direct: "https://m.media-amazon.com/images/M/MV5BMTBlNTEwYmQtNjE1OC00NDRlLWI3M2YtYmRkODVmZTljYWRiXkEyXkFqcGc%40._V1_.jpg", shape: "poster" },
  { file: "media-jujutsu.webp", title: "Jujutsu Kaisen", direct: "https://animotaku.fr/wp-content/uploads/2024/12/anime-jujutsu-kaisen-saison-3-visuel-1.jpg", shape: "poster" },
  { file: "song-bangladesh.webp", title: "Bangladesh", page: "https://open.spotify.com/track/1lENTiHBIkczAsB0vYE1Xd", shape: "square" },
  { file: "song-choosin-texas.webp", title: "Choosin Texas", page: "https://open.spotify.com/track/7scFxt9VhL4FJwuPSfRlfN", shape: "square" },
  { file: "song-hate-love.webp", title: "hate that i made you love me", page: "https://open.spotify.com/track/3idrvUQYONMAJ6EgZZqiL8", shape: "square" },
  { file: "song-u-me.webp", title: "u plus me", page: "https://open.spotify.com/track/6ZIMMWWjupzMw7Qy4d52Vy", shape: "square" },
  { file: "song-ss26.webp", title: "SS26", page: "https://open.spotify.com/track/3d5NbAerF2MMHw9tdIxiFH", shape: "square" },
];

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

const fallbacks = results.filter(({ state }) => state.startsWith("fallback"));
for (const { asset, state } of results) console.log(`${state.padEnd(42)} ${asset.file}`);
console.log(`Prepared ${results.length} images; ${fallbacks.length} used generated fallbacks.`);
if (fallbacks.length > 4) process.exitCode = 1;
