CREATE SCHEMA IF NOT EXISTS modelmgt;

CREATE TABLE IF NOT EXISTS modelmgt.providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  api_type   TEXT NOT NULL DEFAULT 'openai-completions',
  api_key_enc TEXT NOT NULL DEFAULT '',   -- AES-GCM(master key)
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS modelmgt.models (
  provider_id   TEXT NOT NULL REFERENCES modelmgt.providers(id) ON DELETE CASCADE,
  model_id      TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  context_window BIGINT NOT NULL DEFAULT 128000,
  max_tokens    BIGINT NOT NULL DEFAULT 8192,
  input_cost    DOUBLE PRECISION NOT NULL DEFAULT 0,  -- USD per 1M tokens
  output_cost   DOUBLE PRECISION NOT NULL DEFAULT 0,
  reasoning     BOOLEAN NOT NULL DEFAULT false,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (provider_id, model_id)
);
