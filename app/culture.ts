import rawBrief from "../data/trends.json";

export type CultureLayout = "landscape" | "poster" | "square";

export type CultureItem = {
  rank: number;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  imageSource?: string;
  imageSourceKind?: "article";
  imageSourcePageUrl?: string;
  alt: string;
  url: string;
  source: string;
  metric?: {
    label: string;
    value: string;
  };
  evidence: Array<{
    source: string;
    url: string;
  }>;
  accent: string;
  rating?: string;
  ratingLabel?: string;
  spotifyId?: string;
  spotifyRank?: number;
  releaseDate?: string;
  category?: string;
};

export type CultureSource = {
  label: string;
  url: string;
};

export type CultureSection = {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  sources: CultureSource[];
  layout: CultureLayout;
  items: CultureItem[];
  moreItems?: CultureItem[];
  moreLabel?: string;
};

export type CultureQuizQuestion = {
  id: string;
  topicId: string;
  topic: string;
  itemTitle: string;
  prompt: string;
  answers: string[];
  correctAnswer: string;
};

export type CultureQuiz = {
  durationSeconds: number;
  questions: CultureQuizQuestion[];
};

export type CultureBrief = {
  edition: string;
  status: string;
  window: string;
  generatedAt: string;
  summary: string;
  sections: CultureSection[];
  quiz: CultureQuiz;
};

const allowedLinkHosts = new Set([
  "commons.wikimedia.org",
  "en.wikipedia.org",
  "knowyourmeme.com",
  "news.google.com",
  "open.spotify.com",
  "openlibrary.org",
  "trends.google.com",
  "trending.knowyourmeme.com",
  "wikimedia.org",
  "www.amazon.com",
  "www.boxofficemojo.com",
  "www.imdb.com",
  "www.billboard.com",
  "www.goodreads.com",
  "www.urbandictionary.com",
  "www.youtube.com",
  "pageviews.wmcloud.org"
]);

