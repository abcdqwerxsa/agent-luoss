// Model management REST routes: user-facing model list + admin CRUD.
package gateway

import (
	"github.com/gin-gonic/gin"

	modelmgtpb "agentluoss/proto/gen/modelmgt"
)

func (a *App) registerModelRoutes(authed, admin *gin.RouterGroup) {
	authed.GET("/models", a.listModels)

	admin.GET("/admin/providers", a.listProviders)
	admin.PUT("/admin/providers", a.upsertProvider)
	admin.DELETE("/admin/providers", a.deleteProvider)
	admin.POST("/admin/providers/fetch-models", a.fetchProviderModels)
	admin.PUT("/admin/models", a.upsertModel)
	admin.DELETE("/admin/models", a.deleteModel)
	admin.POST("/admin/models/test", a.testModel)
	admin.GET("/admin/models/all", a.listAllModels)
}

func (a *App) listModels(c *gin.Context) {
	resp, err := a.modelmgt.ListModels(outCtx(c), &modelmgtpb.ListModelsRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	models := make([]gin.H, 0, len(resp.Models))
	for _, m := range resp.Models {
		models = append(models, gin.H{
			"provider_id": m.GetProviderId(), "model_id": m.GetId(),
			"display_name": m.GetDisplayName(), "context_window": m.GetContextWindow(),
			"input_cost": m.GetInputCost(), "output_cost": m.GetOutputCost(),
			"reasoning": m.GetReasoning(),
		})
	}
	c.JSON(200, gin.H{"models": models})
}

func (a *App) listProviders(c *gin.Context) {
	resp, err := a.modelmgt.ListProviders(outCtx(c), &modelmgtpb.ListProvidersRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	providers := make([]gin.H, 0, len(resp.Providers))
	for _, p := range resp.Providers {
		providers = append(providers, gin.H{
			"id": p.GetId(), "name": p.GetName(), "base_url": p.GetBaseUrl(),
			"api_type": p.GetApiType(), "has_key": p.GetApiKey() != "", "enabled": p.GetEnabled(),
		})
	}
	c.JSON(200, gin.H{"providers": providers})
}

func (a *App) upsertProvider(c *gin.Context) {
	var req struct {
		ID      string `json:"id" binding:"required"`
		Name    string `json:"name"`
		BaseURL string `json:"base_url" binding:"required"`
		APIType string `json:"api_type"`
		APIKey  string `json:"api_key"`
		Enabled bool   `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "id and base_url required"})
		return
	}
	if _, err := a.modelmgt.UpsertProvider(outCtx(c), &modelmgtpb.UpsertProviderRequest{
		Provider: &modelmgtpb.Provider{
			Id: req.ID, Name: req.Name, BaseUrl: req.BaseURL,
			ApiType: req.APIType, ApiKey: req.APIKey, Enabled: req.Enabled,
		},
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) deleteProvider(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		id = c.Query("id")
	}
	if _, err := a.modelmgt.DeleteProvider(outCtx(c), &modelmgtpb.DeleteProviderRequest{ProviderId: id}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) upsertModel(c *gin.Context) {
	var req struct {
		ProviderID    string  `json:"provider_id" binding:"required"`
		ModelID       string  `json:"model_id" binding:"required"`
		DisplayName   string  `json:"display_name"`
		ContextWindow int64   `json:"context_window"`
		MaxTokens     int64   `json:"max_tokens"`
		InputCost     float64 `json:"input_cost"`
		OutputCost    float64 `json:"output_cost"`
		Reasoning     bool    `json:"reasoning"`
		Enabled       bool    `json:"enabled"`
		Tier          string  `json:"tier"` // "" | "strong" | "weak"
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "provider_id and model_id required"})
		return
	}
	if _, err := a.modelmgt.UpsertModel(outCtx(c), &modelmgtpb.UpsertModelRequest{
		Model: &modelmgtpb.Model{
			ProviderId: req.ProviderID, Id: req.ModelID, DisplayName: req.DisplayName,
			ContextWindow: req.ContextWindow, MaxTokens: req.MaxTokens,
			InputCost: req.InputCost, OutputCost: req.OutputCost,
			Reasoning: req.Reasoning, Enabled: req.Enabled, Tier: req.Tier,
		},
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) deleteModel(c *gin.Context) {
	if _, err := a.modelmgt.DeleteModel(outCtx(c), &modelmgtpb.DeleteModelRequest{
		ProviderId: c.Query("provider_id"), ModelId: c.Query("model_id"),
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// listAllModels returns enabled+disabled models for the admin table.
func (a *App) listAllModels(c *gin.Context) {
	resp, err := a.modelmgt.ListModels(outCtx(c), &modelmgtpb.ListModelsRequest{All: true})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	models := make([]gin.H, 0, len(resp.Models))
	for _, m := range resp.Models {
		models = append(models, gin.H{
			"provider_id": m.GetProviderId(), "model_id": m.GetId(),
			"display_name": m.GetDisplayName(), "context_window": m.GetContextWindow(),
			"input_cost": m.GetInputCost(), "output_cost": m.GetOutputCost(),
			"reasoning": m.GetReasoning(), "enabled": m.GetEnabled(), "tier": m.GetTier(),
		})
	}
	c.JSON(200, gin.H{"models": models})
}

func (a *App) fetchProviderModels(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		id = c.Query("id")
	}
	resp, err := a.modelmgt.FetchProviderModels(outCtx(c), &modelmgtpb.FetchProviderModelsRequest{
		ProviderId: id,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"model_ids": resp.GetModelIds()})
}

func (a *App) testModel(c *gin.Context) {
	var req struct {
		ProviderID string `json:"provider_id" binding:"required"`
		ModelID    string `json:"model_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "provider_id and model_id required"})
		return
	}
	resp, err := a.modelmgt.TestModel(outCtx(c), &modelmgtpb.TestModelRequest{
		ProviderId: req.ProviderID, ModelId: req.ModelID,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": resp.GetOk(), "error": resp.GetError(), "latency_ms": resp.GetLatencyMs()})
}
