import {
  database,
  ensureAccountSchema,
  jsonResponse,
  randomPairingCode,
  randomToken,
  sha256,
} from "../../../../account-server";

export const dynamic = "force-dynamic";

const linkLifetimeMs = 10 * 60 * 1000;
const maxStartsPerHour = 12;

export async function POST(request: Request) {
  const db = await database();
  if (!db) return jsonResponse({ error: "Account storage unavailable" }, 503);
  try {
    await ensureAccountSchema(db);
    const now = new Date();
    const nowIso = now.toISOString();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    // Only trust the edge-provided address. Client-controlled forwarding
    // headers would let an attacker rotate identities and bypass the limit.
    const clientAddress = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
    const ipHash = await sha256(`whatspopular-link:${clientAddress}`);
    const recent = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM mobile_link_requests
      WHERE ip_hash = ?1 AND created_at > ?2
    `).bind(ipHash, hourAgo).first<{ count?: number | string }>();
    if (Number(recent?.count ?? 0) >= maxStartsPerHour) {
      return jsonResponse({ error: "Too many link attempts. Try again later." }, 429, { "Retry-After": "3600" });
    }

    await db.prepare(
      "DELETE FROM mobile_link_requests WHERE expires_at <= ?1 OR status = 'exchanged'",
    ).bind(nowIso).run();
    await db.prepare(
      "DELETE FROM mobile_sessions WHERE refresh_expires_at <= ?1",
    ).bind(nowIso).run();

    const requestId = crypto.randomUUID();
    const pairingCode = randomPairingCode();
    const pairingSecret = randomToken(32);
    const expiresAt = new Date(now.getTime() + linkLifetimeMs).toISOString();
    await db.prepare(`
      INSERT INTO mobile_link_requests
        (request_id, code_hash, secret_hash, status, ip_hash, created_at, expires_at)
      VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)
    `).bind(
      requestId,
      await sha256(pairingCode),
      await sha256(pairingSecret),
      ipHash,
      nowIso,
      expiresAt,
    ).run();

    const requestOrigin = new URL(request.url).origin;
    const approvalUrl = new URL("/mobile-link", requestOrigin);
    approvalUrl.search = new URLSearchParams({ request_id: requestId, code: pairingCode }).toString();
    return jsonResponse({ requestId, pairingCode, pairingSecret, approvalUrl: approvalUrl.href, expiresAt });
  } catch {
    return jsonResponse({ error: "Account storage unavailable" }, 503);
  }
}
