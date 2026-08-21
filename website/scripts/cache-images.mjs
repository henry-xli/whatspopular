import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { assertPublicHostname, fetchBytes, mapConcurrent } from "./runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "public", "culture");
const force = process.argv.includes("--force");
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 18_000;

const pageHosts = new Set([
  "en.wikipedia.org",
  "knowyourmeme.com",
  "news.google.com",
  "www.goodreads.com",
  "open.spotify.com",
  "www.amazon.com",
  "www.imdb.com",
]);

const imageHosts = new Set([
  "images.metahub.space",
  "live.metahub.space",
]);

const allowedImageSuffixes = [
  ".kym-cdn.com",
  ".gr-assets.com",
  ".media-amazon.com",
  ".scdn.co",
  ".wikimedia.org",
];

const assets = [];

const brief = JSON.parse(await readFile(path.join(root, "data", "trends.json"), "utf8"));
const nicheBrief = JSON.parse(await readFile(path.join(root, "data", "niche-trends.json"), "utf8"));
if (!Array.isArray(brief.sections) || brief.sections.length !== 8
  || brief.sections.some((section) => !Array.isArray(section.items) || section.items.length !== 5)) {
  throw new Error("Refusing to modify cached images for an invalid briefing");
}
if (!Array.isArray(nicheBrief.categories)
  || nicheBrief.categories.some((category) => !Array.isArray(category.topics) || category.topics.length < 1)) {
  throw new Error("Refusing to modify cached images for an invalid niche briefing");
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
    const imdbId = section.id === "movies" ? item.url.match(/tt[0-9]{7,9}/)?.[0] : null;
    assets.push({
      file,
      title: item.title,
      page: item.url,
      section: section.id,
      refreshDaily: section.id === "news" || section.id === "products",
      expectedFallback: section.id === "news" && !item.imageSource,
      fit: section.id === "news" && /(?:logo|seal)/i.test(item.imageSource ?? "") ? "contain" : "cover",
      position: section.id === "news" ? "centre" : "attention",
      ...(item.imageSource
        ? { direct: item.imageSource, directKind: item.imageSourceKind }
        : imdbId
          ? { direct: `https://images.metahub.space/poster/medium/${imdbId}/img` }
          : {}),
      shape: section.layout,
    });
    knownFiles.add(file);
  }
}
for (const category of nicheBrief.categories) {
  for (const topic of category.topics) {
    if (!/^\/culture\/niche-[a-z0-9-]+\.webp$/.test(topic.image)) {
      throw new Error(`Refusing invalid niche cached image path: ${topic.image}`);
    }
    const file = path.basename(topic.image);
    if (knownFiles.has(file)) continue;
    assets.push({
      file,
      title: topic.title,
      page: topic.url,
      section: "niche",
      refreshDaily: true,
      // A source image is always attempted when present. If the publisher
      // blocks it, the generated title card is still topic-specific rather
      // than borrowing another article's image.
      expectedFallback: !topic.imageSource,
      fit: "cover",
      position: "attention",
      ...(topic.imageSource ? { direct: topic.imageSource, directKind: "article" } : {}),
      shape: "wide",
    });
    knownFiles.add(file);
  }
}

async function fetchLimited(rawUrl, kind, directKind, allowPublicHost = false) {
  const directHost = directKind === "article" ? new URL(rawUrl).hostname : null;
  return fetchBytes(rawUrl, {
    isAllowedHost: (hostname) => kind === "page"
      ? pageHosts.has(hostname) || (allowPublicHost && hostname !== "news.google.com")
      : imageHosts.has(hostname) || allowedImageSuffixes.some((suffix) => hostname.endsWith(suffix))
        || hostname === directHost || (allowPublicHost && hostname !== "news.google.com"),
    validateHost: directHost || allowPublicHost ? assertPublicHostname : undefined,
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

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2f;/gi, "/");
}

function normalize(value) {
  return decodeHtml(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function htmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function safeImageUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl.trim().replace(/^data:/i, ""), baseUrl);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function imageCandidatesFromValue(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined || output.length > 80) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) imageCandidatesFromValue(entry, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:image|contentUrl|thumbnailUrl)$/i.test(key)) imageCandidatesFromValue(entry, output, depth + 1);
    else if (depth < 4 && /^(?:@graph|mainEntity|itemListElement|offers)$/i.test(key)) imageCandidatesFromValue(entry, output, depth + 1);
  }
}

function productImageUrlScore(candidate, titleTokens) {
  const searchable = normalize(`${candidate.alt} ${candidate.src} ${candidate.className}`);
  const matches = titleTokens.filter((token) => searchable.split(" ").includes(token)).length;
  const logoLike = /\b(?:avatar|favicon|icon|logo|logos|placeholder|sprite|wordmark|badge|banner)\b/i.test(searchable);
  const productCue = /\b(?:product|gallery|detail|variant|media|thumbnail|pdp|zoom)\b/i.test(searchable);
  return matches * 16 + (candidate.isProductData ? 42 : 0) + (productCue ? 8 : 0) - (logoLike ? 100 : 0);
}

