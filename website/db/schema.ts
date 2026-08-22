export const accountSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    selected_tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_user_profiles_updated_at ON user_profiles(updated_at)",
  `CREATE TABLE IF NOT EXISTS mobile_link_requests (
    request_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    user_id TEXT,
    ip_hash TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_at TEXT,
    exchanged_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_mobile_link_requests_expiry ON mobile_link_requests(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_mobile_link_requests_ip_created ON mobile_link_requests(ip_hash, created_at)",
  `CREATE TABLE IF NOT EXISTS mobile_sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    access_token_hash TEXT NOT NULL UNIQUE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    access_expires_at TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    revoked_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_mobile_sessions_access ON mobile_sessions(access_token_hash, revoked_at, access_expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_mobile_sessions_refresh ON mobile_sessions(refresh_token_hash, revoked_at, refresh_expires_at)",
  `CREATE TABLE IF NOT EXISTS auth_users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    password_salt TEXT,
    password_iterations INTEGER,
    email_verified INTEGER NOT NULL DEFAULT 0,
    google_subject TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(email COLLATE NOCASE)",
  "CREATE INDEX IF NOT EXISTS idx_auth_users_google_subject ON auth_users(google_subject)",
  `CREATE TABLE IF NOT EXISTS auth_verification_challenges (
    challenge_id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    username TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    code_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    next_send_at TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  )`,
  "CREATE INDEX IF NOT EXISTS idx_auth_verification_email ON auth_verification_challenges(email, status, expires_at)",
  `CREATE TABLE IF NOT EXISTS auth_login_limits (
    bucket_key TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL,
    blocked_until TEXT,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_oauth_states (
    state_hash TEXT PRIMARY KEY,
    code_verifier TEXT NOT NULL,
    return_to TEXT NOT NULL,
    client TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS auth_mobile_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_auth_mobile_codes_expiry ON auth_mobile_codes(expires_at, used_at)",
];

export const userProfilesSchema = `${accountSchemaStatements.join(";\n")};\n`;
