// kb service: department-scoped knowledge bases behind per-KB MCP tools.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"

	"agentluoss/internal/db"
	"agentluoss/internal/grpcx"
	"agentluoss/internal/kb"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	capspb "agentluoss/proto/gen/caps"
	iampb "agentluoss/proto/gen/iam"
	modelmgtpb "agentluoss/proto/gen/modelmgt"
)

func main() {
	ctx := context.Background()
	pool, err := db.Connect(ctx, envOr("PG_DSN", "postgres://agent:agentdev@127.0.0.1:5432/agentluoss"))
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, kb.Migrations); err != nil {
		log.Fatal(err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: envOr("REDIS_ADDR", "127.0.0.1:6379")})
	defer rdb.Close()

	var caps capspb.CapsClient
	if addr := envOr("CAPS_ADDR", ""); addr != "" {
		caps = dialCaps(addr)
	}
	var iam iampb.IAMClient
	if addr := envOr("IAM_ADDR", ""); addr != "" {
		iam = dialIam(addr)
	}
	var mm modelmgtpb.ModelMgtClient
	if addr := envOr("MODELMGT_ADDR", ""); addr != "" {
		conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial modelmgt: %v", err)
		}
		mm = modelmgtpb.NewModelMgtClient(conn)
	}

	srv := kb.NewServer(kb.NewStore(pool), rdb, caps, iam, mm,
		envOr("MINERU_URL", ""), envOr("KB_ADVERTISED_URL", "http://127.0.0.1:9098"))
	srv.StartIngest()

	// MCP http server (per-KB tool endpoints) on its own port
	mux := http.NewServeMux()
	mux.Handle("/mcp/", srv.MCPHandler())
	// metricsx is started by grpcx.Serve (METRICS_ADDR); no double bind here
	httpPort := envOr("KB_HTTP_PORT", "9098")
	go func() {
		log.Printf("kb mcp listening on :%s", httpPort)
		if err := http.ListenAndServe(":"+httpPort, mux); err != nil {
			log.Fatalf("mcp http: %v", err)
		}
	}()

	port, _ := strconv.Atoi(envOr("PORT", "9097"))
	log.Fatal(grpcx.Serve(port, srv.Register))
}

func dialCaps(addr string) capspb.CapsClient {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("dial caps: %v", err)
	}
	return capspb.NewCapsClient(conn)
}

func dialIam(addr string) iampb.IAMClient {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("dial iam: %v", err)
	}
	return iampb.NewIAMClient(conn)
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
