// Package kb implements the knowledge base service: per-department KBs,
// async document ingestion, markdown-aware chunking and lexical retrieval.
package kb

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	kbpb "agentluoss/proto/gen/kb"
)

var ErrNotFound = errors.New("not found")

type KB struct {
	ID         string
	Name       string
	ScopeType  string
	ScopeValue string
	UpdatedAt  int64
	DocCount   int
}

type Doc struct {
	ID        string
	KBID      string
	Filename  string
	Title     string
	Size      int64
	Uploader  string
	Status    string
	Error     string
	UpdatedAt int64
}

type Chunk struct {
	ID       int64
	DocID   string
	KBID    string
	Seq     int
	Section string
	Text    string
	Tokens  int
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) CreateKB(ctx context.Context, k *KB) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO kb.kbs (id, name, scope_type, scope_value)
		VALUES ($1,$2,$3,$4)`,
		k.ID, k.Name, k.ScopeType, k.ScopeValue)
	return err
}

func (s *Store) DeleteKB(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM kb.kbs WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	// children follow (no FK cascade in schema; explicit keeps it obvious)
	if _, err := s.db.Exec(ctx, `DELETE FROM kb.chunks WHERE kb_id=$1`, id); err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, `DELETE FROM kb.docs WHERE kb_id=$1`, id)
	return err
}

const kbCols = `id, name, scope_type, scope_value, (extract(epoch from updated_at)*1000)::bigint`

func (s *Store) ListKBs(ctx context.Context) ([]*KB, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+kbCols+`, (SELECT count(*) FROM kb.docs d WHERE d.kb_id = k.id)
		FROM kb.kbs k ORDER BY k.updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*KB
	for rows.Next() {
		var k KB
		if err := rows.Scan(&k.ID, &k.Name, &k.ScopeType, &k.ScopeValue, &k.UpdatedAt, &k.DocCount); err != nil {
			return nil, err
		}
		out = append(out, &k)
	}
	return out, rows.Err()
}

