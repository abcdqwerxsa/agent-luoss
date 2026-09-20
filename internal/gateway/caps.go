// Caps + departments REST routes (admin).
package gateway

import (
	"encoding/json"
	"io"
	"strconv"

	"github.com/gin-gonic/gin"

	capspb "agentluoss/proto/gen/caps"
	iampb "agentluoss/proto/gen/iam"
)

func (a *App) registerCapsRoutes(admin *gin.RouterGroup) {
	// departments (backed by iam)
	admin.GET("/admin/departments", a.listDepartments)
	admin.POST("/admin/departments", a.createDepartment)
	admin.PATCH("/admin/departments/:id", a.updateDepartment)
	admin.DELETE("/admin/departments/:id", a.deleteDepartment)

	// MCP servers (backed by caps)
	admin.GET("/admin/mcp", a.listMcp)
	admin.PUT("/admin/mcp", a.upsertMcp)
	admin.DELETE("/admin/mcp/:id", a.deleteMcp)

	// skills (backed by caps; content via zip upload)
	admin.GET("/admin/skills", a.listSkills)
	admin.PUT("/admin/skills", a.upsertSkill)
	admin.POST("/admin/skills/upload", a.uploadSkill)
	admin.DELETE("/admin/skills/:id", a.deleteSkill)
}

// ---- departments ----

func (a *App) listDepartments(c *gin.Context) {
	resp, err := a.iam.ListDepartments(outCtx(c), &iampb.ListDepartmentsRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	out := []gin.H{}
	for _, d := range resp.GetDepartments() {
		out = append(out, gin.H{"id": d.GetId(), "name": d.GetName(), "created_at": d.GetCreatedAt()})
	}
	c.JSON(200, gin.H{"departments": out})
}

func (a *App) createDepartment(c *gin.Context) {
	var req struct {
		ID   string `json:"id"`
		Name string `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resp, err := a.iam.CreateDepartment(outCtx(c), &iampb.CreateDepartmentRequest{Id: req.ID, Name: req.Name})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"department": gin.H{"id": resp.GetDepartment().GetId(), "name": resp.GetDepartment().GetName()}})
}

func (a *App) updateDepartment(c *gin.Context) {
	var req struct {
		Name string `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resp, err := a.iam.UpdateDepartment(outCtx(c), &iampb.UpdateDepartmentRequest{Id: c.Param("id"), Name: req.Name})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"department": gin.H{"id": resp.GetDepartment().GetId(), "name": resp.GetDepartment().GetName()}})
}

