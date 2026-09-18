package task

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// RuntimeRegistry tracks agent-runtime instances in Redis.
// Health = heartbeat key TTL. Scheduling uses active/max load ratio.
type RuntimeRegistry struct {
	rdb  *redis.Client
	mu   sync.RWMutex
	hbTTL, hbInterval time.Duration
}

func NewRegistry(rdb *redis.Client) *RuntimeRegistry {
	return &RuntimeRegistry{rdb: rdb, hbTTL: 15 * time.Second}
}

type runtimeInfo struct {
	ID     string `json:"id"`
	Addr   string `json:"addr"`
	Active int32  `json:"active"`
	Max    int32  `json:"max"`
}

func (r *RuntimeRegistry) Register(ctx context.Context, id, addr string) error {
	if err := r.rdb.SAdd(ctx, "runtime:ids", id).Err(); err != nil {
		return err
	}
	info := runtimeInfo{ID: id, Addr: addr, Max: 1}
	b, _ := json.Marshal(info)
	pipe := r.rdb.Pipeline()
	pipe.Set(ctx, "runtime:info:"+id, string(b), 24*time.Hour)
	pipe.Set(ctx, "runtime:hb:"+id, "1", r.hbTTL)
	_, err := pipe.Exec(ctx)
	return err
}

func (r *RuntimeRegistry) Heartbeat(ctx context.Context, id string, active, max int32) error {
	pipe := r.rdb.Pipeline()
	pipe.Set(ctx, "runtime:hb:"+id, "1", r.hbTTL)
	if info, err := r.Get(ctx, id); err == nil {
		info.Active, info.Max = active, max
		b, _ := json.Marshal(info)
		pipe.Set(ctx, "runtime:info:"+id, string(b), 24*time.Hour)
	}
	_, err := pipe.Exec(ctx)
	return err
}

func (r *RuntimeRegistry) Get(ctx context.Context, id string) (*runtimeInfo, error) {
	raw, err := r.rdb.Get(ctx, "runtime:info:"+id).Result()
	if err != nil {
		return nil, fmt.Errorf("runtime %s unknown", id)
	}
	var info runtimeInfo
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		return nil, err
	}
	if err := r.rdb.Get(ctx, "runtime:hb:"+id).Err(); err != nil {
		return nil, fmt.Errorf("runtime %s unhealthy", id)
	}
	return &info, nil
}

// List returns healthy runtimes, pruning stale ids.
func (r *RuntimeRegistry) List(ctx context.Context) []*runtimeInfo {
	ids, err := r.rdb.SMembers(ctx, "runtime:ids").Result()
	if err != nil {
		return nil
	}
	var out []*runtimeInfo
	for _, id := range ids {
		info, err := r.Get(ctx, id)
		if err != nil {
			r.rdb.SRem(ctx, "runtime:ids", id)
			continue
		}
		out = append(out, info)
	}
	return out
}

// Pick returns the least-loaded healthy runtime (min active/max, then fewer active).
func (r *RuntimeRegistry) Pick(ctx context.Context, exclude ...string) (*runtimeInfo, error) {
	list := r.List(ctx)
	skip := map[string]bool{}
	for _, e := range exclude {
		skip[e] = true
	}
	var best *runtimeInfo
	for _, rt := range list {
		if skip[rt.ID] || rt.Max <= 0 {
			continue
		}
		if best == nil ||
			float64(rt.Active)/float64(rt.Max) < float64(best.Active)/float64(best.Max) ||
			(rt.Active == best.Active && rt.Max > best.Max) {
			best = rt
		}
	}
	if best == nil {
		return nil, fmt.Errorf("no healthy agent-runtime available")
	}
	return best, nil
}

// ---- session locks ----

func (r *RuntimeRegistry) AcquireSessionLock(ctx context.Context, taskID string, ttl time.Duration) bool {
	return r.rdb.SetNX(ctx, "lock:session:"+taskID, "1", ttl).Val()
}

func (r *RuntimeRegistry) ReleaseSessionLock(ctx context.Context, taskID string) {
	r.rdb.Del(ctx, "lock:session:"+taskID)
}
