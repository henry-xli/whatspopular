import { getChatGPTUser } from "./chatgpt-auth";
import { accountSchemaStatements } from "../db/schema";
import { nicheCategories } from "./niche";
import { headers as nextHeaders } from "next/headers";

export type D1StatementLike = {
  bind: (...values: unknown[]) => D1StatementLike;
  first: <T = Record<string, unknown>>() => Promise<T | null>;
  run: () => Promise<{ meta?: { changes?: number } }>;
};

export type D1Like = {
  prepare: (query: string) => D1StatementLike;
  batch?: (statements: D1StatementLike[]) => Promise<Array<{ meta?: { changes?: number } }>>;
};

export type AccountUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  authMethod: "chatgpt" | "mobile" | "first-party";
  sessionId?: string;
};

const MAX_JSON_BODY_BYTES = 32 * 1024;
const MAX_TAGS = 24;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,160}$/;
export const webSessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
export const authVerificationLifetimeMs = 10 * 60 * 1000;
export const authVerificationResendMs = 60 * 1000;
export const authMobileCodeLifetimeMs = 3 * 60 * 1000;
export const authCookieName = "__Host-wp_session";

export async function database(): Promise<D1Like | null> {
  try {
    const runtime = await import("cloudflare:workers");
    return (runtime.env as unknown as { DB?: D1Like }).DB ?? null;
  } catch {
    return null;
  }
}

export async function ensureAccountSchema(db: D1Like) {
  for (const statement of accountSchemaStatements) {
    await db.prepare(statement).run();
  }
}

export function jsonResponse(payload: unknown, status = 200, extraHeaders?: Record<string, string>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

export async function readJsonBody<T>(request: Request): Promise<T | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export function normalizedTags(value: unknown): { tags: string[]; error?: string } {
  if (!Array.isArray(value)) return { tags: [], error: "tags must be an array" };
  const validIds = new Set<string>();
  // Keep the catalog import server-side and validate against the generated snapshot.
  // This prevents arbitrary strings from becoming durable account state.
  for (const category of nicheCatalog()) validIds.add(category);
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string" || !validIds.has(tag)) return { tags: [], error: "tags contains an unknown category" };
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) return { tags: [], error: `choose no more than ${MAX_TAGS} categories` };
  return { tags };
}

function nicheCatalog() {
  // Importing JSON through the typed module keeps this helper compatible with
  // both the Node test runtime and the Cloudflare-compatible build.
  // The import is hoisted by the bundler; this function only hides the shape.
  return nicheCategoryIds;
}

const nicheCategoryIds = nicheCategories.map((category) => category.id);

export function parseStoredTags(value: unknown) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return normalizedTags(parsed).tags;
  } catch {
    return [];
  }
}

