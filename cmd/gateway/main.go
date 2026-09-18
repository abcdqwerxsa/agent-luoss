// gateway service: HTTP edge for the web frontend.
package main

import (
	"log"
	"net/http"
	"os"

	"agentluoss/internal/gateway"
)

func main() {
	port := envOr("PORT", "8080")
	app := gateway.New(envOr("JWT_SECRET", "dev-secret"),
		envOr("IAM_ADDR", "127.0.0.1:9091"),
		envOr("TASK_ADDR", "127.0.0.1:9092"),
		envOr("ARTIFACT_ADDR", "127.0.0.1:9093"),
		envOr("MODELMGT_ADDR", "127.0.0.1:9094"),
		envOr("USAGE_ADDR", "127.0.0.1:9095"))
	addr := ":" + port
	log.Printf("gateway listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, app.Handler()))
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