function assertText(value: unknown, label: string, maximum = 800): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is missing, too long, or contains control characters`);
  }
}

function validQuizPrompt(prompt: string) {
  const sentenceCount = prompt.match(/[^.!?]+[.!?]+/g)?.length ?? 0;
  return prompt.trim().endsWith("?")
    && sentenceCount >= 1 && sentenceCount <= 2
    && prompt.trim().length >= 40 && prompt.trim().length <= 480
    && !/\.\.\.|…/.test(prompt);
}

function publicHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return Boolean(normalized)
    && normalized !== "localhost"
    && !normalized.includes(":")
    && !/^\d+(?:\.\d+){3}$/.test(normalized)
    && !/\.(?:home|internal|invalid|lan|local|localhost|onion|test)$/.test(normalized);
}

function externalUrl(value: unknown, label: string, allowPublicHost = false) {
  assertText(value, label, 2000);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || !(allowedLinkHosts.has(url.hostname) || (allowPublicHost && publicHostname(url.hostname)))) {
    throw new Error(`${label} contains an unapproved external URL: ${value}`);
  }
  return url;
}

function validateItem(value: unknown, label: string, rank: number, titles: Set<string>, sectionId: string): asserts value is CultureItem {
  if (!value || typeof value !== "object") throw new Error(`${label} is not an object`);
  const item = value as Record<string, unknown>;
  assertText(item.title, `${label} title`, 160);
  assertText(item.subtitle, `${item.title} subtitle`, 180);
  assertText(item.description, `${item.title} description`, 1000);
  assertText(item.alt, `${item.title} image description`, 300);
  assertText(item.source, `${item.title} source`, 100);
  if (item.rank !== rank) throw new Error(`${label} must have rank ${rank}`);
  const titleKey = item.title.trim().toLocaleLowerCase("en-US");
  if (titles.has(titleKey)) throw new Error(`${item.title} is duplicated`);
  titles.add(titleKey);
  if (typeof item.image !== "string" || !/^\/culture\/[a-z0-9-]+\.webp$/.test(item.image)) {
    throw new Error(`${item.title} must use a safe local WebP image`);
  }
  if (item.imageSource !== undefined) {
    assertText(item.imageSource, `${item.title} source image`, 2000);
    const imageUrl = new URL(item.imageSource);
    const articleImage = item.imageSourceKind === "article" && sectionId === "news"
      && typeof item.imageSourcePageUrl === "string"
      && externalUrl(item.imageSourcePageUrl, `${item.title} image source page`, true).hostname
        === externalUrl(item.url, item.title, true).hostname;
    if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password || imageUrl.port
      || !(articleImage ? publicHostname(imageUrl.hostname) : /(?:\.gr-assets\.com|\.wikimedia\.org|\.media-amazon\.com|\.scdn\.co)$/.test(imageUrl.hostname))) {
      throw new Error(`${item.title} has an unapproved source image host`);
    }
  }
  if (typeof item.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(item.accent)) {
    throw new Error(`${item.title} has an invalid accent color`);
  }
  externalUrl(item.url, item.title, sectionId === "news" || sectionId === "products");
  if (!Array.isArray(item.evidence) || item.evidence.length < 2 || item.evidence.length > 3) {
    throw new Error(`${item.title} must have two to three sources of evidence`);
  }
  const evidenceSources = new Set<string>();
  const evidenceHosts = new Set<string>();
  for (const value of item.evidence) {
    if (!value || typeof value !== "object") throw new Error(`${item.title} has invalid evidence`);
    const evidence = value as Record<string, unknown>;
    assertText(evidence.source, `${item.title} evidence label`, 120);
    evidenceSources.add(evidence.source.toLocaleLowerCase("en-US"));
    evidenceHosts.add(externalUrl(evidence.url, `${item.title} evidence`, true).hostname);
  }
  if (evidenceSources.size < 2 || evidenceHosts.size < 2) {
    throw new Error(`${item.title} evidence must come from distinct sources`);
  }
  if (item.metric !== undefined) {
    if (!item.metric || typeof item.metric !== "object") throw new Error(`${item.title} has an invalid metric`);
    const metric = item.metric as Record<string, unknown>;
    assertText(metric.label, `${item.title} metric label`, 100);
    assertText(metric.value, `${item.title} metric value`, 60);
  }
  if (item.rating !== undefined) assertText(item.rating, `${item.title} rating`, 20);
  if (item.ratingLabel !== undefined) assertText(item.ratingLabel, `${item.title} rating source`, 40);
  if (item.releaseDate !== undefined) assertText(item.releaseDate, `${item.title} release date`, 60);
  if (item.category !== undefined) assertText(item.category, `${item.title} category`, 40);
  if (item.spotifyId !== undefined && (typeof item.spotifyId !== "string" || !/^[A-Za-z0-9]{22}$/.test(item.spotifyId))) {
    throw new Error(`${item.title} has an invalid Spotify track ID`);
  }
  if (item.spotifyRank !== undefined && (!Number.isInteger(item.spotifyRank) || Number(item.spotifyRank) < 1 || Number(item.spotifyRank) > 50)) {
    throw new Error(`${item.title} has an invalid Spotify rank`);
  }
}

function validateBrief(value: unknown): asserts value is CultureBrief {
  if (!value || typeof value !== "object") throw new Error("Culture brief is not an object");
  const candidate = value as Record<string, unknown>;
  for (const field of ["edition", "status", "window", "summary"] as const) {
    assertText(candidate[field], `Culture brief ${field}`, field === "summary" ? 1000 : 180);
  }
  if (typeof candidate.generatedAt !== "string" || !Number.isFinite(Date.parse(candidate.generatedAt))) {
    throw new Error("Culture brief has an invalid generatedAt date");
  }
  if (!Array.isArray(candidate.sections) || candidate.sections.length !== 8) {
    throw new Error("Culture brief must contain exactly eight boards");
  }
  const expected = [
    ["memes", "landscape"],
    ["slang", "landscape"],
    ["people", "square"],
    ["movies", "poster"],
    ["books", "poster"],
    ["music", "square"],
    ["products", "square"],
    ["news", "landscape"],
  ];
  candidate.sections.forEach((value, sectionIndex) => {
    if (!value || typeof value !== "object") throw new Error(`Board ${sectionIndex + 1} is invalid`);
    const section = value as Record<string, unknown>;
    const [expectedId, expectedLayout] = expected[sectionIndex];
    if (section.id !== expectedId || section.layout !== expectedLayout) {
      throw new Error(`Board ${sectionIndex + 1} must be ${expectedId} with ${expectedLayout} imagery`);
    }
    for (const field of ["eyebrow", "title", "description"] as const) {
      assertText(section[field], `${expectedId} ${field}`, field === "description" ? 1000 : 180);
    }
    const maxSources = 3;
    if (!Array.isArray(section.sources) || section.sources.length < 2 || section.sources.length > maxSources) {
      throw new Error(`${section.title} must list two to ${maxSources} sources`);
    }
    for (const value of section.sources) {
      if (!value || typeof value !== "object") throw new Error(`${section.title} has an invalid source`);
      const source = value as Record<string, unknown>;
      assertText(source.label, `${section.title} source label`, 160);
      externalUrl(source.url, `${section.title} source`, expectedId === "news");
    }
    if (!Array.isArray(section.items) || section.items.length !== 5) {
      throw new Error(`${section.title} must contain exactly five items`);
    }
    if (!Array.isArray(section.moreItems) || section.moreItems.length > 15) {
      throw new Error(`${section.title} must contain no more than fifteen continuation items`);
    }
    if (section.moreLabel !== undefined) assertText(section.moreLabel, `${section.title} continuation label`, 160);
    const titles = new Set<string>();
    section.items.forEach((item, index) => validateItem(item, `${section.title} item ${index + 1}`, index + 1, titles, expectedId));
    section.moreItems.forEach((item, index) => validateItem(item, `${section.title} continuation ${index + 1}`, index + 6, titles, expectedId));
  });

  const brief = value as CultureBrief;
  const items = (id: string) => {
    const section = brief.sections.find((entry) => entry.id === id)!;
    return [...section.items, ...(section.moreItems ?? [])];
  };

  const memes = items("memes");
  const memePollRanks = memes.map((item) => Number(item.metric?.value.slice(1)));
  if (memes.some((item) => !item.metric?.label.endsWith("Meme of the Month"))
    || memePollRanks.some((rank, index) => !Number.isInteger(rank)
      || (index > 0 && rank <= memePollRanks[index - 1]))) {
    throw new Error("Memes must preserve the published Meme of the Month order");
  }

  const slang = items("slang");
  const slangViews = slang.map((item) => Number(item.metric?.value.replaceAll(",", "")));
  if (slang.some((item) => item.metric?.label !== "Know Your Meme page views")
    || slangViews.some((views, index) => !Number.isFinite(views)
      || (index > 0 && views > slangViews[index - 1]))) {
    throw new Error("Slang must be ordered by Know Your Meme page views");
  }

  const people = brief.sections.find((section) => section.id === "people")!;
  const peopleCategories = new Map<string, number>();
  for (const item of [...people.items, ...(people.moreItems ?? [])]) {
    const count = (peopleCategories.get(item.category ?? "") ?? 0) + 1;
    peopleCategories.set(item.category ?? "", count);
    if (!item.category || count > 2) throw new Error("No category may take more than two People places");
  }
  if (items("people").some((item) => !item.metric?.label.startsWith("Wikipedia views · ")
    || item.subtitle.includes("·"))) {
    throw new Error("People must use one primary category and prior-month Wikipedia views");
  }

  const movies = items("movies");
  if (movies.some((item) => !item.rating || !item.metric?.label.startsWith("Wikipedia views · "))) {
    throw new Error("Every movie must include an IMDb rating state and prior-month Wikipedia views");
  }

  const music = items("music");
  const billboardRanks = music.map((item) => Number(item.metric?.value.slice(1)));
  if (music.some((item) => !/^[A-Za-z0-9]{22}$/.test(item.spotifyId ?? "")
      || item.metric?.label !== "Billboard Hot 100")
    || billboardRanks.some((rank, index) => !Number.isInteger(rank) || (index > 0 && rank < billboardRanks[index - 1]))) {
    throw new Error("Every music entry must be playable and globally ordered by Billboard position");
  }

  const products = items("products");
  if (products.some((item) => item.metric?.label !== "Independent viral sources"
      || !/^\d+ sources?$/.test(item.metric?.value ?? "")
      || Number(item.metric?.value.match(/^\d+/)?.[0]) < 2
      || item.subtitle !== "Product")) {
    throw new Error("Products must have at least two recent independent viral sources");
  }

  const volume = (value: string | undefined) => {
    const match = value?.match(/([\d.]+)\s*([KMB])?\+/i);
    return match ? Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase() as "K" | "M" | "B"] ?? 1) : 0;
  };
  const news = items("news");
  const newsVolumes = news.map((item) => volume(item.metric?.value));
  if (news.some((item) => item.metric?.label !== "Google search volume"
      || !/^News(?: · [A-Z][a-z]{2} \d{1,2}, \d{4})?$/.test(item.subtitle))
    || newsVolumes.some((views, index) => !views || (index > 0 && views > newsVolumes[index - 1]))) {
    throw new Error("News must be ordered by seven-day Google search volume");
  }

  if (!candidate.quiz || typeof candidate.quiz !== "object") throw new Error("Culture brief is missing its quiz");
  const quiz = candidate.quiz as Record<string, unknown>;
  if (quiz.durationSeconds !== 15 || !Array.isArray(quiz.questions) || quiz.questions.length !== 21) {
    throw new Error("Culture quiz must contain 21 questions and give each question 15 seconds");
  }
  const quizBoardIds = ["memes", "people", "movies", "books", "music", "products", "news"];
  const quizCounts = new Map<string, number>();
  const quizIds = new Set<string>();
  for (const value of quiz.questions) {
    if (!value || typeof value !== "object") throw new Error("Culture quiz contains an invalid question");
    const question = value as Record<string, unknown>;
    assertText(question.id, "Quiz question id", 80);
    if (quizIds.has(question.id)) throw new Error("Culture quiz contains duplicate questions");
    quizIds.add(question.id);
    assertText(question.topicId, "Quiz topic id", 40);
    if (!quizBoardIds.includes(question.topicId)) throw new Error("Culture quiz contains a slang question");
    assertText(question.topic, "Quiz topic", 100);
    assertText(question.itemTitle, "Quiz item title", 160);
    assertText(question.prompt, "Quiz prompt", 360);
    if (!Array.isArray(question.answers) || question.answers.length !== 4
      || new Set(question.answers).size !== 4) throw new Error("Each quiz question must have four unique answers");
    question.answers.forEach((answer, index) => assertText(answer, `Quiz answer ${index + 1}`, 160));
    assertText(question.correctAnswer, "Quiz correct answer", 160);
    if (!question.answers.includes(question.correctAnswer)) throw new Error("Quiz correct answer is not an answer choice");
    quizCounts.set(question.topicId, (quizCounts.get(question.topicId) ?? 0) + 1);
    const section = brief.sections.find((entry) => entry.id === question.topicId);
    const sourceItems = section ? [...section.items, ...(section.moreItems ?? [])].slice(0, 3) : [];
    const sourceItem = sourceItems.find((item) => item.title === question.itemTitle);
    if (!section || question.topic !== section.title
      || !sourceItem
      || !validQuizPrompt(question.prompt)
      || question.correctAnswer !== question.itemTitle) {
      throw new Error("Quiz question is not grounded in a board's first three entries");
    }
  }
  if (quizBoardIds.some((id) => quizCounts.get(id) !== 3)) {
    throw new Error("Culture quiz must contain three questions for each non-slang board");
  }
}

validateBrief(rawBrief);
export const cultureBrief: CultureBrief = rawBrief;

export function formatUpdatedAt(isoDate: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(new Date(isoDate));
}

export function releaseDateFor(item: Pick<CultureItem, "releaseDate" | "description">) {
  const explicit = item.releaseDate?.trim();
  if (explicit) return explicit;
  const match = item.description.match(/\breleased\s+([^.!?]+)/i)?.[1]?.trim();
  return match || "Release date unavailable";
}
