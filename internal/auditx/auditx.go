// Package auditx publishes audit events to a Redis Stream ("audit").
// Consumers live in the usage service; producers never block on persistence.
package auditx

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

const Stream = "audit"

type Event struct {
	Actor    string          `json:"actor"`
	Action   string          `json:"action"`
	Resource string          `json:"resource"`
	Detail   json.RawMessage `json:"detail,omitempty"`
	IP       string          `json:"ip,omitempty"`
}

// Publish is fire-and-forget: audit loss is logged, never fatal.
func Publish(ctx context.Context, rdb *redis.Client, ev Event) {
	b, _ := json.Marshal(ev)
	err := rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: Stream,
		Values: map[string]any{
			"ts":   time.Now().UnixMilli(),
			"data": string(b),
		},
	}).Err()
	if err != nil {
		log.Printf("audit publish failed (action=%s): %v", ev.Action, err)
	}
}
