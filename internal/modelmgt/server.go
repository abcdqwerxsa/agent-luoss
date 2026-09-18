package modelmgt

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"crypto/cipher"

	"agentluoss/internal/auditx"
	"agentluoss/internal/cryptx"
	"agentluoss/internal/task"
	modelmgtpb "agentluoss/proto/gen/modelmgt"
	runtimpb "agentluoss/proto/gen/runtime"
)

type Server struct {
	modelmgtpb.UnimplementedModelMgtServer
	store     *Store
	rdb       *redis.Client
	aead      cipher.AEAD
	configDir string
	registry  *task.RuntimeRegistry
	clients   *task.RuntimeClients
	renderMu  sync.Mutex
}

func NewServer(db *pgxpool.Pool, rdb *redis.Client, master, configDir string) *Server {
	return &Server{
		store:     NewStore(db),
		rdb:       rdb,
		aead:      cryptx.Cipher(master),
		configDir: configDir,
		registry:  task.NewRegistry(rdb),
		clients:   task.NewRuntimeClients(),
	}
}

func (s *Server) Register(g *grpc.Server) { modelmgtpb.RegisterModelMgtServer(g, s) }

func (s *Server) afterChange(ctx context.Context, actor, action string) {
	if err := s.Render(ctx); err != nil {
		log.Printf("render models.json failed: %v", err)
	}
	s.notifyRuntimes(ctx)
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: actor, Action: action, Resource: "models"})
}

// Render writes models.json (pi format) into configDir with 0600 perms.
func (s *Server) Render(ctx context.Context) error {
	s.renderMu.Lock()
	defer s.renderMu.Unlock()
	providers, err := s.store.ListProviders(ctx)
	if err != nil {
		return err
	}
	models, err := s.store.ListModels(ctx, false)
	if err != nil {
		return err
	}
	byProvider := map[string][]*Model{}
	for _, m := range models {
		byProvider[m.ProviderID] = append(byProvider[m.ProviderID], m)
	}

	out := map[string]any{"providers": map[string]any{}}
	for _, p := range providers {
		if !p.Enabled {
			continue
		}
		key := ""
		if p.APIKey != "" {
			// p.APIKey holds the encrypted value from DB; decrypt for render
			if k, err := cryptx.Decrypt(s.aead, p.APIKey); err == nil {
				key = k
			} else {
				log.Printf("decrypt key for provider %s failed: %v", p.ID, err)
			}
		}
		pm := map[string]any{
			"baseUrl": p.BaseURL,
			"api":     p.APIType,
			"models":  []any{},
		}
		if key != "" {
			pm["apiKey"] = key
		}
		list := []any{}
		for _, m := range byProvider[p.ID] {
			if !m.Enabled {
				continue
			}
			mm := map[string]any{
				"id": m.ModelID,
			}
			if m.DisplayName != "" {
				mm["name"] = m.DisplayName
			}
			if m.ContextWindow > 0 {
				mm["contextWindow"] = m.ContextWindow
			}
			if m.MaxTokens > 0 {
				mm["maxTokens"] = m.MaxTokens
			}
			if m.InputCost > 0 || m.OutputCost > 0 {
				mm["cost"] = map[string]any{"input": m.InputCost, "output": m.OutputCost}
			}
			if m.Reasoning {
				mm["reasoning"] = true
			}
			list = append(list, mm)
		}
		pm["models"] = list
		out["providers"].(map[string]any)[p.ID] = pm
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.configDir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(s.configDir, ".models.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.configDir, "models.json"))
}

// notifyRuntimes asks every healthy runtime to reload config (best effort).
func (s *Server) notifyRuntimes(ctx context.Context) {
	for _, rt := range s.registry.List(ctx) {
		cl, err := s.clients.Get(rt.ID, rt.Addr)
		if err != nil {
			continue
		}
		if _, err := cl.ReloadConfig(ctx, &runtimpb.ReloadConfigRequest{}); err != nil {
			log.Printf("reload on %s failed: %v", rt.ID, err)
		}
	}
}

func errCode(err error) error {
	if err == ErrNotFound {
		return status.Error(codes.NotFound, err.Error())
	}
	return status.Error(codes.Internal, err.Error())
}

func actor(ctx context.Context) string {
	return task.MDGet(ctx, "x-user-id")
}

func (s *Server) adminOnly(ctx context.Context) error {
	if task.MDGet(ctx, "x-user-role") != "admin" {
		return status.Error(codes.PermissionDenied, "admin only")
	}
	return nil
}

func (s *Server) UpsertProvider(ctx context.Context, req *modelmgtpb.UpsertProviderRequest) (*modelmgtpb.UpsertProviderResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	p := req.GetProvider()
	if p.GetId() == "" || p.GetBaseUrl() == "" {
		return nil, status.Error(codes.InvalidArgument, "id and base_url required")
	}
	apiKey := p.GetApiKey()
	if apiKey != "" {
		enc, err := cryptx.Encrypt(s.aead, apiKey)
		if err != nil {
			return nil, errCode(err)
		}
		apiKey = enc
	}
	apiType := p.GetApiType()
	if apiType == "" {
		apiType = "openai-completions"
	}
	if err := s.store.UpsertProvider(ctx, &Provider{
		ID: p.GetId(), Name: p.GetName(), BaseURL: p.GetBaseUrl(),
		APIType: apiType, APIKey: apiKey, Enabled: p.GetEnabled(),
	}); err != nil {
		return nil, errCode(err)
	}
	s.afterChange(ctx, actor(ctx), "model.upsert_provider")
	return &modelmgtpb.UpsertProviderResponse{}, nil
}

func (s *Server) DeleteProvider(ctx context.Context, req *modelmgtpb.DeleteProviderRequest) (*modelmgtpb.DeleteProviderResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if err := s.store.DeleteProvider(ctx, req.GetProviderId()); err != nil {
		return nil, errCode(err)
	}
	s.afterChange(ctx, actor(ctx), "model.delete_provider")
	return &modelmgtpb.DeleteProviderResponse{}, nil
}

func (s *Server) UpsertModel(ctx context.Context, req *modelmgtpb.UpsertModelRequest) (*modelmgtpb.UpsertModelResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	m := req.GetModel()
	if m.GetProviderId() == "" || m.GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "provider_id and model_id required")
	}
	if err := s.store.UpsertModel(ctx, &Model{
		ProviderID: m.GetProviderId(), ModelID: m.GetId(), DisplayName: m.GetDisplayName(),
		ContextWindow: m.GetContextWindow(), MaxTokens: m.GetMaxTokens(),
		InputCost: m.GetInputCost(), OutputCost: m.GetOutputCost(),
		Reasoning: m.GetReasoning(), Enabled: m.GetEnabled(),
	}); err != nil {
		return nil, errCode(err)
	}
	s.afterChange(ctx, actor(ctx), "model.upsert_model")
	return &modelmgtpb.UpsertModelResponse{}, nil
}

