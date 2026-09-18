// iam service: accounts, roles, JWT issuing.
package main

import (
	"context"
	"os"
	"log"
	"strconv"

	"agentluoss/internal/db"
	"agentluoss/internal/grpcx"
	"agentluoss/internal/iam"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, envOr("PG_DSN", "postgres://agent:agentdev@127.0.0.1:5432/agentluoss"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, iam.Migrations); err != nil {
		log.Fatal(err)
	}

	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "127.0.0.1:6379")})
	defer rdb.Close()

	store := iam.NewStore(pool)
	if err := store.Bootstrap(ctx,
		envOr("ADMIN_USERNAME", "admin"),
		envOr("ADMIN_PASSWORD", "admin12345")); err != nil {
		log.Fatal(err)
	}

	port, _ := strconv.Atoi(envOr("PORT", "9091"))
	srv := iam.NewServer(store, envOr("JWT_SECRET", "dev-secret"), rdb)
	log.Fatal(grpcx.Serve(port, srv.Register))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
