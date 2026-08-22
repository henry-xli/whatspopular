const spotifyIdPattern = /^[A-Za-z0-9]{10,64}$/;
const genericMusicEntityWords = new Set([
  "a", "an", "and", "album", "artist", "audio", "by", "debut", "edition", "ep", "from", "his", "her",
  "latest", "mixtape", "music", "new", "record", "release", "remix", "single", "song", "sound", "the",
  "their", "track", "under", "upcoming", "video",
]);

function normalizeMusicText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function spotifyResource(value, embedded) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "open.spotify.com") return null;
  const prefix = embedded ? "embed/" : "";
  const match = url.pathname.match(new RegExp(`^/${prefix}(track|album)/([A-Za-z0-9]{10,64})/?$`, "i"));
  if (!match || !spotifyIdPattern.test(match[2])) return null;
  return { kind: match[1].toLocaleLowerCase("en-US"), id: match[2] };
}

function musicCuePattern(kind) {
  return kind === "album"
    ? /\b(?:album|EP|mixtape|record)\b/i
    : /\b(?:song|track|single|remix|music video|official audio)\b/i;
}

function hasNamedMusicEntity(text, kind) {
  const cue = musicCuePattern(kind);
  const source = String(text ?? "");
  const quotedEntity = /["“]([^"“”]{2,90})["”]|[‘']([^'’]{2,90})[’']/;
  for (const match of source.matchAll(new RegExp(cue.source, `${cue.flags}g`))) {
    const index = match.index ?? 0;
    const window = source.slice(Math.max(0, index - 120), Math.min(source.length, index + match[0].length + 120));
    if (quotedEntity.test(window)) return true;

    const after = source.slice(index + match[0].length, index + match[0].length + 90)
      .replace(/^\s*(?:called|titled|named)\s+/i, "")
      .match(/^\s*([\p{L}\p{N}][\p{L}\p{N}'’.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’.-]*){0,5})/u)?.[1] ?? "";
    const before = source.slice(Math.max(0, index - 90), index)
      .match(/([\p{L}\p{N}][\p{L}\p{N}'’.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’.-]*){0,5})\s*$/u)?.[1] ?? "";
    const candidate = after || before;
    const firstWord = normalizeMusicText(candidate).split(" ")[0] ?? "";
    if (firstWord && !genericMusicEntityWords.has(firstWord)) return true;
  }
  return false;
}

/**
 * Return playback only when it is a canonical Spotify track/album whose
 * matching music identity is present in the card's own text. Playlists and
 * unrelated provider embeds intentionally fail closed.
 */
export function specificMusicPlayback(playback, { text = "", title = "", artist = "" } = {}) {
  if (!playback || playback.provider !== "Spotify") return null;
  const external = spotifyResource(playback.externalUrl, false);
  const embed = spotifyResource(playback.embedUrl, true);
  if (!external || !embed || external.kind !== embed.kind || external.id !== embed.id) return null;
  if (playback.kind && playback.kind !== external.kind) return null;

  const source = String(text ?? "");
  if (!musicCuePattern(external.kind).test(source)) return null;
  const normalizedSource = normalizeMusicText(source);
  if (title && !normalizedSource.includes(normalizeMusicText(title))) return null;
  if (artist && !normalizedSource.includes(normalizeMusicText(artist))) return null;
  if (!title && !hasNamedMusicEntity(source, external.kind)) return null;
  return { ...playback, kind: external.kind };
}
