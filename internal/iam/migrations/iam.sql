CREATE SCHEMA IF NOT EXISTS iam;

CREATE TABLE IF NOT EXISTS iam.users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member',   -- admin | member
  status        TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS iam.refresh_tokens (
  token_hash TEXT PRIMARY KEY,      -- sha256 of opaque token
  user_id    TEXT NOT NULL REFERENCES iam.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON iam.refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS iam.departments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE iam.users ADD COLUMN IF NOT EXISTS department_id TEXT REFERENCES iam.departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_department ON iam.users(department_id);
