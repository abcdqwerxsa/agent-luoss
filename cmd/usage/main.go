// usage service entrypoint. Business logic lands in later steps.
package main

import (
	"log"
	"os"
	"strconv"

	"agentluoss/internal/grpcx"
)

func main() {
	port, _ := strconv.Atoi(envOr("PORT", "9095"))
	log.Printf("usage starting on :%d", port)
	if err := grpcx.Serve(port, nil); err != nil {
		log.Fatal(err)
	}
}

func envOr(k, d string) string {
	if v, ok := os.LookupEnv(k); ok && v != "" {
		return v
	}
	return d
}
