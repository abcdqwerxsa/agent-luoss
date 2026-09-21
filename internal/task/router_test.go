package task

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

const testModels = `{
 "providers": {
  "gw": {"baseUrl": "https://x", "models": [
   {"id": "mini", "cost": {"input": 0.1, "output": 0.2}},
   {"id": "flash", "cost": {"input": 0.3, "output": 0.4}},
   {"id": "pro", "reasoning": true, "cost": {"input": 2, "output": 6}},
   {"id": "max", "reasoning": true, "cost": {"input": 5, "output": 10}}
  ]}
 }
}`

// tieredModels: explicit admin tiers override reasoning flags — "lite" is
// flagged reasoning=true but tiered weak; "std" is non-reasoning but tiered
// strong; "midi" (tier "") still derives from the reasoning flag.
const tieredModels = `{
 "providers": {
  "gw": {"baseUrl": "https://x", "models": [
   {"id": "lite", "reasoning": true, "tier": "weak"},
   {"id": "midi", "reasoning": false},
   {"id": "std", "tier": "strong"}
  ]}
 }
}`

func writeModels(t *testing.T, js string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(p, []byte(js), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// jevStub answers like the OpenRouter Decisions API with fixed probabilities.
func jevStub(t *testing.T, status int, pSimple, pComplex float64) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(fmt.Sprintf(`{"answers": {"difficulty": {"type": "choice", "choice": "simple",
			"probabilities": {"simple": %.2f, "complex": %.2f},
			"confidence": 0.9}}}`, pSimple, pComplex)))
	}))
}

func TestRouteNoKeyFailsOpenToStrong(t *testing.T) {
	r := NewRouter(writeModels(t, testModels), "", "", "")
	res, err := r.Resolve(context.Background(), "t", "hello world")
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "fallback" || res.ModelID != "max" || res.Provider != "gw" {
		t.Fatalf("want fallback to gw/max (priciest reasoning), got %+v", res)
	}
}

func TestRouteSimpleGoesWeakComplexGoesStrong(t *testing.T) {
	// top-ranked label drives the decision; simple at 0.92/0.08 passes the gate
	srv := jevStub(t, 200, 0.92, 0.08)
	defer srv.Close()
	r := NewRouter(writeModels(t, testModels), srv.URL, "k", "jev-test")

	res, err := r.Resolve(context.Background(), "t", "summarize this file")
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "simple" || res.ModelID != "mini" { // cheapest non-reasoning
		t.Fatalf("want simple->gw/mini, got %+v", res)
	}

	// complex at 0.95/0.05 -> strong
	srv2 := jevStub(t, 200, 0.05, 0.95)
	defer srv2.Close()
	r2 := NewRouter(writeModels(t, testModels), srv2.URL, "k", "jev-test")
	res2, err := r2.Resolve(context.Background(), "t", "debug this kernel panic")
	if err != nil {
		t.Fatal(err)
	}
	if res2.Decision != "complex" || res2.ModelID != "max" {
		t.Fatalf("want complex->gw/max, got %+v", res2)
	}
}

func TestRouteUncertainFailsOpenToStrong(t *testing.T) {
	// 0.6/0.4: probability below 0.8 gate
	srv := jevStub(t, 200, 0.6, 0.4)
	defer srv.Close()
	r := NewRouter(writeModels(t, testModels), srv.URL, "k", "jev-test")
	res, err := r.Resolve(context.Background(), "t", "ambiguous task")
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "fallback" || res.ModelID != "max" {
		t.Fatalf("want uncertain->fallback strong, got %+v", res)
	}
}

func TestRouteHTTPErrorFailsOpenToStrong(t *testing.T) {
	srv := jevStub(t, 500, 0, 0)
	defer srv.Close()
	r := NewRouter(writeModels(t, testModels), srv.URL, "k", "jev-test")
	res, err := r.Resolve(context.Background(), "t", "task")
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "fallback" || res.ModelID != "max" {
		t.Fatalf("want http-error->fallback strong, got %+v", res)
	}
}

func TestRouteOnlyWeakModelsConfigured(t *testing.T) {
	onlyWeak := `{"providers": {"gw": {"models": [{"id": "mini", "cost": {"input": 0.1}}]}}}`
	r := NewRouter(writeModels(t, onlyWeak), "", "", "")
	res, err := r.Resolve(context.Background(), "t", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if res.ModelID != "mini" {
		t.Fatalf("strong tier empty should collapse to weak, got %+v", res)
	}
}

func TestRouteNoModelsIsError(t *testing.T) {
	r := NewRouter(writeModels(t, `{}`), "", "", "")
	if _, err := r.Resolve(context.Background(), "t", "hello"); err == nil {
		t.Fatal("want error when no models configured")
	}
}

func TestExplicitTierOverridesReasoningFlag(t *testing.T) {
	// no key: fallback target is the strong representative = "std"
	// (tiered strong) despite being non-reasoning; "lite" (reasoning=true but
	// tiered weak) must NOT be picked as strong.
	r := NewRouter(writeModels(t, tieredModels), "", "", "")
	res, err := r.Resolve(context.Background(), "t", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if res.Decision != "fallback" || res.ModelID != "std" {
		t.Fatalf("want fallback->gw/std (tier strong), got %+v", res)
	}

	// confident simple decision: weak representative must be "lite"
	// (tiered weak), not "midi" (non-reasoning, tier "").
	srv := jevStub(t, 200, 0.92, 0.08)
	defer srv.Close()
	r2 := NewRouter(writeModels(t, tieredModels), srv.URL, "k", "jev-test")
	res2, err := r2.Resolve(context.Background(), "t", "summarize this")
	if err != nil {
		t.Fatal(err)
	}
	if res2.Decision != "simple" || res2.ModelID != "lite" {
		t.Fatalf("want simple->gw/lite (tier weak), got %+v", res2)
	}
}
