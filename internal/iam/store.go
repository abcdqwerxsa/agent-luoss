package iam

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrBadCredentials = errors.New("bad credentials")
	ErrUserExists     = errors.New("username exists")
	ErrNotFound       = errors.New("not found")
)

type User struct {
	ID           string
	Username     string
	DisplayName  string
	Role         string
	Status       string
	DepartmentID string // empty = none
	CreatedAt    int64
}

type Department struct {
	ID        string
	Name      string
	CreatedAt int64
}

type Store struct{ db *pgxpool.Pool }

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

// Bootstrap creates the initial admin when the users table is empty.
func (s *Store) Bootstrap(ctx context.Context, username, password string) error {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM iam.users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := s.CreateUser(ctx, username, password, "Administrator", "admin", "")
	if err != nil {
		return err
	}
	log.Printf("bootstrapped initial admin %q — change the password after first login", username)
	return nil
}

const userCols = `id, username, display_name, role, status,
	coalesce(department_id, ''), (extract(epoch from created_at)*1000)::bigint`

func (s *Store) CreateUser(ctx context.Context, username, password, displayName, role, departmentID string) (*User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	id := newID()
	var u User
	err = s.db.QueryRow(ctx, `
		INSERT INTO iam.users (id, username, password_hash, display_name, role, department_id)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''))
		RETURNING `+userCols,
		id, username, hash, displayName, role, departmentID,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.DepartmentID, &u.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrUserExists
		}
		return nil, err
	}
	return &u, nil
}

func (s *Store) scanUser(row pgx.Row) (*User, string, error) {
	var u User
	var hash string
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.DepartmentID, &u.CreatedAt, &hash)
	return &u, hash, err
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, string, error) {
	u, hash, err := s.scanUser(s.db.QueryRow(ctx, `
		SELECT `+userCols+`, password_hash FROM iam.users WHERE username = $1`, username))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrBadCredentials
	}
	return u, hash, err
}

func (s *Store) GetUserByID(ctx context.Context, id string) (*User, string, error) {
	u, hash, err := s.scanUser(s.db.QueryRow(ctx, `
		SELECT `+userCols+`, password_hash FROM iam.users WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrBadCredentials
	}
	return u, hash, err
}

func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.db.Query(ctx, `
		SELECT `+userCols+` FROM iam.users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.DepartmentID, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

func (s *Store) UpdateUser(ctx context.Context, userID, displayName, role, status, password, departmentID string) (*User, error) {
	hash := ""
	if password != "" {
		var err error
		hash, err = HashPassword(password)
		if err != nil {
			return nil, err
		}
	}
	var u User
	// departmentID: "-" clears, "" leaves unchanged, else set
	err := s.db.QueryRow(ctx, `
		UPDATE iam.users SET
			display_name = COALESCE(NULLIF($2, ''), display_name),
			role         = COALESCE(NULLIF($3, ''), role),
			status       = COALESCE(NULLIF($4, ''), status),
			password_hash = COALESCE(NULLIF($5, ''), password_hash),
			department_id = CASE WHEN $6 = '-' THEN NULL
			                     WHEN $6 = '' THEN department_id
			                     ELSE $6 END
		WHERE id = $1
		RETURNING `+userCols,
		userID, displayName, role, status, hash, departmentID,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.DepartmentID, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) DeleteUser(ctx context.Context, userID string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM iam.users WHERE id = $1`, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- refresh tokens ----

func (s *Store) SaveRefreshToken(ctx context.Context, userID string, ttl time.Duration) (string, error) {
	raw := randHex(32)
	sum := sha256.Sum256([]byte(raw))
	_, err := s.db.Exec(ctx, `
		INSERT INTO iam.refresh_tokens (token_hash, user_id, expires_at)
		VALUES ($1, $2, now() + $3::interval)`,
		hex.EncodeToString(sum[:]), userID, ttl.String())
	return raw, err
}

// ConsumeRefreshToken validates and deletes (single-use) a refresh token.
func (s *Store) ConsumeRefreshToken(ctx context.Context, raw string) (string, error) {
	sum := sha256.Sum256([]byte(raw))
	var userID string
	err := s.db.QueryRow(ctx, `
		DELETE FROM iam.refresh_tokens
		WHERE token_hash = $1 AND expires_at > now()
		RETURNING user_id`, hex.EncodeToString(sum[:]),
	).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrBadCredentials
	}
	return userID, err
}

func (s *Store) DeleteRefreshToken(ctx context.Context, raw string) error {
	sum := sha256.Sum256([]byte(raw))
	_, err := s.db.Exec(ctx, `DELETE FROM iam.refresh_tokens WHERE token_hash = $1`, hex.EncodeToString(sum[:]))
	return err
}

func (s *Store) GetRefreshUserID(ctx context.Context, raw string) (string, error) {
	sum := sha256.Sum256([]byte(raw))
	var userID string
	err := s.db.QueryRow(ctx, `
		SELECT user_id FROM iam.refresh_tokens
		WHERE token_hash = $1 AND expires_at > now()`, hex.EncodeToString(sum[:]),
	).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrBadCredentials
	}
	return userID, err
}

// ---- departments ----

func (s *Store) CreateDepartment(ctx context.Context, id, name string) (*Department, error) {
	if id == "" {
		id = "d_" + randHex(12)
	}
	var d Department
	err := s.db.QueryRow(ctx, `
		INSERT INTO iam.departments (id, name)
		VALUES ($1, $2)
		RETURNING id, name, (extract(epoch from created_at)*1000)::bigint`,
		id, name,
	).Scan(&d.ID, &d.Name, &d.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrUserExists // reuse: duplicate id
		}
		return nil, err
	}
	return &d, nil
}

func (s *Store) UpdateDepartment(ctx context.Context, id, name string) (*Department, error) {
	var d Department
	err := s.db.QueryRow(ctx, `
		UPDATE iam.departments SET name = $2 WHERE id = $1
		RETURNING id, name, (extract(epoch from created_at)*1000)::bigint`,
		id, name,
	).Scan(&d.ID, &d.Name, &d.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &d, err
}

func (s *Store) DeleteDepartment(ctx context.Context, id string) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM iam.departments WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListDepartments(ctx context.Context) ([]*Department, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, name, (extract(epoch from created_at)*1000)::bigint
		FROM iam.departments ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Department
	for rows.Next() {
		var d Department
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &d)
	}
	return out, rows.Err()
}

// ---- helpers ----

func newID() string { return "u_" + randHex(12) }

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
