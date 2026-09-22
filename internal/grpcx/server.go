// Package grpcx provides shared gRPC server bootstrap used by all services.
package grpcx

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/reflection"
)

// Serve registers health + reflection, listens on the given port and blocks
// until SIGINT/SIGTERM. register is called with the server before startup.
func Serve(port int, register func(s *grpc.Server)) error {
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("listen :%d: %w", port, err)
	}
	s := grpc.NewServer(grpc.MaxRecvMsgSize(16<<20), grpc.MaxSendMsgSize(16<<20))
	healthpb.RegisterHealthServer(s, health.NewServer())
	reflection.Register(s)
	if register != nil {
		register(s)
	}

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		s.GracefulStop()
	}()

	log.Printf("grpc listening on :%d", port)
	return s.Serve(ln)
}
