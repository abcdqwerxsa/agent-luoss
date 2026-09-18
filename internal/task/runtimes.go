package task

import (
	"fmt"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	runtimpb "agentluoss/proto/gen/runtime"
)

// RuntimeClients caches gRPC connections to agent-runtime instances,
// keyed by runtime id; invalidated on dial target change or failure.
type RuntimeClients struct {
	mu    sync.Mutex
	conns map[string]*runtimeConn
}

type runtimeConn struct {
	addr string
	cc   *grpc.ClientConn
	cl   runtimpb.AgentRuntimeClient
}

func NewRuntimeClients() *RuntimeClients {
	return &RuntimeClients{conns: map[string]*runtimeConn{}}
}

func (r *RuntimeClients) Get(id, addr string) (runtimpb.AgentRuntimeClient, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.conns[id]; ok {
		if c.addr == addr {
			return c.cl, nil
		}
		_ = c.cc.Close()
		delete(r.conns, id)
	}
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("dial runtime %s at %s: %w", id, addr, err)
	}
	c := &runtimeConn{addr: addr, cc: cc, cl: runtimpb.NewAgentRuntimeClient(cc)}
	r.conns[id] = c
	return c.cl, nil
}

func (r *RuntimeClients) Drop(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if c, ok := r.conns[id]; ok {
		_ = c.cc.Close()
		delete(r.conns, id)
	}
}

func (r *RuntimeClients) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, c := range r.conns {
		_ = c.cc.Close()
		delete(r.conns, id)
	}
}
