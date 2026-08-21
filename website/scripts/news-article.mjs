import { isIP } from "node:net";
import { assertPublicHostname, fetchBytes } from "./runtime.mjs";

const GOOGLE_NEWS_HOST = "news.google.com";
const USER_AGENT = "whatspopular.com/1.0 (+https://whatspopular.com/about)";

const namedHtmlEntities = {
  amp: "&",
  apos: "'",
  bull: "•",
  copy: "©",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lrm: "\u200e",
  lsquo: "‘",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  para: "¶",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  shy: "­",
  thinsp: "\u2009",
  trade: "™",
};

export function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => namedHtmlEntities[name.toLowerCase()] ?? match)
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, decimal) => {
      const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : "�";
    });
}

function decodeHtml(value) {
  return decodeHtmlEntities(value);
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

const playableMediaLabels = {
  "Apple Music": "Listen on Apple Music",
  SoundCloud: "Listen on SoundCloud",
  Spotify: "Listen on Spotify",
  YouTube: "Watch on YouTube",
};

function normalizedMediaUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    return publicHttpsUrl(
      new URL(decodeHtml(rawUrl).trim().replaceAll("\\/", "/"), baseUrl),
      "playback",
    );
  } catch {
    return null;
  }
}

function spotifyMedia(url) {
  if (url.hostname !== "open.spotify.com") return null;
  const match = url.pathname.match(/^\/(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{10,64})\/?$/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  const id = match[2];
  return {
    provider: "Spotify",
    externalUrl: `https://open.spotify.com/${kind}/${id}`,
    embedUrl: `https://open.spotify.com/embed/${kind}/${id}?utm_source=whatspopular&theme=0`,
    label: playableMediaLabels.Spotify,
  };
}

function youtubeMedia(url) {
  const hostname = url.hostname;
  if (!new Set(["m.youtube.com", "www.youtube-nocookie.com", "www.youtube.com", "youtube.com", "youtu.be"]).has(hostname)) {
    return null;
  }
  let videoId = null;
  if (hostname === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (url.pathname === "/watch") {
    videoId = url.searchParams.get("v");
  } else {
    videoId = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/i)?.[1] ?? null;
  }
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  return {
    provider: "YouTube",
    externalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?rel=0`,
    label: playableMediaLabels.YouTube,
  };
}

function soundCloudMedia(url) {
  if (!["soundcloud.com", "www.soundcloud.com"].includes(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, "");
  if (!/^\/[^/]+\/[^/]+(?:\/[^/]+)?$/i.test(path)) return null;
  const externalUrl = `https://soundcloud.com${path}`;
  return {
    provider: "SoundCloud",
    externalUrl,
    embedUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(externalUrl)}&color=%238b5cf6&auto_play=false&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=false`,
    label: playableMediaLabels.SoundCloud,
  };
}

function appleMusicMedia(url) {
  if (!["embed.music.apple.com", "music.apple.com"].includes(url.hostname)) return null;
  if (!/^\/[a-z]{2}(?:-[a-z]{2})?\/(?:album|song|playlist|music-video)\//i.test(url.pathname)) return null;
  const externalUrl = `https://music.apple.com${url.pathname}${url.search}`;
  return {
    provider: "Apple Music",
    externalUrl,
    embedUrl: `https://embed.music.apple.com${url.pathname}${url.search}`,
    label: playableMediaLabels["Apple Music"],
  };
}

export function normalizePlayableMedia(rawUrl, baseUrl) {
  const url = normalizedMediaUrl(rawUrl, baseUrl ?? rawUrl);
  if (!url) return null;
  return spotifyMedia(url) ?? youtubeMedia(url) ?? soundCloudMedia(url) ?? appleMusicMedia(url);
}

function structuredPlayableValues(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined || output.length >= 40) return;
  if (typeof value === "string") {
    output.push({ rawUrl: value, score: 20 });
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) structuredPlayableValues(entry, output, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:contentUrl|embedUrl|sameAs|url)$/i.test(key)) {
      structuredPlayableValues(entry, output, depth + 1);
    } else if (depth < 4 && /^(?:@graph|associatedMedia|mainEntity|subjectOf|video)$/i.test(key)) {
      structuredPlayableValues(entry, output, depth + 1);
    }
  }
}

