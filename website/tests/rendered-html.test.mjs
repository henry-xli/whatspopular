import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildDescriptionPrompt, buildNichePrompt, buildQuizPrompt, generateDescriptionBatch, isDescriptionUsable, isNicheTopicUsable, parseDescriptionOutput, parseNicheOutput, parseQuizOutput } from "../scripts/ai-descriptions.mjs";
import { normalizeMusicIdentity, selectExactSpotifyItem, spotifyPageMatchesIdentity } from "../scripts/music-lookup.mjs";
import { decodeHtmlEntities, extractArticleImage, extractArticleIntro, extractArticleTitle, extractPlayableMedia, publicHttpsUrl } from "../scripts/news-article.mjs";
import { categoryDefinitions, sourceCandidateUsable } from "../scripts/niche-ingestion.mjs";
import { quizAnswerLeak, quizClueIsUsable, quizQuestionIsUsable, quizTitleSignals } from "../scripts/quiz-quality.mjs";
import { createRateLimiter, fetchBytes, isPublicAddress, mapConcurrent } from "../scripts/runtime.mjs";
import { specificMusicPlayback } from "../shared/music-playback.mjs";

async function render(pathname = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}-${init.method ?? "GET"}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://whatspopular.com${pathname}`, {
      headers: { accept: "text/html" },
      ...init,
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("builds and validates source-grounded AI descriptions", () => {
  const prompt = buildDescriptionPrompt("people", [{
    id: "people-1",
    title: "Example Person",
    role: "Actor",
    sourceSnippets: [{ kind: "current_event", source: "Publisher", text: "The person appeared in a new film this summer." }],
  }]);
  assert.match(prompt, /SOURCE DATA BEGIN/);
  assert.match(prompt, /untrusted reference data/i);
  assert.match(prompt, /recent event or coverage/i);
  assert.match(prompt, /first sentence must answer/i);
  assert.match(prompt, /concrete causal signal/i);
  assert.match(prompt, /meme or unusual fan reaction/i);
  assert.match(prompt, /return or re-release/i);
  const musicPrompt = buildDescriptionPrompt("music", [{
    id: "music-1",
    title: "Example Song",
    role: "Example Artist",
    sourceSnippets: [
      { kind: "current_reception", source: "Current coverage", text: "Listeners are using the song in workout edits." },
      { kind: "current_usage", source: "Current coverage", text: "Creators are pairing it with fast-cut dance videos." },
    ],
  }]);
  assert.match(musicPrompt, /what listeners appear to be responding to/i);
  assert.match(musicPrompt, /how the track is being used/i);
  assert.match(prompt, /return an empty description/i);
  assert.match(prompt, /Never mention a publisher|quote a headline/i);
  const parsed = parseDescriptionOutput({
    output_text: JSON.stringify({ descriptions: [
      { id: "people-1", description: "Example Person drew attention this summer after appearing in a new film; they are an actor." },
      { id: "unexpected", description: "This must be ignored." },
    ] }),
  }, ["people-1"]);
  assert.equal(parsed.get("people-1"), "Example Person drew attention this summer after appearing in a new film; they are an actor.");
  assert.equal(parsed.has("unexpected"), false);
  const incomplete = parseDescriptionOutput({
    output_text: JSON.stringify({ descriptions: [
      { id: "people-1", description: "Example Person drew attention after a new role and" },
    ] }),
  }, ["people-1"]);
  assert.equal(incomplete.has("people-1"), false);
  const attributed = parseDescriptionOutput({
    output_text: JSON.stringify({ descriptions: [
      { id: "people-1", description: "Example Person drew attention after a new role, according to The Daily News." },
    ] }),
  }, ["people-1"]);
  assert.equal(attributed.has("people-1"), false);

  const currentEvidence = {
    title: "Example Person",
    sourceSnippets: [{
      kind: "current_event",
      source: "Current coverage",
      text: "Example Person appeared in a new film this summer.",
    }],
  };
  assert.equal(isDescriptionUsable("people", parsed.get("people-1"), currentEvidence), true);
  assert.equal(isDescriptionUsable("people", "Example Person drew attention after appearing in a new film this summer.", currentEvidence), true);
  assert.equal(isDescriptionUsable("people", "Example Person is primarily known as an actor. A new film is coming.", currentEvidence), false);
  assert.equal(isDescriptionUsable("people", "Example Person is an actor. Which reminds me, films are often discussed.", currentEvidence), false);
  assert.equal(isDescriptionUsable("people", "Example Person joins a new project after a major announcement this summer.", {
    title: "Example Person",
    sourceSnippets: [{
      kind: "current_headline",
      source: "Current coverage",
      text: "Example Person joins a new project after a major announcement this summer.",
    }],
  }), false);
  const culturalPersonEvidence = {
    title: "Erling Haaland",
    sourceSnippets: [
      { kind: "current_headline", source: "Current coverage", text: "Erling Haaland's funny walk has become a meme after a viral concert clip." },
      { kind: "current_coverage", source: "Related current coverage", text: "Fans are reacting to Erling Haaland memes and his unusual appearance." },
    ],
  };
  assert.equal(isDescriptionUsable("people", "Erling Haaland became a meme after fans reacted online to his funny walk and unusual appearance.", culturalPersonEvidence), true);
  assert.equal(isDescriptionUsable("people", "Erling Haaland is primarily known as a footballer. He appeared at the World Cup.", culturalPersonEvidence), false);

  const productEvidence = {
    title: "Unicorn Frappuccino",
    sourceSnippets: [
      { kind: "current_demand", source: "Current coverage", text: "Starbucks brought back the Unicorn Frappuccino for a limited return, and demand surged." },
      { kind: "background_context", source: "Product history", text: "The drink was first introduced as a limited release in 2017 and became a viral Starbucks moment." },
    ],
  };
  assert.equal(isDescriptionUsable("products", "The Unicorn Frappuccino is back for a limited return, reviving the viral Starbucks drink that was first introduced in 2017.", productEvidence), true);
  assert.equal(isDescriptionUsable("products", "The Unicorn Frappuccino is a blended drink with a sweet flavor.", productEvidence), false);
  const musicEvidence = {
    title: "Example Song",
    sourceSnippets: [{ kind: "current_reception", source: "Current coverage", text: "Listeners are using the song in workout edits." }],
  };
  assert.equal(isDescriptionUsable("music", "Listeners are using Example Song in workout edits, while creators keep pairing it with fast-cut videos.", musicEvidence), true);
  assert.equal(isDescriptionUsable("music", "“Example Song” is a track by Example Artist, released this summer.", musicEvidence), false);
  assert.equal(isDescriptionUsable("music", "“Example Song” is a track by Example Artist, released this summer.", { title: "Example Song", sourceSnippets: [] }), false);
  assert.equal(decodeHtmlEntities("&ldquo;Trivia Murder Party 3&rdquo; &amp; &hellip;"), "“Trivia Murder Party 3” & …");
  assert.equal(extractArticleIntro("<article><p>Jackbox says the game will launch Sept.</p></article>"), "");
});

