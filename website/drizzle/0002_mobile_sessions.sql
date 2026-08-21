CREATE TABLE IF NOT EXISTS mobile_link_requests (
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
);

CREATE INDEX IF NOT EXISTS idx_mobile_link_requests_expiry
ON mobile_link_requests(expires_at);

CREATE INDEX IF NOT EXISTS idx_mobile_link_requests_ip_created
ON mobile_link_requests(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS mobile_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_access
ON mobile_sessions(access_token_hash, revoked_at, access_expires_at);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_refresh
ON mobile_sessions(refresh_token_hash, revoked_at, refresh_expires_at);
