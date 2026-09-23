// Turn watchdog: a task stuck in running with no events for longer than
// the timeout is failed with a synthetic error event so the UI recovers and
// the user can continue the conversation. Also updates task gauges.
package task

import (
	"context"
	"log"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	runtimpb "agentluoss/proto/gen/runtime"
)

var (
	mRunning = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "task_running", Help: "tasks currently in status running",
	})
	mRuntimes = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "task_runtimes", Help: "healthy agent-runtimes registered",
	})
	mRtActive = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "task_runtime_sessions_active", Help: "sum of active sessions across runtimes",
	})
	mRtMax = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "task_runtime_sessions_max", Help: "sum of session capacity across runtimes",
	})
	mTimeouts = promauto.NewCounter(prometheus.CounterOpts{
		Name: "task_turn_timeouts_total", Help: "turns failed by the watchdog",
	})
)

const watchdogTick = time.Minute

// StartWatchdog launches the watchdog loop (one per process; no stop needed —
// it dies with the service).
func (s *Server) StartWatchdog(timeout time.Duration) {
	go func() {
		t := time.NewTicker(watchdogTick)
		defer t.Stop()
		for range t.C {
			s.watchdogOnce(context.Background(), timeout)
		}
	}()
	log.Printf("turn watchdog started (timeout %s)", timeout)
}

func (s *Server) watchdogOnce(ctx context.Context, timeout time.Duration) {
	running, err := s.store.ListRunning(ctx)
	if err != nil {
		return
	}
	mRunning.Set(float64(len(running)))
	rts := s.registry.List(ctx)
	mRuntimes.Set(float64(len(rts)))
	var act, max int64
	for _, rt := range rts {
		act += int64(rt.Active)
		max += int64(rt.Max)
	}
	mRtActive.Set(float64(act))
	mRtMax.Set(float64(max))

	cutoff := time.Now().Add(-timeout).UnixMilli()
	for _, r := range running {
		marker, err := s.rdb.Get(ctx, "task:lastev:"+r.ID).Int64()
		last := activityMs(marker, err == nil, r.UpdatedAt)
		if !isStale(last, cutoff) {
			continue
		}
		s.failStuckTurn(ctx, r, timeout)
	}
}

// activityMs picks the last-activity timestamp: the live event marker when
// present, else the row's updated_at (pre-deploy tasks / pruned markers).
func activityMs(marker int64, hasMarker bool, rowUpdated int64) int64 {
	if hasMarker {
		return marker
	}
	return rowUpdated
}

// isStale reports whether a turn last active at lastMs predates cutoffMs.
func isStale(lastMs, cutoffMs int64) bool { return lastMs < cutoffMs }

// failStuckTurn aborts the (hung) runtime turn best-effort, releases the
// session lock, marks the task failed and synthesizes an error event.
func (s *Server) failStuckTurn(ctx context.Context, r *runningRef, timeout time.Duration) {
	log.Printf("watchdog: failing stuck turn %s (no events for %s)", r.ID, timeout)
	if r.RuntimeID != "" {
		if rt, err := s.registry.Get(ctx, r.RuntimeID); err == nil {
			if cl, cerr := s.clients.Get(r.RuntimeID, rt.Addr); cerr == nil {
				abortCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
				_, _ = cl.Abort(abortCtx, &runtimpb.AbortRequest{TaskId: r.ID})
				cancel()
			}
		}
	}
	s.registry.ReleaseSessionLock(ctx, r.ID)
	_ = s.store.SetStatus(ctx, r.ID, "failed")
	s.synth(r.ID, "error", map[string]string{
		"message": "任务超过 " + timeout.String() + " 无响应，已自动终止；可继续对话重试",
	})
	mTimeouts.Inc()
}
