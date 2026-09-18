// Package db provides a pgx pool connector plus idempotent schema migration
// from embedded SQL files. Each service migrates only its own schema.
package db

import (
	"context"
	"embed"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect waits for Postgres (compose startup race) and returns a pool.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	var pool *pgxpool.Pool
	var err error
	for i := 0; i < 30; i++ {
		pool, err = pgxpool.New(ctx, dsn)
		if err == nil {
			err = pool.Ping(ctx)
			if err == nil {
				return pool, nil
			}
			pool.Close()
		}
		log.Printf("waiting for postgres (%d/30): %v", i+1, err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return nil, fmt.Errorf("postgres unreachable: %w", err)
}

// Migrate applies every .sql file in the embedded FS (must be idempotent).
func Migrate(ctx context.Context, pool *pgxpool.Pool, fs embed.FS) error {
	entries, err := fs.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, e := range entries {
		sql, err := fs.ReadFile("migrations/" + e.Name())
		if err != nil {
			return err
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("migrate %s: %w", e.Name(), err)
		}
		log.Printf("migrated %s", e.Name())
	}
	return nil
}
