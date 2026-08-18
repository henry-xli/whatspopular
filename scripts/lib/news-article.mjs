import { isIP } from "node:net";
import { assertPublicHostname, fetchBytes } from "./runtime.mjs";

const GOOGLE_NEWS_HOST = "news.google.com";
const USER_AGENT = "whatspopular.com/1.0 (+https://whatspopular.com/about)";

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "�";
    });
}

export function publicHttpsUrl(rawUrl, kind = "external") {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid ${kind} URL`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hostname
    || isIP(hostname) || hostname === "localhost"
    || /\.(?:home|internal|invalid|lan|local|localhost|onion|test)$/.test(hostname)) {
    throw new Error(`Refusing non-public ${kind} URL`);
  }
  url.hostname = hostname;
  return url;
}

function htmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function imageUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    return publicHttpsUrl(new URL(rawUrl, baseUrl), "article image").href;
  } catch {
    return null;
  }
}

function jsonLdImages(value, output, depth = 0, insideImage = false) {
  if (depth > 8 || output.length >= 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (insideImage) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) jsonLdImages(entry, output, depth + 1, insideImage);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:contentUrl|image|thumbnailUrl)$/i.test(key) || (insideImage && key === "url")) {
      jsonLdImages(entry, output, depth + 1, true);
    } else if (depth < 3 && /^(?:@graph|itemListElement|mainEntity)$/i.test(key)) {
      jsonLdImages(entry, output, depth + 1, false);
    }
  }
}

export function extractArticleImage(html, baseUrl) {
  const candidates = [];
  let imageAlt = "";
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    if (/^(?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)$/.test(key)) {
      const url = imageUrl(attributes.content, baseUrl);
      if (url) candidates.push({ url, score: key.startsWith("og:") ? 30 : 20 });
    } else if (/^(?:og:image:alt|twitter:image:alt)$/.test(key) && !imageAlt) {
      imageAlt = attributes.content?.replace(/\s+/g, " ").trim().slice(0, 240) ?? "";
    }
  }
  for (const tag of html.match(/<link\s+[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    if (!/(?:^|\s)image_src(?:\s|$)/i.test(attributes.rel ?? "")) continue;
    const url = imageUrl(attributes.href, baseUrl);
    if (url) candidates.push({ url, score: 15 });
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const rawImages = [];
      let structuredData;
      try {
        structuredData = JSON.parse(match[1].trim());
      } catch {
        structuredData = JSON.parse(decodeHtml(match[1]).trim());
      }
      jsonLdImages(structuredData, rawImages);
      for (const rawImage of rawImages) {
        const url = imageUrl(rawImage, baseUrl);
        if (url) candidates.push({ url, score: 10 });
      }
    } catch {
      // Invalid structured data is common; social metadata remains authoritative.
    }
  }
  const bestByUrl = new Map();
  for (const candidate of candidates) {
    if (!bestByUrl.has(candidate.url) || bestByUrl.get(candidate.url).score < candidate.score) {
      bestByUrl.set(candidate.url, candidate);
    }
  }
  const unique = [...bestByUrl.values()]
    .map((candidate, index) => ({
      ...candidate,
      score: candidate.score - index
        - (/\b(?:avatar|favicon|icon|logo|placeholder|sprite)\b/i.test(candidate.url) ? 25 : 0),
    }))
    .sort((left, right) => right.score - left.score);
  if (!unique.length) throw new Error("The linked article did not provide an image");
  return { imageSource: unique[0].url, imageAlt };
}

function articleText(value) {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function extractArticleIntro(html) {
  const scope = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html;
  const paragraphs = [...scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => articleText(match[1]))
    .filter((text) => text.length >= 45 && text.length <= 1_000)
    .filter((text) => !/^(?:advertisement|subscribe|sign up|newsletter|read more|©|by\s+)/i.test(text))
    .filter((text) => !/\b(?:see more of our coverage|our coverage|in your search results|click here|download our app|follow us|sign up for our|subscribe to our)\b/i.test(text))
    .filter((text, index, values) => values.indexOf(text) === index)
    .slice(0, 3);
  if (!paragraphs.length) return "";
  let result = "";
  for (const paragraph of paragraphs) {
    const candidate = `${result} ${paragraph}`.trim();
    if (candidate.length > 900 && result) break;
    result = candidate;
  }
  return result.slice(0, 860).replace(/\s+\S*$/, "").trim();
}

function relatedArticleHost(candidate, expected) {
  const withoutWww = (hostname) => hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  return withoutWww(candidate) === withoutWww(expected);
}

async function googleNewsBytes(rawUrl, options = {}) {
  return fetchBytes(rawUrl, {
    isAllowedHost: (hostname) => hostname === GOOGLE_NEWS_HOST,
    kind: "Google News article resolver",
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
    timeoutMs: 15_000,
    attempts: 2,
    method: options.method ?? "GET",
    body: options.body,
    headers: {
      accept: options.accept ?? "text/html,application/json;q=0.9,*/*;q=0.5",
      "user-agent": USER_AGENT,
      ...(options.headers ?? {}),
    },
  });
}

function rpcResult(responseText) {
  for (const line of responseText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[[")) continue;
    try {
      const rows = JSON.parse(trimmed);
      const row = rows.find((entry) => Array.isArray(entry) && entry[0] === "wrb.fr" && entry[1] === "Fbv4je");
      if (!row || typeof row[2] !== "string") continue;
      const payload = JSON.parse(row[2]);
      if (payload[0] === "garturlres" && typeof payload[1] === "string") return payload[1];
    } catch {
      // Batch responses can contain unrelated length-prefixed chunks.
    }
  }
  throw new Error("Google News did not return a publisher URL");
}

export async function resolveGoogleNewsArticle(rawUrl) {
  const googleUrl = new URL(rawUrl);
  const token = googleUrl.hostname === GOOGLE_NEWS_HOST
    ? googleUrl.pathname.match(/^\/rss\/articles\/([A-Za-z0-9_-]{20,4096})$/)?.[1]
    : null;
  if (!token) throw new Error("Invalid Google News article URL");
  const page = await googleNewsBytes(googleUrl.href);
  const html = page.buffer.toString("utf8");
  const timestamp = html.match(/\bdata-n-a-ts=["'](\d{9,13})["']/i)?.[1];
  const signature = html.match(/\bdata-n-a-sg=["']([A-Za-z0-9_-]{8,256})["']/i)?.[1];
  if (!timestamp || !signature) throw new Error("Google News article resolver metadata was missing");

  const request = [
    "garturlreq",
    [["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "US:en", null, 180, null, null, null, null, null, 0, null, null, [1608992183, 723341000]], "en-US", "US", 1, [2, 3, 4, 8], 1, 0, "655000234", 0, 0, null, 0],
    token,
    Number(timestamp),
    signature,
  ];
  const body = new URLSearchParams({
    "f.req": JSON.stringify([[['Fbv4je', JSON.stringify(request), null, "generic"]]]),
  });
  const response = await googleNewsBytes("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", {
    method: "POST",
    body,
    maxBytes: 1024 * 1024,
    accept: "application/json",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
  });
  return publicHttpsUrl(rpcResult(response.buffer.toString("utf8")), "publisher article").href;
}

export async function linkedArticleMetadata(articleUrl, { allowMissingImage = false } = {}) {
  const initialUrl = publicHttpsUrl(articleUrl, "publisher article");
  const page = await fetchBytes(initialUrl.href, {
    isAllowedHost: (hostname) => relatedArticleHost(hostname, initialUrl.hostname),
    validateHost: assertPublicHostname,
    kind: "publisher article",
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: 15_000,
    attempts: 2,
    maxRedirects: 2,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9",
      "accept-language": "en-US,en;q=0.8",
      "user-agent": USER_AGENT,
    },
  });
  if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) {
    throw new Error(`Unexpected publisher content type ${page.contentType}`);
  }
  const html = page.buffer.toString("utf8");
  const intro = extractArticleIntro(html);
  try {
    const metadata = extractArticleImage(html, page.finalUrl);
    await assertPublicHostname(new URL(metadata.imageSource).hostname);
    return { url: page.finalUrl, intro, ...metadata };
  } catch (error) {
    if (!allowMissingImage) throw error;
    return { url: page.finalUrl, intro };
  }
}
