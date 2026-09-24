// Knowledge base REST endpoints: admin CRUD + department-member upload.
package gateway

import (
	"io"
	"strconv"

	"github.com/gin-gonic/gin"

	kbpb "agentluoss/proto/gen/kb"
)

func kbJSON(k *kbpb.KbInfo) gin.H {
	return gin.H{
		"id": k.GetId(), "name": k.GetName(),
		"scope":        gin.H{"type": k.GetScope().GetType(), "value": k.GetScope().GetValue()},
		"doc_count":    k.GetDocCount(),
		"mcp_entry_id": k.GetMcpEntryId(),
		"updated_at":   k.GetUpdatedAt(),
	}
}

func docJSON(d *kbpb.DocInfo) gin.H {
	return gin.H{
		"id": d.GetId(), "kb_id": d.GetKbId(), "filename": d.GetFilename(),
		"title": d.GetTitle(), "size": d.GetSize(), "uploader": d.GetUploader(),
		"status": d.GetStatus(), "error": d.GetError(), "updated_at": d.GetUpdatedAt(),
	}
}

func (a *App) registerKbAdminRoutes(admin *gin.RouterGroup) {
	admin.GET("/admin/kb", a.listKbs)
	admin.POST("/admin/kb", a.createKb)
	admin.DELETE("/admin/kb/:id", a.deleteKb)
	admin.GET("/admin/kb/:id/docs", a.listKbDocs)
	admin.DELETE("/admin/kb/docs/:docId", a.deleteKbDoc)
	admin.POST("/admin/kb/:id/docs", a.uploadKbDoc) // admin upload: no scope check
	admin.GET("/admin/kb/:id/search", a.searchKb) // debug + eval harness
	admin.POST("/admin/kb/reindex", a.reindexKb)  // body {kb_id?} empty = all
}

func (a *App) reindexKb(c *gin.Context) {
	var req struct {
		KbId string `json:"kb_id"`
	}
	_ = c.ShouldBindJSON(&req)
	r, err := a.kb.Reindex(outCtx(c), &kbpb.ReindexRequest{KbId: req.KbId})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"cleared": r.GetCleared()})
}

func (a *App) searchKb(c *gin.Context) {
	q := c.Query("q")
	if q == "" {
		c.JSON(400, gin.H{"error": "q required"})
		return
	}
	topK := 8
	if v, err := strconv.Atoi(c.Query("top_k")); err == nil {
		topK = v
	}
	r, err := a.kb.Search(outCtx(c), &kbpb.SearchRequest{KbId: c.Param("id"), Query: q, TopK: int32(topK)})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	hits := []gin.H{}
	for _, h := range r.GetHits() {
		hits = append(hits, gin.H{"doc_id": h.GetDocId(), "title": h.GetTitle(), "section": h.GetSection(), "score": h.GetScore(), "snippet": h.GetSnippet()})
	}
	c.JSON(200, gin.H{"hits": hits})
}

func (a *App) registerKbUserRoutes(authed *gin.RouterGroup) {
	authed.GET("/kb", a.listMyKbs)
	authed.POST("/kb/:id/docs", a.uploadKbDoc) // member upload: kb-svc checks scope
}

func (a *App) listKbs(c *gin.Context) {
	r, err := a.kb.ListKbs(outCtx(c), &kbpb.ListKbsRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	ks := []gin.H{}
	for _, k := range r.GetKbs() {
		ks = append(ks, kbJSON(k))
	}
	c.JSON(200, gin.H{"kbs": ks})
}

func (a *App) listMyKbs(c *gin.Context) {
	r, err := a.kb.ListKbsForUser(outCtx(c), &kbpb.ListKbsForUserRequest{UserId: userID(c)})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	ks := []gin.H{}
	for _, k := range r.GetKbs() {
		ks = append(ks, kbJSON(k))
	}
	c.JSON(200, gin.H{"kbs": ks})
}

func (a *App) createKb(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		name = c.PostForm("name")
	}
	if name == "" {
		c.JSON(400, gin.H{"error": "name required"})
		return
	}
	scope := &kbpb.Scope{Type: "all"}
	if st := c.Query("scope_type"); st != "" {
		scope.Type = st
		scope.Value = c.Query("scope_value")
	} else if st := c.PostForm("scope_type"); st != "" {
		scope.Type = st
		scope.Value = c.PostForm("scope_value")
	}
	r, err := a.kb.CreateKb(outCtx(c), &kbpb.CreateKbRequest{Name: name, Scope: scope})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"kb": kbJSON(r.GetKb())})
}

func (a *App) deleteKb(c *gin.Context) {
	if _, err := a.kb.DeleteKb(outCtx(c), &kbpb.DeleteKbRequest{Id: c.Param("id")}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) listKbDocs(c *gin.Context) {
	r, err := a.kb.ListDocs(outCtx(c), &kbpb.ListDocsRequest{KbId: c.Param("id")})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	ds := []gin.H{}
	for _, d := range r.GetDocs() {
		ds = append(ds, docJSON(d))
	}
	c.JSON(200, gin.H{"docs": ds})
}

// uploadKbDoc accepts multipart form: file=@doc, optional title.
// Same route serves admins (bypass) and members (kb-svc scope check).
func (a *App) uploadKbDoc(c *gin.Context) {
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
	data, err := io.ReadAll(io.LimitReader(f, 50<<20))
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	role := "user"
	if v, ok := c.Get("role"); ok {
		if s, ok := v.(string); ok {
			role = s
		}
	}
	r, err := a.kb.UploadDoc(outCtx(c), &kbpb.UploadDocRequest{
		KbId: c.Param("id"), Filename: fh.Filename, Content: data,
		Uploader: userID(c), UploaderRole: role,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"doc": docJSON(r.GetDoc())})
}

func (a *App) deleteKbDoc(c *gin.Context) {
	if _, err := a.kb.DeleteDoc(outCtx(c), &kbpb.DeleteDocRequest{Id: c.Param("docId")}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func userID(c *gin.Context) string {
	v, _ := c.Get("user_id")
	s, _ := v.(string)
	return s
}
