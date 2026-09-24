// Package usage implements usage metering (tokens/cost per task/user),
// quotas, and the audit-log consumer.
package usage

import (
	"fmt"
	"context"
	"embed"
	"encoding/json"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	usagepb "agentluoss/proto/gen/usage"

	"agentluoss/internal/auditx"
)

//go:embed migrations/*.sql
var Migrations embed.FS

type Server struct {
	usagepb.UnimplementedUsageServer
	db             *pgxpool.Pool
	rdb            *redis.Client
	defaultMonthly float64
}

func NewServer(db *pgxpool.Pool, rdb *redis.Client, defaultMonthly float64) *Server {
	s := &Server{db: db, rdb: rdb, defaultMonthly: defaultMonthly}
	go s.consumeAudit()
	return s
}

func (s *Server) Register(g *grpc.Server) { usagepb.RegisterUsageServer(g, s) }

func (s *Server) adminOnly(ctx context.Context) bool {
	// role metadata set by gateway; task-svc internal calls carry no role and
	// are restricted to non-admin RPCs (ReportUsage/CheckQuota).
	return mdRole(ctx) == "admin"
}

// ---- usage ingestion ----

func (s *Server) ReportUsage(ctx context.Context, req *usagepb.ReportUsageRequest) (*usagepb.ReportUsageResponse, error) {
	day := time.UnixMilli(req.GetTs()).UTC().Format("2006-01-02")
	if req.GetTs() == 0 {
		day = time.Now().UTC().Format("2006-01-02")
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO usage.usage_events
			(task_id, user_id, provider, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, expert_id, ts)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
		req.GetTaskId(), req.GetUserId(), req.GetProvider(), req.GetModelId(),
		req.GetInputTokens(), req.GetOutputTokens(), req.GetCacheReadTokens(), req.GetCacheWriteTokens(),
		req.GetCostUsd(), req.GetExpertId())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	total := req.GetInputTokens() + req.GetOutputTokens() + req.GetCacheReadTokens() + req.GetCacheWriteTokens()
	_, err = s.db.Exec(ctx, `
		INSERT INTO usage.usage_daily (day, user_id, input_tokens, output_tokens, total_tokens, cost_usd, task_count)
		VALUES ($1,$2,$3,$4,$5,$6,1)
		ON CONFLICT (day, user_id) DO UPDATE SET
			input_tokens = usage.usage_daily.input_tokens + EXCLUDED.input_tokens,
			output_tokens = usage.usage_daily.output_tokens + EXCLUDED.output_tokens,
			total_tokens = usage.usage_daily.total_tokens + EXCLUDED.total_tokens,
			cost_usd = usage.usage_daily.cost_usd + EXCLUDED.cost_usd,
			task_count = usage.usage_daily.task_count + 1`,
		day, req.GetUserId(), req.GetInputTokens(), req.GetOutputTokens(), total, req.GetCostUsd())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &usagepb.ReportUsageResponse{}, nil
}

func (s *Server) ReportToolCall(ctx context.Context, req *usagepb.ReportToolCallRequest) (*usagepb.ReportToolCallResponse, error) {
	ts := time.Now()
	if req.GetTs() > 0 {
		ts = time.UnixMilli(req.GetTs())
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO usage.tool_usage_daily (day, user_id, expert_id, tool, calls)
		VALUES ($1,$2,$3,$4,1)
		ON CONFLICT (day, user_id, expert_id, tool) DO UPDATE SET calls = usage.tool_usage_daily.calls + 1`,
		ts.UTC().Format("2006-01-02"), req.GetUserId(), req.GetExpertId(), req.GetTool())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &usagepb.ReportToolCallResponse{}, nil
}

// ---- quota ----

func (s *Server) monthSpend(ctx context.Context, userID string) float64 {
	var spend float64
	_ = s.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(cost_usd),0) FROM usage.usage_daily
		WHERE user_id = $1 AND day >= date_trunc('month', now())`, userID).Scan(&spend)
	return spend
}

func (s *Server) limitFor(ctx context.Context, userID string) float64 {
	var limit *float64
	_ = s.db.QueryRow(ctx, `SELECT monthly_limit_usd FROM usage.quotas WHERE user_id=$1`, userID).Scan(&limit)
	if limit != nil {
		return *limit
	}
	return s.defaultMonthly
}

