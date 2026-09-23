// Package metricsx provides a shared Prometheus /metrics + pprof endpoint
// and gRPC/HTTP instrumentation. Enabled per service via METRICS_ADDR
// (empty = disabled; behavior of existing deployments unchanged).
package metricsx

import (
	"context"
	"log"
	"net/http"
	"net/http/pprof"
	"os"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"google.golang.org/grpc"
	"google.golang.org/grpc/status"
)

var (
	grpcRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "grpc_requests_total", Help: "gRPC requests by method and code",
	}, []string{"method", "code"})
	grpcDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "grpc_request_duration_seconds", Help: "gRPC handler duration",
		Buckets: []float64{.005, .01, .05, .1, .5, 1, 5, 30},
	}, []string{"method"})
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total", Help: "HTTP requests by route, method and code",
	}, []string{"route", "method", "code"})
	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name: "http_request_duration_seconds", Help: "HTTP handler duration",
		Buckets: []float64{.005, .01, .05, .1, .5, 1, 5, 30},
	}, []string{"route", "method"})
)

// Start serves /metrics and /debug/pprof on addr. No-op when addr is empty.
// Fire-and-forget: a dead metrics listener must never take the service down.
func Start(addr string) {
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("metrics server on %s stopped: %v", addr, err)
		}
	}()
	log.Printf("metrics listening on %s", addr)
}

// StartFromEnv starts with METRICS_ADDR.
func StartFromEnv() { Start(os.Getenv("METRICS_ADDR")) }

// UnaryInterceptor instruments unary gRPC handlers. Long-lived streams
// (PushEvents/StreamEvents) are deliberately not intercepted: they never
// settle, only start counts would be meaningful.
func UnaryInterceptor() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		start := time.Now()
		resp, err := handler(ctx, req)
		grpcRequests.WithLabelValues(info.FullMethod, status.Code(err).String()).Inc()
		grpcDuration.WithLabelValues(info.FullMethod).Observe(time.Since(start).Seconds())
		return resp, err
	}
}

// HTTPMiddleware instruments an http.Handler by request path.
func HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, code: 200}
		next.ServeHTTP(rec, r)
		httpRequests.WithLabelValues(r.URL.Path, r.Method, strconv.Itoa(rec.code)).Inc()
		httpDuration.WithLabelValues(r.URL.Path, r.Method).Observe(time.Since(start).Seconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (r *statusRecorder) WriteHeader(code int) { r.code = code; r.ResponseWriter.WriteHeader(code) }
