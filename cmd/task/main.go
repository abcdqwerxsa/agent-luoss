// task service: task orchestration, runtime scheduling, event pipeline.
package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"agentluoss/internal/db"
	"agentluoss/internal/grpcx"
	"agentluoss/internal/task"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, envOr("PG_DSN", "postgres://agent:agentdev@127.0.0.1:5432/agentluoss"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, task.Migrations); err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "127.0.0.1:6379")})
	defer rdb.Close()

	var reporter task.UsageReporter
	var quota task.QuotaChecker
	if addr := envOr("USAGE_ADDR", ""); addr != "" {
		ad, err := task.NewUsageAdapter(addr)
		if err != nil {
			log.Fatal(err)
		}
		reporter, quota = ad, ad
	}
	var caps task.CapsResolver
	if addr := envOr("CAPS_ADDR", ""); addr != "" {
		ad, err := task.NewCapsAdapter(addr)
		if err != nil {
			log.Fatal(err)
		}
		caps = ad
	}
	srv := task.NewServer(pool, rdb, envOr("WORKSPACES_DIR", "/data/workspaces"), reporter, quota, caps)
	log.Fatal(grpcx.Serve(mustAtoi(envOr("PORT", "9092")), srv.Register))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func mustAtoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		log.Fatalf("bad PORT %q: %v", s, err)
	}
	return n
}