func (s *Server) CheckQuota(ctx context.Context, req *usagepb.CheckQuotaRequest) (*usagepb.CheckQuotaResponse, error) {
	used := s.monthSpend(ctx, req.GetUserId())
	limit := s.limitFor(ctx, req.GetUserId())
	return &usagepb.CheckQuotaResponse{
		Allowed:  used < limit,
		Reason:   map[bool]string{true: "", false: "monthly quota exceeded"}[used < limit],
		UsedUsd:  used,
		LimitUsd: limit,
	}, nil
}

func (s *Server) SetQuota(ctx context.Context, req *usagepb.SetQuotaRequest) (*usagepb.SetQuotaResponse, error) {
	if !s.adminOnly(ctx) {
		return nil, status.Error(codes.PermissionDenied, "admin only")
	}
	if req.GetMonthlyLimitUsd() <= 0 {
		_, err := s.db.Exec(ctx, `DELETE FROM usage.quotas WHERE user_id=$1`, req.GetUserId())
		return &usagepb.SetQuotaResponse{}, err
	}
	_, err := s.db.Exec(ctx, `
		INSERT INTO usage.quotas (user_id, monthly_limit_usd) VALUES ($1,$2)
		ON CONFLICT (user_id) DO UPDATE SET monthly_limit_usd = EXCLUDED.monthly_limit_usd`,
		req.GetUserId(), req.GetMonthlyLimitUsd())
	return &usagepb.SetQuotaResponse{}, err
}

// ---- queries ----

// window resolves (from, to) for a summary request; falls back to days.
func window(req *usagepb.GetUsageSummaryRequest) (time.Time, time.Time) {
	to := time.Now()
	if req.GetToTs() > 0 {
		to = time.UnixMilli(req.GetToTs())
	}
	if req.GetFromTs() > 0 {
		return time.UnixMilli(req.GetFromTs()), to
	}
	days := req.GetDays()
	if days <= 0 || days > 366 {
		days = 30
	}
	return to.AddDate(0, 0, -int(days)), to
}