func (s *Server) DeleteModel(ctx context.Context, req *modelmgtpb.DeleteModelRequest) (*modelmgtpb.DeleteModelResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if err := s.store.DeleteModel(ctx, req.GetProviderId(), req.GetModelId()); err != nil {
		return nil, errCode(err)
	}
	s.afterChange(ctx, actor(ctx), "model.delete_model")
	return &modelmgtpb.DeleteModelResponse{}, nil
}

func (s *Server) ListProviders(ctx context.Context, _ *modelmgtpb.ListProvidersRequest) (*modelmgtpb.ListProvidersResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	providers, err := s.store.ListProviders(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	resp := &modelmgtpb.ListProvidersResponse{}
	for _, p := range providers {
		resp.Providers = append(resp.Providers, &modelmgtpb.Provider{
			Id: p.ID, Name: p.Name, BaseUrl: p.BaseURL, ApiType: p.APIType,
			ApiKey: mask(p.APIKey), Enabled: p.Enabled,
		})
	}
	return resp, nil
}

func (s *Server) ListModels(ctx context.Context, _ *modelmgtpb.ListModelsRequest) (*modelmgtpb.ListModelsResponse, error) {
	models, err := s.store.ListModels(ctx, true)
	if err != nil {
		return nil, errCode(err)
	}
	resp := &modelmgtpb.ListModelsResponse{}
	for _, m := range models {
		resp.Models = append(resp.Models, &modelmgtpb.Model{
			ProviderId: m.ProviderID, Id: m.ModelID, DisplayName: m.DisplayName,
			ContextWindow: m.ContextWindow, MaxTokens: m.MaxTokens,
			InputCost: m.InputCost, OutputCost: m.OutputCost,
			Reasoning: m.Reasoning, Enabled: m.Enabled,
		})
	}
	return resp, nil
}

func mask(s string) string {
	if s == "" {
		return ""
	}
	return "•••••"
}

var _ = fmt.Sprintf
