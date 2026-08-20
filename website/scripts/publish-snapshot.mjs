import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourcePath = path.join(root, "data", "trends.json");
const publishedPath = path.join(root, "public", "data", "trends.json");
const raw = await readFile(sourcePath, "utf8");
const brief = JSON.parse(raw);

if (!Array.isArray(brief.sections) || brief.sections.length !== 8
  || brief.sections.some((section) => !Array.isArray(section.items) || section.items.length !== 5)
  || !brief.quiz || !Array.isArray(brief.quiz.questions) || brief.quiz.questions.length === 0) {
  throw new Error("Refusing to publish an invalid briefing snapshot");
}

await mkdir(path.dirname(publishedPath), { recursive: true });
await writeFile(publishedPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");