test("niche cards require concrete current context and plain language", () => {
  const record = {
    id: "golf-1",
    category: "Golf",
    categoryContext: "Current tournament developments and player news.",
    title: "Who is on the bubble to make the Tour Championship?",
    sourceSnippets: [
      {
        kind: "current_headline",
        source: "ESPN",
        headline: "Who is on the bubble to make the Tour Championship?",
        text: "Who is on the bubble to make the Tour Championship?",
        publishedAt: "Fri, 21 Aug 2026 00:00:00 GMT",
      },
      {
        kind: "current_coverage",
        source: "ESPN",
        headline: "Who is on the bubble to make the Tour Championship?",
        text: "The final playoff event is reshaping which players can qualify for the Tour Championship, with late scores changing the field.",
        publishedAt: "Fri, 21 Aug 2026 00:00:00 GMT",
      },
    ],
    popularityEvidence: {
      mode: "independent-coverage",
      coverageCount: 3,
      coverageSources: ["ESPN", "Reuters", "AP"],
      signal: "",
    },
  };
  const prompt = buildNichePrompt([record]);
  assert.match(prompt, /publisher article excerpt/i);
  assert.match(prompt, /actual event, person, release, match, result/i);
  assert.match(prompt, /strict recency and current-event filter/i);
  assert.match(prompt, /evergreen explainer, listicle/i);
  assert.match(prompt, /specific person, product, match, release, return, meme/i);
  assert.match(prompt, /validated popularity_evidence/i);
  assert.match(prompt, /first-person taste test/i);
  assert.match(prompt, /main-character week/i);
  assert.match(prompt, /read like news/i);
  const useful = { title: "Players are fighting for the final places", description: "Late scores in the final playoff event are changing which players can qualify for the Tour Championship.", whyNow: "The final playoff event is changing the Tour Championship field this week.", trendLabel: "Playoff pressure" };
  assert.equal(isNicheTopicUsable(useful, record), true);
  assert.equal(isNicheTopicUsable({ ...useful, title: "The leaderboard is having a main-character week" }, record), false);
  const parsed = parseNicheOutput({ output_text: JSON.stringify({ topics: [
    { id: "golf-1", title: "The leaderboard is having a main-character week", description: "Golf is having a main-character week as fans follow the standings.", why_now: "The sport is having a main-character week.", trend_label: "Big week" },
  ] }) }, ["golf-1"]);
  assert.equal(parsed.has("golf-1"), false);
});

test("ingestion rejects self-described hype without independent popularity evidence", () => {
  const food = categoryDefinitions.find((category) => category.id === "food-drink");
  const now = new Date("2026-08-21T12:00:00.000Z");
  const review = {
    headline: "I Tried The Viral Diet Coke Slushie To See If It Lives Up To The Internet Hype",
    articleIntro: "Diet Coke slushies are currently having their moment in the viral internet sun, but are they actually any good? I wanted to try a Diet Coke slushie for myself, so I headed down to a place in Soho.",
    publishedAt: "Fri, 21 Aug 2026 00:00:00 GMT",
    source: "Tasting Table",
    coverageCount: 1,
    coverageSources: ["Tasting Table"],
  };
  assert.equal(sourceCandidateUsable(food, review, now), false);
  assert.equal(sourceCandidateUsable(food, {
    ...review,
    headline: "Limited drink return sells out and triggers a restock",
    articleIntro: "The limited drink returned this week, sold out at several locations, and triggered a restock after demand exceeded the first shipment.",
    coverageCount: 2,
    coverageSources: ["Publisher One", "Publisher Two"],
    popularityEvidence: {
      mode: "independent-coverage",
      coverageCount: 2,
      coverageSources: ["Publisher One", "Publisher Two"],
      signal: "The limited drink returned this week, sold out at several locations, and triggered a restock.",
    },
  }, now), true);
});

