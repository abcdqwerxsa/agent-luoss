CREATE SCHEMA IF NOT EXISTS caps;

CREATE TABLE IF NOT EXISTS caps.mcp_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  transport  TEXT NOT NULL,              -- stdio | http | sse
  command    TEXT NOT NULL DEFAULT '',
  args       JSONB NOT NULL DEFAULT '[]',
  env        JSONB NOT NULL DEFAULT '{}',-- {k: encrypted-v}
  url        TEXT NOT NULL DEFAULT '',
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS caps.skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  path        TEXT NOT NULL,             -- on-disk dir under skills dir
  enabled     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shared assignment table: a cap with no scope rows is visible to everyone.
CREATE TABLE IF NOT EXISTS caps.cap_scopes (
  cap_type TEXT NOT NULL,                -- 'mcp' | 'skill'
  cap_id   TEXT NOT NULL,
  type     TEXT NOT NULL,                -- all | department | role
  value    TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (cap_type, cap_id, type, value)
);

-- Experts: named bundles of skills/MCP servers for quick-start ("doc-master").
CREATE TABLE IF NOT EXISTS caps.experts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS caps.expert_items (
  expert_id TEXT NOT NULL REFERENCES caps.experts(id) ON DELETE CASCADE,
  cap_type  TEXT NOT NULL,                -- 'skill' | 'mcp'
  cap_id    TEXT NOT NULL,
  PRIMARY KEY (expert_id, cap_type, cap_id)
);
