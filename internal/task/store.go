package task

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("task not found")

type Task struct {
	ID           string
	UserID       string
	Title        string
	Mode         string
	Provider     string
	ModelID      string
	Status       string
	RuntimeID    string
	SessionPath  string
	FirstMessage string
	ExpertID     string
	CreatedAt    int64
	UpdatedAt    int64
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

func (s *Store) Create(ctx context.Context, t *Task) error {
	return s.db.QueryRow(ctx, `
		INSERT INTO task.tasks (id, user_id, title, mode, provider, model_id, status, first_message, expert_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING (extract(epoch from created_at)*1000)::bigint, (extract(epoch from updated_at)*1000)::bigint`,
		t.ID, t.UserID, t.Title, t.Mode, t.Provider, t.ModelID, t.Status, t.FirstMessage, t.ExpertID,
	).Scan(&t.CreatedAt, &t.UpdatedAt)
}

func (s *Store) Get(ctx context.Context, id string) (*Task, error) {
	var t Task
	err := s.db.QueryRow(ctx, `
		SELECT id, user_id, title, mode, provider, model_id, status, runtime_id, session_path,
		       first_message, coalesce(expert_id,''), (extract(epoch from created_at)*1000)::bigint, (extract(epoch from updated_at)*1000)::bigint
		FROM task.tasks WHERE id = $1`, id,
	).Scan(&t.ID, &t.UserID, &t.Title, &t.Mode, &t.Provider, &t.ModelID, &t.Status, &t.RuntimeID, &t.SessionPath, &t.FirstMessage, &t.ExpertID, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) List(ctx context.Context, userID, query string, limit, offset int) ([]*Task, int, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	where := "WHERE user_id = $1"
	args := []any{userID}
	if userID == "" { // admin: all users
		where, args = "", nil
	}
	if query != "" {
		if where == "" {
			where = "WHERE title ILIKE $1"
		} else {
			where += " AND title ILIKE $2"
		}
		args = append(args, "%"+query+"%")
	}
	var total int
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM task.tasks "+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, limit, offset)
	rows, err := s.db.Query(ctx, `
		SELECT id, user_id, title, mode, provider, model_id, status, runtime_id, session_path,
		       first_message, coalesce(expert_id,''), (extract(epoch from created_at)*1000)::bigint, (extract(epoch from updated_at)*1000)::bigint
		FROM task.tasks `+where+`
		ORDER BY updated_at DESC LIMIT $`+itoa(len(args)-1)+" OFFSET $"+itoa(len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []*Task
	for rows.Next() {
		var t Task
		if err := rows.Scan(&t.ID, &t.UserID, &t.Title, &t.Mode, &t.Provider, &t.ModelID, &t.Status, &t.RuntimeID, &t.SessionPath, &t.FirstMessage, &t.ExpertID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, 0, err
		}
		out = append(out, &t)
	}
	return out, total, rows.Err()
}

func (s *Store) UpdateMeta(ctx context.Context, id, title string, archived bool) (*Task, error) {
	status := ""
	if archived {
		status = "archived"
	}
	var t Task
	err := s.db.QueryRow(ctx, `
		UPDATE task.tasks SET
			title = COALESCE(NULLIF($2,''), title),
			status = COALESCE(NULLIF($3,''), status),
			updated_at = now()
		WHERE id = $1 AND status <> 'archived'
		RETURNING id, user_id, title, mode, provider, model_id, status, runtime_id, session_path,
		          first_message, (extract(epoch from created_at)*1000)::bigint, (extract(epoch from updated_at)*1000)::bigint`,
		id, title, status,
	).Scan(&t.ID, &t.UserID, &t.Title, &t.Mode, &t.Provider, &t.ModelID, &t.Status, &t.RuntimeID, &t.SessionPath, &t.FirstMessage, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// either missing or already archived; archive twice is fine
		if archived {
			if _, err := s.db.Exec(ctx, `UPDATE task.tasks SET status='archived', updated_at=now() WHERE id=$1`, id); err != nil {
				return nil, err
			}
			return s.Get(ctx, id)
		}
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Store) Delete(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM task.tasks WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetRuntime(ctx context.Context, id, runtimeID string) error {
	_, err := s.db.Exec(ctx, `UPDATE task.tasks SET runtime_id=$2, updated_at=now() WHERE id=$1`, id, runtimeID)
	return err
}

func (s *Store) SetSessionPath(ctx context.Context, id, path string) error {
	_, err := s.db.Exec(ctx, `UPDATE task.tasks SET session_path=$2, updated_at=now() WHERE id=$1`, id, path)
	return err
}

func (s *Store) SetStatus(ctx context.Context, id, status string) error {
	_, err := s.db.Exec(ctx, `UPDATE task.tasks SET status=$2, updated_at=now() WHERE id=$1 AND status <> 'archived'`, id, status)
	return err
}

// SetMode records the permission mode currently in use (per-turn switches
// update the row so recovery resumes on the last-used mode).
func (s *Store) SetMode(ctx context.Context, id, mode string) error {
	_, err := s.db.Exec(ctx, `UPDATE task.tasks SET mode=$2, updated_at=now() WHERE id=$1`, id, mode)
	return err
}

// SetModel records the model currently in use (per-turn overrides update
// the row so recovery resumes on the last-used model).
func (s *Store) SetModel(ctx context.Context, id, provider, modelID string) error {
	_, err := s.db.Exec(ctx, `UPDATE task.tasks SET provider=$2, model_id=$3, updated_at=now() WHERE id=$1`, id, provider, modelID)
	return err
}

func (s *Store) SetTitleIfEmpty(ctx context.Context, id, title string) error {
	if len(title) > 80 {
		title = title[:80]
	}
	_, err := s.db.Exec(ctx, `UPDATE task.tasks SET title=$2, updated_at=now() WHERE id=$1 AND title=''`, id, title)
	return err
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return string(rune('0'+n/10)) + string(rune('0'+n%10))
}

var _ = time.Now