export function extractPlayableMedia(html, baseUrl) {
  const candidates = [];
  const add = (rawUrl, score) => {
    const playback = normalizePlayableMedia(rawUrl, baseUrl);
    if (playback) candidates.push({ playback, score });
  };

  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    if (/^(?:og:video(?::(?:secure_url|url))?|music:song|twitter:player(?::stream)?)$/.test(key)) {
      add(attributes.content, 36);
    }
  }
  for (const tag of html.match(/<(?:embed|iframe)\s+[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    add(attributes.src ?? attributes["data-src"] ?? attributes["data-embed-url"] ?? attributes["data-url"], 52);
  }
  for (const tag of html.match(/<a\s+[^>]*>/gi) ?? []) {
    add(htmlAttributes(tag).href, 12);
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      let structuredData;
      try {
        structuredData = JSON.parse(match[1].trim());
      } catch {
        structuredData = JSON.parse(decodeHtml(match[1]).trim());
      }
      const values = [];
      structuredPlayableValues(structuredData, values);
      for (const value of values) add(value.rawUrl, value.score);
    } catch {
      // Malformed structured data is common; explicit media tags remain usable.
    }
  }

  const bestByEmbedUrl = new Map();
  for (const candidate of candidates) {
    const current = bestByEmbedUrl.get(candidate.playback.embedUrl);
    if (!current || current.score < candidate.score) bestByEmbedUrl.set(candidate.playback.embedUrl, candidate);
  }
  return [...bestByEmbedUrl.values()].sort((left, right) => right.score - left.score)[0]?.playback ?? null;
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

export function extractArticleTitle(html) {
  for (const tag of html.match(/<meta\s+[^>]*>/gi) ?? []) {
    const attributes = htmlAttributes(tag);
    const key = (attributes.property ?? attributes.name ?? "").toLowerCase();
    if (/^(?:og:title|twitter:title)$/.test(key) && attributes.content?.trim()) {
      return articleText(attributes.content).slice(0, 240);
    }
  }
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? articleText(title).slice(0, 240) : "";
}

function articleText(value) {
  return decodeHtml(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\bU\.\s*S\.\b/gi, "U.S.")
    .replace(/(\d)\.\s+(\d)/g, "$1.$2")
    .trim();
}

function headlineWords(value) {
  return new Set(articleText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !/^(?:about|after|again|also|being|from|have|into|more|most|over|that|their|there|these|they|this|through|under|what|when|where|which|while|with|would|news|report|reports|latest|today|week|weekly|says|said|story|stories|update|updates|release|released|new|time|year|years)$/i.test(word)));
}

function headlineOverlap(value, headline) {
  if (!headline) return 1;
  const words = headlineWords(headline);
  return [...headlineWords(value)].filter((word) => words.has(word)).length;
}

