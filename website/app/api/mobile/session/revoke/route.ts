import { database, ensureAccountSchema, getMobileUser, jsonResponse } from "../../../../account-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getMobileUser(request);
  if (!user?.sessionId) return jsonResponse({ error: "Invalid session" }, 401);
  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    await db.prepare(
      "UPDATE mobile_sessions SET revoked_at = ?1 WHERE session_id = ?2 AND revoked_at IS NULL",
    ).bind(new Date().toISOString(), user.sessionId).run();
    return jsonResponse({ revoked: true });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}
