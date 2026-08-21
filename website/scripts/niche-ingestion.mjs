import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fallbackBrief from "../data/niche-trends.json" with { type: "json" };
import { generateNicheBatch, isNicheTopicUsable } from "./ai-descriptions.mjs";
import { additionalNicheCategories } from "./niche-catalog.mjs";
import { decodeHtmlEntities, linkedArticleMetadata, resolveGoogleNewsArticle } from "./news-article.mjs";
import { fetchBytes, mapConcurrent } from "./runtime.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(root, "data", "niche-trends.json");
const nicheSourceHost = "news.google.com";
const nicheSourceHosts = new Set([
  nicheSourceHost,
  "djmag.com",
  "www.billboard.com",
  "www.rollingstone.com",
  "www.nme.com",
  "www.stereogum.com",
  "stereogum.com",
  "www.edmtunes.com",
  "edmtunes.com",
  "thegroovecartel.com",
  "www.tranceattack.net",
  "tranceattack.net",
  "www.edmsauce.com",
  "edmsauce.com",
  "www.dancingastronaut.com",
  "dancingastronaut.com",
  "www.soompi.com",
  "www.koreaboo.com",
  "www.xxlmag.com",
  "ratedrnb.com",
  "www.whiskeyriff.com",
  "www.savingcountrymusic.com",
  "savingcountrymusic.com",
  "www.afrocritik.com",
  "afrocritik.com",
  "www.notjustok.com",
  "notjustok.com",
  "www.thelineofbestfit.com",
  "thelineofbestfit.com",
  "pitchfork.com",
]);
const musicPublisherFeeds = [
  { url: "https://djmag.com/rss.xml", source: "DJ Mag", categories: ["edm"] },
  { url: "https://www.edmtunes.com/feed/", source: "EDM Tunes", categories: ["edm"] },
  { url: "https://thegroovecartel.com/feed/", source: "The Groove Cartel", categories: ["edm"] },
  { url: "https://www.tranceattack.net/feed/", source: "Trance Attack", categories: ["edm"] },
  { url: "https://www.edmsauce.com/feed/", source: "EDM Sauce", categories: ["edm"] },
  { url: "https://www.dancingastronaut.com/feed/", source: "Dancing Astronaut", categories: ["edm"] },
  { url: "https://www.soompi.com/feed", source: "Soompi", categories: ["kpop"] },
  { url: "https://www.koreaboo.com/feed/", source: "Koreaboo", categories: ["kpop"] },
  { url: "https://www.billboard.com/c/music/pop/feed/", source: "Billboard Pop", categories: ["pop"] },
  { url: "https://www.xxlmag.com/feed/", source: "XXL", categories: ["hip-hop-rap"] },
  { url: "https://ratedrnb.com/feed/", source: "Rated R&B", categories: ["r-and-b-soul"] },
  { url: "https://www.billboard.com/c/music/latin/feed/", source: "Billboard Latin", categories: ["latin-music"] },
  { url: "https://www.whiskeyriff.com/feed/", source: "Whiskey Riff", categories: ["country"] },
  { url: "https://www.savingcountrymusic.com/feed/", source: "Saving Country Music", categories: ["country"] },
  { url: "https://www.afrocritik.com/feed/", source: "Afrocritik", categories: ["afrobeats"] },
  { url: "https://notjustok.com/feed/", source: "NotJustOk", categories: ["afrobeats"] },
  { url: "https://www.thelineofbestfit.com/feed", source: "The Line of Best Fit", categories: ["indie-alternative"] },
  { url: "https://pitchfork.com/feed/feed-news/rss", source: "Pitchfork", categories: ["indie-alternative"], categorySignalRequired: true },
  { url: "https://www.billboard.com/feed/", source: "Billboard", categories: ["all"] },
  { url: "https://www.rollingstone.com/music/music-news/feed/", source: "Rolling Stone", categories: ["all"] },
  { url: "https://www.nme.com/feed", source: "NME", categories: ["all"] },
  { url: "https://www.stereogum.com/feed/", source: "Stereogum", categories: ["all"] },
];
const musicFeedCache = new Map();
const maxBytes = 2 * 1024 * 1024;
const timeoutMs = 15_000;
const maxPublisherCandidates = 12;
const maxCandidateAgeDays = 8;
// A lane may publish one verified card when that is all the live evidence
// supports. Never manufacture a second card just to make the lane look full.
const minimumNicheTopics = 1;
const contextualQuery = "(return OR comeback OR announcement OR result OR record OR chart OR restock OR sold out OR demand OR reaction OR meme)";
const concreteContextPattern = /\b(?:after|amid|announc|assign|award|brought back|bring(?:s|ing)? back|because|comeback|confirm|debut(?:ed)?|demand|drop|first introduced|introduced|launch|limited(?:[- ]time)?|meme|nomination|nostalgia|original(?:ly)?|reaction|receiv|return(?:ed|ing)?|re-?released?|reintroduc|revived|viral|fans?|funny|walk(?:ed|ing)?|appearance|sold out|restock(?:ed)?|survey|study|research|report|win|won|beat|loss|match|tournament|championship|playoffs?|final|injur|trade|transfer|sign(?:ed|ing)?|ruling|vote|strike|storm|fire|earthquake|mission|update|festival|concert|tour|game|season|episode|chapter|premiere|trailer|cast|world cup|record|roster|suspension|red card|special|stand[- ]up|comedian|comedy|sketch|bit|joke|spoof|ticket|guinness|social media|streaming|chart|song|track|single|album|EP|music video|official audio|artist|producer|book|film|series)\b/i;
const attentionSignalPattern = /\b(?:viral|meme|trending|popular|return|comeback|re-?release|reintroduc|reviv|release|debut|drop|chart|stream(?:ed|ing)?|record|sold out|restock|lineup|headliner|festival|concert|tour|premiere|trailer|award|nomination|win|won|match|tournament|championship|playoffs?|final|ruling|lawsuit|recall|strike|storm|fire|earthquake|mission|roster|suspension|red card|announcement|controversy|spoof|special|ticket|guinness|social media)\b/i;
const firstPersonReviewPattern = /\b(?:i|we)\s+(?:tried|tested|tasted|sampled|ordered|visited|reviewed|ranked|compared)\b|\b(?:taste test|restaurant review|product review|does it live up|is it actually any good|my verdict|our verdict)\b/i;
const popularityMetricPattern = /\b(?:sold[- ]out|sold out|sell(?:s|ing)? out|waitlist|pre[- ]orders?|restock(?:ed|ing)?|record(?:ed)?\s+(?:sales|views?|streams?)|box office|ticket sales|chart(?:ed|ing)?\s+(?:at|on|for|in|position|ranking|top)|airplay|no\.?\s*1|number one|top\s+\d+|rank(?:ed|ing)?\s+(?:at|in|on|as|among)|broke (?:the|a) record|set a record|search interest|google trends|trending on|demand (?:surged|spiked|outstripped|exceeded)|\d[\d,.]*(?:\.\d+)?\s*(?:million|billion|thousand|k|m)?\s*(?:views?|streams?|sales?|tickets?|copies|orders?|units?|posts?|likes?|downloads?|searches?))\b/i;
const concreteTrendMechanismPattern = /\b(?:return(?:ed|ing)?|re-?release(?:d|s|ing)?|reintroduc(?:ed|es|ing)?|brought back|restock(?:ed|ing)?|sold[- ]out|sell(?:s|ing)? out|waitlist|limited[- ]time|comeback|reunion|meme(?:d|s)?|fan(?:s)?\s+(?:reacted|reaction|response)|viral\s+(?:clip|video|sound|song|post)|breakout|debut(?:ed|s)?|preview|deluxe edition|mixtape|record(?:ed)?|chart(?:ed|ing)?|stream(?:ed|ing)?|airplay|search interest|trending on)\b/i;
const editorialNicheHeadlinePattern = /(?:^\s*(?:the\s+)?(?:best|top|upcoming|every|all|column|opinion|analysis|commentary)\b|^\s*['"“]?(?:i|we)\s+(?:was|were|am|are|have|had)\b|\b(?:\d+\s+of the best|best new|next great read|books? to read|what to read|gift guide|shopping guide|chart brief|weekly column|column\s*:|opinion|analysis|commentary|paper talk|every\s+(?:movie|film|series|show|game|song|product)|everything\s+(?:we\s+)?know|what to know|how to|here['’]s how|release dates?|predict(?:ing|ions?)?|odds|facts and figures|you should (?:try|know)|according to .* team)\b)/i;
const nonNewsHeadlinePattern = /(?:^\s*predict(?:ing|ion)?\b|\b(?:head-scratcher|on the rise|puts? .* first|building out .* empire|when it comes to|explores? .* in .* club|a look at|news\s*&\s*notes)\b|\b(?:live|follow live|replay)\b[^.!?]{0,80}\b(?:leaderboard|scores?|results?)\b|\b(?:live leaderboard|live scores?)\b|\b(?:scheduled|will take on|set to take on|exhibition game|preseason|conference slates?|fixtures?|schedule\s*:)\b)/i;
const evergreenReviewContextPattern = /\b(?:reviewers?|drop test|subjected .* to|editor(?:s|') picks|best products|tested|testers?|tips? for|how to get the look|what to know|buyers? guide|product guide)\b/i;
const promotionalContentPattern = /\b(?:business wire|globe newswire|prnewswire|webwire|press release|news release|media release|for immediate release|what:\s|when:\s|where:\s|contact:\s|forms? a new .* platform|today announced|announced the next phase)\b/i;
const articleArtifactPattern = /(?:\b(?:we use cookies|cookie policy|privacy policy|subscribe to|sign up to|personal(?:i|i[sz])e content|site to show|tracking technologies|health and wellness column|weekly column)\b|\b(?:tech|news|sports|film|entertainment)\s+news(?:\s+news)?\s*:\s*|\b(?:welcome to (?:the )?chart brief|chart brief)\b|\b(?:mainl|primar|announc|availab|launche|produc|upcomin)\.$|\[\s*(?:…|\.\.\.)\s*\])/i;
const publisherBoilerplatePattern = /\b(?:award[- ]winning daily .* publication|daily print newspaper|24\/7 website|voice of the .* community|free e-alerts|breaking news notifications|our coverage|in your search results)\b/i;
const articleCaptionPattern = /\b(?:file\s*[-–—]|pictured|photo(?:graph)?\s+by|photo\s+credit|image\s+credit|ap\s+photo|reuters\s*\/|illustration\s+(?:taken|by)|front\s+(?:center|centre|row)|looks?\s+on\s+as|stands?\s+ahead\s+of|courtesy\s+of)\b/i;
const hardPromotionalContentPattern = /\b(?:business wire|globe newswire|prnewswire|webwire|press release|news release|media release|for immediate release|what:\s|when:\s|where:\s|contact:\s)\b/i;
const eventListingPattern = /\b(?:event calendar|food truck festival|picnic in the park|family fun|community event|local event|things to do)\b/i;
const genericNicheHeadlinePattern = /(?:^\s*(?:\d+\s+(?:overplayed|ways?|reasons?|things?|songs?|tips?|ideas?|products?|shows?|movies?|books?|recipes?|snacks?|snackable|cocktails?|drinks?|restaurants?|places?|artists?|albums?)\b|top|best|what|why|how|everything|a guide|here are|here['’]s (?:a )?(?:list|what|how)|latest)\b|\b(?:\d+\s+of the best|best new|next great read|books? to read|what to read|gift guide|shopping guide|simple .* changes|popular .* trends|do these \d+|explained|guide|review|roundup|newsletter|industry headlines?|\bupdates?\b|deserves the hype|sets? (?:his|her|their|its) sights|challenges? (?:the )?(?:norms|boundaries)|sparks? (?:a )?debate|what to know|the internet['’]s .* king|making a comeback|latest updates|news and notes|in history|biggest .* ever)\b)/i;
const hardMetaNicheHeadlinePattern = /\b(?:deserves the hype|sets? (?:his|her|their|its) sights|challenges? (?:the )?(?:norms|boundaries)|sparks? (?:a )?debate|the internet['’]s .* king)\b/i;
const numberedNicheHeadlinePattern = /^\s*(?:the\s+)?(?!(?:19|20)\d{2}\b)\d+(?:st|nd|rd|th)?\s+(?!annual\b)/i;
const genericNicheCopyPattern = /\b(?:main[- ]character|having (?:a|its) \w+ week|(?:is|are|was|were) (?:the|a|an) (?:story|headline|moment|vibe)|doing numbers|refuses to stay niche|gets? a second wind|back in rotation|next generation|moving target|worth watching|part of what makes|has amassed serious star power|dominates? social media|the conversation|cultural norms|the scene|the moment|a new era|a fresh take|a changing landscape|current development|generic development|linked report|connect(?:ed|ing)? with fans|continued to connect|lose their minds|hit harder than almost anyone|biggest (?:swing|move|bet)|next chapter|future of|new look to rival)\b/i;
const articleBoilerplatePattern = /^(?:reporting by|editing by|edited by|our standards|this article has been reviewed|the following is a transcript|copyright|all rights reserved|welcome to (?:the )?(?:chart brief|our weekly|this week['’]s))\b/i;
const articleContextBoilerplatePattern = /\b(?:welcome to (?:the )?chart brief|weekly column|chart brief|our standards|subscribe to|sign up for|we use cookies|cookie policy|privacy policy)\b/i;
const articleFragmentPattern = /^(?:[A-Z][^.!?]{0,120},\s+(?:out|available|due|coming)\s+via\b|according to (?:the )?announcement\b|we broke down .*\b(?:look|inside)\b)/i;
const incompleteSentencePattern = /\b(?:St|Mr|Mrs|Ms|Dr|Prof|No|vs|etc|feat|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.$/i;
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const musicReleasePattern = /\b(?:new (?:music|song|track|single|album|EP)|teases? new music|shares? new single|forthcoming (?:album|single|track)|unreleased (?:song|track|album)|(?:debut(?:s|ed)?|new)\s+(?:song|track|single|album|EP|music)|second preview|deluxe edition|release(?:s|d|ing)?|drop(?:s|ped)?|launch(?:es|ed|ing)?|premiere(?:s|d)?|chart(?:s|ed|ing)?|stream(?:s|ed|ing)?|playlist|remix(?:es|ed)?|music video|official audio|viral (?:song|sound|audio)|trending (?:song|track|sound)|(?:song|track|single|album|EP|sound)[^.!?]{0,80}(?:viral|trending|breakout|chart|stream)|(?:viral|trending|breakout|chart|stream)[^.!?]{0,80}(?:song|track|single|album|EP|sound)|(?:announc\w*|reveal\w*|readies?|unveil\w*|share\w*|team(?:s|ed)? up|link(?:s|ed|ing)?)[^.!?]{0,100}(?:song|track|single|album|EP|music|music video|video|playlist|collab))\b/i;
const musicArtifactPattern = /\b(?:song|track|single|album|EP|mixtape|release(?:s|d|ing)?|preview|deluxe edition|music video|music career|music bank|official audio|remix(?:es|ed)?|playlist|stream(?:s|ed|ing)?|chart(?:s|ed|ing)?|airplay|sound|audio)\b/i;
const musicArticleContextPattern = /\b(?:music|song|track|single|album|EP|music video|audio|remix|stream(?:s|ed|ing)?|chart(?:s|ed|ing)?|airplay|radio|hot 100|no\.\s*1|top \d+|singer|artist|idol|group|comeback|debut|release(?:s|d|ing)?)\b/i;
const musicEventOnlyPattern = /\b(?:festival|lineup|headliner|concert|tour|tickets?|venue|show|event)\b/i;
const musicReviewPattern = /\b(?:review|reviews|verdict|album review)\b/i;
const musicGenericSubjectWords = new Set(["album", "artist", "dance", "debut", "deluxe", "edition", "electronic", "house", "latin", "music", "new", "producer", "release", "remix", "single", "song", "track", "video"]);

function musicSubjectOverlap(headline, sentence) {
  return headlineContextOverlap(headline, sentence).filter((word) => !musicGenericSubjectWords.has(word));
}

function musicSearchQueries(category) {
  const label = category.id === "edm" ? "EDM electronic dance music" : category.label;
  return [
    `${label} new song track release artist`,
    `${label} trending song viral sound streaming chart`,
    `${label} new album single music video listeners`,
  ];
}

function musicFeedsForCategory(category) {
  return musicPublisherFeeds.filter((feed) => feed.categories.includes("all") || feed.categories.includes(category.id));
}

function isTrustedMusicCategoryFeed(category, candidate) {
  if (category.parent !== "Music") return false;
  const feed = musicPublisherFeeds.find((entry) => entry.source === candidate.source && entry.categories.includes(category.id));
  return Boolean(feed && !feed.categorySignalRequired);
}

function musicFeedText(feed) {
  if (!musicFeedCache.has(feed.url)) {
    const request = fetchText(new URL(feed.url)).catch((error) => {
      musicFeedCache.delete(feed.url);
      throw error;
    });
    musicFeedCache.set(feed.url, request);
  }
  return musicFeedCache.get(feed.url);
}

const categoryDefinitions = [
  { id: "edm", label: "EDM", parent: "Music", query: "EDM electronic dance music", queryVariants: ["EDM DJ producer release festival lineup", "electronic dance music artist tour festival news"], accent: "#8b5cf6" },
  { id: "kpop", label: "K-pop", parent: "Music", query: "K-pop comeback release fandom", accent: "#ff6b9d" },
  { id: "football", label: "Football", parent: "Sports", query: "soccer FIFA UEFA World Cup players -NFL -NCAA -college", queryVariants: ["soccer latest match transfer tournament news -NFL -NCAA", "FIFA UEFA World Cup soccer players latest -NFL"], accent: "#20b486" },
  { id: "combat-sports", label: "Combat sports", parent: "UFC MMA boxing fight card", accent: "#f05e4f" },
  { id: "beauty", label: "Beauty", parent: "beauty makeup skincare trend product", accent: "#e981a9" },
  { id: "food-drink", label: "Food & drink", parent: "Lifestyle", query: "food drink launch return restock sold out demand trend news", accent: "#f59e42" },
  { id: "gaming", label: "Gaming", parent: "Culture", query: "video game gaming release trailer", accent: "#3fa7ff" },
  { id: "anime-manga", label: "Anime & manga", parent: "Culture", query: "anime manga series fandom", accent: "#ff5d65" },
  { id: "film-tv", label: "Film & TV", parent: "Culture", query: "movie television trailer casting premiere", accent: "#e8b64e" },
  { id: "books-reading", label: "Books & reading", parent: "Culture", query: "books novels reading book club", accent: "#a77b55" },
  { id: "streetwear", label: "Streetwear", parent: "Lifestyle", query: "streetwear sneakers fashion bag restock", accent: "#f37d43" },
  { id: "internet-culture", label: "Internet culture", parent: "Culture", query: "meme internet slang creator trend", accent: "#e95bd6" },
  { id: "tech", label: "Tech", parent: "Culture", query: "technology gadgets AI smartphone product", accent: "#5a9cff" },
  { id: "creators", label: "Creators", parent: "Culture", query: "creator YouTube influencer interview format", accent: "#ff765f" },
  ...additionalNicheCategories,
].map((category) => ({
  ...category,
  query: category.query ?? category.label,
  queryVariants: category.queryVariants ?? ({
    "food-drink": ["food drink return", "food drink fan reaction limited release"],
    golf: ["PGA Tour golf tournament results player news", "golf players tournament latest news LIV"],
    comedy: ["comedian comedy special tour clip interview latest", "stand-up sketch comedian viral bit show news"],
  }[category.id] ?? []),
  description: category.description ?? `${category.label} conversations, releases, and signals that are accelerating beyond the general leaderboard.`,
})).map((category) => {
  if (category.parent !== "Music") return category;
  const [query, ...queryVariants] = musicSearchQueries(category);
  return { ...category, query, queryVariants };
});

const categoryRules = {
  music: {
    include: /\b(?:music|song|track|single|album|EP|artist|producer|DJ|remix|release|stream|chart|playlist|listener|fan|sound|audio|dance|video)\b/i,
    story: musicReleasePattern,
  },
  kpop: {
    include: /\b(?:K-pop|Kpop|Korean pop|Korean music|Korean singer|Korean group|Korean idol|South Korean)\b/i,
    story: musicReleasePattern,
  },
  pop: {
    include: /\b(?:pop music|pop song|pop star|pop singer|pop album|pop artist)\b/i,
    exclude: /\b(?:K-pop|Kpop)\b/i,
    story: musicReleasePattern,
  },
  "hip-hop-rap": {
    include: /\b(?:hip[- ]hop|rap|rapper|rappers|MC|drill|trap|bars)\b/i,
    story: musicReleasePattern,
  },
  "r-and-b-soul": {
    include: /\b(?:R&B|R and B|rhythm and blues|soul|neo[- ]soul)\b/i,
    story: musicReleasePattern,
  },
  "indie-alternative": {
    include: /\b(?:indie|alternative|alt[- ]rock|indie rock|punk|post[- ]punk|shoegaze|guitar band)\b/i,
    exclude: /\b(?:hip[- ]hop|rap(?:per)?|drill|trap|bars|MC)\b/i,
    story: musicReleasePattern,
  },
  "latin-music": {
    include: /\b(?:Latin music|Latin pop|reggaet[oó]n|Afro[- ]Latin|bachata|cumbia|corridos?|regional Mexican|m[uú]sica Mexicana)\b/i,
    story: musicReleasePattern,
  },
  country: {
    include: /\b(?:country music|country singer|country artist|Nashville|Americana|bluegrass|honky[- ]tonk)\b/i,
    story: musicReleasePattern,
  },
  afrobeats: {
    include: /\b(?:Afrobeats?|Afropop|Afrobeat|Nigerian music|Ghanaian music|African pop)\b/i,
    story: musicReleasePattern,
  },
  edm: {
    include: /\b(?:EDM|electronic dance|DJ|producer|festival|rave|club|house|techno|trance|dubstep|drum.?and.?bass|remix)\b/i,
    exclude: /\b(?:study|survey|well[- ]being|midlife|research paper|academic)\b/i,
    story: /\b(?:release|released|album|single|track|festival|concert|tour|lineup|headliner|chart|stream|debut|comeback|return|remix|viral|meme|performance|DJ|producer|label|ticket|sold out)\b/i,
  },
  football: {
    include: /\b(?:soccer|association football|FIFA|UEFA|Premier League|La Liga|Serie A|Bundesliga|World Cup|Champions League|Europa League|NWSL|MLS|red card|goalkeeper)\b/i,
    exclude: /\b(?:NFL|NCAA|college football|quarterback|touchdown|transfer portal|roster cuts|American football|Super Bowl)\b/i,
    story: /\b(?:match|goal|win|won|loss|tournament|championship|playoffs?|final|qualif|transfer|sign(?:ed|ing)?|injur|roster|suspend|red card|World Cup|FIFA|UEFA|league|coach|manager)\b/i,
  },
  golf: {
    include: /\b(?:golf|PGA|LPGA|LIV|Masters|Ryder Cup|FedExCup|course|caddie|putt)\b/i,
    story: /\b(?:tournament|championship|round|win|won|qualif|cut|match|return|sign(?:ed|ing)?|injur|suspend|ranking|title|course|PGA|LIV|player|BMW Championship)\b/i,
  },
  baseball: {
    include: /\b(?:baseball|MLB|pitcher|pitching|home run|ballpark|inning|outfielder|shortstop|catcher|minor league)\b/i,
    story: /\b(?:trade|traded|pitch|pitcher|home run|game|win|won|loss|injur|roster|prospect|draft|deadline|inning|playoffs?|championship|documentary)\b/i,
  },
  motorsport: {
    include: /\b(?:Formula 1|F1|racing|motorsport|Grand Prix|driver|paddock|qualifying|race)\b/i,
    story: /\b(?:race|qualifying|Grand Prix|sign(?:ed|ing)?|contract|transfer|driver|team|pole|win|won|crash|penalt|championship|season)\b/i,
  },
  gaming: {
    include: /\b(?:video game|gaming|gameplay|PlayStation|Xbox|Nintendo|Steam|PC game|developer|publisher|trailer)\b/i,
    story: /\b(?:release|launch|trailer|gameplay|update|demo|beta|studio|developer|publisher|sale|review|premiere)\b/i,
  },
  "anime-manga": {
    include: /\b(?:anime|manga|Crunchyroll|Japanese animation|VTuber|cosplay|shonen|manhwa|webtoon)\b/i,
    story: /\b(?:release|launch|premiere|trailer|announcement|announce|series|film|movie|episode|chapter|tour|festival|event|opens?|convention|fans?|stream|adaptation|cast|renewed|cancelled)\b/i,
  },
  "books-reading": {
    include: /\b(?:book|books|novel|novels|author|writer|publishing|publisher|reading|literary|memoir|fiction|nonfiction|science fiction)\b/i,
    exclude: /\b(?:library|book sale|book club|librarian|county|town hall)\b/i,
    story: /\b(?:book|novel|author|writer|publisher|publishing|debut|release|adaptation|award|bestseller|memoir|series|acquire|acquisition|shortlist|longlist)\b/i,
  },
  beauty: {
    include: /\b(?:beauty|makeup|cosmetic|skincare|skin care|haircare|hair care|nail|lip balm|foundation|mascara)\b/i,
    story: /\b(?:launch|release|return|restock|sold out|demand|shade|collection|product|formula|collaboration|trend|award)\b/i,
  },
  streetwear: {
    include: /\b(?:streetwear|sneaker|fashion|apparel|shoe|shoes|bag|designer|collaboration|drop)\b/i,
    story: /\b(?:launch|release|drop|restock|sold out|collaboration|collection|design|return|auction|debut)\b/i,
  },
  "food-drink": {
    include: /\b(?:food|drink|beverage|coffee|restaurant|menu|snack|dessert|frappuccino|dining|cafe)\b/i,
    story: /\b(?:launch|release|return|restock|sold out|demand|menu|limited|reintroduc|brought back|viral|meme|restaurant|drink|food)\b/i,
  },
  tech: {
    include: /\b(?:technology|tech|AI|artificial intelligence|smartphones?|phones?|gadgets?|software|hardware|chips?|processors?|apps?|devices?|internet|cybersecurity|robots?|repairable)\b/i,
    exclude: /\b(?:Texas Tech|college|university|campus|students?|football|basketball|athletics|red raiders|season)\b/i,
    story: /\b(?:launch|release|sell(?:s|ing)?|announce|unveil|chips?|processors?|phones?|smartphones?|devices?|software|AI|artificial intelligence|repairable|apps?|security|breach|update|regulation|acquisition)\b/i,
  },
  "technology-news": {
    include: /\b(?:technology|tech|AI|artificial intelligence|smartphones?|phones?|gadgets?|software|hardware|chips?|processors?|apps?|devices?|internet|cybersecurity|robots?|repairable)\b/i,
    exclude: /\b(?:Texas Tech|college|university|campus|students?|football|basketball|athletics|red raiders|season)\b/i,
    story: /\b(?:launch|release|sell(?:s|ing)?|announce|unveil|chips?|processors?|phones?|smartphones?|devices?|software|AI|artificial intelligence|repairable|apps?|security|breach|update|regulation|acquisition)\b/i,
  },
  "home-design": {
    include: /\b(?:design|decorat|interior|architecture|furniture|renovation|remodel|house|real estate|landscape)\b/i,
    exclude: /\b(?:Toyota|car|cars|automotive|vehicle|truck|SUV|engine|horsepower)\b/i,
    story: /\b(?:design|decorat|interior|architecture|furniture|renovation|remodel|house|real estate|landscape|home)\b/i,
  },
  health: {
    include: /\b(?:health|medicine|medical|doctor|patient|hospital|disease|drug|treatment|clinical|wellness|fitness|mental health|public health)\b/i,
    story: /\b(?:study|research|trial|treatment|drug|disease|hospital|doctor|patient|health|medical|guidance|approval|risk|outbreak|wellness|fitness)\b/i,
  },
  comedy: {
    include: /\b(?:comedian|comedy|stand[- ]up|sketch|comic|bit|special|joke|funny|crowd work|Netflix|SNL|Guinness|tour)\b/i,
    story: /\b(?:special|tour|show|series|performance|clip|bit|sketch|interview|appearance|festival|award|release|premiere|controversy|meme|viral|podcast|joke|spoof|social media|ticket|record)\b/i,
  },
  "world-news": {
    include: /\b(?:world|international|global|foreign|diplomacy|diplomatic|country|countries|government|conflict|war|ceasefire|election|summit)\b/i,
    story: /\b(?:agreement|attack|conflict|election|government|invasion|launch|mission|negotiat|ruling|sanction|summit|treaty|war|vote)\b/i,
  },
  "business-markets": {
    include: /\b(?:business|market|markets|economy|economic|company|companies|stock|stocks|investor|investors|finance|financial|trade|demand|debt|earnings)\b/i,
    story: /\b(?:acquisition|bankrupt|deal|debt|demand|earnings|federal reserve|inflation|invest|investor|market|merger|profit|revenue|sales|stock|trade|yield)\b/i,
  },
  "science-space": {
    include: /\b(?:science|scientist|research|space|NASA|lunar|moon|mars|planet|astronom|rocket|telescope|mission|physics|biology|climate)\b/i,
    story: /\b(?:discover|image|launch|mission|observ|research|sample|study|telescope|test|trial|moon|lunar|mars|planet|rocket|record)\b/i,
  },
  "climate-environment": {
    include: /\b(?:climate|environment|environmental|weather|heat|warming|ocean|sea|marine|ecosystem|emissions|carbon|farming|energy|conservation)\b/i,
    story: /\b(?:bake|climate|drought|emission|flood|heat|marine|ocean|record|research|storm|temperature|weather|wildfire|warming)\b/i,
  },
  "tech-news": {
    include: /\b(?:technology|tech|AI|artificial intelligence|smartphones?|phones?|gadgets?|software|hardware|chips?|processors?|apps?|devices?|internet|cybersecurity|robots?|regulation|platforms?)\b/i,
    exclude: /\b(?:Texas Tech|college|university|campus|students?|football|basketball|athletics|red raiders|season)\b/i,
    story: /\b(?:acquisition|AI|artificial intelligence|announce|breach|chips?|company|launch|law|regulation|release|security|software|technology|tech|update)\b/i,
  },
  "entertainment-news": {
    include: /\b(?:entertainment|film|movie|television|TV|series|actor|actress|celebrity|studio|Disney|casting|release)\b/i,
    story: /\b(?:announce|cast|casting|celebrity|film|launch|movie|premiere|release|retire|retirement|series|show|studio|television|trailer)\b/i,
  },
  travel: {
    include: /\b(?:travel|traveler|travellers?|destination|hotel|flight|airline|tourism|vacation|itinerary|trip|airport)\b/i,
    exclude: /\b(?:CDC|Ebola|quarantine|affected areas?|health monitoring|outbreak)\b/i,
    story: /\b(?:airline|airport|destination|flight|hotel|itinerary|launch|opening|route|study|tourism|traveler|travelers?|trip|visa)\b/i,
  },
  "wellness-fitness": {
    include: /\b(?:fitness|wellness|exercise|workout|training|running|runner|recovery|sleep|mobility|hydration|athlete)\b/i,
    story: /\b(?:athlete|exercise|fitness|injury|recovery|research|runner|running|sleep|study|training|workout)\b/i,
  },
  parenting: {
    include: /\b(?:parenting|parent|parents|family|families|child|children|kid|kids|school|back-to-school)\b/i,
    story: /\b(?:child|children|family|parent|parents|school|study|research|survey|teacher|teen)\b/i,
  },
  podcasts: {
    include: /\b(?:podcast|podcasts|episode|episodes|host|hosts|audio|video podcast|show)\b/i,
    story: /\b(?:chart|episode|launch|network|release|show|video|viral|host|podcast)\b/i,
  },
};

const genericCategoryTerms = new Set(["and", "news", "music", "sports", "culture", "lifestyle"]);
const categoryTermAliases = new Map([
  ["food-drink", ["beverage", "coffee", "cafe", "restaurant", "menu", "snack", "dessert", "frappuccino", "dining"]],
  ["beauty", ["makeup", "cosmetic", "skincare", "skin", "hair", "nail"]],
  ["gaming", ["gameplay", "playstation", "xbox", "nintendo", "steam"]],
  ["streetwear", ["sneaker", "fashion", "apparel", "streetwear"]],
  ["travel", ["traveler", "travelers", "destination", "hotel", "flight", "airline", "tourism", "vacation", "itinerary", "trip", "airport"]],
]);

function categoryLabelUsable(category, candidate, text) {
  if (category.parent === "Music" && isTrustedMusicCategoryFeed(category, candidate)) return true;
  const terms = [...new Set(`${category.label} ${category.id} ${(categoryTermAliases.get(category.id) ?? []).join(" ")}`
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !genericCategoryTerms.has(term)))];
  if (!terms.length) return true;
  const normalized = text.toLocaleLowerCase("en-US");
  return terms.some((term) => new RegExp(`\\b${term}\\b`, "i").test(normalized));
}

const fallbackCategories = new Map([
  ...additionalNicheCategories,
  ...fallbackBrief.categories,
].map((category) => [category.id, category]));

function cleanText(value, maxLength = 600) {
  return decodeHtmlEntities(String(value ?? ""))
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/```(?:html|xml|text)?/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function cleanArticleIntro(value) {
  return cleanText(value, 1_400)
    .replace(/^\s*\d{1,3}[,.;:]\s*/u, "")
    .replace(/^\s*[-–—]\s*/u, "")
    .trim();
}

function hasUnbalancedQuotes(value) {
  const text = String(value ?? "");
  const straight = (text.match(/"/g) ?? []).length;
  const curlyOpen = (text.match(/“/g) ?? []).length;
  const curlyClose = (text.match(/”/g) ?? []).length;
  return straight % 2 === 1 || curlyOpen !== curlyClose;
}

function articleIntroLooksComplete(value, minimumLength = 80) {
  const text = cleanArticleIntro(value);
  return text.length >= minimumLength
    && /[.!?]["'’”)]?$/u.test(text)
    && !hasUnbalancedQuotes(text)
    && !articleArtifactPattern.test(text)
    && !publisherBoilerplatePattern.test(text)
    && !articleCaptionPattern.test(text);
}

async function fetchText(rawUrl) {
  const { buffer } = await fetchBytes(rawUrl, {
    isAllowedHost: (hostname) => nicheSourceHosts.has(hostname),
    kind: "niche source",
    maxBytes,
    timeoutMs,
    attempts: 2,
    headers: {
      accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
    },
  });
  return buffer.toString("utf8");
}

async function fetchBingNewsSearch(query) {
  const url = new URL("https://www.bing.com/news/search");
  url.search = new URLSearchParams({ q: query, setlang: "en-US" });
  const { buffer } = await fetchBytes(url, {
    isAllowedHost: (hostname) => hostname === "www.bing.com",
    kind: "niche publisher search",
    maxBytes,
    timeoutMs,
    attempts: 2,
    headers: {
      accept: "text/html,application/xhtml+xml;q=0.9, */*;q=0.5",
      "user-agent": "whatspopular.com/1.0 (+https://whatspopular.com/about)",
    },
  });
  return buffer.toString("utf8");
}

function tagValue(block, tag) {
  return block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "";
}

function parseRss(xml, query, fallbackSource = "Google News") {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((match, index) => {
      const block = match[1];
      const rawTitle = cleanText(tagValue(block, "title"), 240);
      const sourceBlock = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
      const source = cleanText(sourceBlock?.[2], 100) || fallbackSource;
      const sourceUrl = sourceBlock?.[1]?.match(/\burl=["']([^"']+)/i)?.[1] ?? "";
      const publishedAt = cleanText(tagValue(block, "pubDate"), 80);
      const link = cleanText(tagValue(block, "link"), 1600);
      const title = rawTitle.replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`, "i"), "").trim();
      return {
        headline: title || rawTitle,
        source,
        sourceUrl: /^https:\/\//i.test(sourceUrl) ? sourceUrl : `https://news.google.com/search?q=${encodeURIComponent(query)}`,
        link: /^https:\/\//i.test(link) ? link : `https://news.google.com/search?q=${encodeURIComponent(query)}`,
        publishedAt,
        order: index,
      };
    })
    .filter((item) => item.headline.length >= 20);
}

function articleSearchResults(html, headline, sourceUrl) {
  let sourceHost = "";
  try { sourceHost = new URL(sourceUrl).hostname.replace(/^www\./i, "").toLowerCase(); } catch {}
  const results = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["'](https:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const rawUrl = match[1].replaceAll("&amp;", "&");
    const title = cleanText(match[2], 240);
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./i, "").toLowerCase();
      if (host === "bing.com" || host.endsWith(".bing.com") || host === "google.com" || host.endsWith(".google.com") || !title) continue;
      const overlap = meaningfulWordOverlap(headline, title).length;
      const domainMatch = sourceHost && (host === sourceHost || host.endsWith(`.${sourceHost}`));
      if (overlap < 2 && !domainMatch) continue;
      results.push({ url: url.href, title, overlap, domainMatch });
    } catch {
      // Search result markup contains tracking links and malformed fragments.
    }
  }
  return [...new Map(results.map((result) => [result.url, result])).values()]
    .sort((left, right) => Number(right.domainMatch) - Number(left.domainMatch) || right.overlap - left.overlap)
    .slice(0, maxPublisherCandidates);
}

async function resolvePublisherArticles(candidate) {
  const urls = [];
  const resolved = await resolveGoogleNewsArticle(candidate.link).catch(() => null);
  if (resolved) {
    try {
      const hostname = new URL(resolved).hostname.toLowerCase();
      if (hostname !== "google.com" && !hostname.endsWith(".google.com")) urls.push(resolved);
    } catch {
      // Fall through to the bounded publisher search below.
    }
  }
  const queries = [
    `site:${new URL(candidate.sourceUrl).hostname.replace(/^www\./i, "")} "${candidate.headline.replaceAll('"', "")}"`,
    `"${candidate.headline.replaceAll('"', "")}"`,
  ];
  for (const query of queries) {
    try {
      const results = articleSearchResults(await fetchBingNewsSearch(query), candidate.headline, candidate.sourceUrl);
      urls.push(...results.map((result) => result.url));
      if (urls.length >= 4) break;
    } catch {
      // A search outage should not replace the last valid snapshot.
    }
  }
  return [...new Set(urls)].slice(0, 4);
}

function hasConcreteArticleContext(headline, intro) {
  if (!intro || articleBoilerplatePattern.test(intro) || publisherBoilerplatePattern.test(intro) || articleCaptionPattern.test(intro)) return false;
  const focused = focusedArticleContext(headline, intro, 620);
  if (!focused || !concreteContextPattern.test(focused)) return false;
  return headlineContextStrong(headline, focused);
}

function meaningfulWordOverlap(left, right) {
  const stopWords = new Set(["about", "after", "again", "also", "around", "because", "being", "could", "first", "from", "have", "into", "more", "most", "over", "that", "their", "there", "these", "they", "this", "through", "under", "what", "when", "where", "which", "while", "with", "would"]);
  const words = (value) => cleanText(value, 1_400)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 5 && !stopWords.has(word));
  const rightWords = new Set(words(right));
  return [...new Set(words(left))].filter((word) => rightWords.has(word));
}

