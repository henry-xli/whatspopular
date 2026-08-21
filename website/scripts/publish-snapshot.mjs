import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "data", "trends.json");
const publishedPath = path.join(root, "public", "data", "trends.json");
const nicheSourcePath = path.join(root, "data", "niche-trends.json");
const nichePublishedPath = path.join(root, "public", "data", "niche-trends.json");
const raw = await readFile(sourcePath, "utf8");
const brief = JSON.parse(raw);
const nicheRaw = await readFile(nicheSourcePath, "utf8");
const nicheBrief = JSON.parse(nicheRaw);

if (!Array.isArray(brief.sections) || brief.sections.length !== 8
  || brief.sections.some((section) => !Array.isArray(section.items) || section.items.length !== 5)
  || !brief.quiz || !Array.isArray(brief.quiz.questions) || brief.quiz.questions.length === 0) {
  throw new Error("Refusing to publish an invalid briefing snapshot");
}
if (!Array.isArray(nicheBrief.categories)
  || nicheBrief.categories.length < 40
  || nicheBrief.categories.some((category) => !Array.isArray(category.topics) || category.topics.length < 3)) {
  throw new Error("Refusing to publish an invalid expanded niche snapshot");
}

await mkdir(path.dirname(publishedPath), { recursive: true });
await writeFile(publishedPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
await mkdir(path.dirname(nichePublishedPath), { recursive: true });
await writeFile(nichePublishedPath, nicheRaw.endsWith("\n") ? nicheRaw : `${nicheRaw}\n`, "utf8");
