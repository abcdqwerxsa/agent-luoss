package modelmgt

import (
	"context"
	"embed"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var Migrations embed.FS

var ErrNotFound = errors.New("not found")

type Provider struct {
	ID       string
	Name     string
	BaseURL  string
	APIType  string
	APIKey   string // write-only; decrypted only for render
	Enabled  bool
}

type Model struct {
	ProviderID    string
	ModelID       string
	DisplayName   string
	ContextWindow int64
	MaxTokens     int64
	InputCost     float64
	OutputCost    float64
	Reasoning     bool
	Enabled       bool
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) UpsertProvider(ctx context.Context, p *Provider) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO modelmgt.providers (id, name, base_url, api_type, api_key_enc, enabled, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6, now())
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name, base_url = EXCLUDED.base_url, api_type = EXCLUDED.api_type,
			api_key_enc = COALESCE(NULLIF(EXCLUDED.api_key_enc,''), modelmgt.providers.api_key_enc),
			enabled = EXCLUDED.enabled, updated_at = now()`,
		p.ID, p.Name, p.BaseURL, p.APIType, p.APIKey, p.Enabled)
	return err
}

func (s *Store) DeleteProvider(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM modelmgt.providers WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListProviders(ctx context.Context) ([]*Provider, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name, base_url, api_type, api_key_enc, enabled FROM modelmgt.providers ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Provider
	for rows.Next() {
		var p Provider
		if err := rows.Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIType, &p.APIKey, &p.Enabled); err != nil {
			return nil, err
		}
		out = append(out, &p)
	}
	return out, rows.Err()
}

func (s *Store) UpsertModel(ctx context.Context, m *Model) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO modelmgt.models (provider_id, model_id, display_name, context_window, max_tokens, input_cost, output_cost, reasoning, enabled)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (provider_id, model_id) DO UPDATE SET
			display_name = EXCLUDED.display_name, context_window = EXCLUDED.context_window,
			max_tokens = EXCLUDED.max_tokens, input_cost = EXCLUDED.input_cost, output_cost = EXCLUDED.output_cost,
			reasoning = EXCLUDED.reasoning, enabled = EXCLUDED.enabled`,
		m.ProviderID, m.ModelID, m.DisplayName, m.ContextWindow, m.MaxTokens, m.InputCost, m.OutputCost, m.Reasoning, m.Enabled)
	return err
}

func (s *Store) DeleteModel(ctx context.Context, providerID, modelID string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM modelmgt.models WHERE provider_id=$1 AND model_id=$2`, providerID, modelID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListModels(ctx context.Context, enabledOnly bool) ([]*Model, error) {
	q := `SELECT provider_id, model_id, display_name, context_window, max_tokens, input_cost, output_cost, reasoning, enabled
	      FROM modelmgt.models`
	if enabledOnly {
		q += ` WHERE enabled AND provider_id IN (SELECT id FROM modelmgt.providers WHERE enabled)`
	}
	rows, err := s.db.Query(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Model
	for rows.Next() {
		var m Model
		if err := rows.Scan(&m.ProviderID, &m.ModelID, &m.DisplayName, &m.ContextWindow, &m.MaxTokens, &m.InputCost, &m.OutputCost, &m.Reasoning, &m.Enabled); err != nil {
			return nil, err
		}
		out = append(out, &m)
	}
	return out, rows.Err()
}

var _ = pgx.ErrNoRows