func (a *App) deleteDepartment(c *gin.Context) {
	if _, err := a.iam.DeleteDepartment(outCtx(c), &iampb.DeleteDepartmentRequest{Id: c.Param("id")}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ---- MCP servers ----

func mcpJSON(m *capspb.McpServerDef) gin.H {
	scopes := []gin.H{}
	for _, s := range m.GetScopes() {
		scopes = append(scopes, gin.H{"type": s.GetType(), "value": s.GetValue()})
	}
	return gin.H{
		"id": m.GetId(), "name": m.GetName(), "transport": m.GetTransport(),
		"command": m.GetCommand(), "args": m.GetArgs(), "url": m.GetUrl(),
		"env": m.GetEnv(), "enabled": m.GetEnabled(), "scopes": scopes,
	}
}

func scopesFromJSON(in []gin.H) []*capspb.Scope {
	out := []*capspb.Scope{}
	for _, s := range in {
		t, _ := s["type"].(string)
		v, _ := s["value"].(string)
		out = append(out, &capspb.Scope{Type: t, Value: v})
	}
	return out
}

func (a *App) listMcp(c *gin.Context) {
	resp, err := a.caps.ListMcpServers(outCtx(c), &capspb.ListMcpServersRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	out := []gin.H{}
	for _, m := range resp.GetServers() {
		out = append(out, mcpJSON(m))
	}
	c.JSON(200, gin.H{"servers": out})
}

func (a *App) upsertMcp(c *gin.Context) {
	var req struct {
		ID        string   `json:"id" binding:"required"`
		Name      string   `json:"name"`
		Transport string   `json:"transport" binding:"required"`
		Command   string   `json:"command"`
		Args      []string `json:"args"`
		Env       map[string]string `json:"env"`
		URL       string   `json:"url"`
		Enabled   *bool    `json:"enabled"`
		Scopes    []gin.H  `json:"scopes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	enabled := req.Enabled == nil || *req.Enabled
	if _, err := a.caps.UpsertMcpServer(outCtx(c), &capspb.UpsertMcpServerRequest{
		Server: &capspb.McpServerDef{
			Id: req.ID, Name: req.Name, Transport: req.Transport,
			Command: req.Command, Args: req.Args, Env: req.Env, Url: req.URL,
			Enabled: enabled, Scopes: scopesFromJSON(req.Scopes),
		},
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) deleteMcp(c *gin.Context) {
	if _, err := a.caps.DeleteMcpServer(outCtx(c), &capspb.DeleteMcpServerRequest{Id: c.Param("id")}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ---- skills ----

func skillJSON(k *capspb.SkillDef) gin.H {
	scopes := []gin.H{}
	for _, s := range k.GetScopes() {
		scopes = append(scopes, gin.H{"type": s.GetType(), "value": s.GetValue()})
	}
	return gin.H{
		"id": k.GetId(), "name": k.GetName(), "description": k.GetDescription(),
		"enabled": k.GetEnabled(), "scopes": scopes,
	}
}

func (a *App) listSkills(c *gin.Context) {
	resp, err := a.caps.ListSkills(outCtx(c), &capspb.ListSkillsRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	out := []gin.H{}
	for _, k := range resp.GetSkills() {
		out = append(out, skillJSON(k))
	}
	c.JSON(200, gin.H{"skills": out})
}

func (a *App) upsertSkill(c *gin.Context) {
	var req struct {
		ID      string  `json:"id" binding:"required"`
		Enabled *bool   `json:"enabled"`
		Scopes  []gin.H `json:"scopes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	enabled := req.Enabled == nil || *req.Enabled
	if _, err := a.caps.UpsertSkill(outCtx(c), &capspb.UpsertSkillRequest{
		Skill: &capspb.SkillDef{Id: req.ID, Enabled: enabled, Scopes: scopesFromJSON(req.Scopes)},
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// uploadSkill accepts multipart form: file=<skill.zip>, optional id, scopes (JSON), enabled.
func (a *App) uploadSkill(c *gin.Context) {
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(400, gin.H{"error": "file required"})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 10<<20)) // 10MB cap
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	enabled := true
	if v := c.PostForm("enabled"); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			enabled = b
		}
	}
	var scopes []*capspb.Scope
	if v := c.PostForm("scopes"); v != "" {
		var hs []gin.H
		if err := json.Unmarshal([]byte(v), &hs); err != nil {
			c.JSON(400, gin.H{"error": "bad scopes JSON"})
			return
		}
		scopes = scopesFromJSON(hs)
	}
	resp, err := a.caps.UploadSkill(outCtx(c), &capspb.UploadSkillRequest{
		Id: c.PostForm("id"), Zip: data, Scopes: scopes, Enabled: enabled,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"skill": skillJSON(resp.GetSkill())})
}

func (a *App) deleteSkill(c *gin.Context) {
	if _, err := a.caps.DeleteSkill(outCtx(c), &capspb.DeleteSkillRequest{Id: c.Param("id")}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

// ---- experts ----

func expertJSON(e *capspb.ExpertDef) gin.H {
	scopes := []gin.H{}
	for _, s := range e.GetScopes() {
		scopes = append(scopes, gin.H{"type": s.GetType(), "value": s.GetValue()})
	}
	return gin.H{
		"id": e.GetId(), "name": e.GetName(), "description": e.GetDescription(),
		"enabled": e.GetEnabled(), "skill_ids": e.GetSkillIds(), "mcp_ids": e.GetMcpIds(),
		"scopes": scopes,
	}
}

func (a *App) registerExpertAdminRoutes(admin *gin.RouterGroup) {
	admin.GET("/admin/experts", a.listExperts)
	admin.PUT("/admin/experts", a.upsertExpert)
	admin.DELETE("/admin/experts/:id", a.deleteExpert)
}

// user-facing: experts visible to the current user
func (a *App) registerExpertUserRoutes(authed *gin.RouterGroup) {
	authed.GET("/experts", a.myExperts)
}

func (a *App) listExperts(c *gin.Context) {
	resp, err := a.caps.ListExperts(outCtx(c), &capspb.ListExpertsRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	out := []gin.H{}
	for _, e := range resp.GetExperts() {
		out = append(out, expertJSON(e))
	}
	c.JSON(200, gin.H{"experts": out})
}

func (a *App) upsertExpert(c *gin.Context) {
	var req struct {
		ID          string   `json:"id" binding:"required"`
		Name        string   `json:"name" binding:"required"`
		Description string   `json:"description"`
		Enabled     *bool    `json:"enabled"`
		SkillIDs    []string `json:"skill_ids"`
		McpIDs      []string `json:"mcp_ids"`
		Scopes      []gin.H  `json:"scopes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	enabled := req.Enabled == nil || *req.Enabled
	if _, err := a.caps.UpsertExpert(outCtx(c), &capspb.UpsertExpertRequest{
		Expert: &capspb.ExpertDef{
			Id: req.ID, Name: req.Name, Description: req.Description, Enabled: enabled,
			SkillIds: req.SkillIDs, McpIds: req.McpIDs, Scopes: scopesFromJSON(req.Scopes),
		},
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) deleteExpert(c *gin.Context) {
	if _, err := a.caps.DeleteExpert(outCtx(c), &capspb.DeleteExpertRequest{Id: c.Param("id")}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) myExperts(c *gin.Context) {
	resp, err := a.caps.ListExpertsForUser(outCtx(c), &capspb.ListExpertsForUserRequest{UserId: c.GetString("user_id")})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	out := []gin.H{}
	for _, e := range resp.GetExperts() {
		out = append(out, expertJSON(e))
	}
	c.JSON(200, gin.H{"experts": out})
}
