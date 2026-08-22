import {
  authCookieName,
  authMobileCodeLifetimeMs,
  authVerificationLifetimeMs,
  authVerificationResendMs,
  changesFrom,
  clientAddressHash,
  cookieValue,
  createSession,
  database,
  ensureAccountSchema,
  getAuthenticatedUser,
  jsonResponse,
  parseStoredTags,
  profileForUser,
  randomToken,
  safeReturnPath,
  sameOriginRequest,
  sessionCookie,
  sha256,
  upsertProfileIdentity,
  type D1Like,
} from "./account-server";
import { hashCode, hashPassword, randomDigits, randomVerifier, verifyPassword } from "./auth-crypto";
import { sendVerificationEmail, VerificationEmailError } from "./auth-email";

export { readJsonBody } from "./account-server";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/u;
const CODE_PATTERN = /^\d{6}$/u;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_VERIFICATION_STARTS_PER_HOUR = 12;
const oauthStateCookieName = "__Host-wp_oauth_state";
const dummyPasswordRecordPromise = hashPassword("not-a-real-whatspopular-password");

type RuntimeEnvironment = Record<string, unknown>;

export type AuthClient = "web" | "mobile";

type AuthUserRow = {
  user_id?: string;
  username?: string;
  email?: string;
  password_hash?: string;
  password_salt?: string;
  password_iterations?: number;
  email_verified?: number;
  google_subject?: string | null;
};

export type AuthSessionResponse = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  profile: ReturnType<typeof profileForUser> extends Promise<infer Profile> ? Profile : never;
};

export async function runtimeEnvironment(): Promise<RuntimeEnvironment> {
  try {
    const runtime = await import("cloudflare:workers");
    return (runtime.env ?? {}) as RuntimeEnvironment;
  } catch {
    return {};
  }
}