const nonArticleContainerPattern = /<(?:figure|figcaption|aside|nav|header|footer|form|dialog|template)\b[\s\S]*?<\/(?:figure|figcaption|aside|nav|header|footer|form|dialog|template)\s*>/gi;
const nonArticleParagraphAttributePattern = /(?:caption|photo|credit|gallery|sidebar|related|promo|advert|weather|breadcrumb|byline|share|social|comment)/i;
const nonArticleParagraphTextPattern = /^(?:mostly cloudy|partly cloudy|weather forecast|advertisement|sign up for|subscribe to|read more|follow us|copyright|all rights reserved)\b/i;
const publisherBoilerplatePattern = /\b(?:award[- ]winning daily .* publication|daily print newspaper|24\/7 website|voice of the .* community|free e-alerts|breaking news notifications|our coverage|in your search results)\b/i;

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const incompleteSentencePattern = /\b(?:St|Mr|Mrs|Ms|Dr|Prof|No|vs|etc|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/i;

function completeSentences(value, maxLength) {
  let result = "";
  for (const { segment } of sentenceSegmenter.segment(value)) {
    const sentence = segment.trim();
    if (!sentence) continue;
    if (!/[.!?]["'’”)]?$/u.test(sentence)) break;
    if (incompleteSentencePattern.test(sentence)) continue;
    if (/^(?:although|because|but|which|while|with|as)\b/i.test(sentence.replace(/^[\s"“”'’]+/, "")) && sentence.length < 72) break;
    const candidate = `${result} ${sentence}`.trim();
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  return result;
}

export function extractArticleIntro(html, headline = "") {
  const scope = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html;
  const boilerplatePattern = /^(?:reporting by|editing by|edited by|our standards|this article has been reviewed|advertisement|subscribe|sign up|newsletter|read more|©|by\s+)/i;
  const contextPattern = /\b(?:after|amid|announc|accus|brought back|bring(?:s|ing)? back|because|comeback|confirm|debut(?:ed)?|demand|first introduced|introduced|launch|limited(?:[- ]time)?|meme|nostalgia|original(?:ly)?|reaction|return(?:ed|ing)?|re-?released?|removal|removed|revived|viral|fans?|funny|walk(?:ed|ing)?|appearance|sold out|restock(?:ed)?|from\s+20\d{2}|in\s+20\d{2}|win|won|beat|loss|match|tournament|championship|playoffs?|final|injur|trade|transfer|sign(?:ed|ing)?|ruling|vote|strike|storm|fire|earthquake|study|research|mission|update|festival|concert|tour|game|season|episode|chapter|book|film|series|official|executive|proposal|investor|yield|debt)\b/gi;
  const metadata = [...html.matchAll(/<meta\s+[^>]*>/gi)]
    .map((match) => htmlAttributes(match[0]))
    .filter((attributes) => /^(?:description|og:description|twitter:description)$/i.test(attributes.property ?? attributes.name ?? "")
      || /^description$/i.test(attributes.itemprop ?? ""))
    .map((attributes) => articleText(attributes.content ?? ""))
    .filter((text) => text.length >= 45 && text.length <= 720
      && !boilerplatePattern.test(text)
      && !publisherBoilerplatePattern.test(text)
      && (!headline || headlineOverlap(text, headline) >= 1))
    .map((text, index) => ({
      text: completeSentences(text, 720),
      index: -100 + index,
      isMetadata: true,
      contextScore: (text.match(contextPattern) ?? []).length + 8 + headlineOverlap(text, headline) * 2,
    }));
  const paragraphScope = scope.replace(nonArticleContainerPattern, " ");
  const paragraphs = [...paragraphScope.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
    .map((match) => ({ attributes: match[1], text: articleText(match[2]) }))
    .filter(({ attributes, text }) => !nonArticleParagraphAttributePattern.test(attributes ?? "")
      && !nonArticleParagraphTextPattern.test(text))
    .map(({ text }) => text)
    .filter((text) => text.length >= 45 && text.length <= 720)
    .filter((text) => !boilerplatePattern.test(text) && !publisherBoilerplatePattern.test(text))
    .filter((text) => !/\b(?:see more of our coverage|our coverage|in your search results|click here|download our app|follow us|sign up for our|subscribe to our)\b/i.test(text))
    .filter((text, index, values) => values.indexOf(text) === index)
    .map((text, index) => ({
      text: completeSentences(text, 720),
      index,
      isMetadata: false,
      contextScore: (text.match(contextPattern) ?? []).length + (text.length >= 90 && text.length <= 520 ? 1 : 0) + headlineOverlap(text, headline) * 2,
    }))
    .filter((entry) => entry.text);
  if (!paragraphs.length && !metadata.length) return "";
  const selected = metadata.concat(paragraphs)
    .slice()
    .sort((left, right) => right.contextScore - left.contextScore || Number(right.isMetadata) - Number(left.isMetadata) || left.index - right.index)
    .slice(0, 5)
    .sort((left, right) => left.index - right.index)
    .filter((entry, index, values) => values.findIndex((candidate) => candidate.text === entry.text) === index);
  let result = "";
  for (const paragraph of selected) {
    const candidate = `${result} ${paragraph.text}`.trim();
    if (candidate.length > 1_400 && result) break;
    result = candidate;
  }
  return completeSentences(result, 1_400);
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
  const resolved = publicHttpsUrl(rpcResult(response.buffer.toString("utf8")), "publisher article");
  if (resolved.hostname === "google.com" || resolved.hostname.endsWith(".google.com")) {
    throw new Error("Google News did not resolve to a publisher article");
  }
  return resolved.href;
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
  const title = extractArticleTitle(html);
  const intro = extractArticleIntro(html, title);
  const playback = extractPlayableMedia(html, page.finalUrl);
  try {
    const metadata = extractArticleImage(html, page.finalUrl);
    await assertPublicHostname(new URL(metadata.imageSource).hostname);
    return { url: page.finalUrl, title, intro, ...(playback ? { playback } : {}), ...metadata };
  } catch (error) {
    if (!allowMissingImage) throw error;
    return { url: page.finalUrl, title, intro, ...(playback ? { playback } : {}) };
  }
}
