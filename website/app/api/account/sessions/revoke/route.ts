import { getChatGPTUser } from "../../../../chatgpt-auth";
import { changesFrom, database, ensureAccountSchema, jsonResponse, sameOriginRequest } from "../../../../account-server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  if (!sameOriginRequest(request)) return jsonResponse({ error: "Cross-site session revocation is not allowed" }, 403);
  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    const result = await db.prepare(`
      UPDATE mobile_sessions
      SET revoked_at = ?1
      WHERE user_id = ?2 AND revoked_at IS NULL
    `).bind(new Date().toISOString(), user.userId).run();
    return jsonResponse({ revoked: true, sessions: changesFrom(result) });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}
