// Usage, quota and audit REST routes.
package gateway

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	taskpb "agentluoss/proto/gen/task"
	usagepb "agentluoss/proto/gen/usage"
)

func (a *App) registerUsageRoutes(authed, admin *gin.RouterGroup) {
	authed.GET("/usage/me", a.myUsage)
	authed.GET("/tasks/:id/usage", a.taskUsage)

	admin.GET("/admin/usage", a.usageSummary)
	admin.GET("/admin/usage/export", a.usageExport)
	admin.GET("/admin/audit", a.auditLogs)
	admin.PUT("/admin/quota", a.setQuota)
}

func (a *App) myUsage(c *gin.Context) {
	resp, err := a.usage.GetMyUsage(outCtx(c), &usagepb.GetMyUsageRequest{UserId: c.GetString("user_id")})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{
		"month_used_usd": resp.MonthUsedUsd, "month_limit_usd": resp.MonthLimitUsd,
		"recent_days": resp.RecentDays,
	})
}

func (a *App) usageSummary(c *gin.Context) {
	userID := c.Query("user_id")
	req := &usagepb.GetUsageSummaryRequest{UserId: userID}
	if v := c.Query("days"); v != "" {
		_ = vScanInt32(v, &req.Days)
	}
	if v := c.Query("from"); v != "" {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil {
			req.FromTs = ms
		}
	}
	if v := c.Query("to"); v != "" {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil {
			req.ToTs = ms
		}
	}
	resp, err := a.usage.GetUsageSummary(outCtx(c), req)
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{
		"rows": resp.Rows, "by_model": resp.ByModel, "top_users": resp.TopUsers,
		"by_expert": resp.ByExpert, "by_department": resp.ByDepartment,
		"by_task": resp.ByTask, "by_tool": resp.ByTool,
		"dau": resp.Dau, "wau": resp.Wau, "mau": resp.Mau, "quotas": resp.Quotas,
	})
}

// usageExport streams the same summary window as CSV (admin only).
func (a *App) usageExport(c *gin.Context) {
	req := &usagepb.GetUsageSummaryRequest{UserId: c.Query("user_id")}
	if v := c.Query("days"); v != "" {
		_ = vScanInt32(v, &req.Days)
	}
	if v := c.Query("from"); v != "" {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil {
			req.FromTs = ms
		}
	}
	if v := c.Query("to"); v != "" {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil {
			req.ToTs = ms
		}
	}
	resp, err := a.usage.GetUsageSummary(outCtx(c), req)
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.Header("Content-Disposition", "attachment; filename=usage.csv")
	c.Header("Content-Type", "text/csv; charset=utf-8")
	var b strings.Builder
	b.WriteString("day,user_id,input_tokens,output_tokens,total_tokens,cost_usd,task_count\n")
	for _, r := range resp.Rows {
		fmt.Fprintf(&b, "%s,%s,%d,%d,%d,%.6f,%d\n",
			r.Day, r.UserId, r.InputTokens, r.OutputTokens, r.TotalTokens, r.CostUsd, r.TaskCount)
	}
	b.WriteString("\nprovider,model_id,input_tokens,output_tokens,cache_read,cache_write,total_tokens,cost_usd,task_count\n")
	for _, m := range resp.ByModel {
		fmt.Fprintf(&b, "%s,%s,%d,%d,%d,%d,%d,%.6f,%d\n",
			m.Provider, m.ModelId, m.InputTokens, m.OutputTokens, m.CacheReadTokens, m.CacheWriteTokens,
			m.TotalTokens, m.CostUsd, m.TaskCount)
	}
	b.WriteString("\nexpert_id,name,total_tokens,cost_usd,task_count\n")
	for _, e := range resp.ByExpert {
		fmt.Fprintf(&b, "%s,%s,%d,%.6f,%d\n", csvEscape(e.ExpertId), csvEscape(e.Name), e.TotalTokens, e.CostUsd, e.TaskCount)
	}
	b.WriteString("\ndepartment,total_tokens,cost_usd,users,task_count\n")
	for _, d := range resp.ByDepartment {
		fmt.Fprintf(&b, "%s,%d,%.6f,%d,%d\n", csvEscape(d.Department), d.TotalTokens, d.CostUsd, d.Users, d.TaskCount)
	}
	b.WriteString("\ntool,calls\n")
	for _, t := range resp.ByTool {
		fmt.Fprintf(&b, "%s,%d\n", csvEscape(t.Tool), t.Calls)
	}
	c.String(200, b.String())
}

