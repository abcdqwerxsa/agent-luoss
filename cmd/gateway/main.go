// gateway service: HTTP edge for the web frontend.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agentluoss/internal/gateway"
	"agentluoss/internal/metricsx"
)

// stopGrace bounds graceful shutdown: SSE clients reconnect via
// Last-Event-ID replay, so cutting them after the grace is safe.
const stopGrace = 8 * time.Second

func main() {
	port := envOr("PORT", "8080")
	app := gateway.New(envOr("JWT_SECRET", "dev-secret"),
		envOr("IAM_ADDR", "127.0.0.1:9091"),
		envOr("TASK_ADDR", "127.0.0.1:9092"),
		envOr("ARTIFACT_ADDR", "127.0.0.1:9093"),
		envOr("MODELMGT_ADDR", "127.0.0.1:9094"),
		envOr("USAGE_ADDR", "127.0.0.1:9095"),
		envOr("CAPS_ADDR", "127.0.0.1:9096"),
		envOr("KB_ADDR", "127.0.0.1:9097"))
	metricsx.StartFromEnv()
	srv := &http.Server{Addr: ":" + port, Handler: app.Handler()}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Printf("gateway listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), stopGrace)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("gateway forced close: %v", err)
	}
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