const genericHeadlineContextWords = new Set([
  "about", "album", "albums", "back", "culture", "debut", "drink", "drinks", "event", "fan", "fans", "film", "food",
  "game", "games", "latest", "match", "music", "news", "new", "official", "people", "player", "players", "product",
  "record", "release", "released", "report", "reports", "return", "returning", "season", "series", "show", "shows",
  "single", "song", "songs", "sports", "story", "stories", "team", "tech", "technology", "today", "track", "tracks",
  "tour", "update", "updates", "week", "weekly", "world",
]);

function headlineContextOverlap(left, right) {
  return meaningfulWordOverlap(left, right).filter((word) => !genericHeadlineContextWords.has(word));
}

function headlineContextStrong(headline, context) {
  const overlap = headlineContextOverlap(headline, context);
  return overlap.length >= 2
    || (overlap.length >= 1 && /\d/.test(context) && popularityMetricPattern.test(context));
}

const coverageGenericWords = new Set(["about", "after", "again", "album", "albums", "back", "being", "drink", "drinks", "food", "latest", "lineup", "menu", "music", "news", "new", "release", "releases", "return", "returning", "says", "songs", "sports", "the", "this", "today", "updates", "week", "weekly"]);

function coverageStoryMatch(left, right) {
  const overlap = [...new Set([...storyWords(left)].filter((word) => storyWords(right).has(word)))];
  const distinctiveOverlap = overlap.filter((word) => word.length >= 4 && !coverageGenericWords.has(word));
  return overlap.length >= 3 || (distinctiveOverlap.length >= 2)
    || (distinctiveOverlap.length >= 1 && overlap.length >= 2);
}