func (s *Store) GetKB(ctx context.Context, id string) (*KB, error) {
	var k KB
	err := s.db.QueryRow(ctx, `
		SELECT `+kbCols+`, (SELECT count(*) FROM kb.docs d WHERE d.kb_id = k.id)
		FROM kb.kbs k WHERE k.id=$1`, id,
	).Scan(&k.ID, &k.Name, &k.ScopeType, &k.ScopeValue, &k.UpdatedAt, &k.DocCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &k, nil
}

func (s *Store) InsertDoc(ctx context.Context, d *Doc, raw []byte) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO kb.docs (id, kb_id, filename, title, size, uploader, status, raw)
		VALUES ($1,$2,$3,$4,$5,$6,'parsing',$7)`,
		d.ID, d.KBID, d.Filename, d.Title, d.Size, d.Uploader, raw)
	return err
}

func (s *Store) SetDocParsed(ctx context.Context, id, mdText string, chunks []*Chunk) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM kb.chunks WHERE doc_id=$1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE kb.docs SET status='ready', error='', md_text=$2, updated_at=now() WHERE id=$1`,
		id, mdText); err != nil {
		return err
	}
	for _, c := range chunks {
		if _, err := tx.Exec(ctx, `
			INSERT INTO kb.chunks (doc_id, kb_id, seq, section, text, tokens)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			c.DocID, c.KBID, c.Seq, c.Section, c.Text, c.Tokens); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) SetDocFailed(ctx context.Context, id, errMsg string) {
	_, _ = s.db.Exec(ctx, `UPDATE kb.docs SET status='failed', error=$2, updated_at=now() WHERE id=$1`, id, errMsg)
}

// ListParsing returns docs awaiting ingestion (worker ticker scan).
func (s *Store) ListParsing(ctx context.Context) ([]*Doc, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, kb_id, filename, size, (extract(epoch from updated_at)*1000)::bigint
		FROM kb.docs WHERE status='parsing' LIMIT 50`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Doc
	for rows.Next() {
		var d Doc
		if err := rows.Scan(&d.ID, &d.KBID, &d.Filename, &d.Size, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &d)
	}
	return out, rows.Err()
}

// DocRaw returns the original upload bytes (parse worker input).
func (s *Store) DocRaw(ctx context.Context, id string) ([]byte, error) {
	var raw []byte
	err := s.db.QueryRow(ctx, `SELECT raw FROM kb.docs WHERE id=$1`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return raw, err
}

func (s *Store) ListDocs(ctx context.Context, kbID string) ([]*Doc, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, kb_id, filename, title, size, uploader, status, coalesce(error,''), (extract(epoch from updated_at)*1000)::bigint
		FROM kb.docs WHERE kb_id=$1 ORDER BY updated_at DESC`, kbID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Doc
	for rows.Next() {
		var d Doc
		if err := rows.Scan(&d.ID, &d.KBID, &d.Filename, &d.Title, &d.Size, &d.Uploader, &d.Status, &d.Error, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &d)
	}
	return out, rows.Err()
}

func (s *Store) GetDoc(ctx context.Context, id string) (*Doc, error) {
	var d Doc
	err := s.db.QueryRow(ctx, `
		SELECT id, kb_id, filename, title, size, uploader, status, coalesce(error,''), (extract(epoch from updated_at)*1000)::bigint
		FROM kb.docs WHERE id=$1`, id,
	).Scan(&d.ID, &d.KBID, &d.Filename, &d.Title, &d.Size, &d.Uploader, &d.Status, &d.Error, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *Store) DocMarkdown(ctx context.Context, id string) (string, error) {
	var md string
	err := s.db.QueryRow(ctx, `SELECT md_text FROM kb.docs WHERE id=$1`, id).Scan(&md)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return md, err
}

func (s *Store) DeleteDoc(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM kb.docs WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	_, err = s.db.Exec(ctx, `DELETE FROM kb.chunks WHERE doc_id=$1`, id)
	return err
}

// ChunkText is one retrieval candidate from the recall SQL.
type ChunkText struct {
	ID      int64
	DocID   string
	Section string
	Text    string
}

// RecallChunks fetches candidates by trigram-accelerated substring match on
// any query term. ponytail: ILIKE recall + Go-side rank; word-similarity SQL
// joins later if evals show misses. Short (<3 rune) terms seq-scan — fine at
// thousands-of-docs scale.
func (s *Store) RecallChunks(ctx context.Context, kbID string, terms []string, limit int) ([]*ChunkText, error) {
	pats := make([]string, len(terms))
	for i, t := range terms {
		pats[i] = "%" + t + "%"
	}
	rows, err := s.db.Query(ctx, `
		SELECT id, doc_id, section, text FROM kb.chunks
		WHERE kb_id=$1 AND text ILIKE ANY($2)
		LIMIT $3`, kbID, pats, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ChunkText
	for rows.Next() {
		var c ChunkText
		if err := rows.Scan(&c.ID, &c.DocID, &c.Section, &c.Text); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// SectionChunks returns a doc's chunks for read_doc (optionally one section).
func (s *Store) SectionChunks(ctx context.Context, docID, section string) ([]*Chunk, error) {
	q := `SELECT doc_id, kb_id, seq, section, text, tokens FROM kb.chunks WHERE doc_id=$1`
	args := []any{docID}
	if section != "" {
		q += ` AND section=$2`
		args = append(args, section)
	}
	q += ` ORDER BY seq`
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Chunk
	for rows.Next() {
		var c Chunk
		if err := rows.Scan(&c.DocID, &c.KBID, &c.Seq, &c.Section, &c.Text, &c.Tokens); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// DocTitles maps doc ids to titles for search result decoration.
func (s *Store) DocTitles(ctx context.Context, ids []string) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, title FROM kb.docs WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, title string
		if err := rows.Scan(&id, &title); err != nil {
			return nil, err
		}
		out[id] = title
	}
	return out, rows.Err()
}

// ---- semantic (pgvector) ----

// HasVector reports whether the pgvector extension is installed.
func (s *Store) HasVector(ctx context.Context) bool {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM pg_extension WHERE extname='vector'`).Scan(&n); err != nil {
		return false
	}
	return n > 0
}

// RecallVectors: cosine top-k over chunks embedded with the CURRENT model
// (dim-consistent). ponytail: exact scan, no index — fine to ~100k chunks;
// add HNSW (fixed dims) when latency demands.
func (s *Store) RecallVectors(ctx context.Context, kbID, model string, q []float32, limit int) ([]*ChunkText, error) {
	lit := VecToLiteral(q)
	rows, err := s.db.Query(ctx, `
		SELECT id, doc_id, section, text FROM kb.chunks
		WHERE kb_id=$1 AND embed_model=$2 AND embedding IS NOT NULL
		ORDER BY embedding <=> $3::vector LIMIT $4`, kbID, model, lit, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*ChunkText
	for rows.Next() {
		var c ChunkText
		if err := rows.Scan(&c.ID, &c.DocID, &c.Section, &c.Text); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// VectorScores returns cosine distances aligned with the given chunks.
func (s *Store) VectorScores(ctx context.Context, model string, q []float32, ids []int64) (map[int64]float64, error) {
	if len(ids) == 0 {
		return map[int64]float64{}, nil
	}
	lit := VecToLiteral(q)
	rows, err := s.db.Query(ctx, `
		SELECT id, 1 - (embedding <=> $1::vector) FROM kb.chunks
		WHERE embed_model=$2 AND id = ANY($3)`, lit, model, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]float64{}
	for rows.Next() {
		var id int64
		var sim float64
		if err := rows.Scan(&id, &sim); err != nil {
			return nil, err
		}
		out[id] = sim
	}
	return out, rows.Err()
}

// ChunkToEmbed lists chunks of ready docs lacking a current-model embedding
// (ingest backfill + reindex after model switch). Order: oldest docs first.
func (s *Store) ChunksToEmbed(ctx context.Context, model string, limit int) ([]*Chunk, error) {
	rows, err := s.db.Query(ctx, `
		SELECT c.id, c.doc_id, c.kb_id, c.seq, c.section, c.text, c.tokens
		FROM kb.chunks c JOIN kb.docs d ON d.id = c.doc_id
		WHERE d.status='ready' AND (c.embed_model IS NULL OR c.embed_model='' OR c.embed_model <> $1)
		ORDER BY d.updated_at ASC LIMIT $2`, model, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Chunk
	for rows.Next() {
		var c Chunk
		if err := rows.Scan(&c.ID, &c.DocID, &c.KBID, &c.Seq, &c.Section, &c.Text, &c.Tokens); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// SetChunkEmbeddings writes vectors for chunk ids (same batch/model).
func (s *Store) SetChunkEmbeddings(ctx context.Context, ids []int64, vecs [][]float32, model string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for i, id := range ids {
		if _, err := tx.Exec(ctx, `
			UPDATE kb.chunks SET embedding=$1::vector, embed_model=$2 WHERE id=$3`,
			VecToLiteral(vecs[i]), model, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ClearEmbeddings drops stored vectors (reindex); kb_id empty = all.
func (s *Store) ClearEmbeddings(ctx context.Context, kbID string) (int64, error) {
	q := `UPDATE kb.chunks SET embedding=NULL, embed_model='' WHERE TRUE`
	args := []any{}
	if kbID != "" {
		q = `UPDATE kb.chunks SET embedding=NULL, embed_model='' WHERE kb_id=$1`
		args = append(args, kbID)
	}
	tag, err := s.db.Exec(ctx, q, args...)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func toPbKB(k *KB) *kbpb.KbInfo {
	return &kbpb.KbInfo{
		Id: k.ID, Name: k.Name,
		Scope:     &kbpb.Scope{Type: k.ScopeType, Value: k.ScopeValue},
		DocCount:  int32(k.DocCount),
		McpEntryId: "kb-" + k.ID,
		UpdatedAt: k.UpdatedAt,
	}
}

func toPbDoc(d *Doc) *kbpb.DocInfo {
	return &kbpb.DocInfo{
		Id: d.ID, KbId: d.KBID, Filename: d.Filename, Title: d.Title,
		Size: d.Size, Uploader: d.Uploader, Status: d.Status, Error: d.Error,
		UpdatedAt: d.UpdatedAt,
	}
}
