// Usage, quota and audit REST routes.
package gateway

import (
	"github.com/gin-gonic/gin"

	usagepb "agentluoss/proto/gen/usage"
)

func (a *App) registerUsageRoutes(authed, admin *gin.RouterGroup) {
	authed.GET("/usage/me", a.myUsage)

	admin.GET("/admin/usage", a.usageSummary)
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
	days := int32(30)
	if v := c.Query("days"); v != "" {
		_ = vScanInt32(v, &days)
	}
	resp, err := a.usage.GetUsageSummary(outCtx(c), &usagepb.GetUsageSummaryRequest{UserId: userID, Days: days})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"rows": resp.Rows})
}

func (a *App) auditLogs(c *gin.Context) {
	req := &usagepb.ListAuditLogsRequest{
		Actor: c.Query("actor"), Action: c.Query("action"),
		Limit: 100,
	}
	if v := c.Query("limit"); v != "" {
		_ = vScanInt32(v, &req.Limit)
	}
	if v := c.Query("offset"); v != "" {
		_ = vScanInt32(v, &req.Offset)
	}
	resp, err := a.usage.ListAuditLogs(outCtx(c), req)
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"logs": resp.Logs, "total": resp.Total})
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
