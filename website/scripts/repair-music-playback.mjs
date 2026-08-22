import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractMusicSongIdentity } from "./niche-ingestion.mjs";
import { resolveSpecificSpotifyPlayback } from "./music-lookup.mjs";
import { specificMusicPlayback } from "../shared/music-playback.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "data", "niche-trends.json");
const publishedPath = path.join(root, "public", "data", "niche-trends.json");

const brief = JSON.parse(await readFile(sourcePath, "utf8"));
let musicTopics = 0;
let resolvedTopics = 0;
let removedUnrelatedPlayers = 0;

for (const category of brief.categories ?? []) {
  if (category.parent !== "Music") continue;
  for (const topic of category.topics ?? []) {
    musicTopics += 1;
    const inferredIdentity = extractMusicSongIdentity({ headline: topic.title, articleIntro: topic.description });
    const identity = topic.musicSongTitle
      ? {
        title: topic.musicSongTitle,
        ...(topic.musicArtist || inferredIdentity?.artist
          ? { artist: topic.musicArtist ?? inferredIdentity.artist }
          : {}),
      }
      : inferredIdentity;
    if (!identity?.title) {
      const existingPlayback = specificMusicPlayback(topic.playback, {
        text: `${topic.title} ${topic.description} ${topic.whyNow}`,
      });
      if (existingPlayback) {
        topic.playback = existingPlayback;
      } else if (topic.playback) {
        delete topic.playback;
        removedUnrelatedPlayers += 1;
      }
      continue;
    }
    topic.musicKind = "song";
    topic.musicSongTitle = identity.title;
    if (identity.artist) topic.musicArtist = identity.artist;
    else delete topic.musicArtist;
    const playback = await resolveSpecificSpotifyPlayback(topic.playback, {
      text: `${topic.title} ${topic.description} ${topic.whyNow}`,
      title: identity.title,
      artist: identity.artist,
      kind: "song",
    });
    if (playback) {
      topic.playback = playback;
      resolvedTopics += 1;
    } else if (topic.playback) {
      delete topic.playback;
      removedUnrelatedPlayers += 1;
    }
  }
}

const output = `${JSON.stringify(brief, null, 2)}\n`;
await writeFile(sourcePath, output, "utf8");
await writeFile(publishedPath, output, "utf8");
console.log(`Music playback repair: ${resolvedTopics}/${musicTopics} cards received exact Spotify players; ${removedUnrelatedPlayers} unrelated players removed.`);
