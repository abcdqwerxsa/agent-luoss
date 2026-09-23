// Package grpcx provides shared gRPC server bootstrap used by all services.
package grpcx

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"agentluoss/internal/metricsx"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

// stopGrace bounds graceful shutdown. Long-lived streams (PushEvents,
// StreamEvents) never settle on their own; without a deadline GracefulStop
// hangs until the container runtime SIGKILLs us. 8s < docker's 10s default.
const stopGrace = 8 * time.Second

// Serve registers health + reflection, listens on the given port and blocks
// until SIGINT/SIGTERM. register is called with the server before startup.
// METRICS_ADDR (optional) starts a Prometheus/pprof endpoint for this service.
func Serve(port int, register func(s *grpc.Server)) error {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("listen :%d: %w", port, err)
	}
	metricsx.StartFromEnv()
	s := grpc.NewServer(
		grpc.MaxRecvMsgSize(16<<20), grpc.MaxSendMsgSize(16<<20),
		grpc.ChainUnaryInterceptor(metricsx.UnaryInterceptor()),
	)
	healthpb.RegisterHealthServer(s, health.NewServer())
	reflection.Register(s)
	if register != nil {
		register(s)
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		done := make(chan struct{})
		go func() {
			s.GracefulStop()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(stopGrace):
			log.Printf("grpc shutdown grace exceeded, forcing stop")
			s.Stop()
		}
	}()

	log.Printf("grpc listening on :%d", port)
	return s.Serve(ln)
}
