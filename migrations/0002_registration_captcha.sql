CREATE TABLE IF NOT EXISTS registration_captchas (
  id TEXT PRIMARY KEY,
  answer_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_registration_captchas_expires_at
  ON registration_captchas(expires_at);
