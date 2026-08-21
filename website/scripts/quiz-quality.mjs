const genericWords = new Set([
  "a", "about", "after", "again", "all", "also", "an", "and", "any", "are", "as", "at", "be", "because",
  "been", "before", "being", "but", "by", "can", "could", "did", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like",
  "more", "most", "much", "my", "near", "no", "not", "of", "on", "or", "our", "out", "over", "she", "so", "some",
  "than", "that", "the", "their", "them", "there", "these", "they", "this", "those", "to", "under", "up", "was", "we",
  "were", "what", "when", "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

const genericTitleWords = new Set([
  "affected", "article", "battle", "big", "book", "chapter", "company", "cream", "cup", "custody", "direct", "edition", "film",
  "full", "hit", "history", "how", "hurricane", "ice", "island", "laugh", "laughing", "list", "match", "meme", "news", "over",
  "products", "report", "return", "see", "spared", "special", "story", "title", "watch", "world",
]);

const genericCluePattern = /^(?:this|the)\s+(?:story|entry|person|book|film|meme|description)\s*[.!?]?$|^a\s+person['’]s\b/i;
const malformedLeadPattern = /^(?:videos?|clips?|posts?)\s+(?:of\s+the\s+subject\s+)?(?:spread|became|went|is|are|were)\b/i;
const boilerplateCluePattern = /\b(?:if you buy something|we may earn commission|in this article|this story was updated|how to watch|start time|full fight card|and more|meme response centers on|source list|page views?|search volume|ranking|ranked)\b/i;
const recentSignalPattern = /\b(?:after|announced?|appeared?|arrested?|attended|became|brought?|celebration|confirmed|coverage|debut(?:ed)?|defeat(?:ed)?|drew|earned|emerged|event|fans?|featured?|filed|fight|following|goes? viral|joined|launch(?:ed)?|match|meme(?:s)?|online|opened?|performed|popular|prompted|reaction|recalled?|record(?:ed|s)?|released?|returned?|sold out|spread|starred|trending|unveiled?|victor(?:y|ies)|viral|win(?:s|ning)?|won|world cup)\b/i;
const premiseSignalPattern = /\b(?:arrives?|asks?|awakens?|attempts?|becomes?|discovers?|encounters?|falls?|follows?|forced|friendship|journey|learns?|lives?|loses?|must|mystery|no one knows|realizes?|reunite|returns?|rises?|sets? out|stranded|takes?|tries?|undergoes?|wakes?|where|while)\b/i;

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(value) {
  return normalize(value)
    .split(/\s+/)
    .filter((word) => word && (word.length >= 3 || /\d/.test(word)) && !genericWords.has(word));
}

function rawTitleTokens(title) {
  return String(title ?? "").match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? [];
}

export function quizTitleSignals(title) {
  const raw = rawTitleTokens(title);
  const hasAcronym = raw.some((token) => /^[A-Z]{2,}[0-9]*$/.test(token));
  const signals = raw
    .filter((token) => {
      const normalized = normalize(token);
      if (!normalized || genericWords.has(normalized) || genericTitleWords.has(normalized)) return false;
      return (/\d/.test(token) && hasAcronym) || /^[A-Z]{2,}/.test(token) || /^[A-Z]/.test(token);
    })
    .map(normalize)
    .filter(Boolean);
  return [...new Set(signals)];
}

export function quizAnswerLeak(value, title) {
  const clue = normalize(value);
  const normalizedTitle = normalize(title);
  if (!clue || !normalizedTitle) return false;
  if (normalizedTitle.length >= 5 && clue.includes(normalizedTitle)) return true;
  const clueWords = new Set(words(clue));
  return quizTitleSignals(title).some((signal) => clueWords.has(signal));
}

export function quizClueTokens(value) {
  return words(value);
}

export function quizClueIsUsable(value, title, topicId) {
  const clue = String(value ?? "").replace(/\s+/g, " ").trim();
  const minimumLength = ["people", "memes"].includes(topicId) ? 40 : 48;
  if (!clue || clue.length < minimumLength || clue.length > 420 || /\.\.\.|…/.test(clue)) return false;
  if (genericCluePattern.test(clue) || malformedLeadPattern.test(clue) || boilerplateCluePattern.test(clue) || quizAnswerLeak(clue, title)) return false;
  const clueWords = words(clue);
  const minimumWords = ["people", "memes"].includes(topicId) ? 5 : 8;
  const minimumUniqueWords = ["people", "memes"].includes(topicId) ? 5 : 6;
  if (clueWords.length < minimumWords || new Set(clueWords).size < minimumUniqueWords) return false;
  if (topicId === "people" && !/\b(?:appearance|brother|clip|face|fans?|funny|gesture|joke|look|meme(?:s)?|reaction|viral|walk)\b/i.test(clue)) return false;
  if (["movies", "books"].includes(topicId)) return premiseSignalPattern.test(clue);
  return recentSignalPattern.test(clue);
}

export function quizQuestionClue(value) {
  return String(value ?? "")
    .replace(/\s+(?:Which|What|Who)\s+(?:meme|person|film|book|story|entry|description)\s+matches\s+this\s+description\??\s*$/i, "")
    .replace(/\s+(?:Which|What|Who)\s+(?:entry|item)\s+is\s+being\s+described\??\s*$/i, "")
    .trim();
}

export function quizQuestionIsUsable(prompt, title, topicId, context) {
  const clean = String(prompt ?? "").replace(/\s+/g, " ").trim();
  if (!clean || !clean.endsWith("?") || clean.length < 40 || clean.length > 480) return false;
  if (/\.\.\.|…/.test(clean) || /[.!?]\s+[a-z]/.test(clean)) return false;
  const clue = quizQuestionClue(clean);
  if (!quizClueIsUsable(clue, title, topicId)) return false;
  const contextWords = new Set(words(context));
  const clueWords = new Set(words(clue));
  const overlap = [...clueWords].filter((word) => contextWords.has(word)).length;
  return overlap >= Math.min(3, Math.max(2, contextWords.size));
}

export function quizGenericPrompt(value) {
  return genericCluePattern.test(String(value ?? "")) || boilerplateCluePattern.test(String(value ?? ""));
}