export function sameOriginRequest(request: Request) {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === expectedOrigin;
  const referer = request.headers.get("referer");
  if (referer) {
    try { return new URL(referer).origin === expectedOrigin; } catch { return false; }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export async function getAuthenticatedUser(request: Request): Promise<AccountUser | null> {
  const cookieUser = await getCookieUser(request);
  if (cookieUser) return cookieUser;
  const mobileUser = await getMobileUser(request);
  if (mobileUser) return mobileUser;
  const chatUser = await getChatGPTUser();
  if (chatUser) return { ...chatUser, authMethod: "chatgpt" };
  return null;
}

export async function getServerAuthenticatedUser(): Promise<AccountUser | null> {
  const requestHeaders = await nextHeaders();
  return getAuthenticatedUser(new Request("https://whatspopular.local/", { headers: requestHeaders }));
}

async function getCookieUser(request: Request): Promise<AccountUser | null> {
  const token = cookieValue(request.headers.get("cookie"), authCookieName);
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  return tokenUser(token, "first-party");
}

export async function getMobileUser(request: Request): Promise<AccountUser | null> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  const token = match?.[1] ?? "";
  if (!TOKEN_PATTERN.test(token)) return null;
  return tokenUser(token, "mobile");
}

async function tokenUser(token: string, authMethod: "mobile" | "first-party") {
  const db = await database();
  if (!db) return null;
  try {
    await ensureAccountSchema(db);
    const tokenHash = await sha256(token);
    const now = new Date().toISOString();
    const row = await db.prepare(`
      SELECT s.session_id, s.user_id,
        COALESCE(p.email, u.email, '') AS email,
        COALESCE(p.display_name, u.username, 'what’s popular? member') AS display_name
      FROM mobile_sessions s
      LEFT JOIN user_profiles p ON p.user_id = s.user_id
      LEFT JOIN auth_users u ON u.user_id = s.user_id
      WHERE s.access_token_hash = ?1
        AND s.revoked_at IS NULL
        AND s.access_expires_at > ?2
    `).bind(tokenHash, now).first<{ session_id?: string; user_id?: string; email?: string; display_name?: string }>();
    if (!row?.session_id || !row.user_id) return null;
    return {
      userId: row.user_id,
      email: row.email ?? "",
      displayName: row.display_name ?? "what’s popular? member",
      fullName: null,
      authMethod,
      sessionId: row.session_id,
    };
  } catch {
    return null;
  }
}

export function cookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return "";
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function randomPairingCode(length = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const result: string[] = [];
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  while (result.length < length) {
    const bytes = new Uint8Array(length - result.length + 4);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= max) continue;
      result.push(alphabet[byte % alphabet.length]);
      if (result.length === length) break;
    }
  }
  return result.join("");
}

export async function upsertProfileIdentity(db: D1Like, user: Pick<AccountUser, "userId" | "email" | "displayName">) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO user_profiles (user_id, email, display_name, selected_tags_json, created_at, updated_at)
    VALUES (?1, ?2, ?3, '[]', ?4, ?4)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name
  `).bind(user.userId, user.email, user.displayName, now).run();
}

export async function createSession(db: D1Like, userId: string, client: "web" | "mobile") {
  const now = new Date();
  const nowIso = now.toISOString();
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const accessLifetime = client === "web" ? webSessionLifetimeMs : mobileAccessLifetimeMs;
  const accessExpiresAt = new Date(now.getTime() + accessLifetime).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + mobileRefreshLifetimeMs).toISOString();
  const sessionId = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO mobile_sessions
      (session_id, user_id, access_token_hash, refresh_token_hash, created_at, last_seen_at, access_expires_at, refresh_expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)
  `).bind(
    sessionId,
    userId,
    await sha256(accessToken),
    await sha256(refreshToken),
    nowIso,
    accessExpiresAt,
    refreshExpiresAt,
  ).run();
  return { sessionId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

export function sessionCookie(token: string, maxAgeSeconds = Math.floor(webSessionLifetimeMs / 1000)) {
  return `${authCookieName}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
  return `${authCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function safeReturnPath(value: unknown, fallback = "/for-you") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const parsed = new URL(value, "https://whatspopular.local");
    if (parsed.origin !== "https://whatspopular.local" || parsed.pathname.startsWith("/api/")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export async function clientAddressHash(request: Request, prefix: string) {
  const address = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  return sha256(`${prefix}:${address}`);
}

export async function profileForUser(db: D1Like, user: Pick<AccountUser, "userId" | "email" | "displayName">) {
  const row = await db.prepare(`
    SELECT email, display_name, selected_tags_json, updated_at
    FROM user_profiles
    WHERE user_id = ?1
  `).bind(user.userId).first<{ email?: string; display_name?: string; selected_tags_json?: string; updated_at?: string }>();
  return {
    hasProfile: Boolean(row),
    tags: parseStoredTags(row?.selected_tags_json),
    email: row?.email ?? user.email,
    displayName: row?.display_name ?? user.displayName,
    updatedAt: row?.updated_at ?? null,
  };
}

export function changesFrom(result: { meta?: { changes?: number } } | null | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

export const mobileAccessLifetimeMs = 15 * 60 * 1000;
export const mobileRefreshLifetimeMs = 60 * 24 * 60 * 60 * 1000;