test("uses a bounded structured request for an enabled AI description batch", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ descriptions: [
        { id: "movies-1", description: "A stranded explorer must solve a dangerous mystery to get home." },
      ] }),
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await generateDescriptionBatch("movies", [{
      id: "movies-1",
      title: "Example Film",
      role: "Movie",
      sourceSnippets: [{ source: "Wikipedia", text: "An explorer wakes on a distant world." }],
    }], { apiKey: "test-key", timeoutMs: 1_000 });
    assert.equal(result.size, 1);
    assert.match(String(request.url), /^https:\/\/api\.openai\.com\/v1\/responses$/);
    assert.equal(request.init.headers.get("authorization"), "Bearer test-key");
    const body = JSON.parse(request.init.body);
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.strict, true);
    assert.match(body.input, /SOURCE DATA BEGIN/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("builds complete description-matching quiz prompts with fixed answer sets", () => {
  const prompt = buildQuizPrompt([{
    id: "people-1",
    topic: "People",
    title: "Example Person",
    quizContext: "Example Person drew attention after appearing in a new film.",
    answerChoices: ["Example Person", "Another Person", "A Film", "A Song"],
  }]);
  assert.match(prompt, /QUIZ DATA BEGIN/);
  assert.match(prompt, /only the supplied target_context/i);
  assert.doesNotMatch(prompt, /target_description/);
  assert.match(prompt, /one or two complete clue sentences/i);
  assert.match(prompt, /never submit a template-only clue/i);
  assert.match(prompt, /distinctive word, proper name, place name, number/i);
  assert.match(prompt, /exactly four answers/i);
  assert.doesNotMatch(prompt, /which topic matches a description/i);
  const parsed = parseQuizOutput({
    output_text: JSON.stringify({ questions: [
      {
        id: "people-1",
        prompt: "This person drew attention after appearing in a new film. Which entry matches this description?",
        answers: ["Example Person", "Another Person", "A Film", "A Song"],
        correct_answer: "Example Person",
      },
      { id: "unexpected", prompt: "Ignore this." },
    ] }),
  }, ["people-1"]);
  assert.deepEqual(parsed.get("people-1"), {
    prompt: "This person drew attention after appearing in a new film. Which entry matches this description?",
    answers: ["Example Person", "Another Person", "A Film", "A Song"],
    correctAnswer: "Example Person",
  });
  assert.equal(parsed.has("unexpected"), false);
});

test("rejects generic or answer-spoiling quiz clues", () => {
  const weakStory = "This story. Which story matches this description?";
  assert.equal(quizQuestionIsUsable(weakStory, "A current event", "news", "This story."), false);

  const answerLeakingBook = "One spring morning, a stranger arrives in the small southern city of Golden. Which book matches this description?";
  assert.equal(quizAnswerLeak(answerLeakingBook, "Theo of Golden"), true);
  assert.equal(quizQuestionIsUsable(answerLeakingBook, "Theo of Golden", "books", "One spring morning, a stranger arrives in the small southern city of Golden."), false);

  const answerLeakingPerson = "Which reminds me, in an odd sense, of the way Nolan’s films are often discussed. Which person matches this description?";
  assert.equal(quizAnswerLeak(answerLeakingPerson, "Christopher Nolan"), true);
  assert.equal(quizQuestionIsUsable(answerLeakingPerson, "Christopher Nolan", "people", "A director drew attention after a recent meme about his films."), false);

  const answerSafeBook = "One spring morning, a stranger arrives in a small southern city. No one knows where he came from or why he asks more questions than he answers. Which book matches this description?";
  assert.equal(quizAnswerLeak(answerSafeBook, "Theo of Golden"), false);
  assert.equal(quizQuestionIsUsable(answerSafeBook, "Theo of Golden", "books", "One spring morning, a stranger arrives in the small southern city. No one knows where he has come from or why he asks a lot more questions than he answers."), true);

  assert.equal(quizClueIsUsable("This story", "Any story", "news"), false);
  assert.deepEqual(quizTitleSignals("Theo of Golden"), ["theo", "golden"]);
});

test("renders the complete finite culture briefing", async () => {
  const brief = JSON.parse(await readFile(new URL("../data/trends.json", import.meta.url), "utf8"));
  const publishedBrief = JSON.parse(await readFile(new URL("../public/data/trends.json", import.meta.url), "utf8"));
  assert.deepEqual(publishedBrief, brief);
  const allItems = brief.sections.flatMap((section) => [...section.items, ...section.moreItems]);
  const homeResponse = await render();
  const response = await render("/explore");
  const mobileSnapshotResponse = await render("/api/brief", { headers: { accept: "application/json" } });
  assert.equal(mobileSnapshotResponse.status, 200);
  assert.deepEqual(await mobileSnapshotResponse.json(), brief);
  assert.match(mobileSnapshotResponse.headers.get("cache-control") ?? "", /s-maxage=300/);
  assert.equal(homeResponse.status, 200);
  const homeHtml = await homeResponse.text();
  assert.match(homeHtml, /How trendy are you\?/);
  assert.match(homeHtml, />Quiz me</);
  assert.match(homeHtml, />Explore/);
  assert.match(homeHtml, /class="hero-visuals"/);
  assert.match(homeHtml, /class="hero-slideshow"/);
  assert.equal((homeHtml.match(/class="hero-slide"/g) ?? []).length, 16);
  assert.match(homeHtml, /class="hero-spotlight"/);
  assert.match(homeHtml, /Standout ·/);
  assert.match(homeHtml, /aria-label="Previous standout"/);
  assert.match(homeHtml, /aria-label="Next standout"/);
  assert.match(homeHtml, /class="is-active" href="\/"[^>]*>Home<\/a>/);
  assert.match(homeHtml, /aria-current="page"/);
  assert.match(homeHtml, /One daily snapshot\. Eight boards\. One quiz\./);
  assert.doesNotMatch(homeHtml, /Catch me up|How this works/);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-src[^;]*https:\/\/buymeacoffee\.com/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src[^;]*https:\/\/open\.spotify\.com/);
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src[^;]*https:\/\/embed-cdn\.spotifycdn\.com/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-permitted-cross-domain-policies"), "none");
  assert.match(response.headers.get("cache-control") ?? "", /s-maxage=86400/);

  const html = await response.text();
  assert.match(html, /class="is-active" href="\/explore"[^>]*>Explore<\/a>/);
  assert.match(html, /Everything worth knowing at a glance/);
  assert.match(html, /class="explore-index"/);
  for (const id of ["people", "movies", "books", "music", "products", "news", "memes", "slang"]) {
    assert.match(html, new RegExp(`class="explore-index-link"[^>]*aria-controls="${id}"`));
  }
  assert.doesNotMatch(html, /href="#(?:memes|slang|people|movies|books|music|products|news)"/);
  assert.match(html, /class="scroll-top"/);
  assert.match(html, />Memes</);
  assert.match(html, />Slang</);
  assert.match(html, />People</);
  assert.match(html, />Movies</);
  assert.match(html, />Books</);
  assert.match(html, />Music</);
  assert.match(html, />Products</);
  assert.match(html, />News</);
  const boardPositions = ["people", "movies", "books", "music", "products", "news", "memes", "slang"]
    .map((id) => html.indexOf(`id="${id}-title"`));
  assert.ok(boardPositions.every((position, index) => position >= 0
    && (index === 0 || position > boardPositions[index - 1])));
  assert.match(html, /Know Your Meme page views/);
  assert.match(html, /Wikipedia views · [A-Z][a-z]+/);
  assert.match(html, /Independent viral sources/);
  assert.match(html, /Google search volume/);
  assert.match(html, /Billboard Hot 100/);
  assert.match(html, /class="source-list"[^>]*>[\s\S]*?<a /);
  assert.doesNotMatch(html, /How an entry earns a spot|>Right now<|The whole internet\. Five short lists\.|Less feed\. More signal\./);
  assert.doesNotMatch(html, /Viral formats|TikTok|KYM \+ LIMC signal|SocialCounts|Social Blade|Subscribers gained/i);
  assert.match(html, /BMC-Widget/);
  assert.match(html, /<script[^>]*data-name="BMC-Widget"[^>]*defer=""/);
  assert.match(html, /buymeacoffee\.com\/0wtynrfutb/);
  assert.match(html, /href="#main-content"/);
  assert.match(html, /<main id="main-content" tabindex="-1">/);
  assert.match(html, /og\.jpg/);
  assert.doesNotMatch(html, /og\.png|data-nimg|\/_next\/image\?/);
  const images = html.match(/<img\b[^>]*>/g) ?? [];
  const contentImages = images.filter((image) => /\bloading="lazy"/.test(image));
  assert.equal(contentImages.length, allItems.length);
  assert.ok(contentImages.every((image) => /\balt="[^"]+"/.test(image)));
  assert.ok(contentImages.every((image) => /\bwidth="\d+"/.test(image) && /\bheight="\d+"/.test(image)));
  assert.ok(contentImages.every((image) => /\bdecoding="async"/.test(image)));
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  const nonMusicSections = brief.sections.filter((section) => section.id !== "music");
  assert.equal((html.match(/class="culture-card/g) ?? []).length,
    nonMusicSections.reduce((count, section) => count + section.items.length, 0));
  assert.equal((html.match(/<details class="expanded-ranking"/g) ?? []).length,
    nonMusicSections.filter((section) => section.moreItems.length).length);
  assert.equal((html.match(/class="expanded-entry /g) ?? []).length,
    nonMusicSections.reduce((count, section) => count + section.moreItems.length, 0));
  assert.doesNotMatch(html, /class="expanded-source"|↗|▶/);
  assert.match(html, /class="ui-icon ui-icon-external/);
  assert.match(html, /<svg class="ui-icon ui-icon-external/);
  assert.match(html, /class="ui-icon ui-icon-play/);
  assert.match(html, /class="music-playlist"/);
  assert.match(html, /class="music-tracklist"/);
  assert.equal((html.match(/class="music-track-row/g) ?? []).length,
    brief.sections.find((section) => section.id === "music").items.length
      + brief.sections.find((section) => section.id === "music").moreItems.length);
  assert.equal((html.match(/aria-label="Play /g) ?? []).length,
    brief.sections.find((section) => section.id === "music").items.length
      + brief.sections.find((section) => section.id === "music").moreItems.length);
  assert.match(html, /Show ranks 6/);
  assert.equal(brief.quiz.durationSeconds, 15);
  assert.equal(brief.quiz.questions.length, 15);
  const movieQuizQuestions = brief.quiz.questions.filter((question) => question.topicId === "movies");
  assert.equal(movieQuizQuestions.length, 3);
  assert.ok(movieQuizQuestions.every((question) => /\b(?:about|after|before|character|conflict|creator|discovers?|dimension|encounters?|family|follows?|forced|friendship|happens?|home|journey|king|memory|mission|mystery|plot|premise|reunite|returns?|set|sister|story|stranded|takes?|tries?|undergoes?|wakes?|when|where|while|world)\b/i.test(question.prompt)));
});

test("renders the About flowchart", async () => {
  const response = await render("/about");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Sources in\. Context out\./);
  assert.match(html, /One daily snapshot\. Eight boards\. One quiz\./);
  assert.match(html, /12:00 AM Pacific/);
  for (const label of ["Pull sources", "Ingest every day", "Build the snapshot", "Write and quiz", "Validate and publish"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.doesNotMatch(html, /The eight algorithms|Exactly how each list is made/);
  assert.match(html, /last good snapshot stays live/i);
  assert.match(html, /<main class="about-page" id="main-content" tabindex="-1">/);
  const workflow = await readFile(new URL("../../.github/workflows/update-daily.yml", import.meta.url), "utf8");
  assert.match(workflow, /cron: "0 \* \* \* \*"/);
  assert.match(workflow, /pacific_hour/);
  assert.match(workflow, /check-refresh-due\.mjs/);
  assert.match(workflow, /steps\.due\.outputs\.run/);
});

test("renders the niche For You builder and keeps anonymous profiles gated", async () => {
  const nicheBrief = JSON.parse(await readFile(new URL("../data/niche-trends.json", import.meta.url), "utf8"));
  const publishedNicheBrief = JSON.parse(await readFile(new URL("../public/data/niche-trends.json", import.meta.url), "utf8"));
  assert.deepEqual(publishedNicheBrief, nicheBrief);
  assert.ok(nicheBrief.categories.length >= 18);
  assert.ok(nicheBrief.categories.every((category) => category.topics.length >= 1));
  assert.ok(nicheBrief.categories.every((category) => category.topics.every((topic) => topic.evidenceMode === "source-grounded")));
  const nicheTopics = nicheBrief.categories.flatMap((category) => category.topics);
  assert.ok(nicheTopics.every((topic) => topic.popularityEvidence
    && ["independent-coverage", "measurable-signal", "concrete-trend-signal"].includes(topic.popularityEvidence.mode)
    && (topic.popularityEvidence.mode === "independent-coverage"
      ? topic.popularityEvidence.coverageCount >= 2 && topic.popularityEvidence.coverageSources.length >= 2
        && (topic.popularityEvidence.coverageSources.length >= 3
          || /\b(?:sold[- ]out|sell(?:s|ing)? out|restock|record|box office|ticket sales|chart(?:ed|ing)?|airplay|no\.?\s*1|top\s+\d+|rank|search interest|trending on|demand|return|re-?release|reintroduc|brought back|comeback|reunion|meme|viral (?:clip|video|sound|song|post)|debut|preview|deluxe edition|mixtape|breakout|win|won|beat|match|tournament)\b/i.test(topic.popularityEvidence.signal))
      : /\b(?:sold[- ]out|sell(?:s|ing)? out|restock|record|chart|airplay|no\.?\s*1|top\s+\d+|rank|search interest|trending on|demand|return|re-?release|reintroduc|brought back|comeback|reunion|meme|viral (?:clip|video|sound|song|post)|debut|preview|deluxe edition|mixtape|breakout|win|won|beat|match|tournament|\d[\d,.]*\s*(?:million|billion|thousand|views?|streams?|sales?|tickets?|orders?))\b/i.test(topic.popularityEvidence.signal))));
  assert.ok(nicheTopics.every((topic) => topic.whyNow.trim().toLocaleLowerCase() !== topic.title.trim().toLocaleLowerCase()));
  assert.ok(nicheTopics.every((topic) => !/^Reports from\b/i.test(topic.whyNow)));
  assert.ok(nicheTopics.every((topic) => /^\/culture\/niche-[a-z0-9-]+\.webp$/.test(topic.image)));
  assert.ok(nicheTopics.every((topic) => !/(?:main[- ]character|next generation|moving target|worth watching|having (?:a|its) \w+ week|deserves the hype|sets? (?:his|her|their|its) sights|challenges? (?:the )?(?:norms|boundaries)|sparks? (?:a )?debate|current development|latest updates|news and notes|connect(?:ed|ing)? with fans|^\s*(?:the\s+)?(?!(?:19|20)\d{2}\b)\d+(?:st|nd|rd|th)?\s+(?!annual\b))/i.test(`${topic.title} ${topic.description} ${topic.whyNow}`)));
  assert.ok(nicheTopics.every((topic) => !/(?:award[- ]winning daily .* publication|daily print newspaper|24\/7 website|front (?:center|centre)|photo(?:graph)? by|ap photo|illustration taken|stands? ahead of|reports? from)/i.test(`${topic.title} ${topic.description} ${topic.whyNow}`)));
  assert.ok(nicheTopics.every((topic) => !topic.imageSource || (new URL(topic.imageSource).protocol === "https:" && topic.imageSourcePageUrl === topic.url)));
  assert.doesNotMatch(JSON.stringify(nicheBrief), /&(?:ldquo|rdquo|lsquo|rsquo|hellip|nbsp|ndash|mdash);|&#(?:x[0-9a-f]+|\d+);/i);
  const musicTopics = nicheBrief.categories.filter((category) => category.parent === "Music").flatMap((category) => category.topics);
  const songTopics = musicTopics.filter((topic) => topic.musicKind === "song");
  assert.ok(songTopics.length > 0);
  assert.ok(songTopics.some((topic) => topic.musicSongTitle && topic.musicArtist && topic.playback?.kind === "track"));
  assert.ok(songTopics.every((topic) => !topic.playback || topic.playback.kind === "track"));
  assert.ok(musicTopics.every((topic) => !topic.playback || specificMusicPlayback(topic.playback, {
    text: `${topic.title} ${topic.description} ${topic.whyNow}`,
    title: topic.musicSongTitle,
    artist: topic.musicArtist,
  })));
  assert.ok(musicTopics.every((topic) => !topic.playback || !/\/playlist\//i.test(topic.playback.externalUrl)));
  assert.ok(musicTopics.every((topic) => /\b(?:song|track|single|album|EP|release|released|debut|drop|music video|official audio|chart|stream|playlist|viral (?:song|sound|audio)|listeners?|Spotify|Billboard)\b/i.test(`${topic.title} ${topic.description} ${topic.whyNow}`)));
  assert.ok(musicTopics.every((topic) => !/\b(?:festival|lineup|headliner|concert|tour|tickets?)\b/i.test(topic.title)
    || /\b(?:song|track|single|album|EP|release|released|debut|drop|music video|official audio|chart|stream|playlist)\b/i.test(`${topic.title} ${topic.description} ${topic.whyNow}`)));
  const nicheIds = new Set(nicheBrief.categories.map((category) => category.id));
  for (const id of ["edm", "football", "food-drink", "golf", "pop", "r-and-b-soul", "sports-news", "science-space", "tech-news"]) {
    assert.ok(categoryDefinitions.some((category) => category.id === id), `expected configured niche category: ${id}`);
  }
  for (const id of ["edm", "food-drink", "sports-news", "science-space", "tech-news"]) {
    assert.ok(nicheIds.has(id), `expected currently populated niche category: ${id}`);
  }

  const response = await render("/for-you");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Your internet/);
  assert.match(html, /Choose your corners/);
  assert.match(html, /Compile my feed/);
  assert.doesNotMatch(html, /Not a popularity contest|A weekly signal mix/);
  assert.match(html, /class="interest-tag/);
  assert.match(html, /class="is-active" href="\/for-you"[^>]*>For You<\/a>/);
  assert.match(html, /href="\/signin\?return_to=%2Ffor-you"/);
  assert.match(html, /profile-avatar-button/);
  assert.doesNotMatch(html, />Account<\/a>/);
  assert.doesNotMatch(html, /Continue with ChatGPT|Sign in with ChatGPT/);
  const forYouSource = await readFile(new URL("../app/components/for-you.tsx", import.meta.url), "utf8");
  const forYouStyles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const headerSource = await readFile(new URL("../app/components/site-header.tsx", import.meta.url), "utf8");
  const profileSettingsSource = await readFile(new URL("../app/components/profile-settings.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(forYouSource, /DigestLayout|digestLayoutFor|data-layout|digest-card-edge/);
  assert.match(forYouSource, /Sign in or create account/);
  assert.match(forYouSource, /className="digest-card"/);
  assert.match(forYouSource, /MusicPlaybackEmbed/);
  assert.match(forYouSource, /specificMusicPlaybackForTopic\(topic\)/);
  assert.match(forYouSource, /allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"/);
  assert.match(forYouStyles, /\.digest-card > \*/);
  assert.match(forYouStyles, /overflow-wrap: anywhere/);
  assert.match(forYouStyles, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(forYouStyles, /grid-column: 1 \/ -1/);
  assert.match(forYouStyles, /grid-template-columns: minmax\(280px, 0\.38fr\) minmax\(0, 0\.62fr\)/);
  assert.match(forYouStyles, /aspect-ratio: 16 \/ 10/);
  assert.match(forYouStyles, /\.digest-card-meta[\s\S]*align-items: baseline/);
  assert.match(forYouStyles, /\.tag-builder-summary[\s\S]*align-items: baseline/);
  assert.match(forYouStyles, /scroll-margin-top: calc\(var\(--header-height\) \+ 18px\)/);
  assert.doesNotMatch(forYouStyles, /digest-card-edge|rotate\(-17deg\)/);
  assert.doesNotMatch(forYouStyles, /transform: rotate\(-17deg\)/);
  assert.match(forYouStyles, /\.digest-why[\s\S]*margin-top: clamp\(26px, 4vw, 42px\)/);
  assert.match(forYouStyles, /object-fit: cover/);
  assert.match(forYouStyles, /@keyframes digest-card-in \{\s*from \{ opacity: 0; \}/);
  assert.match(headerSource, /ProfileSettingsPanel/);
  assert.doesNotMatch(headerSource, /href="\/account"/);
  assert.match(profileSettingsSource, /Email me a verification code/);
  assert.match(profileSettingsSource, /Verify new email/);
  assert.match(profileSettingsSource, /Save username/);

  const profile = await render("/api/for-you/profile", { headers: { accept: "application/json" } });
  assert.equal(profile.status, 401);
  const identity = await render("/api/account/identity", { headers: { accept: "application/json" } });
  assert.equal(identity.status, 401);
  const emailStart = await render("/api/account/email/start", { method: "POST", headers: { accept: "application/json" } });
  assert.equal(emailStart.status, 401);
  const emailVerify = await render("/api/account/email/verify", { method: "POST", headers: { accept: "application/json" } });
  assert.equal(emailVerify.status, 401);
  const account = await render("/account");
  assert.ok([301, 302, 307, 308].includes(account.status));
  assert.equal(account.headers.get("location"), "/for-you");
  const signIn = await render("/signin?return_to=%2Ffor-you");
  assert.equal(signIn.status, 200);
  const signInHtml = await signIn.text();
  assert.match(signInHtml, /Google sign-in/);
  const signInSource = await readFile(new URL("../app/components/sign-in-experience.tsx", import.meta.url), "utf8");
  assert.match(signInSource, /Email me a verification code/);
  assert.match(signInSource, /Verification code/);
  assert.doesNotMatch(signInSource, /password.*localStorage|localStorage.*password/i);
  const mobileAccountSource = await readFile(new URL("../../mobile/WhatspopularMobile/MobileAccountSheet.swift", import.meta.url), "utf8");
  assert.match(mobileAccountSource, /Email verification unavailable/);
  assert.match(mobileAccountSource, /Google sign-in unavailable/);
  assert.doesNotMatch(mobileAccountSource, /Use an existing website account|Link again on another device/);
  const providers = await render("/api/auth/providers", { headers: { accept: "application/json" } });
  assert.equal(providers.status, 200);
  assert.deepEqual(await providers.json(), { emailVerificationConfigured: false, googleConfigured: false });
  const mobileLink = await render("/mobile-link");
  assert.equal(mobileLink.status, 200);
  assert.match(await mobileLink.text(), /This link is invalid/);
  const revoke = await render("/api/account/sessions/revoke", { method: "POST" });
  assert.equal(revoke.status, 401);
});

test("matches Spotify players to the named card identity instead of accepting adjacent results", () => {
  assert.equal(normalizeMusicIdentity("Beyoncé — Memories"), "beyonce memories");
  const exact = selectExactSpotifyItem([
    { id: "wrongartist123", name: "Memories", artists: [{ name: "Another Artist" }] },
    { id: "righttrack123", name: "Memories", artists: [{ name: "beabadoobee" }] },
  ], { kind: "song", title: "Memories", artist: "Beabadoobee" });
  assert.equal(exact?.id, "righttrack123");
  assert.equal(selectExactSpotifyItem([
    { id: "livetrack123", name: "Memories (Live)", artists: [{ name: "beabadoobee" }] },
  ], { kind: "song", title: "Memories", artist: "Beabadoobee" }), null);
  assert.equal(spotifyPageMatchesIdentity(`
    <meta property="og:title" content="Memories">
    <meta property="og:description" content="beabadoobee · Pylon · Song · 2026">
  `, { kind: "song", title: "Memories", artist: "beabadoobee" }, "track"), true);
  assert.equal(spotifyPageMatchesIdentity(`
    <meta property="og:title" content="Memories (Live)">
    <meta property="og:description" content="beabadoobee · Live · Song · 2026">
  `, { kind: "song", title: "Memories", artist: "beabadoobee" }, "track"), false);
});

test("never edge-caches errors or unsafe request methods", async () => {
  const missing = await render("/definitely-not-a-page");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");

  const post = await render("/", { method: "POST" });
  assert.equal(post.headers.get("cache-control"), "no-store");
});

test("reuses deployment-versioned HTML from the edge cache", async () => {
  const hadCaches = Object.hasOwn(globalThis, "caches");
  const originalCaches = globalThis.caches;
  let stored;
  let matches = 0;
  let puts = 0;
  globalThis.caches = {
    default: {
      async match(request) {
        matches += 1;
        return stored?.url === request.url ? stored.response.clone() : undefined;
      },
      async put(request, response) {
        puts += 1;
        stored = { url: request.url, response };
      },
    },
  };
  try {
    const first = await render("/");
    assert.equal(first.status, 200);
    const firstHtml = await first.text();
    const second = await render("/?campaign=ignored");
    assert.equal(await second.text(), firstHtml);
    assert.equal(matches, 2);
    assert.equal(puts, 1);
    assert.match(stored.url, /\?__wpv=/);
    assert.doesNotMatch(stored.url, /campaign/);
  } finally {
    if (hadCaches) globalThis.caches = originalCaches;
    else delete globalThis.caches;
  }
});

test("validates every redirect before making the next request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private" } });
  };
  try {
    await assert.rejects(fetchBytes("https://example.com/start", {
      isAllowedHost: (hostname) => hostname === "example.com",
      kind: "test",
      maxBytes: 1024,
      timeoutMs: 1000,
      attempts: 1,
    }), /unapproved test URL/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runs address validation again after an approved-host redirect", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://images.example.net/private" } });
  };
  try {
    await assert.rejects(fetchBytes("https://publisher.example/story", {
      isAllowedHost: (hostname) => hostname.endsWith(".example") || hostname.endsWith(".example.net"),
      validateHost: async (hostname) => {
        if (hostname === "images.example.net") throw new Error("Refusing non-public host");
      },
      kind: "test",
      maxBytes: 1024,
      timeoutMs: 1000,
      attempts: 1,
    }), /non-public host/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects oversized upstream responses before reading them", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(2048), {
    headers: { "content-length": "2048", "content-type": "text/plain" },
  });
  try {
    await assert.rejects(fetchBytes("https://example.com/data", {
      isAllowedHost: (hostname) => hostname === "example.com",
      kind: "test",
      maxBytes: 1024,
      timeoutMs: 1000,
      attempts: 1,
    }), /exceeds 1024 bytes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extracts safe lead images from linked publisher metadata", () => {
  const metadata = extractArticleImage(`
    <meta content="https://cdn.example.com/news/lead.jpg?width=1200&amp;height=675" property="og:image">
    <meta name="twitter:image" content="https://cdn.example.com/logo.png">
    <meta property="og:image:alt" content="Storm clouds approaching the coast">
  `, "https://www.example.com/story");
  assert.equal(metadata.imageSource, "https://cdn.example.com/news/lead.jpg?width=1200&height=675");
  assert.equal(metadata.imageAlt, "Storm clouds approaching the coast");
  assert.equal(extractArticleTitle('<meta property="og:title" content="A concrete current event">'), "A concrete current event");
  const structured = extractArticleImage(`
    <script type="application/ld+json">{"url":"https://www.example.com/story","image":{"url":"https://cdn.example.com/news/structured.jpg"}}</script>
  `, "https://www.example.com/story");
  assert.equal(structured.imageSource, "https://cdn.example.com/news/structured.jpg");
  const intro = extractArticleIntro(`
    <article><p>The company announced a recall after officials found a contamination risk across several states.</p>
    <p>The move affects stores nationwide and has prompted new guidance for consumers.</p></article>
  `);
  assert.match(intro, /recall after officials found a contamination risk/);
  assert.match(extractArticleIntro('<meta property="og:description" content="The product returned this week after a limited re-release and demand rose quickly.">'), /returned this week after a limited re-release/);
  const captionSafeIntro = extractArticleIntro(`
    <meta name="description" content="The federation president accused FIFA of fear tactics after it removed a senior executive.">
    <article>
      <p class="image-caption">FIFA officials stand ahead of a World Cup match in Texas, Tuesday.</p>
      <p>The federation president said the firing was unacceptable and urged leaders to resist damaging orders.</p>
    </article>
  `, "Federation president accuses FIFA after executive firing");
  assert.match(captionSafeIntro, /accused FIFA of fear tactics/);
  assert.doesNotMatch(captionSafeIntro, /stand ahead of a World Cup match/i);
  assert.doesNotMatch(extractArticleIntro(`
    <meta name="description" content="The Journal Record is an award-winning daily general business and legal publication with a 24/7 website.">
    <article><p class="image-caption">Illustration taken February 19, 2024.</p></article>
  `, "AI spending drives record tech debt"), /award-winning daily|Illustration taken/i);
  const boundedIntro = extractArticleIntro(`
    <article><p>Officials announced a new event after months of preparation. The update drew fresh attention from readers.</p>
    <p>This paragraph is deliberately long and should not be clipped in the middle of a sentence when the ingestion limit is reached. It remains complete.</p></article>
  `);
  assert.doesNotMatch(boundedIntro, /(?:…|\.\.\.)\s*$|\b(?:and|or|of|to|with)\.?$/i);
  const contextRichIntro = extractArticleIntro(`
    <article><p>The item returned this week and quickly drew attention from shoppers.</p>
    <p>Retailers described the demand as unusually strong during the limited window.</p>
    <p>The product was first introduced in 2017 and became a memorable limited release.</p>
    <p>More background that is less relevant to the current explanation.</p></article>
  `);
  assert.match(contextRichIntro, /first introduced in 2017/);
  assert.doesNotMatch(extractArticleIntro(`
    <article><p>See more of our coverage and sign up for our newsletter to receive updates.</p>
    <p>Officials opened an investigation after the incident was reported at several locations.</p></article>
  `), /See more of our coverage/i);
  assert.deepEqual(extractPlayableMedia(`
    <iframe data-src="https://open.spotify.com/embed/album/2os46ReV779WlryAHPL6ko?si=ignored"></iframe>
  `, "https://publisher.example/story"), {
    provider: "Spotify",
    kind: "album",
    externalUrl: "https://open.spotify.com/album/2os46ReV779WlryAHPL6ko",
    embedUrl: "https://open.spotify.com/embed/album/2os46ReV779WlryAHPL6ko?utm_source=whatspopular&theme=0",
    label: "Listen on Spotify",
  });
  assert.equal(extractPlayableMedia(`
    <iframe src="https://open.spotify.com/embed/playlist/5359l8Co8qztllR0Mxk4Zv"></iframe>
  `, "https://publisher.example/story"), null);
  assert.deepEqual(extractPlayableMedia(`
    <meta property="og:video" content="https://www.youtube.com/watch?v=veBbOF5OtO8">
  `, "https://publisher.example/story"), {
    provider: "YouTube",
    externalUrl: "https://www.youtube.com/watch?v=veBbOF5OtO8",
    embedUrl: "https://www.youtube-nocookie.com/embed/veBbOF5OtO8?rel=0",
    label: "Watch on YouTube",
  });
  assert.equal(extractPlayableMedia("<a href=\"https://open.spotify.com/u\">bad</a>", "https://publisher.example/story"), null);
  assert.throws(() => publicHttpsUrl("http://example.com/image.jpg"), /non-public/);
  assert.throws(() => publicHttpsUrl("https://127.0.0.1/image.jpg"), /non-public/);
});

test("classifies public and reserved network addresses", () => {
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("10.0.0.1"), false);
  assert.equal(isPublicAddress("169.254.1.1"), false);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("::1"), false);
  assert.equal(isPublicAddress("fc00::1"), false);
});

test("bounded concurrency preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapConcurrent([3, 1, 4, 2], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(result, [6, 2, 8, 4]);
  assert.equal(peak, 2);
});

test("rate-limited work stays serialized after failures", async () => {
  const schedule = createRateLimiter(1);
  const events = [];
  const first = schedule(async () => {
    events.push("first-start");
    throw new Error("expected failure");
  }).catch(() => events.push("first-failed"));
  const second = schedule(async () => {
    events.push("second-start");
    return "ok";
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-failed", "second-start"]);
});

test("keeps content and outbound links constrained", async () => {
  const brief = JSON.parse(await readFile(new URL("../data/trends.json", import.meta.url), "utf8"));
  assert.deepEqual(brief.sections.map((section) => section.id),
    ["people", "movies", "books", "music", "products", "news", "memes", "slang"]);
  assert.equal(brief.quiz.durationSeconds, 15);
  assert.equal(brief.quiz.questions.length, 15);
  const quizCounts = new Map();
  for (const question of brief.quiz.questions) {
    assert.ok(["memes", "people", "movies", "books", "news"].includes(question.topicId));
    assert.equal(question.answers.length, 4);
    assert.equal(new Set(question.answers).size, 4);
    assert.ok(question.answers.includes(question.correctAnswer));
    quizCounts.set(question.topicId, (quizCounts.get(question.topicId) ?? 0) + 1);
    const sourceSection = brief.sections.find((section) => section.id === question.topicId);
    const sourceItem = [...(sourceSection?.items ?? []), ...(sourceSection?.moreItems ?? [])]
      .find((item) => item.title === question.itemTitle);
    assert.ok(sourceItem);
    assert.equal(quizQuestionIsUsable(question.prompt, question.itemTitle, question.topicId, sourceItem.description), true);
  }
  const movieQuizQuestions = brief.quiz.questions.filter((question) => question.topicId === "movies");
  assert.ok(movieQuizQuestions.every((question) => !/^This film is (?:an?\s+)?[\w/-]+ film\./i.test(question.prompt)));
  assert.ok(movieQuizQuestions.every((question) => /\b(?:about|after|before|character|conflict|creator|discovers?|dimension|encounters?|family|follows?|forced|friendship|happens?|home|journey|king|memory|mission|mystery|plot|premise|reunite|returns?|set|sister|story|stranded|takes?|tries?|undergoes?|wakes?|when|where|while|world)\b/i.test(question.prompt)));
  assert.ok([...quizCounts.values()].every((count) => count === 3));
  assert.ok(brief.sections.every((section) => section.items.length === 5));
  assert.ok(brief.sections.every((section) => section.moreItems.length <= 15));
  for (const section of brief.sections) {
    assert.ok(section.sources.length >= 2 && section.sources.length <= 3);
    assert.ok(section.sources.every((source) => source.label && new URL(source.url).protocol === "https:"));
    assert.deepEqual(section.moreItems.map((item) => item.rank), section.moreItems.map((_, index) => index + 6));
    assert.ok(section.moreItems.every((item) => !section.items.some((topItem) => topItem.title === item.title)));
    assert.ok(section.moreItems.every((item) => !/(?:…|\.{3})\s*$/.test(item.description)));
  }
  const items = brief.sections.flatMap((section) => [...section.items, ...section.moreItems]);
  for (const item of items) {
    assert.match(item.image, /^\/culture\/[a-z0-9-]+\.webp$/);
    assert.equal(new URL(item.url).protocol, "https:");
    assert.ok(item.description.length >= 30);
    assert.ok(item.alt.length >= 5);
    assert.match(item.accent, /^#[0-9a-f]{6}$/i);
    assert.ok(item.evidence.length >= 2 && item.evidence.length <= 3);
    assert.ok(new Set(item.evidence.map((entry) => entry.source)).size >= 2);
    assert.ok(new Set(item.evidence.map((entry) => new URL(entry.url).hostname)).size >= 2);
    if (item.imageSource) assert.equal(new URL(item.imageSource).protocol, "https:");
  }
  const memes = brief.sections.find((section) => section.id === "memes");
  assert.ok(memes.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.youtube.com")));
  assert.ok(memes.items.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "knowyourmeme.com")));
  assert.ok(memes.moreItems.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.youtube.com")));
  assert.ok(memes.moreItems.every((item) => item.description.length >= 40));
  assert.ok(memes.items.every((item) => /Meme of the Month$/.test(item.metric.label)));
  const pollRanks = memes.items.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(pollRanks, [...pollRanks].sort((left, right) => left - right));
  assert.doesNotMatch(memes.items.map((item) => item.description).join(" "), /placed in Know Your Meme|reached Lessons in Meme Culture|has a Know Your Meme entry/i);
  const people = brief.sections.find((section) => section.id === "people");
  const allPeople = [...people.items, ...people.moreItems];
  assert.ok(allPeople.every((item) => /^Wikipedia views · [A-Z][a-z]+$/.test(item.metric.label)));
  assert.ok(allPeople.every((item) => !item.subtitle.includes("·")));
  assert.ok(allPeople.every((item) => !/Wikipedia (?:article )?(?:drew|views?)/i.test(item.description)));
  const noisyCopyPattern = /\b(?:according to|reported by|reports? say|as reported|takes? a closer look|everything (?:we|you) know|what you need to know|not what you think|publisher|source says)\b|(?:…|\.\.\.)\s*$/i;
  assert.ok(allPeople.every((item) => !noisyCopyPattern.test(item.description)));
  assert.ok(allPeople.every((item) => !/(?:^|\s)[a-z]{1,2}\.$/.test(item.description)));
  const categoryCounts = new Map();
  for (const item of allPeople) categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  assert.ok([...categoryCounts.values()].every((count) => count <= 2));
  const slang = brief.sections.find((section) => section.id === "slang");
  assert.ok(slang.items.every((item) => item.metric.label === "Know Your Meme page views"));
  assert.ok(slang.items.every((item) => /^\d{1,3}(?:,\d{3})*$/.test(item.metric.value)));
  assert.ok(slang.moreItems.every((item) => item.metric.label === "Know Your Meme page views"));
  const slangViews = [...slang.items, ...slang.moreItems].map((item) => Number(item.metric.value.replaceAll(",", "")));
  assert.deepEqual(slangViews, [...slangViews].sort((left, right) => right - left));
  assert.ok([...slang.items, ...slang.moreItems].every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.urbandictionary.com")));
  const movies = brief.sections.find((section) => section.id === "movies");
  assert.equal(movies.title, "Movies");
  const allMovies = [...movies.items, ...movies.moreItems];
  assert.ok(allMovies.every((item) => /^Wikipedia views · [A-Z][a-z]+$/.test(item.metric.label)));
  assert.ok(allMovies.every((item) => /^\d+(?:\.\d{1,2})?[MK]?$/.test(item.metric.value)));
  assert.ok(allMovies.every((item) => item.rating === "Not rated" || /^\d+(?:\.\d)?$/.test(item.rating)));
  assert.ok(allMovies.every((item) => item.description.length >= 30));
  assert.ok(allMovies.every((item) => /\b(?:about|after|before|cent(?:er|re)s?|discovers?|encounters?|follows?|forced|journey|must|reunite|returns?|set|stranded|takes? place|tries?|undergoes?|when|where|while|wakes?|story|film|movie)\b/i.test(item.description)));
  assert.ok(allMovies.every((item) => !/Wikipedia views|most-read movie pages/i.test(item.description)));
  const movieViews = allMovies.map((item) => Number(item.metric.value.replace("M", "e6").replace("K", "e3")));
  assert.deepEqual(movieViews, [...movieViews].sort((left, right) => right - left));
  const books = brief.sections.find((section) => section.id === "books");
  const allBooks = [...books.items, ...books.moreItems];
  assert.ok(allBooks.every((item) => item.metric.label === "Goodreads monthly readers"));
  assert.ok(allBooks.every((item) => /^Goodreads · /.test(item.subtitle)));
  assert.ok(allBooks.every((item) => new URL(item.url).hostname === "www.goodreads.com"));
  assert.ok(allBooks.every((item) => new URL(item.imageSource).hostname === "i.gr-assets.com"));
  assert.ok(allBooks.every((item) => item.ratingLabel === "Goodreads" && /^\d(?:\.\d{2})$/.test(item.rating)));
  assert.ok(allBooks.every((item) => !/^\w+(?:\s+\w+)* is a book by /i.test(item.description)));
  assert.ok(allBooks.every((item) => !/\b(?:may refer to|was a rock band|television sitcom|American actor|any disturbed state)\b/i.test(item.description)));
  const bookReaders = allBooks.map((item) => Number(item.metric.value.replaceAll(",", "")));
  assert.deepEqual(bookReaders, [...bookReaders].sort((left, right) => right - left));
  const music = brief.sections.find((section) => section.id === "music");
  assert.match(music.description, /songs with a fresh chart, playlist, release, or audience signal/i);
  const allSongs = [...music.items, ...music.moreItems];
  assert.ok(allSongs.length >= 5 && allSongs.length <= 10);
  assert.ok(allSongs.every((item) => item.metric.label === "Billboard Hot 100"));
  assert.ok(allSongs.every((item) => Number.isInteger(item.spotifyRank) && item.spotifyRank <= 50));
  assert.ok(allSongs.every((item) => /^[A-Za-z0-9]{22}$/.test(item.spotifyId)));
  const billboardRanks = allSongs.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(billboardRanks, [...billboardRanks].sort((left, right) => left - right));
  assert.ok(allSongs.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.billboard.com")));
  assert.ok(allSongs.every((item) => !/Billboard Hot 100|Spotify’s Today’s Top Hits|\b#\d+\b/i.test(item.description)));
  assert.ok(allSongs.every((item) => /\b(?:fans?|listeners?|audiences?|viral|social media|playlist|cover|dance|edit|replay|meme|soundtrack|karaoke)\b/i.test(item.description)));
  assert.ok(allSongs.every((item) => !/^(?:“[^”]+”\s+)?is\s+(?:a\s+)?(?:track|song)\s+by\b/i.test(item.description)));
  const songsWithCurrentCoverage = allSongs.filter((item) => item.evidence.length >= 3);
  assert.ok(songsWithCurrentCoverage.every((item) => !/^“[^”]+” is a track by [^.]+(?:, released [^.]+)?\.$/i.test(item.description)));
  const products = brief.sections.find((section) => section.id === "products");
  const allProducts = [...products.items, ...products.moreItems];
  assert.ok(allProducts.every((item) => (item.metric.label === "Independent viral sources"
    && /^\d+ sources?$/.test(item.metric.value)
    && Number(item.metric.value.match(/^(\d+)/)[1]) >= 2)
    || (item.metric.label === "Recent viral source + Amazon velocity"
      && item.metric.value === "1 source + Amazon velocity")));
  assert.ok(allProducts.every((item) => !/\bis a consumer product\./i.test(item.description)));
  assert.ok(allProducts.every((item) => /\b(?:backorder|buying|collect(?:ing|or)?|craze|demand|expansion|frenzy|global|interest|launch|opening|popular|pre[- ]?order|recommend|record|release|restock|return|rollout|selling|sold out|trend(?:ing)?|unbox(?:ing)?|viral)\b/i.test(item.description)));
  assert.ok(allProducts.every((item) => {
    const url = new URL(item.url);
    const amazonListing = url.hostname === "www.amazon.com" && /^\/(?:dp|gp\/product)\/[A-Z0-9]{10}\/?$/i.test(url.pathname);
    const relatedArticle = url.hostname !== "www.amazon.com" && item.evidence.some((entry) => entry.url === item.url);
    return (amazonListing || relatedArticle) && item.imageSource;
  }));
  assert.ok(allProducts.every((item) => !/^\/s(?:\/|$)/i.test(new URL(item.url).pathname)));
  assert.ok(allProducts.every((item) => item.evidence.every((entry) => new URL(entry.url).hostname !== "news.google.com")));
  assert.ok(allProducts.every((item) => !/Google Shopping|ranking it #|rose \+\d|TikTok/i.test(item.description)));
  assert.ok(allProducts.every((item) => !noisyCopyPattern.test(item.description)));
  const news = brief.sections.find((section) => section.id === "news");
  assert.equal(news.sources[1]?.url, "https://news.google.com/");
  assert.ok(news.sources.every((source) => !news.items.some((item) => item.url === source.url)));
  const volume = (value) => {
    const match = value.match(/([\d.]+)\s*([KMB])?\+/i);
    return Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]] ?? 1);
  };
  const newsVolumes = [...news.items, ...news.moreItems].map((item) => volume(item.metric.value));
  assert.deepEqual(newsVolumes, [...newsVolumes].sort((left, right) => right - left));
  assert.ok([...news.items, ...news.moreItems].every((item) => item.metric.label === "Google search volume"));
  assert.ok([...news.items, ...news.moreItems].every((item) => /^News(?: · [A-Z][a-z]{2} \d{1,2}, \d{4})?$/.test(item.subtitle)));
  assert.ok([...news.items, ...news.moreItems].every((item) => !/past 7 days/i.test(item.subtitle)));
  assert.ok([...news.items, ...news.moreItems].every((item) => !/U\.S\. Google searches|search volume|placing it #/i.test(item.description)));
  assert.ok([...news.items, ...news.moreItems].every((item) => item.description.length >= 24 && item.description.length <= 360));
  assert.ok([...news.items, ...news.moreItems].every((item) => !noisyCopyPattern.test(item.description)));
  assert.ok([...news.items, ...news.moreItems].every((item) => item.imageSourceKind !== "article"
    || (item.imageSourcePageUrl === item.url && !["news.google.com", "en.wikipedia.org", "commons.wikimedia.org"].includes(new URL(item.imageSource).hostname))));
  const updater = await readFile(new URL("../scripts/update-trends.mjs", import.meta.url), "utf8");
  assert.match(updater, /AF_initDataCallback/);
  assert.match(updater, /data-term/);
  assert.match(updater, /parseAnnualSlangReview/);
  assert.match(updater, /generateQuizBatch/);
  assert.match(updater, /productExpansionSeeds/);
  assert.match(updater, /PRODUCT_MOVERS_SNAPSHOT/);
  assert.match(updater, /productTokenSubset/);
  assert.match(updater, /commerceSource/);
  assert.match(updater, /isAmazonListingUrl/);
  assert.match(updater, /amazonListingMatchesProduct/);
  assert.match(updater, /amazonDetailMatchesProduct/);
  assert.match(updater, /musicContextForTrack/);
  assert.match(updater, /current_reception/);
  assert.match(updater, /source-grounded audience context/);
  assert.doesNotMatch(updater, /Unicorn Frappuccino|Galaxy Z Fold 8/i);
  assert.doesNotMatch(updater, /annualSlangCandidates|summaryQuery\s*=/);
  assert.doesNotMatch(JSON.stringify(brief), /tiktok|socialcounts|socialblade/i);
  assert.doesNotMatch(JSON.stringify(brief), /caution|b\*{2,}|a\*{2,}/i);
  assert.doesNotMatch(JSON.stringify(brief), /"(?:signal|score)":/);
  const referencedImages = new Set(items.map((item) => item.image.split("/").at(-1)));
  const nicheBrief = JSON.parse(await readFile(new URL("../data/niche-trends.json", import.meta.url), "utf8"));
  const referencedNicheImages = new Set(nicheBrief.categories.flatMap((category) => category.topics.map((topic) => topic.image.split("/").at(-1))));
  const cachedImages = new Set((await readdir(new URL("../public/culture/", import.meta.url))).filter((file) => file.endsWith(".webp")));
  assert.deepEqual(cachedImages, new Set([...referencedImages, ...referencedNicheImages]));

  const expectedDimensions = {
    landscape: { width: 720, height: 520 },
    poster: { width: 520, height: 780 },
    square: { width: 640, height: 640 },
  };
  for (const section of brief.sections) {
    for (const item of [...section.items, ...section.moreItems]) {
      const metadata = await sharp(fileURLToPath(new URL(`../public${item.image}`, import.meta.url))).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, expectedDimensions[section.layout].width);
      assert.equal(metadata.height, expectedDimensions[section.layout].height);
    }
  }
  for (const topic of nicheBrief.categories.flatMap((category) => category.topics)) {
    const metadata = await sharp(fileURLToPath(new URL(`../public${topic.image}`, import.meta.url))).metadata();
    assert.equal(metadata.format, "webp");
    assert.equal(metadata.width, 720);
    assert.equal(metadata.height, 520);
  }

  const socialPreview = await sharp(fileURLToPath(new URL("../public/og.jpg", import.meta.url))).metadata();
  assert.equal(socialPreview.format, "jpeg");
  assert.equal(socialPreview.width, 1200);
  assert.equal(socialPreview.height, 630);
});
