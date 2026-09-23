package task

import "testing"

// One runnable check for the watchdog decision logic: marker-vs-row fallback
// and the staleness window boundary. Side-effect chain (abort/status/synth)
// mirrors AbortTask and needs live PG+Redis; covered by deploy e2e instead.
func TestWatchdogStaleness(t *testing.T) {
	const cutoff = 1_000_000
	cases := []struct {
		name               string
		marker, rowUpdated int64
		hasMarker          bool
		wantStale          bool
	}{
		{"fresh marker", cutoff + 1, 0, true, false},
		{"marker exactly at cutoff is fresh", cutoff, 0, true, false},
		{"stale marker beats fresh row", cutoff - 1, cutoff + 100, true, true},
		{"no marker falls back to stale row", 0, cutoff - 1, false, true},
		{"no marker falls back to fresh row", 0, cutoff + 1, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			last := activityMs(c.marker, c.hasMarker, c.rowUpdated)
			if got := isStale(last, cutoff); got != c.wantStale {
				t.Fatalf("isStale(%d, %d) = %v, want %v", last, cutoff, got, c.wantStale)
			}
		})
	}
}
