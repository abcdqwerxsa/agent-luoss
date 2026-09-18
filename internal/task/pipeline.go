package task

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	taskpb "agentluoss/proto/gen/task"
)

// Pipeline: assigns seq numbers, persists events to a Redis Stream
// (SSE replay log, 7d TTL) and fans out to live subscribers.
type Pipeline struct {
	rdb *redis.Client

	mu   sync.Mutex
	subs map[string]map[int]chan *taskpb.AgentEvent
	subSeq int
}

func NewPipeline(rdb *redis.Client) *Pipeline {
	return &Pipeline{rdb: rdb, subs: map[string]map[int]chan *taskpb.AgentEvent{}}
}

const eventTTL = 7 * 24 * time.Hour

// Ingest assigns seq, persists, fans out. Returns the stored event.
func (p *Pipeline) Ingest(ctx context.Context, ev *taskpb.AgentEvent) (*taskpb.AgentEvent, error) {
	seq, err := p.rdb.Incr(ctx, "seq:task:"+ev.TaskId).Result()
	if err != nil {
		return nil, err
	}
	ev.Seq = seq
	ev.Timestamp = nowMs()
	b, err := json.Marshal(ev)
	if err != nil {
		return nil, err
	}
	pipe := p.rdb.Pipeline()
	pipe.XAdd(ctx, &redis.XAddArgs{
		Stream: "stream:task:" + ev.TaskId,
		Values: map[string]any{"data": string(b)},
	})
	pipe.Expire(ctx, "stream:task:"+ev.TaskId, eventTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}

	p.mu.Lock()
	if chans, ok := p.subs[ev.TaskId]; ok {
		for _, ch := range chans {
			select {
			case ch <- ev:
			default: // slow consumer: live feed skips; replay covers via SSE reconnect
			}
		}
	}
	p.mu.Unlock()
	return ev, nil
}

// Subscribe returns a live channel plus a cancel func. The channel is buffered;
// overflow is dropped (clients recover via Last-Event-ID replay).
func (p *Pipeline) Subscribe(taskID string) (<-chan *taskpb.AgentEvent, func()) {
	ch := make(chan *taskpb.AgentEvent, 256)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.subs[taskID] == nil {
		p.subs[taskID] = map[int]chan *taskpb.AgentEvent{}
	}
	p.subSeq++
	id := p.subSeq
	p.subs[taskID][id] = ch
	return ch, func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		delete(p.subs[taskID], id)
		if len(p.subs[taskID]) == 0 {
			delete(p.subs, taskID)
		}
	}
}

// Replay returns events with seq > since, up to limit.
func (p *Pipeline) Replay(ctx context.Context, taskID string, since int64, limit int) ([]*taskpb.AgentEvent, error) {
	stream := "stream:task:" + taskID
	last := "0"
	if since > 0 {
		last = strconv.FormatInt(since, 10)
	}
	// Map seq→entry id: entries were added one value each, ids are <ms>-<seqInMs>.
	// We can't map seq to redis id directly, so scan from last known time bucket.
	// Simplest correct approach: read whole stream (bounded by 7d of one task)
	// and filter in memory.
	entries, err := p.rdb.XRange(ctx, stream, "-", "+").Result()
	if err != nil {
		return nil, err
	}
	out := make([]*taskpb.AgentEvent, 0, 64)
	for _, e := range entries {
		raw, ok := e.Values["data"].(string)
		if !ok {
			continue
		}
		var ev taskpb.AgentEvent
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			continue
		}
		if ev.Seq > since {
			out = append(out, &ev)
		}
	}
	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	_ = last
	return out, nil
}

// LatestSeq returns the max seq persisted for a task (0 if none).
func (p *Pipeline) LatestSeq(ctx context.Context, taskID string) int64 {
	n, err := p.rdb.Get(ctx, "seq:task:"+taskID).Int64()
	if err != nil {
		return 0
	}
	return n
}

func nowMs() int64 { return time.Now().UnixMilli() }

var _ = fmt.Sprintf
