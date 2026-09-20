// Live provider queries: fetch model list (/models) and test a model
// (minimal completion). Keys are decrypted in-memory only.
package modelmgt

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"agentluoss/internal/cryptx"
	modelmgtpb "agentluoss/proto/gen/modelmgt"
)

var httpClient = &http.Client{Timeout: 30 * time.Second}

// providerWithKey loads a provider and decrypts its API key.
func (s *Server) providerWithKey(ctx context.Context, id string) (*Provider, string, error) {
	provs, err := s.store.ListProviders(ctx)
	if err != nil {
		return nil, "", err
	}
	for _, p := range provs {
		if p.ID == id {
			key := ""
			if p.APIKey != "" {
				if k, err := cryptx.Decrypt(s.aead, p.APIKey); err != nil {
					return nil, "", fmt.Errorf("decrypt key: %w", err)
				} else {
					key = k
				}
			}
			return p, key, nil
		}
	}
	return nil, "", ErrNotFound
}

func (s *Server) authHeaders(apiType, key string) map[string]string {
	if apiType == "anthropic-messages" {
		return map[string]string{
			"x-api-key":         key,
			"anthropic-version": "2023-06-01",
		}
	}
	return map[string]string{"Authorization": "Bearer " + key}
}

func trimSlash(u string) string { return strings.TrimSuffix(u, "/") }

// FetchProviderModels live-queries {base_url}/models (OpenAI-compatible).
func (s *Server) FetchProviderModels(ctx context.Context, req *modelmgtpb.FetchProviderModelsRequest) (*modelmgtpb.FetchProviderModelsResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	p, key, err := s.providerWithKey(ctx, req.GetProviderId())
	if err != nil {
		return nil, errCode(err)
	}
	hreq, _ := http.NewRequestWithContext(ctx, "GET", trimSlash(p.BaseURL)+"/models", nil)
	for k, v := range s.authHeaders(p.APIType, key) {
		hreq.Header.Set(k, v)
	}
	resp, err := httpClient.Do(hreq)
	if err != nil {
		return nil, status.Error(codes.Unavailable, fmt.Sprintf("provider unreachable: %v", err))
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return nil, status.Error(codes.Unavailable,
			fmt.Sprintf("provider returned %d: %.200s", resp.StatusCode, body))
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct { // some gateways use {"models": ["id", ...]}
			ID string `json:"id"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, status.Error(codes.Unavailable, "bad /models response: "+err.Error())
	}
	ids := map[string]bool{}
	res := &modelmgtpb.FetchProviderModelsResponse{}
	for _, m := range out.Data {
		if m.ID != "" && !ids[m.ID] {
			ids[m.ID] = true
			res.ModelIds = append(res.ModelIds, m.ID)
		}
	}
	for _, m := range out.Models {
		if m.ID != "" && !ids[m.ID] {
			ids[m.ID] = true
			res.ModelIds = append(res.ModelIds, m.ID)
		}
	}
	if len(res.ModelIds) == 0 {
		return nil, status.Error(codes.Unavailable, "no models in /models response")
	}
	return res, nil
}

// TestModel sends a 1-token completion and reports latency.
func (s *Server) TestModel(ctx context.Context, req *modelmgtpb.TestModelRequest) (*modelmgtpb.TestModelResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	p, key, err := s.providerWithKey(ctx, req.GetProviderId())
	if err != nil {
		return nil, errCode(err)
	}

	var url string
	payload := map[string]any{"model": req.GetModelId(), "max_tokens": 1, "stream": false}
	if p.APIType == "anthropic-messages" {
		url = trimSlash(p.BaseURL) + "/messages"
		payload["messages"] = []map[string]string{{"role": "user", "content": "hi"}}
	} else {
		url = trimSlash(p.BaseURL) + "/chat/completions"
		payload["messages"] = []map[string]string{{"role": "user", "content": "hi"}}
	}
	body, _ := json.Marshal(payload)

	hreq, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	hreq.Header.Set("Content-Type", "application/json")
	for k, v := range s.authHeaders(p.APIType, key) {
		hreq.Header.Set(k, v)
	}

	t0 := time.Now()
	resp, err := httpClient.Do(hreq)
	latency := time.Since(t0).Milliseconds()
	res := &modelmgtpb.TestModelResponse{LatencyMs: latency}
	if err != nil {
		res.Error = fmt.Sprintf("request failed: %v", err)
		return res, nil
	}
	defer resp.Body.Close()
	rbody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		res.Error = fmt.Sprintf("HTTP %d: %.300s", resp.StatusCode, rbody)
		return res, nil
	}
	res.Ok = true
	return res, nil
}
