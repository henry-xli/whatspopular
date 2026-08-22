import {
  changesFrom,
  database,
  ensureAccountSchema,
  getAuthenticatedUser,
  jsonResponse,
  readJsonBody,
  sameOriginRequest,
  sha256,
  upsertProfileIdentity,
} from "../../../../account-server";

export const dynamic = "force-dynamic";

type ApprovalPayload = { requestId?: unknown; code?: unknown };

export async function POST(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in or create an account before linking a device" }, 401);
  if (!sameOriginRequest(request)) return jsonResponse({ error: "Cross-site link approvals are not allowed" }, 403);
  const payload = await readJsonBody<ApprovalPayload>(request);
  const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
  const code = typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";
  if (!/^[0-9a-f-]{20,80}$/i.test(requestId) || !/^[A-Z2-9]{8}$/.test(code)) {
    return jsonResponse({ error: "Invalid or expired link request" }, 400);
  }

  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    const now = new Date().toISOString();
    const row = await db.prepare(`
      SELECT request_id, code_hash, status, attempt_count, expires_at
      FROM mobile_link_requests
      WHERE request_id = ?1
    `).bind(requestId).first<{ request_id?: string; code_hash?: string; status?: string; attempt_count?: number; expires_at?: string }>();
    if (!row?.request_id || !row.code_hash || !row.expires_at || row.expires_at <= now || row.status !== "pending" || Number(row.attempt_count ?? 0) >= 5) {
      return jsonResponse({ error: "Invalid or expired link request" }, 410);
    }
    if (await sha256(code) !== row.code_hash) {
      const attempts = Number(row.attempt_count ?? 0) + 1;
      await db.prepare(`
        UPDATE mobile_link_requests
        SET attempt_count = ?1, status = CASE WHEN ?1 >= 5 THEN 'expired' ELSE status END
        WHERE request_id = ?2 AND status = 'pending'
      `).bind(attempts, requestId).run();
      return jsonResponse({ error: "Invalid or expired link request" }, 400);
    }

    const result = await db.prepare(`
      UPDATE mobile_link_requests
      SET status = 'approved', user_id = ?1, approved_at = ?2
      WHERE request_id = ?3 AND status = 'pending' AND expires_at > ?2
    `).bind(user.userId, now, requestId).run();
    if (changesFrom(result) !== 1) return jsonResponse({ error: "Link request was already used" }, 409);
    try {
      // Claim the request before touching the profile. If two signed-in users
      // submit the same code at once, only the winner may update identity data.
      await upsertProfileIdentity(db, { userId: user.userId, email: user.email, displayName: user.displayName });
    } catch (error) {
      // Make a transient profile-storage failure retryable unless the mobile
      // side has already exchanged the claimed request.
      await db.prepare(`
        UPDATE mobile_link_requests
        SET status = 'pending', user_id = NULL, approved_at = NULL
        WHERE request_id = ?1 AND status = 'approved' AND user_id = ?2
      `).bind(requestId, user.userId).run();
      throw error;
    }
    return jsonResponse({ approved: true, expiresAt: row.expires_at });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}
