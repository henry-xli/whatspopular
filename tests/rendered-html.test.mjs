import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { buildDescriptionPrompt, buildQuizPrompt, generateDescriptionBatch, parseDescriptionOutput, parseQuizOutput } from "../scripts/ai-descriptions.mjs";
import { extractArticleImage, extractArticleIntro, publicHttpsUrl } from "../scripts/news-article.mjs";
import { fetchBytes, isPublicAddress, mapConcurrent } from "../scripts/runtime.mjs";

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
    sourceSnippets: [{ source: "Publisher", text: "The person appeared in a new film this summer." }],
  }]);
  assert.match(prompt, /SOURCE DATA BEGIN/);
  assert.match(prompt, /untrusted reference data/i);
  assert.match(prompt, /recent event or coverage/i);
  assert.match(prompt, /Never mention a publisher|quote a headline/i);
  const parsed = parseDescriptionOutput({
    output_text: JSON.stringify({ descriptions: [
      { id: "people-1", description: "Example Person is an actor whose new film role has brought them renewed attention this summer." },
      { id: "unexpected", description: "This must be ignored." },
    ] }),
  }, ["people-1"]);
  assert.equal(parsed.get("people-1"), "Example Person is an actor whose new film role has brought them renewed attention this summer.");
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
  assert.match(prompt, /one or two complete sentences/i);
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

