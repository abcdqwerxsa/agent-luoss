CREATE SCHEMA IF NOT EXISTS task;

CREATE TABLE IF NOT EXISTS task.tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  mode          TEXT NOT NULL DEFAULT 'craft',    -- ask | craft | plan
  provider      TEXT NOT NULL DEFAULT '',
  model_id      TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | running | idle | failed | archived
  runtime_id    TEXT NOT NULL DEFAULT '',
  session_path  TEXT NOT NULL DEFAULT '',
  first_message TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON task.tasks(user_id, updated_at DESC);

ALTER TABLE task.tasks ADD COLUMN IF NOT EXISTS expert_id TEXT NOT NULL DEFAULT '';
