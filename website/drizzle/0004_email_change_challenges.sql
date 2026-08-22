CREATE TABLE IF NOT EXISTS auth_email_change_challenges (
  challenge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  new_email TEXT NOT NULL COLLATE NOCASE,
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  next_send_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_auth_email_change_user
  ON auth_email_change_challenges(user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_email_change_email
  ON auth_email_change_challenges(new_email, status, expires_at);
