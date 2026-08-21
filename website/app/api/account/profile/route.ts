import {
  changesFrom,
  database,
  ensureAccountSchema,
  getAuthenticatedUser,
  jsonResponse,
  normalizedTags,
  parseStoredTags,
  profileForUser,
  readJsonBody,
  sameOriginRequest,
} from "../../../account-server";

export const dynamic = "force-dynamic";

type ProfilePayload = { tags?: unknown; expectedUpdatedAt?: unknown };

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    return jsonResponse({ ...(await profileForUser(db, user)), storage: "d1" });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  return updateProfile(request);
}

export async function PUT(request: Request) {
  return updateProfile(request);
}

export async function PATCH(request: Request) {
  return updateProfile(request);
}

async function updateProfile(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  if (user.authMethod === "chatgpt" && !sameOriginRequest(request)) {
    return jsonResponse({ error: "Cross-site profile writes are not allowed" }, 403);
  }
  const payload = await readJsonBody<ProfilePayload>(request);
  if (!payload || !Object.hasOwn(payload, "tags") || !Object.hasOwn(payload, "expectedUpdatedAt")) {
    return jsonResponse({ error: "Invalid JSON profile" }, 400);
  }
  const normalized = normalizedTags(payload.tags);
  if (normalized.error) return jsonResponse({ error: normalized.error }, 422);
  const expectedUpdatedAt = payload.expectedUpdatedAt === null
    ? null
    : typeof payload.expectedUpdatedAt === "string" && payload.expectedUpdatedAt.length <= 80
      ? payload.expectedUpdatedAt
      : undefined;
  if (expectedUpdatedAt === undefined) return jsonResponse({ error: "Invalid profile version" }, 422);

  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    const existing = await profileForUser(db, user);
    if ((expectedUpdatedAt === null && existing.hasProfile) || (expectedUpdatedAt && existing.updatedAt !== expectedUpdatedAt)) {
      return jsonResponse({ error: "Profile changed on another device", conflict: true, ...existing }, 409);
    }
    const currentTimestamp = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
    const now = new Date(Math.max(Date.now(), Number.isFinite(currentTimestamp) ? currentTimestamp + 1 : 0)).toISOString();
    const values = [user.userId, user.email, user.displayName, JSON.stringify(normalized.tags), now];
    const result = existing.hasProfile
      ? await db.prepare(`
          UPDATE user_profiles
          SET email = ?2, display_name = ?3, selected_tags_json = ?4, updated_at = ?5
          WHERE user_id = ?1 AND updated_at = ?6
        `).bind(...values, expectedUpdatedAt).run()
      : await db.prepare(`
          INSERT INTO user_profiles (user_id, email, display_name, selected_tags_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?5)
          ON CONFLICT(user_id) DO NOTHING
        `).bind(...values).run();
    if (changesFrom(result) !== 1) {
      const current = await profileForUser(db, user);
      return jsonResponse({ error: "Profile changed on another device", conflict: true, ...current }, 409);
    }
    return jsonResponse({
      tags: parseStoredTags(JSON.stringify(normalized.tags)),
      email: user.email,
      displayName: user.displayName,
      updatedAt: now,
      hasProfile: true,
      storage: "d1",
    });
  } catch {
    return jsonResponse({ error: "Profile storage unavailable" }, 503);
  }
}
