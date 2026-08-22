const focusDefinitions = [
  { key: "hook", label: "the hook or chorus", pattern: /\b(?:hook|chorus|refrain|catchy|earworm)\b/i },
  { key: "lyrics", label: "the lyrics", pattern: /\b(?:lyric(?:s)?|line|verse|bars?)\b/i },
  { key: "vocals", label: "the vocals", pattern: /\b(?:vocal(?:s)?|voice|sing(?:s|ing)?|falsetto|harmon(?:y|ies))\b/i },
  { key: "beat", label: "the beat or drop", pattern: /\b(?:beat|drop|bassline|drum(?:s)?|rhythm|tempo)\b/i },
  { key: "production", label: "the production", pattern: /\b(?:production|mix(?:ing)?|instrumental|synth(?:s|es)?|sample(?:s|d)?|arrangement)\b/i },
  { key: "sound", label: "the sound or audio clip", pattern: /\b(?:sound|audio|snippet|clip|soundtrack)\b/i },
  { key: "visuals", label: "the video or visuals", pattern: /\b(?:music video|video|visual(?:s)?|performance|live clip)\b/i },
];

const useDefinitions = [
  { key: "short-form", label: "short-form videos", pattern: /\b(?:TikTok|Reels?|Shorts?|short[- ]form|viral video)\b/i },
  { key: "edits", label: "edits", pattern: /\b(?:edit(?:s|ed|ing)?|fan cam|fancam)\b/i },
  { key: "dance", label: "dance clips", pattern: /\b(?:dance|choreograph(?:y|ies)|challenge)\b/i },
  { key: "playlists", label: "playlists", pattern: /\b(?:playlist(?:s)?|rotation|stream(?:s|ed|ing)?)\b/i },
  { key: "singalong", label: "sing-alongs or covers", pattern: /\b(?:cover(?:s|ed|ing)?|karaoke|sing(?:s|ing)? along|singalong)\b/i },
  { key: "meme", label: "memes", pattern: /\b(?:meme(?:s|d|ing)?|joke|parody)\b/i },
  { key: "workout-party", label: "workouts or parties", pattern: /\b(?:workout|gym|party|club|rave)\b/i },
];

const sentimentDefinitions = {
  positive: /\b(?:love|loves|loved|like|likes|liked|praise|praised|favorite|favourite|obsess(?:ed|ion)|catchy|earworm|infectious|addictive|singable|replayable|acclaim(?:ed)?|celebrat(?:ed|ing))\b/i,
  negative: /\b(?:hate|hated|dislike|disliked|bad|worst|terrible|awful|cringe|flop(?:ped)?|critic(?:ized|ism)|mock(?:ed|ing)|ridiculous|annoying|irritating|divisive backlash)\b/i,
  mixed: /\b(?:mixed|divided|polariz(?:ed|ing)|controvers(?:y|ial)|debate|backlash|love[- ]hate|some fans|not everyone)\b/i,
};

const allowedFocus = new Set(focusDefinitions.map((entry) => entry.label));
const allowedUse = new Set(useDefinitions.map((entry) => entry.label));
const allowedSentiments = new Set(["positive", "mixed", "negative", "unclear"]);

function clean(value, maxLength = 360) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function completeNote(value) {
  const text = clean(value);
  if (!text) return "";
  const match = text.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match?.[0] ?? text).trim();
}

export function musicAudienceAnalysis(value) {
  const note = completeNote(value);
  if (note.length < 25) return null;

  const focus = focusDefinitions.filter((entry) => entry.pattern.test(note)).map((entry) => entry.label);
  const use = useDefinitions.filter((entry) => entry.pattern.test(note)).map((entry) => entry.label);
  const sentiment = sentimentDefinitions.mixed.test(note)
    ? "mixed"
    : sentimentDefinitions.negative.test(note)
      ? "negative"
      : sentimentDefinitions.positive.test(note)
        ? "positive"
        : "unclear";

  if (!focus.length && !use.length && sentiment === "unclear") return null;
  return { note, sentiment, focus, use };
}

export function isMusicAudience(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  const analyzedNote = musicAudienceAnalysis(candidate.note);
  return typeof candidate.note === "string"
    && candidate.note.length >= 25
    && Boolean(analyzedNote)
    && allowedSentiments.has(candidate.sentiment)
    && Array.isArray(candidate.focus)
    && candidate.focus.every((entry) => allowedFocus.has(entry))
    && Array.isArray(candidate.use)
    && candidate.use.every((entry) => allowedUse.has(entry));
}

export function normalizeMusicAudience(value) {
  if (!isMusicAudience(value)) return null;
  return {
    note: completeNote(value.note),
    sentiment: value.sentiment,
    focus: [...new Set(value.focus)],
    use: [...new Set(value.use)],
  };
}

export function musicAudienceSignal(value) {
  const audience = normalizeMusicAudience(value);
  return audience?.note ?? "";
}