func vScanInt64(s string, out *int64) error {
	v, err := strconv.ParseInt(s, 10, 64)
	if err == nil {
		*out = v
	}
	return err
}

func csvEscape(s string) string {
	if strings.ContainsAny(s, ",\"\n") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}

// taskUsage reports token/cost consumption of one task. Owners and admins only.
func (a *App) taskUsage(c *gin.Context) {
	taskID := c.Param("id")
	t, err := a.task.GetTask(outCtx(c), &taskpb.GetTaskRequest{TaskId: taskID})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	if t.GetTask().GetUserId() != c.GetString("user_id") && c.GetString("role") != "admin" {
		c.JSON(403, gin.H{"error": "forbidden"})
		return
	}
	resp, err := a.usage.GetTaskUsage(outCtx(c), &usagepb.GetTaskUsageRequest{TaskId: taskID})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"by_model": resp.ByModel, "total_tokens": resp.TotalTokens, "cost_usd": resp.CostUsd})
}

func (a *App) auditLogs(c *gin.Context) {
	req := &usagepb.ListAuditLogsRequest{
		Actor: c.Query("actor"), Action: c.Query("action"), Resource: c.Query("resource"),
		Limit: 100,
	}
	if v := c.Query("limit"); v != "" {
		_ = vScanInt32(v, &req.Limit)
	}
	if v := c.Query("offset"); v != "" {
		_ = vScanInt32(v, &req.Offset)
	}
	if v := c.Query("from_ts"); v != "" {
		_ = vScanInt64(v, &req.FromTs)
	}
	if v := c.Query("to_ts"); v != "" {
		_ = vScanInt64(v, &req.ToTs)
	}
	if c.Query("export") == "1" {
		a.auditExport(c, req)
		return
	}
	resp, err := a.usage.ListAuditLogs(outCtx(c), req)
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"logs": resp.Logs, "total": resp.Total})
}

// auditExport streams the filtered audit log as CSV (admin only).
func (a *App) auditExport(c *gin.Context, req *usagepb.ListAuditLogsRequest) {
	req.Limit = 5000
	resp, err := a.usage.ListAuditLogs(outCtx(c), req)
	if err != nil {
		grpcStatus(c, err)
		return
	}
	var b strings.Builder
	b.WriteString("ts,actor,action,resource,ip,detail\n")
	for _, l := range resp.Logs {
		b.WriteString(fmt.Sprintf("%s,%s,%s,%s,%s,%s\n",
			time.UnixMilli(l.GetTs()).UTC().Format(time.RFC3339), csvEscape(l.GetActor()), csvEscape(l.GetAction()),
			csvEscape(l.GetResource()), csvEscape(l.GetIp()), csvEscape(l.GetDetail())))
	}
	c.Header("Content-Disposition", "attachment; filename=audit.csv")
	c.Data(200, "text/csv; charset=utf-8", []byte(b.String()))
}

func (a *App) setQuota(c *gin.Context) {
	var req struct {
		UserID          string  `json:"user_id" binding:"required"`
		MonthlyLimitUSD float64 `json:"monthly_limit_usd"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "user_id required"})
		return
	}
	if _, err := a.usage.SetQuota(outCtx(c), &usagepb.SetQuotaRequest{
		UserId: req.UserID, MonthlyLimitUsd: req.MonthlyLimitUSD,
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func vScanInt32(s string, out *int32) error {
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			return nil
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		return nil
	}
	*out = int32(n)
	return nil
}
