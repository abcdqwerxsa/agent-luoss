// caps service: admin-managed MCP servers and skills with dept/role scope.
package main

import (
	"context"
	"log"
	"os"
	"strconv"

	"agentluoss/internal/caps"
	"agentluoss/internal/db"
	"agentluoss/internal/grpcx"

	iampb "agentluoss/proto/gen/iam"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, envOr("PG_DSN", "postgres://agent:agentdev@127.0.0.1:5432/agentluoss"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, caps.Migrations); err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "127.0.0.1:6379")})
	defer rdb.Close()

	var iam iampb.IAMClient
	if addr := envOr("IAM_ADDR", "127.0.0.1:9091"); addr != "" {
		conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial iam: %v", err)
		}
		defer conn.Close()
		iam = iampb.NewIAMClient(conn)
	}

	srv := caps.NewServer(caps.NewStore(pool), rdb,
		envOr("KEY_MASTER", "dev-master"), envOr("SKILLS_DIR", "/data/skills"), iam)
	port, _ := strconv.Atoi(envOr("PORT", "9096"))
	log.Fatal(grpcx.Serve(port, srv.Register))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
