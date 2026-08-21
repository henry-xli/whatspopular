import {
  changesFrom,
  database,
  ensureAccountSchema,
  jsonResponse,
  mobileAccessLifetimeMs,
  mobileRefreshLifetimeMs,
  parseStoredTags,
  profileForUser,
  randomToken,
  readJsonBody,
  sha256,
} from "../../../../account-server";

export const dynamic = "force-dynamic";

type ExchangePayload = { requestId?: unknown; pairingSecret?: unknown };

export async function POST(request: Request) {
  const payload = await readJsonBody<ExchangePayload>(request);
  const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  const pairingSecret = typeof payload?.pairingSecret === "string" ? payload.pairingSecret.trim() : "";
  if (!/^[0-9a-f-]{20,80}$/i.test(requestId) || !/^[A-Za-z0-9_-]{40,80}$/.test(pairingSecret)) {
    return jsonResponse({ error: "Invalid link exchange" }, 401);
  }
  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    const now = new Date();
    const nowIso = now.toISOString();
    const row = await db.prepare(`
      SELECT request_id, secret_hash, status, user_id, expires_at
      FROM mobile_link_requests
      WHERE request_id = ?1
    `).bind(requestId).first<{ request_id?: string; secret_hash?: string; status?: string; user_id?: string; expires_at?: string }>();
    if (!row?.request_id || !row.secret_hash || !row.expires_at || await sha256(pairingSecret) !== row.secret_hash) {
      return jsonResponse({ error: "Invalid link exchange" }, 401);
    }
    if (row.expires_at <= nowIso) return jsonResponse({ error: "Link request expired" }, 410);
    if (row.status === "pending") return jsonResponse({ status: "pending", expiresAt: row.expires_at }, 202);
    if (row.status !== "approved" || !row.user_id) return jsonResponse({ error: "Link request is no longer available" }, 409);

    const claimed = await db.prepare(`
      UPDATE mobile_link_requests
      SET status = 'exchanged', exchanged_at = ?1
      WHERE request_id = ?2 AND status = 'approved' AND expires_at > ?1
    `).bind(nowIso, requestId).run();
    if (changesFrom(claimed) !== 1) return jsonResponse({ error: "Link request was already exchanged" }, 409);

    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const accessExpiresAt = new Date(now.getTime() + mobileAccessLifetimeMs).toISOString();
    const refreshExpiresAt = new Date(now.getTime() + mobileRefreshLifetimeMs).toISOString();
    const sessionId = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO mobile_sessions
        (session_id, user_id, access_token_hash, refresh_token_hash, created_at, last_seen_at, access_expires_at, refresh_expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
    `).bind(
      sessionId,
      row.user_id,
      await sha256(accessToken),
      await sha256(refreshToken),
      nowIso,
      accessExpiresAt,
      refreshExpiresAt,
    ).run();
    const profile = await profileForUser(db, {
      userId: row.user_id,
      email: "",
      displayName: "what’s popular? member",
    });
    return jsonResponse({
      accessToken,
      refreshToken,
      accessExpiresAt,
      refreshExpiresAt,
      profile: { ...profile, tags: parseStoredTags(JSON.stringify(profile.tags)) },
    });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}