function removeArticleBoilerplate(value) {
  return [...sentenceSegmenter.segment(cleanText(value, 1_400))]
    .map(({ segment }) => segment.trim())
    .filter((sentence) => sentence
      && !articleBoilerplatePattern.test(sentence)
      && !articleContextBoilerplatePattern.test(sentence)
      && !publisherBoilerplatePattern.test(sentence)
      && !articleCaptionPattern.test(sentence))
    .join(" ");
}

function focusedArticleContext(headline, intro, maxLength = 420) {
  const seenSentenceKeys = new Set();
  const candidates = [...sentenceSegmenter.segment(cleanText(intro, 1_400))]
    .map(({ segment: text }, index) => ({
      text: text.trim(),
      index,
      headlineOverlap: meaningfulWordOverlap(headline, text),
      score: (text.match(concreteContextPattern) ? 1 : 0)
        + meaningfulWordOverlap(headline, text).length * 3
        - (articleBoilerplatePattern.test(text) ? 8 : 0)
        - (/\b(?:courtesy|editorial process|our standards|subscribe|newsletter|read more)\b/i.test(text) ? 5 : 0)
        - (/^[\s"“”'’]*(?:said|says|according to)\b/i.test(text) || /["“][^"”]+["”]/.test(text) ? 6 : 0),
    }))
    .filter((entry) => entry.text.length >= 45 && !/^(?:although|because|but|which|while|with|as)\b/i.test(entry.text.replace(/^[\s"“”'’]+/, "")))
    .filter((entry) => !incompleteSentencePattern.test(entry.text))
    .filter((entry) => !articleBoilerplatePattern.test(entry.text)
      && !articleContextBoilerplatePattern.test(entry.text)
      && !publisherBoilerplatePattern.test(entry.text)
      && !articleCaptionPattern.test(entry.text))
    .filter((entry) => !articleFragmentPattern.test(entry.text))
    .filter((entry) => !/\b(?:courtesy|editorial process|our standards|subscribe|newsletter|read more)\b/i.test(entry.text))
    .filter((entry) => {
      const key = entry.text.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, " ").trim();
      if (!key || seenSentenceKeys.has(key)) return false;
      seenSentenceKeys.add(key);
      return true;
    });
  const safeCandidates = candidates.filter((entry) => !(/["“][^"”]+["”]/.test(entry.text)
    && /\b(?:said|says|according to|told|explained|wrote|stated)\b/i.test(entry.text)));
  const related = safeCandidates
    .filter((entry) => entry.headlineOverlap.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2);
  const relatedIndexes = new Set(related.map((entry) => entry.index));
  const context = safeCandidates
    .filter((entry) => !relatedIndexes.has(entry.index))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 1);
  const sentences = [...new Map(related.concat(context).map((entry) => [entry.index, entry])).values()]
    .sort((left, right) => left.index - right.index);
  const selectedSentences = [];
  for (const sentence of sentences) {
    const currentWords = storyWords(sentence.text);
    const repeatsEarlierContext = selectedSentences.some((previous) => {
      const previousWords = storyWords(previous.text);
      if (!currentWords.size || !previousWords.size) return false;
      const overlap = [...currentWords].filter((word) => previousWords.has(word)).length;
      return overlap >= 3 && overlap / Math.min(currentWords.size, previousWords.size) >= 0.45;
    });
    if (!repeatsEarlierContext) selectedSentences.push(sentence);
  }
  let result = "";
  for (const sentence of selectedSentences) {
    const next = `${result} ${sentence.text}`.trim();
    if (next.length > maxLength && result) break;
    result = next;
  }
  return result;
}

function popularitySignalSentence(value, headline = "") {
  return [...sentenceSegmenter.segment(cleanText(value, 2_000))]
    .map(({ segment }) => segment.trim())
    .filter((sentence) => sentence
      && !/["“][^"”]+["”]/.test(sentence)
      && !articleFragmentPattern.test(sentence)
      && !publisherBoilerplatePattern.test(sentence)
      && !articleCaptionPattern.test(sentence))
    .find((sentence) => popularityMetricPattern.test(sentence)
      && (!headline || headlineContextOverlap(headline, sentence).length >= 1))
    ?? "";
}

function concreteTrendSentence(value, headline = "") {
  return [...sentenceSegmenter.segment(cleanText(value, 2_000))]
    .map(({ segment }) => segment.trim())
    .filter((sentence) => sentence
      && !/["“][^"”]+["”]/.test(sentence)
      && !articleFragmentPattern.test(sentence)
      && !publisherBoilerplatePattern.test(sentence)
      && !articleCaptionPattern.test(sentence))
    .find((sentence) => concreteTrendMechanismPattern.test(sentence)
      && (!headline || headlineContextOverlap(headline, sentence).length >= 1)
      && !/\breturn(?:s|ed)?\s+to\s+(?:its|their|the)\s+original\s+shape\b/i.test(sentence))
    ?? "";
}

function popularityEvidenceFor(candidate, focused = "") {
  const sources = [...new Set([
    ...(candidate?.coverageSources ?? []),
    candidate?.source,
  ].map((source) => cleanText(source, 120)).filter(Boolean))]
    .filter((source) => !/^google news$/i.test(source));
  const coverageCount = Number(candidate?.coverageCount ?? 0);
  const sourceText = `${candidate?.articleIntro ?? ""} ${focused} ${candidate?.headline ?? ""}`;
  const signal = popularitySignalSentence(sourceText, candidate?.headline ?? "");
  const mechanismSignal = concreteTrendSentence(sourceText, candidate?.headline ?? "");
  const musicReleaseSignal = candidate?.directCategoryFeed && musicReleasePattern.test(sourceText)
    ? ([...sentenceSegmenter.segment(cleanText(sourceText, 2_000))]
      .map(({ segment }) => segment.trim())
      .find((sentence) => musicReleasePattern.test(sentence)
        && musicArtifactPattern.test(sentence)
        && musicSubjectOverlap(candidate.headline, sentence).length >= 1
        && !articleFragmentPattern.test(sentence)
        && !publisherBoilerplatePattern.test(sentence)
        && !articleCaptionPattern.test(sentence))
      ?? "")
    : "";
  const preferredSignal = candidate?.directCategoryFeed && musicReleaseSignal
    ? musicReleaseSignal
    : signal || mechanismSignal || musicReleaseSignal;
  if (candidate?.directCategoryFeed && !musicReleaseSignal) {
    return {
      mode: "none",
      coverageCount,
      coverageSources: sources.slice(0, 6),
      signal: "",
    };
  }
  const coverageHasSpecificSignal = Boolean(preferredSignal);
  if (coverageCount >= 2 && sources.length >= 2 && (sources.length >= 3 || coverageHasSpecificSignal)) {
    return {
      mode: "independent-coverage",
      coverageCount,
      coverageSources: sources.slice(0, 6),
      signal: preferredSignal,
    };
  }
  if (signal) {
    return {
      mode: "measurable-signal",
      coverageCount,
      coverageSources: sources.slice(0, 6),
      signal,
    };
  }
  if (candidate?.directCategoryFeed
    && musicReleasePattern.test(sourceText)
    && musicArtifactPattern.test(sourceText)) {
    return {
      mode: "concrete-trend-signal",
      coverageCount,
      coverageSources: sources.slice(0, 6),
      signal: musicReleaseSignal,
    };
  }
  if (mechanismSignal) {
    return {
      mode: "concrete-trend-signal",
      coverageCount,
      coverageSources: sources.slice(0, 6),
      signal: mechanismSignal,
    };
  }
  return {
    mode: "none",
    coverageCount,
    coverageSources: sources.slice(0, 6),
    signal: "",
  };
}

function popularityEvidenceText(candidate) {
  const evidence = candidate?.popularityEvidence ?? popularityEvidenceFor(candidate);
  if (["measurable-signal", "concrete-trend-signal"].includes(evidence.mode) && evidence.signal) return evidence.signal;
  if (evidence.mode === "independent-coverage" && evidence.coverageSources.length >= 2) {
    return `Reports from ${evidence.coverageSources.slice(0, 3).join(", ")} covered the same development during the past seven days.`;
  }
  return "";
}

const contextualBackgroundPattern = /\b(?:first introduced|introduced in 20\d{2}|originally|previously|last year|earlier this year|for the first time|again|anniversary|reunites?|return(?:s|ed)? after|revived|nostalgia|viral sensation)\b/i;

function publicationAgeDays(value, now) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return null;
  return (now.getTime() - timestamp) / 86_400_000;
}

function isRecentPublication(value, now) {
  const age = publicationAgeDays(value, now);
  return age !== null && age >= -0.25 && age <= maxCandidateAgeDays;
}

function nicheImagePath(id) {
  return `/culture/niche-${String(id).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}.webp`;
}

function storyWords(value) {
  const stopWords = new Set(["about", "after", "again", "also", "around", "because", "being", "could", "first", "from", "have", "into", "more", "most", "over", "that", "their", "there", "these", "they", "this", "through", "under", "what", "when", "where", "which", "while", "with", "would", "latest", "news", "report", "reports", "today", "week", "weekly", "returns", "returning", "album", "albums", "single", "singles", "track", "tracks", "song", "songs", "music", "release", "releases", "released", "new", "debut", "official", "video", "listen", "artist", "artists", "producer", "producers", "remix", "featuring", "feat", "ep"]);
  return new Set(cleanText(value, 2_000)
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stopWords.has(word)));
}

function sameStoryFamily(left, right) {
  const leftTitle = storyWords(left?.headline);
  const rightTitle = storyWords(right?.headline);
  if (!leftTitle.size || !rightTitle.size) return false;
  const titleOverlap = [...leftTitle].filter((word) => rightTitle.has(word)).length;
  const titleRatio = titleOverlap / Math.min(leftTitle.size, rightTitle.size);
  if (titleOverlap >= 3 && titleRatio >= 0.35) return true;
  const leftContext = storyWords(left?.articleIntro);
  const rightContext = storyWords(right?.articleIntro);
  const contextOverlap = [...leftContext].filter((word) => rightContext.has(word)).length;
  return titleOverlap >= 2 && contextOverlap >= 4;
}

function categoryRuleUsable(category, candidate, focused) {
  const rules = category.parent === "Music"
    ? [categoryRules.music, categoryRules[category.id]].filter(Boolean)
    : [categoryRules[category.id]].filter(Boolean);
  const text = `${candidate.headline} ${focused}`;
  if (!categoryLabelUsable(category, candidate, text)) return false;
  if (!rules.length) return true;
  if (category.parent === "Music" && musicEventOnlyPattern.test(candidate.headline)
    && (!musicArtifactPattern.test(candidate.headline) || !musicReleasePattern.test(candidate.headline))) return false;
  for (const [index, rule] of rules.entries()) {
    if (rule.exclude?.test(text)) return false;
    if (rule.include && !(index > 0 && isTrustedMusicCategoryFeed(category, candidate)) && !rule.include.test(text)) return false;
    if (rule.story && !rule.story.test(text)) return false;
  }
  return true;
}

function sourceCandidateCoreUsable(category, candidate, now) {
  if (!candidate || !isRecentPublication(candidate.publishedAt, now)) return false;
  if (category.parent === "Music" && !candidate.playback?.embedUrl) return false;
  const minimumIntroLength = category.parent === "Music" && candidate.directCategoryFeed ? 45 : 80;
  if (!articleIntroLooksComplete(candidate.articleIntro, minimumIntroLength)) return false;
  const focused = focusedArticleContext(candidate.headline, candidate.articleIntro, 620);
  if (!focused || genericNicheCopyPattern.test(focused)) return false;
  const sourceText = `${candidate.headline} ${candidate.articleIntro} ${focused}`;
  if (articleArtifactPattern.test(sourceText) || publisherBoilerplatePattern.test(sourceText) || articleCaptionPattern.test(sourceText)) return false;
  if (eventListingPattern.test(sourceText)) return false;
  if (hardPromotionalContentPattern.test(`${candidate.source} ${sourceText}`)) return false;
  if (firstPersonReviewPattern.test(sourceText)) return false;
  if (evergreenReviewContextPattern.test(sourceText)
    && !popularityMetricPattern.test(sourceText)
    && !concreteTrendMechanismPattern.test(sourceText)) return false;
  if (promotionalContentPattern.test(`${candidate.source} ${sourceText}`)
    && !popularityMetricPattern.test(sourceText)
    && !concreteTrendMechanismPattern.test(sourceText)) return false;
  if (category.parent === "Music" && candidate.directCategoryFeed && category.id !== "edm"
    && (!musicArtifactPattern.test(candidate.headline) || !musicArticleContextPattern.test(focused))) return false;
  if (category.id === "edm"
    && !musicArtifactPattern.test(candidate.headline)
    && !musicReleasePattern.test(candidate.headline)) return false;
  if (category.parent === "Music" && musicReviewPattern.test(focused) && !musicReleasePattern.test(candidate.headline)) return false;
  if (category.parent === "Music" && !candidate.directCategoryFeed && !musicReleasePattern.test(candidate.headline)) return false;
  if (category.parent === "Music" && candidate.directCategoryFeed && category.id !== "edm" && !musicReleasePattern.test(`${candidate.headline} ${focused}`)) return false;
  if (hardMetaNicheHeadlinePattern.test(candidate.headline)) return false;
  if (editorialNicheHeadlinePattern.test(candidate.headline)) return false;
  if (nonNewsHeadlinePattern.test(candidate.headline)) return false;
  if (/\/(?:opinion|analysis|columns?|reviews?|review|guides?|editorial|press[-_]?release|media[-_]?release|news[-_]?release)\b/i.test(candidate.link ?? "")
    || /(?:businesswire|globenewswire|prnewswire|webwire)\./i.test(candidate.link ?? "")) return false;
  if (!categoryRuleUsable(category, candidate, focused)) return false;
  if (numberedNicheHeadlinePattern.test(candidate.headline) || genericNicheHeadlinePattern.test(candidate.headline)) return false;
  const directMusicContext = category.parent === "Music"
    && candidate.directCategoryFeed
    && focused.length >= 45
    && musicReleasePattern.test(`${candidate.headline} ${focused}`)
    && concreteContextPattern.test(`${candidate.headline} ${focused}`);
  if (!hasConcreteArticleContext(candidate.headline, candidate.articleIntro) && !directMusicContext) return false;
  if (!concreteContextPattern.test(`${candidate.headline} ${focused}`)) return false;
  return headlineContextStrong(candidate.headline, focused) || directMusicContext;
}

function sourceCandidateUsable(category, candidate, now) {
  if (!sourceCandidateCoreUsable(category, candidate, now)) return false;
  const focused = focusedArticleContext(candidate.headline, candidate.articleIntro, 620);
  const popularityEvidence = validatedPopularityEvidence(popularityEvidenceFor(candidate, focused));
  if (!popularityEvidence) return false;
  if (!attentionSignalPattern.test(`${candidate.headline} ${focused}`)
    && !["independent-coverage", "measurable-signal", "concrete-trend-signal"].includes(popularityEvidence.mode)) return false;
  return true;
}

function candidateRelevanceScore(candidate, now) {
  const age = publicationAgeDays(candidate.publishedAt, now) ?? maxCandidateAgeDays;
  const freshness = Math.max(0, maxCandidateAgeDays - age + 1);
  const focused = focusedArticleContext(candidate.headline, candidate.articleIntro, 620);
  const headlineSignal = Number(concreteContextPattern.test(candidate.headline));
  const articleSignal = Number(concreteContextPattern.test(focused));
  const causalSignal = Number(/\b(?:after|amid|because|following|when|return|re-?release|meme|viral|reaction|fans?|funny|sold out|restock|won|match|tournament|announc|report|study|research)\b/i.test(focused));
  const overlap = meaningfulWordOverlap(candidate.headline, focused).length;
  const imageSignal = Number(Boolean(candidate.imageSource));
  const playbackSignal = Number(Boolean(candidate.playback?.embedUrl));
  const coverageSignal = Math.min(4, Number(candidate.coverageCount ?? 0));
  const coverageSourceSignal = Math.min(4, new Set(candidate.coverageSources ?? []).size);
  const popularitySignal = Number(candidate.popularityEvidence?.mode && candidate.popularityEvidence.mode !== "none");
  const attentionSignal = Number(attentionSignalPattern.test(`${candidate.headline} ${focused}`));
  return freshness * 12 + coverageSignal * 18 + coverageSourceSignal * 16 + popularitySignal * 24 + headlineSignal * 28 + articleSignal * 12 + causalSignal * 10 + attentionSignal * 14 + overlap * 5 + imageSignal * 6 + playbackSignal * 8;
}

const corroborationQueryStopWords = new Set([
  "about", "after", "again", "also", "and", "back", "because", "before", "being", "debut", "doing", "fall",
  "first", "from", "giving", "gives", "here", "his", "how", "including", "items", "just", "latest", "lineup",
  "meal", "more", "news", "only", "releases", "return", "returning", "set", "some", "than", "that", "the", "their",
  "this", "through", "today", "what", "when", "where", "which", "with", "week", "weekly", "will", "you",
]);

function corroborationQuery(category, candidate) {
  const categoryTerms = new Set(`${category.label} ${category.id}`
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3));
  const terms = cleanText(candidate?.headline, 320)
    .replace(/[^a-z0-9]+/gi, " ")
    .split(/\s+/)
    .map((term) => term.toLocaleLowerCase("en-US"))
    .filter((term) => term.length >= 4 || /^\d{4}$/.test(term))
    .filter((term) => !corroborationQueryStopWords.has(term) && !categoryTerms.has(term))
    .filter((term, index, values) => values.indexOf(term) === index)
    .slice(0, 6);
  return terms.length >= 2 ? terms.join(" ") : "";
}

async function corroborateCandidate(category, candidate) {
  const query = corroborationQuery(category, candidate);
  if (!query) return candidate;
  const url = new URL("https://news.google.com/rss/search");
  url.search = new URLSearchParams({
    q: `${query} when:7d`,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });
  try {
    const related = parseRss(await fetchText(url), query)
      .filter((item) => coverageStoryMatch(candidate.headline, item.headline))
      .slice(0, 8);
    const coverageSources = [...new Set([
      ...(candidate.coverageSources ?? []),
      candidate.source,
      ...related.map((item) => item.source),
    ].filter(Boolean))].filter((source) => !/^google news$/i.test(source));
    return {
      ...candidate,
      coverageCount: Math.max(Number(candidate.coverageCount ?? 0), 1 + related.length),
      coverageSources,
      coverageHeadlines: related.map((item) => ({
        headline: item.headline,
        source: item.source,
        publishedAt: item.publishedAt,
      })),
    };
  } catch {
    return candidate;
  }
}

async function categoryCandidates(category, now = new Date()) {
  try {
    const broadQuery = category.parent === "Music"
      ? `${category.label} new music news`
      : `${category.label} latest news`;
    const queries = [...new Set([
      broadQuery,
      category.query,
      ...(category.queryVariants ?? []),
      `${category.query} ${contextualQuery}`,
      `${category.label} latest news ${contextualQuery}`,
    ].filter(Boolean))].slice(0, 4);
    const queryLimit = category.parent === "Music" ? 8 : Math.ceil(20 / queries.length);
    const candidatePoolLimit = category.id === "edm" ? 30 : category.parent === "Music" ? 18 : 18;
    const feedRequests = [
      ...queries.map((query) => {
        const url = new URL("https://news.google.com/rss/search");
        url.search = new URLSearchParams({
          q: `${query} when:7d`,
          hl: "en-US",
          gl: "US",
          ceid: "US:en",
        });
        return { url, query, source: "Google News", limit: queryLimit };
      }),
      ...(category.parent === "Music" ? musicFeedsForCategory(category).map((feed) => ({
        feed,
        url: new URL(feed.url),
        query: `${category.label} music publisher feed`,
        source: feed.source,
        limit: 10,
      })) : []),
    ];
    const feedItems = await mapConcurrent(feedRequests, 3, async (request) => {
      try {
        const rawFeed = request.feed ? await musicFeedText(request.feed) : await fetchText(request.url);
        return parseRss(rawFeed, request.query, request.source)
          .slice(0, request.limit)
          .map((item) => ({
            ...item,
            query: request.query,
            directCategoryFeed: Boolean(request.feed?.categories?.includes(category.id)),
          }));
      } catch (error) {
        console.warn(`Niche source unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    const allItems = feedItems.flat();
    const seenHeadlines = new Set();
    const items = allItems.filter((item) => {
      const key = item.headline.toLocaleLowerCase("en-US");
      if (seenHeadlines.has(key)) return false;
      seenHeadlines.add(key);
      return true;
    }).map((item) => {
      const relatedItems = allItems.filter((other) => coverageStoryMatch(item.headline, other.headline));
      const coverageSources = [...new Set(relatedItems.map((other) => other.source).filter(Boolean))];
      return {
        ...item,
        coverageCount: relatedItems.length,
        coverageSources,
        coverageHeadlines: relatedItems.map((other) => ({
          headline: other.headline,
          source: other.source,
          publishedAt: other.publishedAt,
        })),
        coverageSourceCount: coverageSources.filter((source) => !/^google news$/i.test(source)).length,
      };
    }).sort((left, right) => (category.parent === "Music"
      ? Number(Boolean(right.directCategoryFeed)) - Number(Boolean(left.directCategoryFeed))
      : 0) || right.coverageCount - left.coverageCount || left.order - right.order)
      .slice(0, candidatePoolLimit);
    const enriched = await mapConcurrent(items, 3, async (candidate) => {
      try {
        const candidateUrl = new URL(candidate.link);
        const publisherUrls = candidateUrl.hostname === nicheSourceHost
          ? await resolvePublisherArticles(candidate)
          : [candidate.link];
        for (const publisherUrl of publisherUrls) {
          try {
            const metadata = await linkedArticleMetadata(publisherUrl, { allowMissingImage: true });
            const articleIntro = cleanArticleIntro(metadata.intro);
            const enrichedCandidate = {
              ...candidate,
              link: metadata.url,
              articleIntro,
              playback: metadata.playback,
              imageSource: metadata.imageSource,
              imageAlt: metadata.imageAlt,
            };
            const minimumIntroLength = category.parent === "Music" && enrichedCandidate.directCategoryFeed ? 45 : 80;
            if (articleIntro.length < minimumIntroLength || !sourceCandidateCoreUsable(category, enrichedCandidate, now)) {
              if (process.env.NICHE_DEBUG === "1") {
                console.log(JSON.stringify({
                  category: category.id,
                  headline: candidate.headline,
                  source: candidate.source,
                  coverageCount: candidate.coverageCount,
                  coverageSources: candidate.coverageSources,
                  introLength: articleIntro.length,
                  articleIntro: articleIntro.slice(0, 240),
                  coreUsable: false,
                }));
              }
              continue;
            }
            let candidateWithEvidence = {
              ...enrichedCandidate,
              popularityEvidence: popularityEvidenceFor(
                enrichedCandidate,
                focusedArticleContext(enrichedCandidate.headline, articleIntro, 620),
              ),
            };
            if (candidateWithEvidence.popularityEvidence.mode !== "independent-coverage") {
              const corroboratedCandidate = await corroborateCandidate(category, candidateWithEvidence);
              candidateWithEvidence = {
                ...corroboratedCandidate,
                popularityEvidence: popularityEvidenceFor(
                  corroboratedCandidate,
                  focusedArticleContext(corroboratedCandidate.headline, articleIntro, 620),
                ),
              };
            }
            const popularityEvidence = candidateWithEvidence.popularityEvidence;
            const usable = sourceCandidateUsable(category, candidateWithEvidence, now);
            if (process.env.NICHE_DEBUG === "1" && !usable) {
              console.log(JSON.stringify({
                category: category.id,
                headline: candidate.headline,
                source: candidate.source,
                coverageCount: candidateWithEvidence.coverageCount,
                coverageSources: candidateWithEvidence.coverageSources,
                evidence: popularityEvidence,
                introLength: articleIntro.length,
                articleIntro: articleIntro.slice(0, 240),
              }));
            }
            if (!usable) continue;
            if (metadata.title && meaningfulWordOverlap(candidate.headline, metadata.title).length < 2) continue;
            return { ...candidateWithEvidence, relevanceScore: candidateRelevanceScore(candidateWithEvidence, now) };
          } catch {
            // Try the next publisher result when a syndicator blocks the request.
          }
        }
        return null;
      } catch (error) {
        console.warn(`Niche article unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const valid = [];
    for (const item of enriched.filter(Boolean).sort((left, right) => right.relevanceScore - left.relevanceScore || left.order - right.order)) {
      if (valid.some((existing) => sameStoryFamily(existing, item))) continue;
      valid.push(item);
      if (valid.length === 3) break;
    }
    if (valid.length >= minimumNicheTopics) return valid;

    // Google News occasionally returns its own interstitial instead of a
    // publisher URL. Revalidate the last source-grounded cards directly so a
    // resolver outage does not force a generic fallback or lose a good feed.
    const priorTopics = fallbackCategory(category).topics
      .filter((topic) => topic.evidenceMode === "source-grounded" && /^https:\/\//i.test(topic.url ?? ""))
      .slice(0, maxPublisherCandidates);
    const prior = await mapConcurrent(priorTopics, 3, async (topic) => {
      try {
        const metadata = await linkedArticleMetadata(topic.url, { allowMissingImage: true });
        const articleIntro = cleanArticleIntro(metadata.intro);
        const publishedAt = topic.publishedAt ?? fallbackBrief.generatedAt;
          const priorCandidate = {
            headline: topic.title,
            articleIntro,
            publishedAt,
            playback: metadata.playback,
            imageSource: metadata.imageSource,
            source: topic.source,
            coverageCount: topic.popularityEvidence?.coverageCount,
            coverageSources: topic.popularityEvidence?.coverageSources,
            popularityEvidence: topic.popularityEvidence,
            directCategoryFeed: isTrustedMusicCategoryFeed(category, { source: topic.source }),
          };
        const popularityEvidence = popularityEvidenceFor(
          priorCandidate,
          focusedArticleContext(priorCandidate.headline, articleIntro, 620),
        );
        const priorCandidateWithEvidence = { ...priorCandidate, popularityEvidence };
        if (articleIntro.length < 80 || !sourceCandidateUsable(category, priorCandidateWithEvidence, now)) return null;
        if (metadata.title && meaningfulWordOverlap(topic.title, metadata.title).length < 2) return null;
        return {
          headline: topic.title,
          source: topic.source,
          sourceUrl: topic.url,
          link: metadata.url,
          publishedAt,
          order: topic.id,
          articleIntro,
          playback: metadata.playback,
          imageSource: metadata.imageSource,
          imageAlt: metadata.imageAlt,
          coverageCount: popularityEvidence.coverageCount,
          coverageSources: popularityEvidence.coverageSources,
          popularityEvidence,
          relevanceScore: candidateRelevanceScore(priorCandidateWithEvidence, now),
        };
      } catch (error) {
        console.warn(`Last-good niche article unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    const combined = [];
    for (const item of valid.concat(prior).filter(Boolean)
      .sort((left, right) => right.relevanceScore - left.relevanceScore || String(left.order).localeCompare(String(right.order)))) {
      if (combined.some((existing) => sameStoryFamily(existing, item))) continue;
      combined.push(item);
      if (combined.length === 3) break;
    }
    return combined;
  } catch (error) {
    console.warn(`Niche source unavailable for ${category.label}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function fallbackCategory(category) {
  const candidate = fallbackCategories.get(category.id);
  return candidate ?? {
    ...category,
    topics: [],
  };
}

function candidateRecords(category, candidates) {
  return candidates.slice(0, 3).map((candidate, index) => {
    const focusedContext = removeArticleBoilerplate(focusedArticleContext(candidate.headline, candidate.articleIntro, 620));
    return {
      id: `${category.id}-${index + 1}`,
      category: category.label,
      categoryContext: category.description,
      title: candidate.headline,
      sourceUrl: candidate.link,
      publishedAt: candidate.publishedAt,
      imageSource: candidate.imageSource,
      coverageCount: candidate.coverageCount,
      coverageSources: candidate.coverageSources,
      popularityEvidence: candidate.popularityEvidence,
      sourceSnippets: [
        {
          kind: "current_headline",
          source: candidate.source,
          headline: candidate.headline,
          text: candidate.headline,
          publishedAt: candidate.publishedAt,
        },
        {
          kind: "current_coverage",
          source: candidate.source,
          headline: candidate.headline,
          text: focusedContext,
          publishedAt: candidate.publishedAt,
        },
        {
          kind: "popularity_evidence",
          source: (candidate.popularityEvidence?.coverageSources ?? []).join(", "),
          headline: candidate.headline,
          text: popularityEvidenceText(candidate),
          publishedAt: candidate.publishedAt,
        },
        ...(candidate.coverageHeadlines ?? []).map((coverage) => ({
          kind: "related_coverage",
          source: coverage.source,
          headline: coverage.headline,
          text: coverage.headline,
          publishedAt: coverage.publishedAt,
        })),
      ],
      candidate,
    };
  });
}

function completeSentences(value, maxLength = 520) {
  let result = "";
  for (const { segment } of sentenceSegmenter.segment(cleanText(value, 1_400))) {
    const sentence = segment.trim();
    if (!sentence || /^(?:although|because|but|which|while|with|as)\b/i.test(sentence.replace(/^[\s"“”'’]+/, "")) && sentence.length < 72) break;
    if (incompleteSentencePattern.test(sentence)) continue;
    const next = `${result} ${sentence}`.trim();
    if (next.length > maxLength && result) break;
    result = next;
  }
  return result;
}

function normalizePopularityEvidence(value) {
  const mode = ["independent-coverage", "measurable-signal", "concrete-trend-signal"].includes(value?.mode)
    ? value.mode
    : "none";
  const coverageSources = [...new Set((value?.coverageSources ?? [])
    .map((source) => cleanText(source, 120))
    .filter(Boolean)
    .filter((source) => !/^google news$/i.test(source)))];
  const coverageCount = Number(value?.coverageCount ?? 0);
  const signal = cleanText(value?.signal, 360);
  return { mode, coverageCount, coverageSources, signal };
}

function validatedPopularityEvidence(value) {
  const evidence = normalizePopularityEvidence(value);
  return (evidence.mode === "independent-coverage"
    && evidence.coverageCount >= 2
    && evidence.coverageSources.length >= 2
    && (evidence.coverageSources.length >= 3
      || popularityMetricPattern.test(evidence.signal)
      || concreteTrendMechanismPattern.test(evidence.signal)))
    || (evidence.mode === "measurable-signal" && popularityMetricPattern.test(evidence.signal))
    || (evidence.mode === "concrete-trend-signal" && concreteTrendMechanismPattern.test(evidence.signal))
    ? evidence
    : null;
}

function sourceGroundedTopic(record, category, index, fallback) {
  const candidate = record.candidate;
  const fallbackTopics = fallbackBrief.categories.flatMap((entry) => entry.topics ?? []);
  const fallbackTopic = fallback?.topics?.[index] ?? fallbackTopics[index % Math.max(1, fallbackTopics.length)] ?? { accent: category.accent };
  const headline = cleanText(candidate?.headline, 180);
  const sourceArticleIntro = removeArticleBoilerplate(candidate?.articleIntro);
  const articleIntro = removeArticleBoilerplate(focusedArticleContext(headline, sourceArticleIntro, 420));
  if (!candidate || !articleIntro) throw new Error(`Niche topic ${record.id} has no source-grounded article context`);
  const popularityEvidence = validatedPopularityEvidence(candidate.popularityEvidence);
  if (!popularityEvidence) throw new Error(`Niche topic ${record.id} has no validated popularity evidence`);
  const description = completeSentences(articleIntro, 520);
  const whyNowSource = [...sentenceSegmenter.segment(articleIntro)]
    .map(({ segment }) => segment.trim())
    .filter((sentence) => sentence && !/["“][^"”]+["”]/.test(sentence) && !articleContextBoilerplatePattern.test(sentence))
    .sort((left, right) => {
      const score = (sentence) => Number(concreteContextPattern.test(sentence)) * 2
        + Number(popularityMetricPattern.test(sentence)) * 4
        + Number(attentionSignalPattern.test(sentence))
        + meaningfulWordOverlap(headline, sentence).length;
      return score(right) - score(left);
    })
    .find((sentence) => concreteContextPattern.test(sentence)
      && !publisherBoilerplatePattern.test(sentence)
      && !articleCaptionPattern.test(sentence)
      && headlineContextOverlap(headline, sentence).length >= 1);
  const fallbackWhyNowSource = [...sentenceSegmenter.segment(articleIntro)]
    .map(({ segment }) => segment.trim())
    .find((sentence) => sentence
      && !articleContextBoilerplatePattern.test(sentence)
      && !publisherBoilerplatePattern.test(sentence)
      && !articleCaptionPattern.test(sentence)
      && !/["“][^"”]+["”]/.test(sentence)
      && concreteContextPattern.test(sentence));
  const backgroundContext = [...sentenceSegmenter.segment(sourceArticleIntro)]
    .map(({ segment }) => segment.trim())
    .find((sentence) => contextualBackgroundPattern.test(sentence)
      && !articleContextBoilerplatePattern.test(sentence)
      && !publisherBoilerplatePattern.test(sentence)
      && !articleCaptionPattern.test(sentence)
      && headlineContextOverlap(headline, sentence).length >= 1
      && sentence !== whyNowSource);
  const whyNowParts = [];
  if (["measurable-signal", "concrete-trend-signal"].includes(popularityEvidence.mode) && popularityEvidence.signal) {
    whyNowParts.push(popularityEvidence.signal);
  } else if (whyNowSource) {
    whyNowParts.push(whyNowSource);
  } else if (fallbackWhyNowSource) {
    whyNowParts.push(fallbackWhyNowSource);
  }
  if (backgroundContext && !whyNowParts.includes(backgroundContext)) whyNowParts.push(backgroundContext);
  const whyNow = completeSentences(
    whyNowParts.join(" "),
    280,
  );
  if (!whyNow) throw new Error(`Niche topic ${record.id} has no evidence-based why-now context`);
  return {
    id: record.id,
    title: headline,
    description,
    whyNow,
    url: candidate.link,
    source: candidate.source,
    sourceLabel: "Read the report",
    evidenceMode: "source-grounded",
    image: nicheImagePath(record.id),
    ...(candidate.playback ? { playback: candidate.playback } : {}),
    ...(candidate.imageSource ? {
      imageSource: candidate.imageSource,
      imageSourcePageUrl: candidate.link,
      imageAlt: candidate.imageAlt,
    } : {}),
    ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
    coverageCount: popularityEvidence.coverageCount,
    coverageSources: popularityEvidence.coverageSources,
    popularityEvidence,
    accent: fallbackTopic.accent ?? category.accent,
    trendLabel: popularityEvidence.mode === "measurable-signal" ? "Measured this week" : "Recent signal",
  };
}

function cleanedRetainedWhyNow(value) {
  const withoutCoverageAttribution = cleanText(value, 420)
    .replace(/\s+Reports? from\b[\s\S]*?(?:past seven days\.?|$)/i, "")
    .trim();
  if (withoutCoverageAttribution && !hasUnbalancedQuotes(withoutCoverageAttribution)
    && !articleContextBoilerplatePattern.test(withoutCoverageAttribution)) {
    return completeSentences(withoutCoverageAttribution, 280);
  }
  return "";
}

function retainedTopic(topic, category, index) {
  const id = topic.id || `${category.id}-${index + 1}`;
  return {
    ...topic,
    id,
    title: cleanText(topic.title, 180),
    description: completeSentences(removeArticleBoilerplate(topic.description), 520),
    whyNow: cleanedRetainedWhyNow(topic.whyNow),
    ...(topic.source ? { source: cleanText(topic.source, 120) } : {}),
    ...(topic.sourceLabel ? { sourceLabel: cleanText(topic.sourceLabel, 120) } : {}),
    ...(topic.imageAlt ? { imageAlt: cleanText(topic.imageAlt, 180) } : {}),
    ...(topic.popularityEvidence ? { popularityEvidence: normalizePopularityEvidence(topic.popularityEvidence) } : {}),
    image: nicheImagePath(id),
  };
}

function persistedTopicUsable(topic, category, now = new Date()) {
  const candidate = {
    headline: topic?.title ?? "",
    source: topic?.source ?? "",
    coverageCount: topic?.popularityEvidence?.coverageCount,
    coverageSources: topic?.popularityEvidence?.coverageSources,
    playback: topic?.playback,
    directCategoryFeed: isTrustedMusicCategoryFeed(category, { source: topic?.source ?? "" }),
  };
  const focused = `${topic?.description ?? ""} ${topic?.whyNow ?? ""}`;
  const outputText = `${topic?.title ?? ""} ${focused}`;
  const rawPopularityEvidence = normalizePopularityEvidence(topic?.popularityEvidence);
  const popularityEvidence = validatedPopularityEvidence(rawPopularityEvidence)
    ?? (category.parent === "Music"
      && rawPopularityEvidence.mode === "independent-coverage"
      && rawPopularityEvidence.coverageCount >= 2
      && rawPopularityEvidence.coverageSources.length >= 2
      && musicReleasePattern.test(outputText)
      && musicArtifactPattern.test(outputText)
      ? rawPopularityEvidence
      : null);
  return topic?.evidenceMode === "source-grounded"
    && isRecentPublication(topic.publishedAt, now)
    && /^https:\/\//i.test(topic.url ?? "")
    && (category.parent !== "Music" || Boolean(topic?.playback?.embedUrl))
    && !numberedNicheHeadlinePattern.test(topic.title ?? "")
    && !genericNicheHeadlinePattern.test(topic.title ?? "")
    && !editorialNicheHeadlinePattern.test(topic.title ?? "")
    && !hardMetaNicheHeadlinePattern.test(topic.title ?? "")
    && !nonNewsHeadlinePattern.test(topic.title ?? "")
    && !genericNicheCopyPattern.test(outputText)
    && !articleArtifactPattern.test(outputText)
    && !publisherBoilerplatePattern.test(outputText)
    && !articleCaptionPattern.test(outputText)
    && !eventListingPattern.test(outputText)
    && String(topic.whyNow ?? "").trim().length >= 20
    && !hasUnbalancedQuotes(topic.description)
    && !hasUnbalancedQuotes(topic.whyNow)
    && !firstPersonReviewPattern.test(outputText)
    && !(evergreenReviewContextPattern.test(outputText)
      && !popularityMetricPattern.test(outputText)
      && !concreteTrendMechanismPattern.test(outputText))
    && !(promotionalContentPattern.test(outputText)
      && !popularityMetricPattern.test(outputText)
      && !concreteTrendMechanismPattern.test(outputText))
    && !hardPromotionalContentPattern.test(`${topic.source ?? ""} ${outputText}`)
    && !editorialNicheHeadlinePattern.test(topic.title ?? "")
    && !/\bReports? from\b/i.test(topic.whyNow ?? "")
    && String(topic.whyNow ?? "").trim().toLocaleLowerCase() !== String(topic.title ?? "").trim().toLocaleLowerCase()
    && Boolean(popularityEvidence)
    && concreteContextPattern.test(`${topic.description ?? ""} ${topic.whyNow ?? ""}`)
    && headlineContextStrong(topic.title ?? "", focused)
    && !(category.parent === "Music" && candidate.directCategoryFeed && category.id !== "edm"
      && (!musicArtifactPattern.test(candidate.headline) || !musicArticleContextPattern.test(focused)))
    && categoryRuleUsable(category, candidate, focused);
}

export async function generateNicheSnapshot(brief, { now = new Date(), dryRun = false } = {}) {
  const sourceResults = await mapConcurrent(categoryDefinitions, 4, async (category) => ({
    category,
    candidates: await categoryCandidates(category, now),
  }));
  const retainedCategoryIds = new Set();
  const records = sourceResults.flatMap(({ category, candidates }) => {
    const fallback = fallbackCategory(category);
    if (candidates.length < minimumNicheTopics) {
      retainedCategoryIds.add(category.id);
      console.warn(`${category.label} produced only ${candidates.length} source-grounded topics; retaining its last validated cards`);
      return [];
    }
    const sourceRecords = candidateRecords(category, candidates);
    return sourceRecords.map((record, index) => {
      try {
        return {
          ...record,
          fallback: sourceGroundedTopic(record, category, index, fallback),
        };
      } catch (error) {
        console.warn(`${category.label} dropped ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }).filter(Boolean);
  });
  let generated = new Map();
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      generated = await generateNicheBatch(records);
    } catch (error) {
      console.warn(`AI niche topics unavailable; deterministic niche cards retained: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    console.log("AI niche topics skipped: OPENAI_API_KEY is not configured; deterministic niche cards remain active.");
  }

  const categories = categoryDefinitions.map((category) => {
    const fallback = fallbackCategory(category);
    if (retainedCategoryIds.has(category.id)) {
      const retainedTopics = fallback.topics?.slice(0, 3).map((topic, index) => retainedTopic(topic, category, index)) ?? [];
      const verifiedRetainedTopics = retainedTopics.filter((topic) => persistedTopicUsable(topic, category, now));
      if (verifiedRetainedTopics.length < minimumNicheTopics) {
        console.warn(`${category.label} has no verified last-good cards; excluding the tag until fresh coverage is available`);
        return { id: category.id, label: category.label, parent: category.parent, description: category.description, accent: category.accent, topics: [] };
      }
      return {
        id: category.id,
        label: category.label,
        parent: category.parent,
        description: fallback.description,
        accent: category.accent,
        topics: verifiedRetainedTopics,
      };
    }
    const categoryRecords = records.filter((record) => record.category === category.label).slice(0, 3);
    const topics = categoryRecords.map((record, index) => {
      const base = record.fallback ?? sourceGroundedTopic(record, category, index, fallback);
      const ai = generated.get(record.id);
      const usableAi = ai && isNicheTopicUsable(ai, record) ? ai : null;
      return {
        ...base,
        ...(usableAi ? {
          title: usableAi.title,
          description: usableAi.description,
          whyNow: usableAi.whyNow,
          trendLabel: usableAi.trendLabel,
        } : {}),
      };
    });
    const validatedTopics = topics.filter((topic) => persistedTopicUsable(topic, category, now));
    if (validatedTopics.length !== topics.length) {
      console.warn(`${category.label} dropped ${topics.length - validatedTopics.length} card(s) during final quality validation`);
    }
    return {
      id: category.id,
      label: category.label,
      parent: category.parent,
      description: fallback.description,
      accent: category.accent,
      topics: validatedTopics,
    };
  });
  const publishableCategories = categories.filter((category) => category.topics.length >= minimumNicheTopics);
  const snapshot = {
    generatedAt: now.toISOString(),
    edition: `Week of ${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(now)}`,
    window: "Past 7 days",
    summary: fallbackBrief.summary,
    categories: publishableCategories,
  };
  if (dryRun) {
    console.log(`Niche snapshot dry run: ${publishableCategories.length} categories, ${generated.size} AI topic cards, ${retainedCategoryIds.size} retained categories, ${publishableCategories.reduce((total, category) => total + category.topics.length, 0)} total cards.`);
  } else {
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }
  return snapshot;
}

export { categoryCandidates, categoryDefinitions, concreteTrendSentence, coverageStoryMatch, focusedArticleContext, popularityEvidenceFor, sourceCandidateUsable };

if (process.argv.includes("--standalone")) {
  const rawBrief = JSON.parse(await readFile(path.join(root, "data", "trends.json"), "utf8"));
  await generateNicheSnapshot(rawBrief, { dryRun: process.argv.includes("--dry-run") });
}
