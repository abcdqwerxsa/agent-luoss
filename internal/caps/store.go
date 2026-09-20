package caps

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrDuplicate = errors.New("id exists")
)

type McpServer struct {
	ID        string
	Name      string
	Transport string // stdio | http | sse
	Command   string
	Args      []string
	Env       map[string]string // values encrypted at rest
	URL       string
	Enabled   bool
	Scopes    []Scope
	UpdatedAt int64
}

type Skill struct {
	ID          string
	Name        string
	Description string
	Path        string
	Enabled     bool
	Scopes      []Scope
	UpdatedAt   int64
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func dup(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return ErrDuplicate
	}
	return err
}

func (s *Store) setScopes(ctx context.Context, capType, capID string, scopes []Scope) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM caps.cap_scopes WHERE cap_type=$1 AND cap_id=$2`, capType, capID); err != nil {
		return err
	}
	for _, sc := range scopes {
		if _, err := s.db.Exec(ctx,
			`INSERT INTO caps.cap_scopes (cap_type, cap_id, type, value) VALUES ($1,$2,$3,$4)`,
			capType, capID, sc.Type, sc.Value); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) scopesFor(ctx context.Context, capType string) (map[string][]Scope, error) {
	out := map[string][]Scope{}
	rows, err := s.db.Query(ctx,
		`SELECT cap_id, type, value FROM caps.cap_scopes WHERE cap_type=$1`, capType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, t, v string
		if err := rows.Scan(&id, &t, &v); err != nil {
			return nil, err
		}
		out[id] = append(out[id], Scope{Type: t, Value: v})
	}
	return out, rows.Err()
}

// ---- MCP servers ----

func (s *Store) UpsertMcpServer(ctx context.Context, m *McpServer) error {
	args, _ := json.Marshal(m.Args)
	env, err := json.Marshal(m.Env)
	if err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `
		UPDATE caps.mcp_servers SET name=$2, transport=$3, command=$4, args=$5,
		       env=$6, url=$7, enabled=$8, updated_at=now()
		WHERE id=$1`,
		m.ID, m.Name, m.Transport, m.Command, args, env, m.URL, m.Enabled)
	if err != nil {
		return dup(err)
	}
	if tag.RowsAffected() == 0 {
		_, err = s.db.Exec(ctx, `
			INSERT INTO caps.mcp_servers (id, name, transport, command, args, env, url, enabled)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			m.ID, m.Name, m.Transport, m.Command, args, env, m.URL, m.Enabled)
		if err != nil {
			return dup(err)
		}
	}
	return s.setScopes(ctx, "mcp", m.ID, NormalizeScopes(m.Scopes))
}

func (s *Store) DeleteMcpServer(ctx context.Context, id string) error {
	if err := s.delete(ctx, "caps.mcp_servers", id); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `DELETE FROM caps.cap_scopes WHERE cap_type='mcp' AND cap_id=$1`, id)
	return err
}

func (s *Store) ListMcpServers(ctx context.Context) ([]*McpServer, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, transport, command, args, env, url, enabled,
		       (extract(epoch from updated_at)*1000)::bigint
		FROM caps.mcp_servers ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*McpServer
	for rows.Next() {
		var m McpServer
		var args, env []byte
		if err := rows.Scan(&m.ID, &m.Name, &m.Transport, &m.Command, &args, &env, &m.URL, &m.Enabled, &m.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(args, &m.Args)
		_ = json.Unmarshal(env, &m.Env)
		out = append(out, &m)
	}
	scopes, err := s.scopesFor(ctx, "mcp")
	if err != nil {
		return nil, err
	}
	for _, m := range out {
		m.Scopes = scopes[m.ID]
	}
	return out, rows.Err()
}

// ---- skills ----

func (s *Store) UpsertSkill(ctx context.Context, k *Skill) error {
	tag, err := s.db.Exec(ctx, `
		UPDATE caps.skills SET name=$2, description=$3, path=$4, enabled=$5, updated_at=now()
		WHERE id=$1`,
		k.ID, k.Name, k.Description, k.Path, k.Enabled)
	if err != nil {
		return dup(err)
	}
	if tag.RowsAffected() == 0 {
		_, err = s.db.Exec(ctx, `
			INSERT INTO caps.skills (id, name, description, path, enabled)
			VALUES ($1,$2,$3,$4,$5)`,
			k.ID, k.Name, k.Description, k.Path, k.Enabled)
		if err != nil {
			return dup(err)
		}
	}
	return s.setScopes(ctx, "skill", k.ID, NormalizeScopes(k.Scopes))
}

func (s *Store) DeleteSkill(ctx context.Context, id string) error {
	if err := s.delete(ctx, "caps.skills", id); err != nil {
		return err
	}
	_, err := s.db.Exec(ctx, `DELETE FROM caps.cap_scopes WHERE cap_type='skill' AND cap_id=$1`, id)
	return err
}

func (s *Store) ListSkills(ctx context.Context) ([]*Skill, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, description, path, enabled,
		       (extract(epoch from updated_at)*1000)::bigint
		FROM caps.skills ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Skill
	for rows.Next() {
		var k Skill
		if err := rows.Scan(&k.ID, &k.Name, &k.Description, &k.Path, &k.Enabled, &k.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &k)
	}
	scopes, err := s.scopesFor(ctx, "skill")
	if err != nil {
		return nil, err
	}
	for _, k := range out {
		k.Scopes = scopes[k.ID]
	}
	return out, rows.Err()
}

func (s *Store) delete(ctx context.Context, table, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM `+table+` WHERE id=$1`, id) // table is a constant, not user input
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- effective resolution ----

// EffectiveCaps resolves visible caps for a user (department may be empty).
// Filter is applied in-process; row counts stay tiny (tens).
func EffectiveCaps(mcp []*McpServer, skills []*Skill, department, role string) ([]*McpServer, []*Skill) {
	var mout []*McpServer
	for _, m := range mcp {
		if m.Enabled && EffectiveScope(m.Scopes, department, role) {
			mout = append(mout, m)
		}
	}
	var kout []*Skill
	for _, k := range skills {
		if k.Enabled && EffectiveScope(k.Scopes, department, role) {
			kout = append(kout, k)
		}
	}
	return mout, kout
}

// UpsertSkillMeta updates only enabled/scopes (admin toggles after upload).
func (s *Store) UpsertSkillMeta(ctx context.Context, k *Skill) error {
	tag, err := s.db.Exec(ctx,
		`UPDATE caps.skills SET enabled=$2, updated_at=now() WHERE id=$1`, k.ID, k.Enabled)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return s.setScopes(ctx, "skill", k.ID, NormalizeScopes(k.Scopes))
}

// GetSkill fetches one skill row (for cleanup on delete).
func (s *Store) GetSkill(ctx context.Context, id string) (*Skill, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, description, path, enabled,
		       (extract(epoch from updated_at)*1000)::bigint
		FROM caps.skills WHERE id=$1`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, ErrNotFound
	}
	var k Skill
	if err := rows.Scan(&k.ID, &k.Name, &k.Description, &k.Path, &k.Enabled, &k.UpdatedAt); err != nil {
		return nil, err
	}
	return &k, rows.Err()
}