func (s *Server) GetUsageSummary(ctx context.Context, req *usagepb.GetUsageSummaryRequest) (*usagepb.GetUsageSummaryResponse, error) {
	if req.GetUserId() == "" && !s.adminOnly(ctx) {
		return nil, status.Error(codes.PermissionDenied, "admin only")
	}
	from, to := window(req)
	user := req.GetUserId()
	admin := user == ""
	resp := &usagepb.GetUsageSummaryResponse{}

	// per user/day rows (fast path via usage_daily; JOIN iam hides deleted users)
	rows, err := s.db.Query(ctx, `
		SELECT to_char(ud.day,'YYYY-MM-DD'), ud.user_id, coalesce(nullif(u.display_name,''), u.username),
		       ud.input_tokens, ud.output_tokens, ud.total_tokens, ud.cost_usd, ud.task_count
		FROM usage.usage_daily ud JOIN iam.users u ON u.id = ud.user_id
		WHERE ud.day >= $1::date AND ud.day <= $2::date AND ($3 = '' OR ud.user_id = $3)
		ORDER BY ud.day DESC LIMIT 500`, from, to, user)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var r usagepb.UsageRow
		if err := rows.Scan(&r.Day, &r.UserId, &r.Username, &r.InputTokens, &r.OutputTokens, &r.TotalTokens, &r.CostUsd, &r.TaskCount); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.Rows = append(resp.Rows, &r)
	}
	if err := rows.Err(); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	// by model (from raw events; cache breakdown only lives there)
	mrows, err := s.db.Query(ctx, `
		SELECT provider, model_id,
		       sum(input_tokens), sum(output_tokens),
		       sum(cache_read_tokens), sum(cache_write_tokens),
		       sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),
		       sum(cost_usd), count(DISTINCT task_id)
		FROM usage.usage_events
		WHERE ts >= $1 AND ts <= $2 AND ($3 = '' OR user_id = $3)
		GROUP BY provider, model_id ORDER BY sum(cost_usd) DESC LIMIT 100`, from, to, user)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer mrows.Close()
	for mrows.Next() {
		var m usagepb.ModelUsageRow
		if err := mrows.Scan(&m.Provider, &m.ModelId, &m.InputTokens, &m.OutputTokens,
			&m.CacheReadTokens, &m.CacheWriteTokens, &m.TotalTokens, &m.CostUsd, &m.TaskCount); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.ByModel = append(resp.ByModel, &m)
	}
	if err := mrows.Err(); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}

	// top users (admin view only; JOIN iam filters deleted users and yields names).
	// task_count = distinct tasks from raw events (usage_daily.task_count is
	// per-message report count, not tasks).
	if admin {
		urows, err := s.db.Query(ctx, `
			SELECT e.user_id, coalesce(nullif(u.display_name,''), u.username),
			       sum(e.input_tokens+e.output_tokens+e.cache_read_tokens+e.cache_write_tokens),
			       sum(e.cost_usd), count(DISTINCT e.task_id)
			FROM usage.usage_events e
			JOIN iam.users u ON u.id = e.user_id
			WHERE e.ts >= $1 AND e.ts <= $2
			GROUP BY 1,2 ORDER BY sum(e.cost_usd) DESC LIMIT 20`, from, to)
		if err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		defer urows.Close()
		for urows.Next() {
			var u usagepb.UserUsageRow
			if err := urows.Scan(&u.UserId, &u.DisplayName, &u.TotalTokens, &u.CostUsd, &u.TaskCount); err != nil {
				return nil, status.Error(codes.Internal, err.Error())
			}
			resp.TopUsers = append(resp.TopUsers, &u)
		}
		if err := urows.Err(); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
	}

	// by expert (raw events carry expert_id; '' excluded)
	erows, err := s.db.Query(ctx, `
		SELECT e.expert_id, coalesce(x.name, e.expert_id),
		       sum(e.input_tokens+e.output_tokens+e.cache_read_tokens+e.cache_write_tokens),
		       sum(e.cost_usd), count(DISTINCT e.task_id)
		FROM usage.usage_events e LEFT JOIN caps.experts x ON x.id = e.expert_id
		WHERE e.ts >= $1 AND e.ts <= $2 AND e.expert_id <> '' AND ($3 = '' OR e.user_id = $3)
		GROUP BY 1,2 ORDER BY sum(e.cost_usd) DESC LIMIT 20`, from, to, user)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer erows.Close()
	for erows.Next() {
		var e usagepb.ExpertUsageRow
		if err := erows.Scan(&e.ExpertId, &e.Name, &e.TotalTokens, &e.CostUsd, &e.TaskCount); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.ByExpert = append(resp.ByExpert, &e)
	}

	// by department (usage_daily JOIN iam)
	drows, err := s.db.Query(ctx, `
		SELECT coalesce(d.name, '未分配'), sum(ud.total_tokens), sum(ud.cost_usd),
		       count(DISTINCT ud.user_id), sum(ud.task_count)
		FROM usage.usage_daily ud
		JOIN iam.users u ON u.id = ud.user_id
		LEFT JOIN iam.departments d ON d.id = u.department_id
		WHERE ud.day >= $1::date AND ud.day <= $2::date AND ($3 = '' OR ud.user_id = $3)
		GROUP BY 1 ORDER BY sum(ud.cost_usd) DESC LIMIT 20`, from, to, user)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer drows.Close()
	for drows.Next() {
		var d usagepb.DeptUsageRow
		if err := drows.Scan(&d.Department, &d.TotalTokens, &d.CostUsd, &d.Users, &d.TaskCount); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.ByDepartment = append(resp.ByDepartment, &d)
	}

	// highest-cost tasks
	trows, err := s.db.Query(ctx, `
		SELECT e.task_id, coalesce(t.title,''), t.user_id,
		       sum(e.input_tokens+e.output_tokens+e.cache_read_tokens+e.cache_write_tokens), sum(e.cost_usd)
		FROM usage.usage_events e JOIN task.tasks t ON t.id = e.task_id
		WHERE e.ts >= $1 AND e.ts <= $2 AND ($3 = '' OR e.user_id = $3)
		GROUP BY e.task_id, t.title, t.user_id ORDER BY sum(e.cost_usd) DESC LIMIT 20`, from, to, user)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer trows.Close()
	for trows.Next() {
		var r usagepb.TaskUsageRow
		if err := trows.Scan(&r.TaskId, &r.Title, &r.UserId, &r.TotalTokens, &r.CostUsd); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.ByTask = append(resp.ByTask, &r)
	}

	// active users (current dau/wau/mau, not window-scoped)
	_ = s.db.QueryRow(ctx, `
		SELECT (SELECT count(DISTINCT user_id) FROM usage.usage_daily WHERE day = current_date AND ($1 = '' OR user_id = $1)),
		       (SELECT count(DISTINCT user_id) FROM usage.usage_daily WHERE day >= current_date - 6 AND ($1 = '' OR user_id = $1)),
		       (SELECT count(DISTINCT user_id) FROM usage.usage_daily WHERE day >= current_date - 29 AND ($1 = '' OR user_id = $1))`,
		user).Scan(&resp.Dau, &resp.Wau, &resp.Mau)

	// by tool
	krows, err := s.db.Query(ctx, `
		SELECT tool, sum(calls) FROM usage.tool_usage_daily
		WHERE day >= $1::date AND day <= $2::date AND ($3 = '' OR user_id = $3)
		GROUP BY tool ORDER BY 2 DESC LIMIT 20`, from, to, user)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer krows.Close()
	for krows.Next() {
		var t usagepb.ToolUsageRow
		if err := krows.Scan(&t.Tool, &t.Calls); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.ByTool = append(resp.ByTool, &t)
	}

	// quotas: all users' limit + month spend (admin view only)
	if admin {
		qrows, err := s.db.Query(ctx, `
			SELECT u.id, coalesce(q.monthly_limit_usd, 0),
			       (SELECT coalesce(sum(ud.cost_usd), 0) FROM usage.usage_daily ud
			        WHERE ud.user_id = u.id AND ud.day >= date_trunc('month', current_date))
			FROM iam.users u LEFT JOIN usage.quotas q ON q.user_id = u.id
			ORDER BY 3 DESC`)
		if err == nil {
			defer qrows.Close()
			for qrows.Next() {
				var q usagepb.UserQuotaRow
				if err := qrows.Scan(&q.UserId, &q.MonthlyLimitUsd, &q.MonthUsedUsd); err == nil {
					resp.Quotas = append(resp.Quotas, &q)
				}
			}
		}
	}
	return resp, nil
}

