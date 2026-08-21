import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { additionalNicheCategories } from "./niche-catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const snapshotPath = path.join(root, "data", "niche-trends.json");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const existingIds = new Set(snapshot.categories.map((category) => category.id));
const additions = additionalNicheCategories.filter((category) => !existingIds.has(category.id));

snapshot.categories.push(...additions);
await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`Materialized ${additions.length} additional niche categories (${snapshot.categories.length} total).`);
