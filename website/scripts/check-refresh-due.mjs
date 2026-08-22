import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const recoveryHours = Number(process.env.REFRESH_RECOVERY_HOURS ?? 5);
const forced = process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
  || process.env.REFRESH_FORCE === "true";
const candidateWindow = forced || process.env.REFRESH_CANDIDATE === "true";
const now = process.env.REFRESH_NOW ? new Date(process.env.REFRESH_NOW) : new Date();

if (!Number.isFinite(now.getTime())) throw new Error("REFRESH_NOW is not a valid timestamp");
if (!Number.isInteger(recoveryHours) || recoveryHours < 0 || recoveryHours > 23) {
  throw new Error("REFRESH_RECOVERY_HOURS must be an integer from 0 to 23");
}

function parts(formatter) {
  return Object.fromEntries(formatter.formatToParts(now)
    .filter(({ type }) => type !== "literal")
    .map(({ type, value }) => [type, value]));
}

const dateParts = parts(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}));
const hourParts = parts(new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  hourCycle: "h23",
}));
const pacificDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
const pacificHour = Number(hourParts.hour);
if (!Number.isInteger(pacificHour)) throw new Error("Could not determine Pacific time");

async function snapshotDate(relativePath) {
  const value = JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  const timestamp = Date.parse(value.generatedAt);
  if (!Number.isFinite(timestamp)) throw new Error(`${relativePath} has an invalid generatedAt timestamp`);
  const generatedParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp))
    .filter(({ type }) => type !== "literal")
    .map(({ type, value: partValue }) => [type, partValue]));
  return `${generatedParts.year}-${generatedParts.month}-${generatedParts.day}`;
}

const briefDate = await snapshotDate("data/trends.json");
const nicheDate = await snapshotDate("data/niche-trends.json");
const stale = briefDate !== pacificDate || nicheDate !== pacificDate;
const inRecoveryWindow = pacificHour <= recoveryHours;
const run = forced || (candidateWindow && inRecoveryWindow && stale);
const late = run && !forced && pacificHour > 0;

console.error(`Pacific refresh check: local=${pacificDate} ${String(pacificHour).padStart(2, "0")}:00, brief=${briefDate}, niche=${nicheDate}, stale=${stale}, run=${run}${late ? " (recovery window)" : ""}`);
console.log(`run=${run}`);
console.log(`late=${late}`);
console.log(`pacific_date=${pacificDate}`);
console.log(`pacific_hour=${String(pacificHour).padStart(2, "0")}`);
console.log(`brief_date=${briefDate}`);
console.log(`niche_date=${nicheDate}`);
