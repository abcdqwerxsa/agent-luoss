// artifact service: workspace files (list/download/upload/delete).
package main

import (
	"log"
	"os"
	"strconv"

	"agentluoss/internal/artifact"
	"agentluoss/internal/grpcx"
)

func main() {
	root := envOr("WORKSPACES_DIR", "/data/workspaces")
	if err := os.MkdirAll(root, 0o755); err != nil {
		log.Fatal(err)
	}
	port, _ := strconv.Atoi(envOr("PORT", "9093"))
	srv := artifact.NewServer(root)
	log.Printf("artifact serving workspaces at %s", root)
	log.Fatal(grpcx.Serve(port, srv.Register))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