func (s *Server) GetTaskUsage(ctx context.Context, req *usagepb.GetTaskUsageRequest) (*usagepb.GetTaskUsageResponse, error) {
	resp := &usagepb.GetTaskUsageResponse{}
	rows, err := s.db.Query(ctx, `
		SELECT provider, model_id,
		       sum(input_tokens), sum(output_tokens),
		       sum(cache_read_tokens), sum(cache_write_tokens),
		       sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens),
		       sum(cost_usd), count(DISTINCT task_id)
		FROM usage.usage_events
		WHERE task_id = $1
		GROUP BY provider, model_id ORDER BY sum(cost_usd) DESC`, req.GetTaskId())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var m usagepb.ModelUsageRow
		if err := rows.Scan(&m.Provider, &m.ModelId, &m.InputTokens, &m.OutputTokens,
			&m.CacheReadTokens, &m.CacheWriteTokens, &m.TotalTokens, &m.CostUsd, &m.TaskCount); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		resp.ByModel = append(resp.ByModel, &m)
		resp.TotalTokens += m.TotalTokens
		resp.CostUsd += m.CostUsd
	}
	return resp, rows.Err()
}

func (s *Server) GetMyUsage(ctx context.Context, req *usagepb.GetMyUsageRequest) (*usagepb.GetMyUsageResponse, error) {
	resp := &usagepb.GetMyUsageResponse{
		MonthUsedUsd:  s.monthSpend(ctx, req.GetUserId()),
		MonthLimitUsd: s.limitFor(ctx, req.GetUserId()),
	}
	rows, err := s.db.Query(ctx, `
		SELECT to_char(day,'YYYY-MM-DD'), user_id, input_tokens, output_tokens, total_tokens, cost_usd, task_count
		FROM usage.usage_daily WHERE user_id = $1 AND day >= current_date - 14 ORDER BY day DESC`, req.GetUserId())
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var r usagepb.UsageRow
		if err := rows.Scan(&r.Day, &r.UserId, &r.InputTokens, &r.OutputTokens, &r.TotalTokens, &r.CostUsd, &r.TaskCount); err == nil {
			resp.RecentDays = append(resp.RecentDays, &r)
		}
	}
	return resp, nil
}

