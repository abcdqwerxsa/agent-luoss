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
	ID          string
	Username    string
	DisplayName string
	Role        string
	Status      string
	CreatedAt   int64
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
	_, err := s.CreateUser(ctx, username, password, "Administrator", "admin")
	if err != nil {
		return err
	}
	log.Printf("bootstrapped initial admin %q — change the password after first login", username)
	return nil
}

func (s *Store) CreateUser(ctx context.Context, username, password, displayName, role string) (*User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	id := newID()
	var u User
	err = s.db.QueryRow(ctx, `
		INSERT INTO iam.users (id, username, password_hash, display_name, role)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, username, display_name, role, status, (extract(epoch from created_at)*1000)::bigint`,
		id, username, hash, displayName, role,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrUserExists
		}
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, string, error) {
	var u User
	var hash string
	err := s.db.QueryRow(ctx, `
		SELECT id, username, display_name, role, status,
		       (extract(epoch from created_at)*1000)::bigint, password_hash
		FROM iam.users WHERE username = $1`, username,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.CreatedAt, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrBadCredentials
	}
	if err != nil {
		return nil, "", err
	}
	return &u, hash, nil
}

func (s *Store) GetUserByID(ctx context.Context, id string) (*User, string, error) {
	var u User
	var hash string
	err := s.db.QueryRow(ctx, `
		SELECT id, username, display_name, role, status,
		       (extract(epoch from created_at)*1000)::bigint, password_hash
		FROM iam.users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.CreatedAt, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrBadCredentials
	}
	if err != nil {
		return nil, "", err
	}
	return &u, hash, nil
}

func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, username, display_name, role, status, (extract(epoch from created_at)*1000)::bigint
		FROM iam.users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &u)
	}
	return out, rows.Err()
}

func (s *Store) UpdateUser(ctx context.Context, userID, displayName, role, status, password string) (*User, error) {
	hash := ""
	if password != "" {
		var err error
		hash, err = HashPassword(password)
		if err != nil {
			return nil, err
		}
	}
	var u User
	err := s.db.QueryRow(ctx, `
		UPDATE iam.users SET
			display_name = COALESCE(NULLIF($2, ''), display_name),
			role         = COALESCE(NULLIF($3, ''), role),
			status       = COALESCE(NULLIF($4, ''), status),
			password_hash = COALESCE(NULLIF($5, ''), password_hash)
		WHERE id = $1
		RETURNING id, username, display_name, role, status, (extract(epoch from created_at)*1000)::bigint`,
		userID, displayName, role, status, hash,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status, &u.CreatedAt)
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

// ---- helpers ----

func newID() string { return "u_" + randHex(12) }

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
