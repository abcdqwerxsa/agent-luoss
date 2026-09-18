CREATE SCHEMA IF NOT EXISTS usage;

CREATE TABLE IF NOT EXISTS usage.usage_events (
  id           BIGSERIAL PRIMARY KEY,
  task_id      TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  provider     TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  ts           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage.usage_events(ts);

CREATE TABLE IF NOT EXISTS usage.usage_daily (
  day          DATE NOT NULL,
  user_id      TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  task_count   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id)
);

CREATE TABLE IF NOT EXISTS usage.quotas (
  user_id            TEXT PRIMARY KEY,
  monthly_limit_usd  DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS usage.audit_logs (
  id       BIGSERIAL PRIMARY KEY,
  actor    TEXT NOT NULL,          -- user id or "anonymous"
  action   TEXT NOT NULL,          -- e.g. auth.login, task.create, model.upsert
  resource TEXT NOT NULL DEFAULT '',
  detail   TEXT NOT NULL DEFAULT '{}',
  ip       TEXT NOT NULL DEFAULT '',
  ts       TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON usage.audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON usage.audit_logs(actor);
