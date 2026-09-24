package task

import (
	"context"
	"fmt"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	usagepb "agentluoss/proto/gen/usage"
)

// UsageAdapter connects task-svc to the usage service for metering + quota.
type UsageAdapter struct{ cl usagepb.UsageClient }

func NewUsageAdapter(addr string) (*UsageAdapter, error) {
	cc, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, err
	}
	return &UsageAdapter{cl: usagepb.NewUsageClient(cc)}, nil
}

func (u *UsageAdapter) Report(ctx context.Context, taskID, userID, provider, modelID, expertID string, d usageDelta) {
	_, err := u.cl.ReportUsage(ctx, &usagepb.ReportUsageRequest{
		TaskId: taskID, UserId: userID, Provider: provider, ModelId: modelID, ExpertId: expertID,
		InputTokens: d.Input, OutputTokens: d.Output,
		CacheReadTokens: d.CacheRead, CacheWriteTokens: d.CacheWrite,
		CostUsd: d.CostUSD, Ts: nowMs(),
	})
	if err != nil {
		logUsageError(taskID, err)
	}
}

func (u *UsageAdapter) ReportTool(ctx context.Context, userID, expertID, tool string) {
	_, err := u.cl.ReportToolCall(ctx, &usagepb.ReportToolCallRequest{
		UserId: userID, ExpertId: expertID, Tool: tool, Ts: nowMs(),
	})
	if err != nil {
		logUsageError(tool, err)
	}
}

func (u *UsageAdapter) Allowed(ctx context.Context, userID string) error {
	resp, err := u.cl.CheckQuota(ctx, &usagepb.CheckQuotaRequest{UserId: userID})
	if err != nil {
		// fail-open: metering outage must not block work
		return nil
	}
	if !resp.GetAllowed() {
		return fmt.Errorf("quota exceeded: used $%.2f of $%.2f", resp.GetUsedUsd(), resp.GetLimitUsd())
	}
	return nil
}

func logUsageError(taskID string, err error) {
	// kept tiny; task/log.go would be overkill for one line
	log.Printf("usage report failed for %s: %v", taskID, err)
}
