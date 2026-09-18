// modelmgt service: provider/model registry, key vault, models.json render.
package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"agentluoss/internal/db"
	"agentluoss/internal/grpcx"
	"agentluoss/internal/modelmgt"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, envOr("PG_DSN", "postgres://agent:agentdev@127.0.0.1:5432/agentluoss"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, modelmgt.Migrations); err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "127.0.0.1:6379")})
	defer rdb.Close()

	srv := modelmgt.NewServer(pool, rdb, envOr("KEY_MASTER", "dev-master"), envOr("CONFIG_DIR", "/data/config"))
	if err := srv.Render(ctx); err != nil {
		log.Printf("initial render skipped: %v", err)
	}
	port, _ := strconv.Atoi(envOr("PORT", "9094"))
	log.Fatal(grpcx.Serve(port, srv.Register))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