test("renders the complete finite culture briefing", async () => {
  const brief = JSON.parse(await readFile(new URL("../data/trends.json", import.meta.url), "utf8"));
  const allItems = brief.sections.flatMap((section) => [...section.items, ...section.moreItems]);
  const homeResponse = await render();
  const response = await render("/explore");
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
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-permitted-cross-domain-policies"), "none");
  assert.match(response.headers.get("cache-control") ?? "", /s-maxage=86400/);

  const html = await response.text();
  assert.match(html, /class="is-active" href="\/explore"[^>]*>Explore<\/a>/);
  assert.match(html, /Everything worth knowing at a glance/);
  assert.match(html, /class="explore-index"/);
  for (const id of ["memes", "slang", "people", "movies", "books", "music", "products", "news"]) {
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
  const boardPositions = ["memes", "slang", "people", "movies", "books", "music", "products", "news"]
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
  assert.equal(images.length, allItems.length);
  assert.ok(images.every((image) => /\balt="[^"]+"/.test(image)));
  assert.ok(images.every((image) => /\bwidth="\d+"/.test(image) && /\bheight="\d+"/.test(image)));
  assert.ok(images.every((image) => /\bloading="lazy"/.test(image) && /\bdecoding="async"/.test(image)));
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  assert.equal((html.match(/class="culture-card/g) ?? []).length, 40);
  assert.equal((html.match(/<details class="expanded-ranking"/g) ?? []).length,
    brief.sections.filter((section) => section.moreItems.length).length);
  assert.equal((html.match(/class="expanded-entry /g) ?? []).length,
    brief.sections.reduce((count, section) => count + section.moreItems.length, 0));
  assert.doesNotMatch(html, /class="expanded-source"|↗|▶/);
  assert.match(html, /class="ui-icon ui-icon-external/);
  assert.match(html, /<svg class="ui-icon ui-icon-external/);
  assert.match(html, /class="ui-icon ui-icon-play/);
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
  for (const label of ["Pull sources", "Ingest daily", "Build the snapshot", "Write and quiz", "Validate and publish"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.doesNotMatch(html, /The eight algorithms|Exactly how each list is made/);
  assert.match(html, /last good snapshot stays live/i);
  assert.match(html, /<main class="about-page" id="main-content" tabindex="-1">/);
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
  const structured = extractArticleImage(`
    <script type="application/ld+json">{"url":"https://www.example.com/story","image":{"url":"https://cdn.example.com/news/structured.jpg"}}</script>
  `, "https://www.example.com/story");
  assert.equal(structured.imageSource, "https://cdn.example.com/news/structured.jpg");
  const intro = extractArticleIntro(`
    <article><p>The company announced a recall after officials found a contamination risk across several states.</p>
    <p>The move affects stores nationwide and has prompted new guidance for consumers.</p></article>
  `);
  assert.match(intro, /recall after officials found a contamination risk/);
  const boundedIntro = extractArticleIntro(`
    <article><p>Officials announced a new event after months of preparation. The update drew fresh attention from readers.</p>
    <p>This paragraph is deliberately long and should not be clipped in the middle of a sentence when the ingestion limit is reached. It remains complete.</p></article>
  `);
  assert.doesNotMatch(boundedIntro, /(?:…|\.\.\.)\s*$|\b(?:and|or|of|to|with)\.?$/i);
  assert.doesNotMatch(extractArticleIntro(`
    <article><p>See more of our coverage and sign up for our newsletter to receive updates.</p>
    <p>Officials opened an investigation after the incident was reported at several locations.</p></article>
  `), /See more of our coverage/i);
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

test("keeps content and outbound links constrained", async () => {
  const brief = JSON.parse(await readFile(new URL("../data/trends.json", import.meta.url), "utf8"));
  assert.deepEqual(brief.sections.map((section) => section.id),
    ["memes", "slang", "people", "movies", "books", "music", "products", "news"]);
  assert.equal(brief.quiz.durationSeconds, 15);
  assert.equal(brief.quiz.questions.length, 15);
  const quizCounts = new Map();
  for (const question of brief.quiz.questions) {
    assert.ok(["memes", "people", "movies", "books", "news"].includes(question.topicId));
    assert.equal(question.answers.length, 4);
    assert.equal(new Set(question.answers).size, 4);
    assert.ok(question.answers.includes(question.correctAnswer));
    quizCounts.set(question.topicId, (quizCounts.get(question.topicId) ?? 0) + 1);
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
  assert.match(music.description, /first 10 tracks in Spotify’s Today’s Top Hits/i);
  const allSongs = [...music.items, ...music.moreItems];
  assert.ok(allSongs.every((item) => item.metric.label === "Billboard Hot 100"));
  assert.ok(allSongs.every((item) => Number.isInteger(item.spotifyRank) && item.spotifyRank <= 50));
  assert.ok(allSongs.every((item) => /^[A-Za-z0-9]{22}$/.test(item.spotifyId)));
  const billboardRanks = allSongs.map((item) => Number(item.metric.value.slice(1)));
  assert.deepEqual(billboardRanks, [...billboardRanks].sort((left, right) => left - right));
  assert.ok(allSongs.every((item) => item.evidence.some((entry) => new URL(entry.url).hostname === "www.billboard.com")));
  assert.ok(allSongs.every((item) => !/Billboard Hot 100|Spotify’s Today’s Top Hits|\b#\d+\b/i.test(item.description)));
  const products = brief.sections.find((section) => section.id === "products");
  const allProducts = [...products.items, ...products.moreItems];
  assert.ok(allProducts.every((item) => (item.metric.label === "Independent viral sources"
    && /^\d+ sources?$/.test(item.metric.value)
    && Number(item.metric.value.match(/^(\d+)/)[1]) >= 2)
    || (item.metric.label === "Recent viral source + Amazon velocity"
      && item.metric.value === "1 source + Amazon velocity")));
  assert.ok(allProducts.every((item) => !/\bis a consumer product\./i.test(item.description)));
  assert.ok(allProducts.every((item) => /\b(?:backorder|buying|collect(?:ing|or)?|craze|demand|expansion|frenzy|global|launch|opening|popular|pre[- ]?order|recommend|release|restock|return|rollout|selling|sold out|trend(?:ing)?|unbox(?:ing)?|viral)\b/i.test(item.description)));
  assert.ok(allProducts.every((item) => {
    const url = new URL(item.url);
    return url.hostname === "www.amazon.com" && item.imageSource;
  }));
  assert.ok(allProducts.every((item) => item.evidence.every((entry) => new URL(entry.url).hostname !== "news.google.com")));
  assert.ok(allProducts.every((item) => !/Google Shopping|ranking it #|rose \+\d|TikTok/i.test(item.description)));
  assert.ok(allProducts.every((item) => !noisyCopyPattern.test(item.description)));
  const news = brief.sections.find((section) => section.id === "news");
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
  assert.match(updater, /data-term/);
  assert.match(updater, /parseAnnualSlangReview/);
  assert.match(updater, /generateQuizBatch/);
  assert.match(updater, /productExpansionSeeds/);
  assert.match(updater, /PRODUCT_MOVERS_SNAPSHOT/);
  assert.match(updater, /productTokenSubset/);
  assert.match(updater, /commerceSource/);
  assert.doesNotMatch(updater, /Unicorn Frappuccino|Galaxy Z Fold 8/i);
  assert.doesNotMatch(updater, /annualSlangCandidates|summaryQuery\s*=/);
  assert.doesNotMatch(JSON.stringify(brief), /tiktok|socialcounts|socialblade/i);
  assert.doesNotMatch(JSON.stringify(brief), /caution|b\*{2,}|a\*{2,}/i);
  assert.doesNotMatch(JSON.stringify(brief), /"(?:signal|score)":/);
  const referencedImages = new Set(items.map((item) => item.image.split("/").at(-1)));
  const cachedImages = new Set((await readdir(new URL("../public/culture/", import.meta.url))).filter((file) => file.endsWith(".webp")));
  assert.deepEqual(cachedImages, referencedImages);

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

  const socialPreview = await sharp(fileURLToPath(new URL("../public/og.jpg", import.meta.url))).metadata();
  assert.equal(socialPreview.format, "jpeg");
  assert.equal(socialPreview.width, 1200);
  assert.equal(socialPreview.height, 630);
});
