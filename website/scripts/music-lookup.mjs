import { createRateLimiter, fetchBytes, mapConcurrent } from "./runtime.mjs";
import { specificMusicPlayback } from "../shared/music-playback.mjs";

const spotifyIdPattern = /^[A-Za-z0-9]{10,64}$/;
const lookupCache = new Map();
const spotifyTokenCache = { value: "", expiresAt: 0 };
const braveSchedule = createRateLimiter(250);
const lookupTimeoutMs = 12_000;
const lookupMaxBytes = 1_500_000;

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeMusicIdentity(value) {
  return decodeHtmlEntities(String(value ?? ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function spotifyKindForIdentity(kind) {
  if (kind === "album" || kind === "record" || kind === "ep") return "album";
  return "track";
}

function spotifyPlayback(kind, id) {
  if (!spotifyIdPattern.test(id)) return null;
  return {
    provider: "Spotify",
    kind,
    externalUrl: `https://open.spotify.com/${kind}/${id}`,
    embedUrl: `https://open.spotify.com/embed/${kind}/${id}?utm_source=whatspopular&theme=0`,
    label: "Listen on Spotify",
  };
}

function artistMatches(actualArtist, requestedArtist) {
  const actual = normalizeMusicIdentity(actualArtist);
  const requested = normalizeMusicIdentity(requestedArtist);
  if (!requested) return true;
  return actual === requested || actual.includes(requested) || requested.includes(actual);
}

function titleMatches(actualTitle, requestedTitle) {
  return normalizeMusicIdentity(actualTitle) === normalizeMusicIdentity(requestedTitle);
}

export function selectExactSpotifyItem(items, identity = {}) {
  const kind = spotifyKindForIdentity(identity.kind);
  const title = String(identity.title ?? "").trim();
  if (!title) return null;
  return (Array.isArray(items) ? items : []).find((item) => {
    if (!item || !titleMatches(item.name, title)) return false;
    const artists = Array.isArray(item.artists) ? item.artists.map((artist) => artist?.name).filter(Boolean) : [];
    return artistMatches(artists.join(", "), identity.artist) && spotifyPlayback(kind, String(item.id ?? ""));
  }) ?? null;
}

export function spotifyPlaybackFromItem(item, identity = {}) {
  if (!item) return null;
  const kind = spotifyKindForIdentity(identity.kind);
  const playback = spotifyPlayback(kind, String(item.id ?? ""));
  if (!playback || !titleMatches(item.name, identity.title)) return null;
  const artists = Array.isArray(item.artists) ? item.artists.map((artist) => artist?.name).filter(Boolean) : [];
  if (!artistMatches(artists.join(", "), identity.artist)) return null;
  return playback;
}

function spotifyLinksFromSearch(html, requestedKind) {
  const decoded = decodeHtmlEntities(String(html ?? ""))
    .replaceAll("\\/", "/")
    .replaceAll("\\u002F", "/");
  const links = [];
  const pattern = /https?:\/\/open\.spotify\.com\/(track|album)\/([A-Za-z0-9]{10,64})/gi;
  for (const match of decoded.matchAll(pattern)) {
    const kind = match[1].toLocaleLowerCase("en-US");
    const id = match[2];
    if (kind !== requestedKind || !spotifyIdPattern.test(id)) continue;
    const key = `${kind}:${id}`;
    if (!links.some((link) => link.key === key)) links.push({ kind, id, key });
  }
  return links;
}

function metaContent(html, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\b[^>]*(?:property|name)=["']${escapedKey}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${escapedKey}["'][^>]*>`, "i"),
  ];
  return decodeHtmlEntities(patterns.map((pattern) => String(html ?? "").match(pattern)?.[1] ?? "").find(Boolean) ?? "");
}

function spotifyPageIdentity(html, kind) {
  const rawTitle = metaContent(html, "og:title") || String(html ?? "").match(/<title[^>]*>([^<]+)/i)?.[1] || "";
  const description = metaContent(html, "og:description");
  const pageTitle = kind === "album"
    ? rawTitle.replace(/\s+-\s+(?:album|ep)\s+by\s+.+?\s*\|\s*spotify\s*$/i, "").trim()
    : rawTitle.replace(/\s+-\s+song and lyrics by\s+.+?\s*\|\s*spotify\s*$/i, "").trim();
  const artist = description.split("·")[0]?.trim() ?? "";
  return { title: pageTitle, artist };
}

export function spotifyPageMatchesIdentity(html, identity = {}, kind = spotifyKindForIdentity(identity.kind)) {
  const page = spotifyPageIdentity(html, kind);
  return titleMatches(page.title, identity.title) && artistMatches(page.artist, identity.artist);
}

async function fetchSpotifyPage(kind, id) {
  const { buffer } = await fetchBytes(`https://open.spotify.com/${kind}/${id}`, {
    isAllowedHost: (hostname) => hostname === "open.spotify.com",
    kind: "Spotify identity lookup",
    maxBytes: 700_000,
    timeoutMs: lookupTimeoutMs,
    attempts: 2,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
    },
  });
  return buffer.toString("utf8");
}

async function spotifyAccessToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return "";
  if (spotifyTokenCache.value && spotifyTokenCache.expiresAt > Date.now() + 30_000) return spotifyTokenCache.value;
  const { buffer } = await fetchBytes("https://accounts.spotify.com/api/token", {
    isAllowedHost: (hostname) => hostname === "accounts.spotify.com",
    kind: "Spotify token request",
    maxBytes: 100_000,
    timeoutMs: lookupTimeoutMs,
    attempts: 2,
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const payload = JSON.parse(buffer.toString("utf8"));
  if (!payload.access_token) return "";
  spotifyTokenCache.value = payload.access_token;
  spotifyTokenCache.expiresAt = Date.now() + Number(payload.expires_in ?? 3600) * 1000;
  return spotifyTokenCache.value;
}

async function spotifyApiSearch(identity) {
  const token = await spotifyAccessToken();
  if (!token || !identity.title || !identity.artist) return null;
  const type = spotifyKindForIdentity(identity.kind) === "album" ? "album" : "track";
  const query = `${type}:${identity.title} artist:${identity.artist}`;
  const url = new URL("https://api.spotify.com/v1/search");
  url.search = new URLSearchParams({ q: query, type, limit: "10", market: "US" });
  const { buffer } = await fetchBytes(url, {
    isAllowedHost: (hostname) => hostname === "api.spotify.com",
    kind: "Spotify catalog search",
    maxBytes: lookupMaxBytes,
    timeoutMs: lookupTimeoutMs,
    attempts: 2,
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
  });
  const payload = JSON.parse(buffer.toString("utf8"));
  const items = payload?.[`${type}s`]?.items ?? [];
  return spotifyPlaybackFromItem(selectExactSpotifyItem(items, identity), identity);
}

async function braveSearch(identity) {
  const kind = spotifyKindForIdentity(identity.kind);
  const quoted = `site:open.spotify.com/${kind} "${identity.title}"${identity.artist ? ` "${identity.artist}"` : ""}`;
  const url = new URL("https://search.brave.com/search");
  // Brave occasionally returns a rate-limit page for its default spelling
  // pass; disabling that extra pass keeps this bounded lookup deterministic.
  url.search = new URLSearchParams({ q: quoted, source: "web", spellcheck: "0" });
  const { buffer } = await braveSchedule(() => fetchBytes(url, {
    isAllowedHost: (hostname) => hostname === "search.brave.com",
    kind: "Spotify web search",
    maxBytes: lookupMaxBytes,
    timeoutMs: lookupTimeoutMs,
    attempts: 2,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
    },
  }));
  return spotifyLinksFromSearch(buffer.toString("utf8"), kind);
}

async function verifiedBravePlayback(identity) {
  if (!identity.title || !identity.artist) return null;
  const candidates = await braveSearch(identity);
  const verified = await mapConcurrent(candidates.slice(0, 5), 3, async (candidate) => {
    try {
      const html = await fetchSpotifyPage(candidate.kind, candidate.id);
      return spotifyPageMatchesIdentity(html, identity, candidate.kind)
        ? spotifyPlayback(candidate.kind, candidate.id)
        : null;
    } catch {
      return null;
    }
  });
  return verified.find(Boolean) ?? null;
}

/**
 * Resolve a Spotify player only for the named track/album on a card. The
 * article's own media wins when it is already exact; otherwise the catalog
 * API or a bounded web search is used, and every result is verified against
 * Spotify's title and artist metadata before it can reach the snapshot.
 */
export async function resolveSpecificSpotifyPlayback(initialPlayback, identity = {}) {
  const text = String(identity.text ?? "");
  const title = String(identity.title ?? "").trim();
  const artist = String(identity.artist ?? "").trim();
  const kind = spotifyKindForIdentity(identity.kind);
  const direct = specificMusicPlayback(initialPlayback, { text, title, artist });
  if (direct) return direct;
  if (!title || !artist) return null;

  const cacheKey = `${kind}|${normalizeMusicIdentity(title)}|${normalizeMusicIdentity(artist)}`;
  if (!lookupCache.has(cacheKey)) {
    lookupCache.set(cacheKey, (async () => {
      try {
        const apiResult = await spotifyApiSearch({ ...identity, title, artist, kind });
        if (apiResult) return apiResult;
      } catch (error) {
        console.warn(`Spotify catalog lookup unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        return await verifiedBravePlayback({ ...identity, title, artist, kind });
      } catch (error) {
        console.warn(`Spotify web lookup unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    })());
  }
  const resolved = await lookupCache.get(cacheKey);
  return specificMusicPlayback(resolved, { text, title, artist });
}