function extractProductImage(html, baseUrl, title) {
  const titleTokens = normalize(title).split(" ").filter((token) => token.length > 2
    && !new Set(["the", "and", "for", "with", "product", "item", "consumer"]).has(token));
  const candidates = [];
  const add = (rawUrl, metadata = {}) => {
    const url = safeImageUrl(rawUrl, baseUrl);
    if (!url) return;
    candidates.push({ url, ...metadata, score: productImageUrlScore({ ...metadata, src: url }, titleTokens) });
  };
  for (const tag of html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []) {
    const body = tag.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      const data = JSON.parse(decodeHtml(body));
      const values = [];
      imageCandidatesFromValue(data, values);
      for (const value of values) add(value, { alt: title, className: "product structured-data", isProductData: true });
    } catch {
      // Malformed structured data is common; image tags remain usable.
    }
  }
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const srcset = attrs.srcset ?? attrs["data-srcset"] ?? "";
    const srcsetUrl = srcset.split(",").map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean).at(-1);
    add(attrs.src ?? attrs["data-src"] ?? attrs["data-lazy-src"] ?? attrs["data-original"] ?? srcsetUrl, {
      alt: attrs.alt ?? "",
      className: `${attrs.class ?? ""} ${attrs.id ?? ""}`,
    });
    const dynamic = attrs["data-a-dynamic-image"];
    if (dynamic) {
      try {
        for (const value of Object.keys(JSON.parse(dynamic))) add(value, { alt: attrs.alt ?? "", className: "product dynamic-image" });
      } catch {
        // Amazon sometimes emits truncated JSON in an image attribute.
      }
    }
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = htmlAttributes(tag);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (/^(?:og:image(?::url|:secure_url)?|twitter:image(?::src)?)$/.test(key)) {
      add(attrs.content, { alt: attrs["og:image:alt"] ?? "", className: "social-preview" });
    }
  }
  const unique = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
    .filter((candidate) => !/\b(?:avatar|favicon|icon|logo|logos|placeholder|sprite|wordmark)\b/i.test(normalize(`${candidate.url} ${candidate.alt} ${candidate.className}`)))
    .sort((left, right) => right.score - left.score);
  if (!unique.length || unique[0].score < 0) throw new Error("No product-specific image was found");
  return unique[0].url;
}

async function resolveImage(asset) {
  const allowPublicHost = asset.section === "products";
  const productPage = asset.section === "products" && (() => {
    try {
      const url = new URL(asset.page);
      return url.hostname === "www.amazon.com" && (/^\/s(?:\/|$)/i.test(url.pathname) || /^\/dp\//i.test(url.pathname));
    } catch {
      return false;
    }
  })();
  if (productPage && asset.directKind !== "commerce") {
    try {
      const page = await fetchLimited(asset.page, "page", undefined, allowPublicHost);
      const productImage = extractProductImage(page.buffer.toString("utf8"), page.finalUrl, asset.title);
      if (productImage) return productImage;
    } catch {
      // Amazon often serves a consent or bot-check page; keep the validated source image below.
    }
  }
  if (asset.direct) return asset.direct;
  const page = await fetchLimited(asset.page, "page", undefined, allowPublicHost);
  const html = page.buffer.toString("utf8");
  if (asset.section === "products") return extractProductImage(html, page.finalUrl, asset.title);
  return extractOgImage(html, page.finalUrl);
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
  const maxCharacters = shape === "poster" ? 16 : shape === "square" ? 19 : 24;
  const lines = [];
  for (const word of title.split(/\s+/).filter(Boolean)) {
    const current = lines.at(-1);
    if (!current || `${current} ${word}`.length > maxCharacters) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  const visibleLines = lines.slice(0, 3);
  if (lines.length > 3) visibleLines[2] = lines.slice(2).join(" ");
  const longestLine = Math.max(...visibleLines.map((line) => line.length), 1);
  const fontSize = Math.max(34, Math.min(64, Math.floor((width * 0.84) / (longestLine * 0.58))));
  const lineHeight = Math.round(fontSize * 1.08);
  const firstLineY = Math.round(height * 0.47 - ((visibleLines.length - 1) * lineHeight) / 2);
  const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const text = visibleLines.map((line, index) => `<tspan x="${width * 0.08}" y="${firstLineY + index * lineHeight}">${escape(line)}</tspan>`).join("");
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#6f48e5"/><circle cx="${width * 0.8}" cy="${height * 0.15}" r="${width * 0.2}" fill="#d4f163"/><path d="M0 ${height * 0.68} Q ${width * 0.4} ${height * 0.43} ${width} ${height * 0.72} V ${height} H0Z" fill="#ff765f"/><text fill="#fff" font-size="${fontSize}" font-family="Georgia,serif" font-weight="700">${text}</text></svg>`);
}

async function writeWebp(input, destination, shape, fit = "cover", position = "attention") {
  const { width, height } = dimensions(shape);
  const temporary = `${destination}.${process.pid}.tmp.webp`;
  try {
    await sharp(input, { failOn: "warning", limitInputPixels: 40_000_000, sequentialRead: true })
      .rotate()
      .resize(width, height, { fit, position })
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
  if (!force && cached && !asset.refreshDaily) return { asset, state: "cached" };

  try {
    const imageUrl = await resolveImage(asset);
    const image = await fetchLimited(imageUrl, "image", asset.directKind, asset.section === "products");
    if (!/^image\/(?:avif|gif|jpeg|png|webp)\b/i.test(image.contentType)) {
      throw new Error(`Unexpected content type ${image.contentType}`);
    }
    await writeWebp(image.buffer, destination, asset.shape, asset.fit, asset.position);
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
const unexpectedFallbacks = fallbacks.filter(({ asset }) => !asset.expectedFallback);
for (const { asset, state } of results) console.log(`${state.padEnd(42)} ${asset.file}`);
console.log(`Prepared ${results.length} images; ${fallbacks.length} used generated fallbacks (${unexpectedFallbacks.length} unexpected).`);
if (removedFiles.length) console.log(`Removed ${removedFiles.length} obsolete cached images.`);
if (unexpectedFallbacks.length > 4) process.exitCode = 1;
