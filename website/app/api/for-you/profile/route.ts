import { getChatGPTUser } from "../../../chatgpt-auth";
import { nicheCategories } from "../../../niche";

export const dynamic = "force-dynamic";

type D1StatementLike = {
  bind: (...values: unknown[]) => D1StatementLike;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  run: () => Promise<unknown>;
};

type D1Like = {
  prepare: (query: string) => D1StatementLike;
};

const createTableSql = `CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  selected_tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const createIndexSql = "CREATE INDEX IF NOT EXISTS idx_user_profiles_updated_at ON user_profiles(updated_at)";

async function database() {
  try {
    const runtime = await import("cloudflare:workers");
    return (runtime.env as unknown as { DB?: D1Like }).DB ?? null;
  } catch {
    return null;
  }
}

async function ensureSchema(db: D1Like) {
  await db.prepare(createTableSql).run();
  await db.prepare(createIndexSql).run();
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function allowedTags(value: unknown) {
  const ids = new Set(nicheCategories.map((category) => category.id));
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === "string" && ids.has(tag)))].slice(0, 24);
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  const db = await database();
  if (!db) return jsonResponse({ tags: [], storage: "local-preview" });

  try {
    await ensureSchema(db);
    const row = await db.prepare(
      "SELECT selected_tags_json FROM user_profiles WHERE user_id = ?1",
    ).bind(user.userId).first<{ selected_tags_json?: string }>();
    const parsed = row?.selected_tags_json ? JSON.parse(row.selected_tags_json) : [];
    return jsonResponse({ tags: allowedTags(parsed), storage: "d1" });
  } catch {
    return jsonResponse({ tags: [], storage: "unavailable" });
  }
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  let payload: { tags?: unknown };
  try {
    payload = await request.json() as { tags?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }
  const tags = allowedTags(payload.tags);
  const db = await database();
  if (!db) return jsonResponse({ tags, storage: "local-preview" });

  try {
    await ensureSchema(db);
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO user_profiles (user_id, email, display_name, selected_tags_json, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(user_id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        selected_tags_json = excluded.selected_tags_json,
        updated_at = excluded.updated_at
    `).bind(user.userId, user.email, user.displayName, JSON.stringify(tags), now).run();
    return jsonResponse({ tags, storage: "d1" });
  } catch {
    return jsonResponse({ error: "Profile storage unavailable" }, 503);
  }
}
