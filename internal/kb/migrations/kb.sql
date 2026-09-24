CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS kb;

-- One KB per caps MCP entry: visibility is caps scope governance.
CREATE TABLE IF NOT EXISTS kb.kbs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope_type  TEXT NOT NULL DEFAULT 'all',   -- all | department | role
  scope_value TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- docs: raw upload + parse state machine (parsing -> ready | failed).
CREATE TABLE IF NOT EXISTS kb.docs (
  id         TEXT PRIMARY KEY,
  kb_id      TEXT NOT NULL,
  filename   TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',        -- filename minus extension
  size       BIGINT NOT NULL DEFAULT 0,
  uploader   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'parsing',
  error      TEXT NOT NULL DEFAULT '',
  raw        BYTEA NOT NULL DEFAULT '',        -- original upload (MinerU input)
  md_text    TEXT NOT NULL DEFAULT '',        -- parsed markdown (read_doc source)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_docs_kb ON kb.docs(kb_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_parsing ON kb.docs(status) WHERE status = 'parsing';

-- chunks: retrieval unit. embedding column arrives with the semantic phase.
CREATE TABLE IF NOT EXISTS kb.chunks (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id   TEXT NOT NULL,
  kb_id    TEXT NOT NULL,
  seq      INT NOT NULL,
  section  TEXT NOT NULL DEFAULT '',
  text     TEXT NOT NULL,
  tokens   INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON kb.chunks(doc_id, seq);
CREATE INDEX IF NOT EXISTS idx_chunks_trgm ON kb.chunks USING gin (text gin_trgm_ops);

-- Semantic layer: pgvector columns, installed only when the extension is
-- available (pgvector image). On vanilla postgres these no-op and kb stays
-- lexical-only — graceful degradation.
DO $$
BEGIN
	CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
	RAISE NOTICE 'pgvector unavailable: semantic search disabled';
END $$;
DO $$
BEGIN
	ALTER TABLE kb.chunks ADD COLUMN IF NOT EXISTS embedding vector;
	ALTER TABLE kb.chunks ADD COLUMN IF NOT EXISTS embed_model TEXT NOT NULL DEFAULT '';
EXCEPTION WHEN OTHERS THEN
	RAISE NOTICE 'vector columns skipped (no pgvector)';
END $$;