// ---- experts ----

type Expert struct {
	ID          string
	Name        string
	Description string
	Enabled     bool
	SkillIDs    []string
	McpIDs      []string
	Scopes      []Scope
	UpdatedAt   int64
}

func (s *Store) UpsertExpert(ctx context.Context, e *Expert) error {
	tag, err := s.db.Exec(ctx, `
		UPDATE caps.experts SET name=$2, description=$3, enabled=$4, updated_at=now()
		WHERE id=$1`, e.ID, e.Name, e.Description, e.Enabled)
	if err != nil {
		return dup(err)
	}
	if tag.RowsAffected() == 0 {
		_, err = s.db.Exec(ctx, `
			INSERT INTO caps.experts (id, name, description, enabled) VALUES ($1,$2,$3,$4)`,
			e.ID, e.Name, e.Description, e.Enabled)
		if err != nil {
			return dup(err)
		}
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM caps.expert_items WHERE expert_id=$1`, e.ID); err != nil {
		return err
	}
	for _, id := range e.SkillIDs {
		if _, err := s.db.Exec(ctx, `INSERT INTO caps.expert_items (expert_id, cap_type, cap_id) VALUES ($1,'skill',$2)`, e.ID, id); err != nil {
			return err
		}
	}
	for _, id := range e.McpIDs {
		if _, err := s.db.Exec(ctx, `INSERT INTO caps.expert_items (expert_id, cap_type, cap_id) VALUES ($1,'mcp',$2)`, e.ID, id); err != nil {
			return err
		}
	}
	return s.setScopes(ctx, "expert", e.ID, NormalizeScopes(e.Scopes))
}

func (s *Store) DeleteExpert(ctx context.Context, id string) error {
	if _, err := s.db.Exec(ctx, `DELETE FROM caps.expert_items WHERE expert_id=$1`, id); err != nil {
		return err
	}
	if _, err := s.db.Exec(ctx, `DELETE FROM caps.cap_scopes WHERE cap_type='expert' AND cap_id=$1`, id); err != nil {
		return err
	}
	return s.delete(ctx, "caps.experts", id)
}

func (s *Store) ListExperts(ctx context.Context) ([]*Expert, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, description, enabled, (extract(epoch from updated_at)*1000)::bigint
		FROM caps.experts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]*Expert{}
	var out []*Expert
	for rows.Next() {
		var e Expert
		if err := rows.Scan(&e.ID, &e.Name, &e.Description, &e.Enabled, &e.UpdatedAt); err != nil {
			return nil, err
		}
		byID[e.ID] = &e
		out = append(out, &e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	items, err := s.db.Query(ctx, `SELECT expert_id, cap_type, cap_id FROM caps.expert_items`)
	if err != nil {
		return nil, err
	}
	defer items.Close()
	for items.Next() {
		var eid, ct, cid string
		if err := items.Scan(&eid, &ct, &cid); err != nil {
			return nil, err
		}
		if e := byID[eid]; e != nil {
			if ct == "skill" {
				e.SkillIDs = append(e.SkillIDs, cid)
			} else {
				e.McpIDs = append(e.McpIDs, cid)
			}
		}
	}
	scopes, err := s.scopesFor(ctx, "expert")
	if err != nil {
		return nil, err
	}
	for _, e := range out {
		e.Scopes = scopes[e.ID]
	}
	return out, items.Err()
}

// ExpertItems returns member cap ids of one expert.
func (s *Store) ExpertItems(ctx context.Context, expertID string) (skills, mcps []string, err error) {
	rows, err := s.db.Query(ctx, `SELECT cap_type, cap_id FROM caps.expert_items WHERE expert_id=$1`, expertID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ct, cid string
		if err := rows.Scan(&ct, &cid); err != nil {
			return nil, nil, err
		}
		if ct == "skill" {
			skills = append(skills, cid)
		} else {
			mcps = append(mcps, cid)
		}
	}
	return skills, mcps, rows.Err()
}
