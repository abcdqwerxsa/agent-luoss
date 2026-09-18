// usage service: metering, quotas, audit log storage and queries.
package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"agentluoss/internal/db"
	"agentluoss/internal/grpcx"
	"agentluoss/internal/usage"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, envOr("PG_DSN", "postgres://agent:agentdev@127.0.0.1:5432/agentluoss"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, usage.Migrations); err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "127.0.0.1:6379")})
	defer rdb.Close()

	limit, _ := strconv.ParseFloat(envOr("DEFAULT_MONTHLY_LIMIT_USD", "100"), 64)
	srv := usage.NewServer(pool, rdb, limit)
	port, _ := strconv.Atoi(envOr("PORT", "9095"))
	log.Fatal(grpcx.Serve(port, srv.Register))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