func (s *Server) ListAuditLogs(ctx context.Context, req *usagepb.ListAuditLogsRequest) (*usagepb.ListAuditLogsResponse, error) {
	if !s.adminOnly(ctx) {
		return nil, status.Error(codes.PermissionDenied, "admin only")
	}
	limit := req.GetLimit()
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	where, args := "WHERE TRUE", []any{}
	if req.GetActor() != "" {
		args = append(args, req.GetActor())
		where += fmt.Sprintf(" AND actor = $%d", len(args))
	}
	if req.GetAction() != "" {
		args = append(args, req.GetAction())
		where += fmt.Sprintf(" AND action = $%d", len(args))
	}
	if req.GetResource() != "" {
		args = append(args, "%"+req.GetResource()+"%")
		where += fmt.Sprintf(" AND resource ILIKE $%d", len(args))
	}
	if req.GetFromTs() > 0 {
		args = append(args, time.UnixMilli(req.GetFromTs()))
		where += fmt.Sprintf(" AND ts >= $%d", len(args))
	}
	if req.GetToTs() > 0 {
		args = append(args, time.UnixMilli(req.GetToTs()))
		where += fmt.Sprintf(" AND ts <= $%d", len(args))
	}
	var total int
	if err := s.db.QueryRow(ctx, "SELECT count(*) FROM usage.audit_logs "+where, args...).Scan(&total); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	args = append(args, limit, req.GetOffset())
	q := fmt.Sprintf(`SELECT id, actor, action, resource, detail, ip, (extract(epoch from ts)*1000)::bigint
		FROM usage.audit_logs %s ORDER BY ts DESC LIMIT $%d OFFSET $%d`,
		where, len(args)-1, len(args))
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	defer rows.Close()
	resp := &usagepb.ListAuditLogsResponse{Total: int32(total)}
	for rows.Next() {
		var l usagepb.AuditLog
		if err := rows.Scan(&l.Id, &l.Actor, &l.Action, &l.Resource, &l.Detail, &l.Ip, &l.Ts); err == nil {
			resp.Logs = append(resp.Logs, &l)
		}
	}
	return resp, nil
}

// ---- audit consumer ----

const auditGroup = "usage-svc"

func (s *Server) consumeAudit() {
	ctx := context.Background()
	_ = s.rdb.XGroupCreateMkStream(ctx, auditx.Stream, auditGroup, "0").Err()
	for {
		res, err := s.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: auditGroup, Consumer: "usage-1",
			Streams: []string{auditx.Stream, ">"},
			Count:   64, Block: 5 * time.Second,
		}).Result()
		if err != nil {
			if err != redis.Nil {
				log.Printf("[audit] read failed: %v", err)
				time.Sleep(2 * time.Second)
			}
			continue
		}
		for _, stream := range res {
			for _, msg := range stream.Messages {
				var (
					ts   int64
					data string
				)
				if v, ok := msg.Values["ts"]; ok {
					_ = json.Unmarshal([]byte(v.(string)), &ts)
				}
				if v, ok := msg.Values["data"].(string); ok {
					data = v
				}
				var ev struct {
					Actor    string `json:"actor"`
					Action   string `json:"action"`
					Resource string `json:"resource"`
					Detail   string `json:"detail"`
					IP       string `json:"ip"`
				}
				if json.Unmarshal([]byte(data), &ev) == nil && ev.Action != "" {
					if ev.Detail == "" {
						ev.Detail = "{}"
					}
					if ts == 0 {
						ts = time.Now().UnixMilli()
					}
					_, _ = s.db.Exec(ctx, `
						INSERT INTO usage.audit_logs (actor, action, resource, detail, ip, ts)
						VALUES ($1,$2,$3,$4,$5, $6)`,
						ev.Actor, ev.Action, ev.Resource, ev.Detail, ev.IP, time.UnixMilli(ts))
				}
				_ = s.rdb.XAck(ctx, auditx.Stream, auditGroup, msg.ID).Err()
			}
		}
	}
}

var _ = fmt.Sprintf
