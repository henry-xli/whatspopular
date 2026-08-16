import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { fetchBytes, mapConcurrent } from "./lib/runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "public", "culture");
const force = process.argv.includes("--force");
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 18_000;

const pageHosts = new Set([
  "en.wikipedia.org",
  "knowyourmeme.com",
  "open.spotify.com",
  "www.imdb.com",
]);

const imageHosts = new Set([
  "images.metahub.space",
  "live.metahub.space",
]);

const allowedImageSuffixes = [
  ".kym-cdn.com",
  ".scdn.co",
  ".wikimedia.org",
];

const assets = [];

const brief = JSON.parse(await readFile(path.join(root, "data", "trends.json"), "utf8"));
if (!Array.isArray(brief.sections) || brief.sections.length !== 5
  || brief.sections.some((section) => !Array.isArray(section.items) || section.items.length !== 5)) {
  throw new Error("Refusing to modify cached images for an invalid briefing");
}
const referencedFiles = new Set(brief.sections.flatMap((section) =>
  [...section.items, ...(section.moreItems ?? [])].map((item) => {
    if (!/^\/culture\/[a-z0-9-]+\.webp$/.test(item.image)) {
      throw new Error(`Refusing invalid cached image path: ${item.image}`);
    }
    return path.basename(item.image);
  }),
));
for (let index = assets.length - 1; index >= 0; index -= 1) {
  if (!referencedFiles.has(assets[index].file)) assets.splice(index, 1);
}
const knownFiles = new Set(assets.map((asset) => asset.file));
for (const section of brief.sections) {
  for (const item of [...section.items, ...(section.moreItems ?? [])]) {
    const file = path.basename(item.image);
    if (knownFiles.has(file)) continue;
    const imdbId = section.id === "watch" ? item.url.match(/tt[0-9]{7,9}/)?.[0] : null;
    assets.push({
      file,
      title: item.title,
      page: item.url,
      ...(imdbId ? { direct: `https://images.metahub.space/poster/medium/${imdbId}/img` } : {}),
      shape: section.layout,
    });
    knownFiles.add(file);
  }
}

async function fetchLimited(rawUrl, kind) {
  return fetchBytes(rawUrl, {
    isAllowedHost: (hostname) => kind === "page"
      ? pageHosts.has(hostname)
      : imageHosts.has(hostname) || allowedImageSuffixes.some((suffix) => hostname.endsWith(suffix)),
    kind,
    maxBytes: MAX_BYTES,
    timeoutMs: TIMEOUT_MS,
    headers: {
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
      accept: kind === "page" ? "text/html,application/xhtml+xml" : "image/avif,image/webp,image/*,*/*;q=0.7",
    },
  });
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

async function validImage(file, shape, format = "webp") {
  try {
    if ((await stat(file)).size <= 5000) return false;
    const metadata = await sharp(file, { limitInputPixels: 40_000_000 }).metadata();
    const expected = dimensions(shape);
    return metadata.format === format && metadata.width === expected.width && metadata.height === expected.height;
  } catch {
    return false;
  }
}

function dimensions(shape) {
  if (shape === "icon") return { width: 512, height: 512 };
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

async function writeWebp(input, destination, shape) {
  const { width, height } = dimensions(shape);
  const temporary = `${destination}.${process.pid}.tmp.webp`;
  try {
    await sharp(input, { failOn: "warning", limitInputPixels: 40_000_000, sequentialRead: true })
      .rotate()
      .resize(width, height, { fit: "cover", position: "attention" })
      .webp({ quality: 78, effort: 5, smartSubsample: true })
      .toFile(temporary);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function processAsset(asset) {
  const destination = path.join(outputRoot, asset.file);
  const cached = await validImage(destination, asset.shape);
  if (!force && cached) return { asset, state: "cached" };

  try {
    const imageUrl = await resolveImage(asset);
    const image = await fetchLimited(imageUrl, "image");
    if (!/^image\/(?:avif|gif|jpeg|png|webp)\b/i.test(image.contentType)) {
      throw new Error(`Unexpected content type ${image.contentType}`);
    }
    await writeWebp(image.buffer, destination, asset.shape);
    return { asset, state: "downloaded" };
  } catch (error) {
    if (cached) return { asset, state: `stale (${error instanceof Error ? error.message : String(error)})` };
    await writeWebp(fallbackCard(asset.title, asset.shape), destination, asset.shape);
    return { asset, state: `fallback (${error instanceof Error ? error.message : String(error)})` };
  }
}

async function buildIcon() {
  const destination = path.join(root, "public", "icon.png");
  if (!force && await validImage(destination, "icon", "png")) return;
  const icon = Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" rx="124" fill="#6f48e5"/><text x="256" y="325" text-anchor="middle" fill="#fff" font-size="260" font-family="Arial,sans-serif" font-weight="800" letter-spacing="-30">w?</text></svg>`);
  const temporary = `${destination}.${process.pid}.tmp.png`;
  try {
    await sharp(icon, { limitInputPixels: 40_000_000 }).png({ compressionLevel: 9 }).toFile(temporary);
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

await mkdir(outputRoot, { recursive: true });
sharp.cache({ files: 0, items: 64, memory: 64 });
sharp.concurrency(1);
const results = await mapConcurrent(assets, 4, processAsset);
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
