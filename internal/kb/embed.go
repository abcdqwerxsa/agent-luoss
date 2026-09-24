// Embedding client: resolves the embedding model from modelmgt admin config
// (provider+model with kind=embedding), calls the OpenAI-compatible
// /embeddings endpoint. Cached; falls back to nil (lexical-only) when
// unconfigured or pgvector is absent.
package kb

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	modelmgtpb "agentluoss/proto/gen/modelmgt"
)

type embedClient struct {
	mm       modelmgtpb.ModelMgtClient
	http     *http.Client
	mu       sync.Mutex
	cached   *modelmgtpb.GetEmbeddingConfigResponse
	fetched  time.Time
	failUntil time.Time
}

// errNoEmbed: no embedding model configured in modelmgt (lexical-only mode).
var errNoEmbed = errors.New("no embedding model configured")

func newEmbedClient(mm modelmgtpb.ModelMgtClient, hc *http.Client) *embedClient {
	return &embedClient{mm: mm, http: hc}
}

// config returns the active embedding config (60s cache, 30s backoff on
// miss/failure). nil = no embedding model configured.
func (e *embedClient) config(ctx context.Context) *modelmgtpb.GetEmbeddingConfigResponse {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cached != nil && time.Since(e.fetched) < time.Minute {
		return e.cached
	}
	if time.Now().Before(e.failUntil) {
		return e.cached // stale is better than hammering modelmgt
	}
	if e.mm == nil {
		return nil
	}
	cfg, err := e.mm.GetEmbeddingConfig(ctx, &modelmgtpb.GetEmbeddingConfigRequest{})
	if err != nil {
		e.failUntil = time.Now().Add(30 * time.Second)
		return e.cached
	}
	e.cached, e.fetched = cfg, time.Now()
	return e.cached
}

// EmbedTexts calls POST {base}/embeddings with the batch, returns vectors in
// input order.
func (e *embedClient) EmbedTexts(ctx context.Context, texts []string) ([][]float32, string, error) {
	cfg := e.config(ctx)
	if cfg == nil {
		return nil, "", errNoEmbed
	}
	body, _ := json.Marshal(map[string]any{"model": cfg.GetModelId(), "input": texts})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(cfg.GetBaseUrl(), "/")+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	if cfg.GetApiKey() != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.GetApiKey())
	}
	resp, err := e.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b := make([]byte, 512)
		n, _ := resp.Body.Read(b)
		return nil, "", fmt.Errorf("embeddings http %d: %s", resp.StatusCode, b[:n])
	}
	var out struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, "", err
	}
	if len(out.Data) != len(texts) {
		return nil, "", fmt.Errorf("embeddings: got %d vectors for %d texts", len(out.Data), len(texts))
	}
	vecs := make([][]float32, len(texts))
	for _, d := range out.Data {
		if d.Index < len(vecs) {
			vecs[d.Index] = d.Embedding
		}
	}
	return vecs, cfg.GetProviderId() + "/" + cfg.GetModelId(), nil
}

// VecToLiteral renders a float slice as a pgvector literal '[0.1,0.2,...]'.
func VecToLiteral(v []float32) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, f := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		if math.IsNaN(float64(f)) || math.IsInf(float64(f), 0) {
			f = 0
		}
		fmt.Fprintf(&b, "%.6g", f)
	}
	b.WriteByte(']')
	return b.String()
}