function configuredString(environment: RuntimeEnvironment, key: string) {
  const value = environment[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function authProviderStatus() {
  const environment = await runtimeEnvironment();
  const emailApiKey = configuredString(environment, "AUTH_EMAIL_API_KEY") || configuredString(environment, "RESEND_API_KEY");
  const emailFrom = configuredString(environment, "AUTH_EMAIL_FROM") || configuredString(environment, "RESEND_FROM");
  const emailEndpoint = configuredString(environment, "AUTH_EMAIL_API_URL") || (emailApiKey && emailFrom ? "configured" : "");
  return {
    emailVerificationConfigured: Boolean(emailApiKey && emailFrom && emailEndpoint),
    googleConfigured: Boolean(configuredString(environment, "GOOGLE_CLIENT_ID") && configuredString(environment, "GOOGLE_CLIENT_SECRET")),
  };
}

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL_PATTERN.test(email) ? email : "";
}

export function normalizeUsername(value: unknown) {
  if (typeof value !== "string") return "";
  const username = value.trim();
  return USERNAME_PATTERN.test(username) ? username : "";
}

export function normalizeDisplayName(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const displayName = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return displayName || fallback;
}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function authClient(value: unknown): AuthClient {
  return value === "mobile" ? "mobile" : "web";
}

export function browserMutationAllowed(request: Request) {
  const hasBrowserSignal = Boolean(request.headers.get("origin") || request.headers.get("referer") || request.headers.get("sec-fetch-site"));
  return !hasBrowserSignal || sameOriginRequest(request);
}

export function authError(message: string, status = 400, retryAfter?: number) {
  return jsonResponse({ error: message }, status, retryAfter ? { "Retry-After": String(retryAfter) } : undefined);
}

export async function startEmailSignup(request: Request, payload: Record<string, unknown>) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  const email = normalizeEmail(payload.email);
  const username = normalizeUsername(payload.username);
  const displayName = normalizeDisplayName(payload.displayName, username);
  const password = payload.password;
  const client = authClient(payload.client);
  if (!email) return authError("Enter a valid email address.", 422);
  if (!username) return authError("Username must be 3–24 letters, numbers, or underscores.", 422);
  if (!validPassword(password)) return authError("Use a password with 12–128 characters.", 422);

  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const now = new Date();
    const nowIso = now.toISOString();
    const ipHash = await clientAddressHash(request, "whatspopular-auth");
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const recentFromIp = await db.prepare("SELECT COUNT(*) AS count FROM auth_verification_challenges WHERE ip_hash = ?1 AND created_at > ?2").bind(ipHash, hourAgo).first<{ count?: number | string }>();
    if (Number(recentFromIp?.count ?? 0) >= MAX_VERIFICATION_STARTS_PER_HOUR) {
      return authError("Too many verification requests. Try again later.", 429, 3600);
    }
    const existing = await db.prepare(`
      SELECT user_id, email, username
      FROM auth_users
      WHERE email = ?1 COLLATE NOCASE OR username = ?2 COLLATE NOCASE
      LIMIT 1
    `).bind(email, username).first<{ user_id?: string; email?: string; username?: string }>();
    if (existing?.user_id) return authError("That email or username is already in use. Try signing in instead.", 409);

    const recent = await db.prepare(`
      SELECT next_send_at
      FROM auth_verification_challenges
      WHERE email = ?1 COLLATE NOCASE AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(email).first<{ next_send_at?: string }>();
    if (recent?.next_send_at && recent.next_send_at > nowIso) {
      const retryAfter = Math.max(1, Math.ceil((Date.parse(recent.next_send_at) - now.getTime()) / 1000));
      return authError("A verification code was already sent. Check your email or wait before requesting another.", 429, retryAfter);
    }

    const passwordRecord = await hashPassword(password);
    const code = randomDigits(6);
    const codeSalt = randomToken(16);
    const challengeId = randomToken(18);
    const expiresAt = new Date(now.getTime() + authVerificationLifetimeMs).toISOString();
    const nextSendAt = new Date(now.getTime() + authVerificationResendMs).toISOString();
    await db.prepare("UPDATE auth_verification_challenges SET status = 'replaced' WHERE email = ?1 COLLATE NOCASE AND status = 'pending'").bind(email).run();
    await db.prepare(`
      INSERT INTO auth_verification_challenges
        (challenge_id, email, username, display_name, password_hash, password_salt, password_iterations, code_hash, code_salt, created_at, expires_at, next_send_at, ip_hash, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'pending')
    `).bind(
      challengeId,
      email,
      username,
      displayName,
      passwordRecord.hash,
      passwordRecord.salt,
      passwordRecord.iterations,
      await hashCode(code, codeSalt),
      codeSalt,
      nowIso,
      expiresAt,
      nextSendAt,
      ipHash,
    ).run();

    try {
      await sendVerificationEmail(email, code, displayName);
    } catch (error) {
      await db.prepare("UPDATE auth_verification_challenges SET status = 'delivery_failed' WHERE challenge_id = ?1 AND status = 'pending'").bind(challengeId).run();
      if (error instanceof VerificationEmailError && error.code === "not_configured") {
        return authError("Email verification is not configured on this site yet.", 503);
      }
      return authError("We could not send that verification email. Try again shortly.", 503);
    }
    return jsonResponse({ pending: true, email, expiresAt, client });
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

export async function verifyEmailSignup(request: Request, payload: Record<string, unknown>) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  const email = normalizeEmail(payload.email);
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  const client = authClient(payload.client);
  if (!email || !CODE_PATTERN.test(code)) return authError("Enter the six-digit verification code.", 422);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const nowIso = new Date().toISOString();
    const challenge = await db.prepare(`
      SELECT challenge_id, email, username, display_name, password_hash, password_salt, password_iterations, code_hash, code_salt, attempt_count, expires_at
      FROM auth_verification_challenges
      WHERE email = ?1 COLLATE NOCASE AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(email).first<{
      challenge_id?: string; email?: string; username?: string; display_name?: string;
      password_hash?: string; password_salt?: string; password_iterations?: number;
      code_hash?: string; code_salt?: string; attempt_count?: number; expires_at?: string;
    }>();
    if (!challenge?.challenge_id || !challenge.code_hash || !challenge.code_salt || !challenge.expires_at || challenge.expires_at <= nowIso || Number(challenge.attempt_count ?? 0) >= 5) {
      if (challenge?.challenge_id) await db.prepare("UPDATE auth_verification_challenges SET status = 'expired' WHERE challenge_id = ?1 AND status = 'pending'").bind(challenge.challenge_id).run();
      return authError("That code is invalid or expired. Request a new one.", 410);
    }
    if (await hashCode(code, challenge.code_salt) !== challenge.code_hash) {
      const attempts = Number(challenge.attempt_count ?? 0) + 1;
      await db.prepare("UPDATE auth_verification_challenges SET attempt_count = ?1, status = CASE WHEN ?1 >= 5 THEN 'expired' ELSE status END WHERE challenge_id = ?2 AND status = 'pending'").bind(attempts, challenge.challenge_id).run();
      return authError("That code is invalid or expired. Try again.", 400);
    }

    const userId = `usr_${randomToken(18)}`;
    const createdAt = new Date().toISOString();
    try {
      await db.prepare(`
        INSERT INTO auth_users
          (user_id, username, email, password_hash, password_salt, password_iterations, email_verified, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
      `).bind(
        userId,
        challenge.username,
        challenge.email,
        challenge.password_hash,
        challenge.password_salt,
        challenge.password_iterations,
        createdAt,
      ).run();
    } catch {
      return authError("That email or username is already in use. Try signing in instead.", 409);
    }
    await upsertProfileIdentity(db, {
      userId,
      email: challenge.email ?? email,
      displayName: challenge.display_name ?? challenge.username ?? "what’s popular? member",
    });
    const claimed = await db.prepare("UPDATE auth_verification_challenges SET status = 'used' WHERE challenge_id = ?1 AND status = 'pending'").bind(challenge.challenge_id).run();
    if (changesFrom(claimed) !== 1) return authError("That code was already used. Try signing in.", 409);
    return issueSession(db, userId, client);
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

export async function loginWithPassword(request: Request, payload: Record<string, unknown>) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  const identifier = typeof payload.identifier === "string" ? payload.identifier.trim() : "";
  const lookup = identifier.includes("@") ? normalizeEmail(identifier) : normalizeUsername(identifier);
  const password = payload.password;
  const client = authClient(payload.client);
  if (!lookup || !validPassword(password)) return authError("Enter your username or email and password.", 422);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  const ipHash = await clientAddressHash(request, "whatspopular-login");
  const identifierHash = await sha256(lookup);
  const limitKeys = [ipHash, `${ipHash}:${identifierHash}`];
  try {
    await ensureAccountSchema(db);
    for (const key of limitKeys) {
      const limited = await loginLimit(db, key);
      if (!limited.allowed) return authError("Too many sign-in attempts. Try again later.", 429, limited.retryAfter);
    }
    const user = await db.prepare(`
      SELECT user_id, username, email, password_hash, password_salt, password_iterations, email_verified
      FROM auth_users
      WHERE email = ?1 COLLATE NOCASE OR username = ?1 COLLATE NOCASE
      LIMIT 1
    `).bind(lookup).first<AuthUserRow>();
    const passwordMatches = user?.password_hash && user.password_salt && user.password_iterations
      ? await verifyPassword(password, user.password_hash, user.password_salt, Number(user.password_iterations))
      : await (async () => {
        const dummy = await dummyPasswordRecordPromise;
        await verifyPassword(password, dummy.hash, dummy.salt, dummy.iterations);
        return false;
      })();
    if (!passwordMatches || !user?.user_id) {
      await Promise.all(limitKeys.map((key) => incrementLoginLimit(db, key)));
      return authError("That sign-in did not match an account.", 401);
    }
    if (Number(user.email_verified ?? 0) !== 1) return authError("Verify your email before signing in.", 403);
    await Promise.all(limitKeys.map((key) => clearLoginLimit(db, key)));
    await db.prepare("UPDATE auth_users SET last_login_at = ?1, updated_at = ?1 WHERE user_id = ?2").bind(new Date().toISOString(), user.user_id).run();
    return issueSession(db, user.user_id, client);
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

async function issueSession(db: D1Like, userId: string, client: AuthClient) {
  const session = await createSession(db, userId, client);
  const profile = await profileForUser(db, {
    userId,
    email: "",
    displayName: "what’s popular? member",
  });
  return jsonResponse({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
    profile: { ...profile, tags: parseStoredTags(JSON.stringify(profile.tags)) },
  }, 200, client === "web" ? { "Set-Cookie": sessionCookie(session.accessToken) } : undefined);
}

async function identityForUser(db: D1Like, user: Awaited<ReturnType<typeof getAuthenticatedUser>>) {
  if (!user) return null;
  const profile = await profileForUser(db, user);
  const row = await db.prepare(`
    SELECT username, email, email_verified
    FROM auth_users
    WHERE user_id = ?1
  `).bind(user.userId).first<AuthUserRow>();
  return {
    username: row?.username ?? profile.username,
    email: row?.email ?? profile.email,
    emailVerified: Number(row?.email_verified ?? 0) === 1,
    displayName: profile.displayName,
    updatedAt: profile.updatedAt,
    authMethod: user.authMethod,
    canEditIdentity: Boolean(row?.username) && user.authMethod !== "chatgpt",
  };
}

export async function accountIdentity(request: Request) {
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const identity = await identityForUser(db, user);
    return jsonResponse(identity ? { ...identity, storage: "d1" } : { error: "Account not found" }, identity ? 200 : 404);
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

export async function updateAccountIdentity(request: Request, payload: Record<string, unknown>) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  if (user.authMethod === "chatgpt") return authError("This account identity is managed by the sign-in provider.", 400);
  const username = normalizeUsername(payload.username);
  if (!username) return authError("Username must be 3–24 letters, numbers, or underscores.", 422);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const existing = await db.prepare("SELECT user_id, username FROM auth_users WHERE user_id = ?1 LIMIT 1").bind(user.userId).first<AuthUserRow>();
    if (!existing?.user_id) return authError("This account does not support editable identity settings.", 400);
    const conflict = await db.prepare("SELECT user_id FROM auth_users WHERE username = ?1 COLLATE NOCASE AND user_id != ?2 LIMIT 1").bind(username, user.userId).first<{ user_id?: string }>();
    if (conflict?.user_id) return authError("That username is already in use.", 409);
    await db.prepare("UPDATE auth_users SET username = ?1, updated_at = ?2 WHERE user_id = ?3").bind(username, new Date().toISOString(), user.userId).run();
    const identity = await identityForUser(db, user);
    return jsonResponse(identity ? { ...identity, storage: "d1" } : { error: "Account not found" });
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return authError("That username is already in use.", 409);
    return authError("Account storage unavailable", 503);
  }
}

export async function startEmailChange(request: Request, payload: Record<string, unknown>) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  if (user.authMethod === "chatgpt") return authError("This account identity is managed by the sign-in provider.", 400);
  const email = normalizeEmail(payload.email);
  if (!email) return authError("Enter a valid new email address.", 422);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const account = await db.prepare("SELECT user_id, email FROM auth_users WHERE user_id = ?1 LIMIT 1").bind(user.userId).first<AuthUserRow>();
    if (!account?.user_id || !account.email) return authError("This account does not support editable email settings.", 400);
    if (email === account.email.toLowerCase()) return authError("Enter a different email address.", 422);
    const taken = await db.prepare("SELECT user_id FROM auth_users WHERE email = ?1 COLLATE NOCASE LIMIT 1").bind(email).first<{ user_id?: string }>();
    if (taken?.user_id && taken.user_id !== user.userId) return authError("That email is already in use.", 409);

    const now = new Date();
    const nowIso = now.toISOString();
    const ipHash = await clientAddressHash(request, "whatspopular-email-change");
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const recentFromIp = await db.prepare("SELECT COUNT(*) AS count FROM auth_email_change_challenges WHERE ip_hash = ?1 AND created_at > ?2").bind(ipHash, hourAgo).first<{ count?: number | string }>();
    if (Number(recentFromIp?.count ?? 0) >= MAX_VERIFICATION_STARTS_PER_HOUR) return authError("Too many verification requests. Try again later.", 429, 3600);
    const recent = await db.prepare(`
      SELECT next_send_at
      FROM auth_email_change_challenges
      WHERE user_id = ?1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(user.userId).first<{ next_send_at?: string }>();
    if (recent?.next_send_at && recent.next_send_at > nowIso) {
      return authError("A verification code was already sent. Check that email or wait before requesting another.", 429, Math.max(1, Math.ceil((Date.parse(recent.next_send_at) - now.getTime()) / 1000)));
    }

    const code = randomDigits(6);
    const codeSalt = randomToken(16);
    const challengeId = randomToken(18);
    const expiresAt = new Date(now.getTime() + authVerificationLifetimeMs).toISOString();
    const nextSendAt = new Date(now.getTime() + authVerificationResendMs).toISOString();
    await db.prepare("UPDATE auth_email_change_challenges SET status = 'replaced' WHERE user_id = ?1 AND status = 'pending'").bind(user.userId).run();
    await db.prepare(`
      INSERT INTO auth_email_change_challenges
        (challenge_id, user_id, new_email, code_hash, code_salt, created_at, expires_at, next_send_at, ip_hash, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending')
    `).bind(challengeId, user.userId, email, await hashCode(code, codeSalt), codeSalt, nowIso, expiresAt, nextSendAt, ipHash).run();
    try {
      const profile = await profileForUser(db, user);
      await sendVerificationEmail(email, code, profile.displayName, "change_email");
    } catch (error) {
      await db.prepare("UPDATE auth_email_change_challenges SET status = 'delivery_failed' WHERE challenge_id = ?1 AND status = 'pending'").bind(challengeId).run();
      if (error instanceof VerificationEmailError && error.code === "not_configured") return authError("Email verification is not configured on this site yet.", 503);
      return authError("We could not send that verification email. Try again shortly.", 503);
    }
    return jsonResponse({ pending: true, email, expiresAt });
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

export async function verifyEmailChange(request: Request, payload: Record<string, unknown>) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: "Sign in required" }, 401);
  if (user.authMethod === "chatgpt") return authError("This account identity is managed by the sign-in provider.", 400);
  const code = typeof payload.code === "string" ? payload.code.trim() : "";
  if (!CODE_PATTERN.test(code)) return authError("Enter the six-digit verification code.", 422);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const nowIso = new Date().toISOString();
    const challenge = await db.prepare(`
      SELECT challenge_id, user_id, new_email, code_hash, code_salt, attempt_count, expires_at
      FROM auth_email_change_challenges
      WHERE user_id = ?1 AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).bind(user.userId).first<{ challenge_id?: string; user_id?: string; new_email?: string; code_hash?: string; code_salt?: string; attempt_count?: number; expires_at?: string }>();
    if (!challenge?.challenge_id || !challenge.new_email || !challenge.code_hash || !challenge.code_salt || !challenge.expires_at || challenge.expires_at <= nowIso || Number(challenge.attempt_count ?? 0) >= 5) {
      if (challenge?.challenge_id) await db.prepare("UPDATE auth_email_change_challenges SET status = 'expired' WHERE challenge_id = ?1 AND status = 'pending'").bind(challenge.challenge_id).run();
      return authError("That code is invalid or expired. Request a new one.", 410);
    }
    if (await hashCode(code, challenge.code_salt) !== challenge.code_hash) {
      const attempts = Number(challenge.attempt_count ?? 0) + 1;
      await db.prepare("UPDATE auth_email_change_challenges SET attempt_count = ?1, status = CASE WHEN ?1 >= 5 THEN 'expired' ELSE status END WHERE challenge_id = ?2 AND status = 'pending'").bind(attempts, challenge.challenge_id).run();
      return authError("That code is invalid or expired. Try again.", 400);
    }
    const taken = await db.prepare("SELECT user_id FROM auth_users WHERE email = ?1 COLLATE NOCASE AND user_id != ?2 LIMIT 1").bind(challenge.new_email, user.userId).first<{ user_id?: string }>();
    if (taken?.user_id) {
      await db.prepare("UPDATE auth_email_change_challenges SET status = 'replaced' WHERE challenge_id = ?1 AND status = 'pending'").bind(challenge.challenge_id).run();
      return authError("That email is already in use.", 409);
    }
    const claimed = await db.prepare("UPDATE auth_email_change_challenges SET status = 'used' WHERE challenge_id = ?1 AND status = 'pending' AND expires_at > ?2").bind(challenge.challenge_id, nowIso).run();
    if (changesFrom(claimed) !== 1) return authError("That code was already used. Request a new one.", 409);
    const updatedAt = new Date().toISOString();
    try {
      const updated = await db.prepare("UPDATE auth_users SET email = ?1, email_verified = 1, updated_at = ?2 WHERE user_id = ?3").bind(challenge.new_email, updatedAt, user.userId).run();
      if (changesFrom(updated) !== 1) return authError("Account email could not be updated.", 409);
      await db.prepare("UPDATE user_profiles SET email = ?1, updated_at = ?2 WHERE user_id = ?3").bind(challenge.new_email, updatedAt, user.userId).run();
    } catch (error) {
      if (String(error).toLowerCase().includes("unique")) return authError("That email is already in use.", 409);
      throw error;
    }
    const identity = await identityForUser(db, user);
    return jsonResponse(identity ? { ...identity, storage: "d1" } : { error: "Account not found" });
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

async function loginLimit(db: D1Like, key: string) {
  const row = await db.prepare("SELECT attempt_count, blocked_until, window_started_at FROM auth_login_limits WHERE bucket_key = ?1").bind(key).first<{ attempt_count?: number; blocked_until?: string | null; window_started_at?: string }>();
  const now = Date.now();
  const blockedUntil = row?.blocked_until ? Date.parse(row.blocked_until) : 0;
  if (blockedUntil > now) return { allowed: false, retryAfter: Math.ceil((blockedUntil - now) / 1000) };
  return { allowed: true, retryAfter: 0 };
}

async function incrementLoginLimit(db: D1Like, key: string) {
  const now = new Date();
  const nowIso = now.toISOString();
  const row = await db.prepare("SELECT attempt_count, window_started_at FROM auth_login_limits WHERE bucket_key = ?1").bind(key).first<{ attempt_count?: number; window_started_at?: string }>();
  const windowStart = row?.window_started_at && Date.parse(row.window_started_at) + LOGIN_WINDOW_MS > now.getTime() ? row.window_started_at : nowIso;
  const attempts = windowStart === row?.window_started_at ? Number(row?.attempt_count ?? 0) + 1 : 1;
  const blockedUntil = attempts >= MAX_LOGIN_ATTEMPTS ? new Date(now.getTime() + LOGIN_BLOCK_MS).toISOString() : null;
  await db.prepare(`
    INSERT INTO auth_login_limits (bucket_key, attempt_count, window_started_at, blocked_until, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(bucket_key) DO UPDATE SET attempt_count = excluded.attempt_count, window_started_at = excluded.window_started_at, blocked_until = excluded.blocked_until, updated_at = excluded.updated_at
  `).bind(key, attempts, windowStart, blockedUntil, nowIso).run();
}

async function clearLoginLimit(db: D1Like, key: string) {
  await db.prepare("DELETE FROM auth_login_limits WHERE bucket_key = ?1").bind(key).run();
}

export async function googleConfig(request: Request) {
  const environment = await runtimeEnvironment();
  const clientId = configuredString(environment, "GOOGLE_CLIENT_ID");
  const clientSecret = configuredString(environment, "GOOGLE_CLIENT_SECRET");
  const redirectUri = configuredString(environment, "GOOGLE_REDIRECT_URI") || `${new URL(request.url).origin}/api/auth/google/callback`;
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
}

export async function startGoogle(request: Request) {
  const config = await googleConfig(request);
  if (!config) return authError("Google sign-in is not configured on this site yet.", 503);
  const url = new URL(request.url);
  const client: AuthClient = url.searchParams.get("client") === "mobile" ? "mobile" : "web";
  const returnTo = client === "mobile" ? "whatspopular://auth" : safeReturnPath(url.searchParams.get("return_to"));
  const state = randomToken(32);
  const verifier = randomVerifier(32);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const now = new Date();
    await db.prepare("DELETE FROM auth_oauth_states WHERE expires_at <= ?1 OR used_at IS NOT NULL").bind(now.toISOString()).run();
    await db.prepare(`
      INSERT INTO auth_oauth_states (state_hash, code_verifier, return_to, client, created_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).bind(
      await sha256(state),
      verifier,
      returnTo,
      client,
      now.toISOString(),
      new Date(now.getTime() + OAUTH_STATE_LIFETIME_MS).toISOString(),
    ).run();
    const query = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: await sha256(verifier),
      code_challenge_method: "S256",
      access_type: "online",
      prompt: "select_account",
    });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`,
        "Set-Cookie": `${oauthStateCookieName}=${state}; Path=/; Max-Age=${Math.floor(OAUTH_STATE_LIFETIME_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

export async function completeGoogle(request: Request, code: string, state: string) {
  const config = await googleConfig(request);
  if (!config || !code || !state) return authError("Google sign-in could not be completed.", 400);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const nowIso = new Date().toISOString();
    const stateRow = await db.prepare(`
      SELECT state_hash, code_verifier, return_to, client, expires_at
      FROM auth_oauth_states
      WHERE state_hash = ?1 AND used_at IS NULL AND expires_at > ?2
    `).bind(await sha256(state), nowIso).first<{ state_hash?: string; code_verifier?: string; return_to?: string; client?: string; expires_at?: string }>();
    if (!stateRow?.state_hash || !stateRow.code_verifier || !stateRow.return_to || !stateRow.client) return authError("Google sign-in expired. Try again.", 400);
    const stateCookie = cookieValue(request.headers.get("cookie"), oauthStateCookieName);
    if (stateRow.client === "web" && stateCookie !== state) return authError("Google sign-in could not be verified. Try again.", 400);
    const claimed = await db.prepare("UPDATE auth_oauth_states SET used_at = ?1 WHERE state_hash = ?2 AND used_at IS NULL AND expires_at > ?1").bind(nowIso, stateRow.state_hash).run();
    if (changesFrom(claimed) !== 1) return authError("Google sign-in was already used. Try again.", 400);

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
        code_verifier: stateRow.code_verifier,
      }),
    });
    if (!tokenResponse.ok) return authError("Google sign-in could not be completed.", 400);
    const tokenPayload = await tokenResponse.json() as { access_token?: unknown };
    if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) return authError("Google sign-in could not be completed.", 400);
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { accept: "application/json", authorization: `Bearer ${tokenPayload.access_token}` },
    });
    if (!profileResponse.ok) return authError("Google sign-in could not be completed.", 400);
    const googleUser = await profileResponse.json() as { sub?: unknown; email?: unknown; email_verified?: unknown; name?: unknown };
    const email = normalizeEmail(googleUser.email);
    const subject = typeof googleUser.sub === "string" ? googleUser.sub.trim() : "";
    if (!email || !subject || googleUser.email_verified !== true) return authError("Google did not return a verified email address.", 400);
    const userId = await upsertGoogleUser(db, subject, email, normalizeDisplayName(googleUser.name, email.split("@")[0]));
    if (stateRow.client === "mobile") {
      const exchangeCode = randomToken(32);
      const exchangeNow = new Date();
      await db.prepare("DELETE FROM auth_mobile_codes WHERE expires_at <= ?1 OR used_at IS NOT NULL").bind(exchangeNow.toISOString()).run();
      await db.prepare("INSERT INTO auth_mobile_codes (code_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(
        await sha256(exchangeCode),
        userId,
        exchangeNow.toISOString(),
        new Date(exchangeNow.getTime() + authMobileCodeLifetimeMs).toISOString(),
      ).run();
      const headers = new Headers({ Location: `${stateRow.return_to}?code=${encodeURIComponent(exchangeCode)}` });
      headers.append("Set-Cookie", clearOAuthStateCookie());
      return new Response(null, { status: 302, headers });
    }
    const session = await createSession(db, userId, "web");
    const returnUrl = new URL(stateRow.return_to, new URL(request.url).origin);
    const headers = new Headers({ Location: returnUrl.href });
    headers.append("Set-Cookie", sessionCookie(session.accessToken));
    headers.append("Set-Cookie", clearOAuthStateCookie());
    return new Response(null, { status: 302, headers });
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

function clearOAuthStateCookie() {
  return `${oauthStateCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function upsertGoogleUser(db: D1Like, subject: string, email: string, displayName: string) {
  const bySubject = await db.prepare("SELECT user_id, email, username, google_subject, email_verified FROM auth_users WHERE google_subject = ?1 LIMIT 1").bind(subject).first<AuthUserRow>();
  let userId = bySubject?.user_id;
  if (!userId) {
    const byEmail = await db.prepare("SELECT user_id, email, username, google_subject, email_verified FROM auth_users WHERE email = ?1 COLLATE NOCASE LIMIT 1").bind(email).first<AuthUserRow>();
    if (byEmail?.user_id) {
      if (byEmail.google_subject && byEmail.google_subject !== subject) throw new Error("Google identity is already linked to another account");
      if (Number(byEmail.email_verified ?? 0) !== 1) throw new Error("Email must be verified before linking Google");
      userId = byEmail.user_id;
      await db.prepare("UPDATE auth_users SET google_subject = ?1, updated_at = ?2 WHERE user_id = ?3 AND google_subject IS NULL").bind(subject, new Date().toISOString(), userId).run();
    }
  }
  if (!userId) {
    const username = await uniqueGoogleUsername(db, email.split("@")[0]);
    userId = `usr_${randomToken(18)}`;
    const now = new Date().toISOString();
    await db.prepare(`
      INSERT INTO auth_users (user_id, username, email, email_verified, google_subject, created_at, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
    `).bind(userId, username, email, subject, now).run();
  }
  const storedAccount = await db.prepare("SELECT email FROM auth_users WHERE user_id = ?1 LIMIT 1").bind(userId).first<{ email?: string }>();
  await upsertProfileIdentity(db, { userId, email: storedAccount?.email ?? email, displayName });
  await db.prepare("UPDATE auth_users SET last_login_at = ?1, updated_at = ?1 WHERE user_id = ?2").bind(new Date().toISOString(), userId).run();
  return userId;
}

async function uniqueGoogleUsername(db: D1Like, value: string) {
  const base = (value.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 18) || "member").padEnd(3, "x");
  for (let suffix = 0; suffix < 20; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base.slice(0, 19 - String(suffix).length)}_${suffix}`;
    const row = await db.prepare("SELECT user_id FROM auth_users WHERE username = ?1 COLLATE NOCASE LIMIT 1").bind(candidate).first<{ user_id?: string }>();
    if (!row?.user_id) return candidate;
  }
  return `member_${randomDigits(6)}`;
}

export async function exchangeGoogleMobile(request: Request, code: string) {
  if (!browserMutationAllowed(request)) return authError("Cross-site account requests are not allowed", 403);
  if (!/^[A-Za-z0-9_-]{40,80}$/u.test(code)) return authError("Invalid Google sign-in response.", 400);
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    const nowIso = new Date().toISOString();
    const row = await db.prepare("SELECT code_hash, user_id, expires_at FROM auth_mobile_codes WHERE code_hash = ?1 AND used_at IS NULL AND expires_at > ?2").bind(await sha256(code), nowIso).first<{ code_hash?: string; user_id?: string; expires_at?: string }>();
    if (!row?.code_hash || !row.user_id) return authError("Google sign-in expired. Try again.", 410);
    const claimed = await db.prepare("UPDATE auth_mobile_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1").bind(nowIso, row.code_hash).run();
    if (changesFrom(claimed) !== 1) return authError("Google sign-in was already used. Try again.", 409);
    return issueSession(db, row.user_id, "mobile");
  } catch {
    return authError("Account storage unavailable", 503);
  }
}

export async function authSession(request: Request) {
  const status = await authProviderStatus();
  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ signedIn: false, providers: status });
  return jsonResponse({
    signedIn: true,
    providers: status,
    user: { userId: user.userId, displayName: user.displayName, email: user.email, authMethod: user.authMethod },
  });
}

export async function revokeSession(request: Request) {
  if (!browserMutationAllowed(request)) return authError("Cross-site sign-out is not allowed", 403);
  const user = await getAuthenticatedUser(request);
  if (!user?.sessionId) return jsonResponse({ signedOut: true });
  const db = await database();
  if (!db) return authError("Account storage unavailable", 503);
  try {
    await ensureAccountSchema(db);
    await db.prepare("UPDATE mobile_sessions SET revoked_at = ?1 WHERE session_id = ?2 AND revoked_at IS NULL").bind(new Date().toISOString(), user.sessionId).run();
    const headers: Record<string, string> = {};
    if (user.authMethod === "first-party") headers["Set-Cookie"] = `${authCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
    return jsonResponse({ signedOut: true }, 200, headers);
  } catch {
    return authError("Account storage unavailable", 503);
  }
}
