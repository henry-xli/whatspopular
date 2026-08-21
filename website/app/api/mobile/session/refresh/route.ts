import {
  changesFrom,
  database,
  ensureAccountSchema,
  jsonResponse,
  mobileAccessLifetimeMs,
  parseStoredTags,
  profileForUser,
  mobileRefreshLifetimeMs,
  randomToken,
  readJsonBody,
  sha256,
} from "../../../../account-server";

export const dynamic = "force-dynamic";

type RefreshPayload = { refreshToken?: unknown };

export async function POST(request: Request) {
  const payload = await readJsonBody<RefreshPayload>(request);
  const refreshToken = typeof payload?.refreshToken === "string" ? payload.refreshToken.trim() : "";
  if (!/^[A-Za-z0-9_-]{40,80}$/.test(refreshToken)) return jsonResponse({ error: "Invalid session" }, 401);
  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    const now = new Date();
    const nowIso = now.toISOString();
    const refreshHash = await sha256(refreshToken);
    const row = await db.prepare(`
      SELECT session_id, user_id, refresh_expires_at
      FROM mobile_sessions
      WHERE refresh_token_hash = ?1 AND revoked_at IS NULL AND refresh_expires_at > ?2
    `).bind(refreshHash, nowIso).first<{ session_id?: string; user_id?: string; refresh_expires_at?: string }>();
    if (!row?.session_id || !row.user_id) return jsonResponse({ error: "Invalid or expired session" }, 401);

    const accessToken = randomToken(32);
    const nextRefreshToken = randomToken(32);
    const accessExpiresAt = new Date(now.getTime() + mobileAccessLifetimeMs).toISOString();
    const refreshExpiresAt = new Date(now.getTime() + mobileRefreshLifetimeMs).toISOString();
    const updated = await db.prepare(`
      UPDATE mobile_sessions
      SET access_token_hash = ?1, refresh_token_hash = ?2, last_seen_at = ?3,
          access_expires_at = ?4, refresh_expires_at = ?5
      WHERE session_id = ?6 AND refresh_token_hash = ?7 AND revoked_at IS NULL
    `).bind(
      await sha256(accessToken),
      await sha256(nextRefreshToken),
      nowIso,
      accessExpiresAt,
      refreshExpiresAt,
      row.session_id,
      refreshHash,
    ).run();
    if (changesFrom(updated) !== 1) return jsonResponse({ error: "Session refresh was already used" }, 401);
    const profile = await profileForUser(db, { userId: row.user_id, email: "", displayName: "what’s popular? member" });
    return jsonResponse({
      accessToken,
      refreshToken: nextRefreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      profile: { ...profile, tags: parseStoredTags(JSON.stringify(profile.tags)) },
    });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}
