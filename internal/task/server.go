// Package task implements the Task orchestration service: task lifecycle,
// runtime scheduling, session resume, and the event pipeline.
package task

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"agentluoss/internal/auditx"
	runtimpb "agentluoss/proto/gen/runtime"
	taskpb "agentluoss/proto/gen/task"
)

type Server struct {
	taskpb.UnimplementedTaskServer
	store     *Store
	registry  *RuntimeRegistry
	pipe      *Pipeline
	clients   *RuntimeClients
	rdb       *redis.Client
	workspacesDir string
	usage     UsageReporter
	quota     QuotaChecker
}

// QuotaChecker gates prompts on user quota (nil = always allow).
type QuotaChecker interface {
	Allowed(ctx context.Context, userID string) error
}

// UsageReporter receives per-message token/cost reports (implemented by the
// usage service client; noop keeps task-svc standalone in tests).
type UsageReporter interface {
	Report(ctx context.Context, taskID, userID, provider, modelID string, u usageDelta)
}

type usageDelta struct {
	Input, Output, CacheRead, CacheWrite int64
	CostUSD                              float64
}

type noopUsage struct{}

func (noopUsage) Report(context.Context, string, string, string, string, usageDelta) {}

func NewServer(db *pgxpool.Pool, rdb *redis.Client, workspacesDir string, usage UsageReporter, quota QuotaChecker) *Server {
	if usage == nil {
		usage = noopUsage{}
	}
	return &Server{
		store:     NewStore(db),
		registry:  NewRegistry(rdb),
		pipe:      NewPipeline(rdb),
		clients:   NewRuntimeClients(),
		rdb:       rdb,
		workspacesDir: workspacesDir,
		usage:     usage,
		quota:     quota,
	}
}

func (s *Server) Register(g *grpc.Server) { taskpb.RegisterTaskServer(g, s) }

func errCode(err error) error {
	if errors.Is(err, ErrNotFound) {
		return status.Error(codes.NotFound, err.Error())
	}
	return status.Error(codes.Internal, err.Error())
}

func newTaskID() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return "t_" + hex.EncodeToString(b)
}

func (s *Server) synth(taskID, typ string, body any) {
	b, _ := json.Marshal(body)
	_, _ = s.pipe.Ingest(context.Background(), &taskpb.AgentEvent{
		TaskId: taskID, Type: typ, Payload: string(b),
	})
}

// ---- user-facing ----

func (s *Server) CreateTask(ctx context.Context, req *taskpb.CreateTaskRequest) (*taskpb.CreateTaskResponse, error) {
	mode := modeName(req.GetMode())
	if mode == "" {
		mode = "craft"
	}
	if req.GetModel().GetModelId() == "" {
		return nil, status.Error(codes.InvalidArgument, "model required")
	}
	t := &Task{
		ID: newTaskID(), UserID: req.GetUserId(), Title: req.GetTitle(),
		Mode: mode, Provider: req.GetModel().GetProvider(), ModelID: req.GetModel().GetModelId(),
		Status: "pending", FirstMessage: req.GetFirstMessage(),
	}
	if err := s.store.Create(ctx, t); err != nil {
		return nil, errCode(err)
	}
	actor := mdGet(ctx, "x-user-id")
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: actor, Action: "task.create", Resource: "task/" + t.ID})

	if req.GetFirstMessage() != "" {
		// first prompt runs async; events arrive via SSE
		go func() {
			bctx := context.Background()
			if _, err := s.SendPrompt(bctx, &taskpb.SendPromptRequest{
				TaskId: t.ID, UserId: req.GetUserId(), Message: req.GetFirstMessage(),
			}); err != nil {
				log.Printf("first prompt for %s failed: %v", t.ID, err)
				s.synth(t.ID, "error", map[string]string{"message": err.Error()})
				_ = s.store.SetStatus(bctx, t.ID, "idle")
			}
		}()
	}
	return &taskpb.CreateTaskResponse{Task: toPb(t)}, nil
}

func modeName(m runtimpb.TaskMode) string {
	switch m {
	case runtimpb.TaskMode_TASK_MODE_ASK:
		return "ask"
	case runtimpb.TaskMode_TASK_MODE_PLAN:
		return "plan"
	case runtimpb.TaskMode_TASK_MODE_CRAFT:
		return "craft"
	}
	return ""
}

func modeEnum(m string) runtimpb.TaskMode {
	switch m {
	case "ask":
		return runtimpb.TaskMode_TASK_MODE_ASK
	case "plan":
		return runtimpb.TaskMode_TASK_MODE_PLAN
	}
	return runtimpb.TaskMode_TASK_MODE_CRAFT
}

func (s *Server) GetTask(ctx context.Context, req *taskpb.GetTaskRequest) (*taskpb.GetTaskResponse, error) {
	t, err := s.store.Get(ctx, req.GetTaskId())
	if err != nil {
		return nil, errCode(err)
	}
	return &taskpb.GetTaskResponse{Task: toPb(t)}, nil
}

func (s *Server) ListTasks(ctx context.Context, req *taskpb.ListTasksRequest) (*taskpb.ListTasksResponse, error) {
	// empty user_id (admin, enforced by gateway) lists all
	tasks, total, err := s.store.List(ctx, req.GetUserId(), req.GetQuery(), int(req.GetLimit()), int(req.GetOffset()))
	if err != nil {
		return nil, errCode(err)
	}
	out := &taskpb.ListTasksResponse{Total: int32(total)}
	for _, t := range tasks {
		out.Tasks = append(out.Tasks, toPb(t))
	}
	return out, nil
}

func (s *Server) UpdateTask(ctx context.Context, req *taskpb.UpdateTaskRequest) (*taskpb.UpdateTaskResponse, error) {
	t, err := s.store.UpdateMeta(ctx, req.GetTaskId(), req.GetTitle(), req.GetArchive())
	if err != nil {
		return nil, errCode(err)
	}
	return &taskpb.UpdateTaskResponse{Task: toPb(t)}, nil
}

func (s *Server) DeleteTask(ctx context.Context, req *taskpb.DeleteTaskRequest) (*taskpb.DeleteTaskResponse, error) {
	t, err := s.store.Get(ctx, req.GetTaskId())
	if err == nil && t.RuntimeID != "" {
		if rt, rerr := s.registry.Get(ctx, t.RuntimeID); rerr == nil {
			if cl, cerr := s.clients.Get(t.RuntimeID, rt.Addr); cerr == nil {
				_, _ = cl.CloseSession(ctx, &runtimpb.CloseSessionRequest{TaskId: req.GetTaskId()})
			}
		}
	}
	if err := s.store.Delete(ctx, req.GetTaskId()); err != nil {
		return nil, errCode(err)
	}
	actor := mdGet(ctx, "x-user-id")
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: actor, Action: "task.delete", Resource: "task/" + req.GetTaskId()})
	return &taskpb.DeleteTaskResponse{}, nil
}

// ensureSession guarantees the task's pi session exists on a healthy runtime,
// resuming from the session file when needed. Returns the runtime client.
func (s *Server) ensureSession(ctx context.Context, t *Task) (runtimpb.AgentRuntimeClient, string, error) {
	tryIDs := []string{}
	if t.RuntimeID != "" {
		tryIDs = append(tryIDs, t.RuntimeID)
	}
	var rt *runtimeInfo
	if len(tryIDs) > 0 {
		if info, err := s.registry.Get(ctx, tryIDs[0]); err == nil {
			rt = info
		}
	}
	if rt == nil {
		var err error
		rt, err = s.registry.Pick(ctx)
		if err != nil {
			return nil, "", err
		}
		tryIDs = append([]string{rt.ID}, tryIDs...)
	}

	for _, id := range tryIDs {
		info, err := s.registry.Get(ctx, id)
		if err != nil {
			continue
		}
		cl, err := s.clients.Get(info.ID, info.Addr)
		if err != nil {
			continue
		}
		// Is the session already live in this runtime's pool?
		st, err := cl.GetSessionState(ctx, &runtimpb.GetSessionStateRequest{TaskId: t.ID})
		if err == nil && st.GetExists() {
			if t.RuntimeID != info.ID {
				_ = s.store.SetRuntime(ctx, t.ID, info.ID)
				t.RuntimeID = info.ID
			}
			return cl, info.ID, nil
		}
		// (Re-)create: with session_path it resumes from file
		resp, err := cl.CreateSession(ctx, &runtimpb.CreateSessionRequest{
			TaskId: t.ID, UserId: t.UserID, Mode: modeEnum(t.Mode),
			Model:      &runtimpb.ModelRef{Provider: t.Provider, ModelId: t.ModelID},
			WorkspacePath: s.workspaceFor(t.UserID),
			SessionPath: t.SessionPath,
		})
		if err != nil {
			log.Printf("createSession on %s failed: %v", info.ID, err)
			s.clients.Drop(info.ID)
			continue
		}
		if t.SessionPath == "" && resp.GetSessionPath() != "" {
			_ = s.store.SetSessionPath(ctx, t.ID, resp.GetSessionPath())
			t.SessionPath = resp.GetSessionPath()
		}
		if t.RuntimeID != info.ID {
			_ = s.store.SetRuntime(ctx, t.ID, info.ID)
			t.RuntimeID = info.ID
		}
		return cl, info.ID, nil
	}
	return nil, "", errors.New("no runtime could host the session")
}

func (s *Server) workspaceFor(userID string) string {
	return strings.TrimSuffix(s.workspacesDir, "/") + "/" + userID
}

func (s *Server) SendPrompt(ctx context.Context, req *taskpb.SendPromptRequest) (*taskpb.SendPromptResponse, error) {
	t, err := s.store.Get(ctx, req.GetTaskId())
	if err != nil {
		return nil, errCode(err)
	}
	if req.GetUserId() != "" && t.UserID != req.GetUserId() {
		role := mdGet(ctx, "x-user-role")
		if role != "admin" {
			return nil, status.Error(codes.PermissionDenied, "not your task")
		}
	}
	if t.Status == "archived" {
		return nil, status.Error(codes.FailedPrecondition, "task archived")
	}
	if req.GetMessage() == "" {
		return nil, status.Error(codes.InvalidArgument, "message required")
	}
	if s.quota != nil {
		if err := s.quota.Allowed(ctx, t.UserID); err != nil {
			return nil, status.Error(codes.ResourceExhausted, err.Error())
		}
	}
	if !s.registry.AcquireSessionLock(ctx, t.ID, 15*time.Minute) {
		return nil, status.Error(codes.ResourceExhausted, "task busy")
	}
	// safety net: runtime lock release happens on settled; TTL above bounds loss
	cl, _, err := s.ensureSession(ctx, t)
	if err != nil {
		s.registry.ReleaseSessionLock(ctx, t.ID)
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	images := make([]*runtimpb.ImageContent, 0, len(req.GetImages()))
	for _, im := range req.GetImages() {
		images = append(images, &runtimpb.ImageContent{Data: im.GetData(), MediaType: im.GetMediaType()})
	}
	_, err = cl.Prompt(ctx, &runtimpb.PromptRequest{
		TaskId: t.ID, Message: req.GetMessage(), Images: images,
		StreamingBehavior: req.GetStreamingBehavior(),
	})
	if err != nil {
		s.registry.ReleaseSessionLock(ctx, t.ID)
		if status.Code(err) == codes.InvalidArgument {
			return nil, err
		}
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	_ = s.store.SetStatus(ctx, t.ID, "running")
	_ = s.store.SetTitleIfEmpty(ctx, t.ID, req.GetMessage())
	s.synth(t.ID, "task_status", map[string]string{"status": "running"})
	return &taskpb.SendPromptResponse{Accepted: true}, nil
}

func (s *Server) SteerTask(ctx context.Context, req *taskpb.SteerTaskRequest) (*taskpb.SteerTaskResponse, error) {
	t, err := s.store.Get(ctx, req.GetTaskId())
	if err != nil {
		return nil, errCode(err)
	}
	if t.UserID != req.GetUserId() && mdGet(ctx, "x-user-role") != "admin" {
		return nil, status.Error(codes.PermissionDenied, "not your task")
	}
	cl, _, err := s.ensureSession(ctx, t)
	if err != nil {
		return nil, status.Error(codes.Unavailable, err.Error())
	}
	if _, err := cl.Steer(ctx, &runtimpb.SteerRequest{TaskId: t.ID, Message: req.GetMessage()}); err != nil {
		return nil, err
	}
	return &taskpb.SteerTaskResponse{}, nil
}

func (s *Server) AbortTask(ctx context.Context, req *taskpb.AbortTaskRequest) (*taskpb.AbortTaskResponse, error) {
	t, err := s.store.Get(ctx, req.GetTaskId())
	if err != nil {
		return nil, errCode(err)
	}
	if t.UserID != req.GetUserId() && mdGet(ctx, "x-user-role") != "admin" {
		return nil, status.Error(codes.PermissionDenied, "not your task")
	}
	if t.RuntimeID != "" {
		if rt, rerr := s.registry.Get(ctx, t.RuntimeID); rerr == nil {
			if cl, cerr := s.clients.Get(t.RuntimeID, rt.Addr); cerr == nil {
				_, _ = cl.Abort(ctx, &runtimpb.AbortRequest{TaskId: t.ID})
			}
		}
	}
	s.registry.ReleaseSessionLock(ctx, t.ID)
	s.synth(t.ID, "task_status", map[string]string{"status": "aborted"})
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdGet(ctx, "x-user-id"), Action: "task.abort", Resource: "task/" + t.ID})
	return &taskpb.AbortTaskResponse{}, nil
}

// ---- events ----

func (s *Server) StreamEvents(req *taskpb.StreamEventsRequest, stream taskpb.Task_StreamEventsServer) error {
	t, err := s.store.Get(stream.Context(), req.GetTaskId())
	if err != nil {
		return errCode(err)
	}
	if req.GetUserId() != "" && t.UserID != req.GetUserId() {
		role := mdGet(stream.Context(), "x-user-role")
		if role != "admin" {
			return status.Error(codes.PermissionDenied, "not your task")
		}
	}
	ctx := stream.Context()

	// subscribe first, then replay, then live (skip already-seen seqs)
	ch, cancel := s.pipe.Subscribe(req.GetTaskId())
	defer cancel()

	var maxSeq int64
	if req.GetSinceSeq() > 0 {
		hist, err := s.pipe.Replay(ctx, req.GetTaskId(), req.GetSinceSeq(), 5000)
		if err != nil {
			return errCode(err)
		}
		for _, ev := range hist {
			if err := stream.Send(ev); err != nil {
				return err
			}
			if ev.Seq > maxSeq {
				maxSeq = ev.Seq
			}
		}
	}

	synth, _ := json.Marshal(map[string]string{"status": t.Status})
	_ = stream.Send(&taskpb.AgentEvent{TaskId: t.ID, Type: "task_status", Payload: string(synth), Seq: maxSeq + 1, Timestamp: time.Now().UnixMilli()})

	for {
		select {
		case <-ctx.Done():
			return nil
		case ev := <-ch:
			if ev.Seq <= maxSeq {
				continue
			}
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// ---- runtime-facing ----

func (s *Server) RegisterRuntime(ctx context.Context, req *taskpb.RegisterRuntimeRequest) (*taskpb.RegisterRuntimeResponse, error) {
	if err := s.registry.Register(ctx, req.GetRuntimeId(), req.GetAddress()); err != nil {
		return nil, errCode(err)
	}
	log.Printf("runtime registered: %s @ %s", req.GetRuntimeId(), req.GetAddress())
	return &taskpb.RegisterRuntimeResponse{}, nil
}

func (s *Server) RuntimeHeartbeat(ctx context.Context, req *taskpb.RuntimeHeartbeatRequest) (*taskpb.RuntimeHeartbeatResponse, error) {
	_ = s.registry.Heartbeat(ctx, req.GetRuntimeId(), req.GetActiveSessions(), req.GetMaxSessions())
	return &taskpb.RuntimeHeartbeatResponse{}, nil
}

func (s *Server) PushEvents(stream taskpb.Task_PushEventsServer) error {
	ctx := stream.Context()
	for {
		ev, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&taskpb.PushEventsResponse{})
		}
		if err != nil {
			return err
		}
		stored, err := s.pipe.Ingest(ctx, ev)
		if err != nil {
			log.Printf("ingest event %s/%s failed: %v", ev.GetTaskId(), ev.GetType(), err)
			continue
		}
		s.onEvent(ctx, stored)
	}
}

// onEvent derives platform state from pi events: task status, usage, locks.
func (s *Server) onEvent(ctx context.Context, ev *taskpb.AgentEvent) {
	switch ev.GetType() {
	case "agent_start":
		_ = s.store.SetStatus(ctx, ev.GetTaskId(), "running")
	case "agent_settled":
		_ = s.store.SetStatus(ctx, ev.GetTaskId(), "idle")
		s.registry.ReleaseSessionLock(ctx, ev.GetTaskId())
	case "message_end":
		s.reportUsage(ctx, ev)
	case "error":
		_ = s.store.SetStatus(ctx, ev.GetTaskId(), "idle")
		s.registry.ReleaseSessionLock(ctx, ev.GetTaskId())
	}
}

// reportUsage extracts usage from an assistant message_end event.
type msgUsage struct {
	Input      int64   `json:"input"`
	Output     int64   `json:"output"`
	CacheRead  int64   `json:"cacheRead"`
	CacheWrite int64   `json:"cacheWrite"`
	TotalTokens int64  `json:"totalTokens"`
	Cost       struct {
		Total float64 `json:"total"`
	} `json:"cost"`
}

type msgEndPayload struct {
	Message struct {
		Role     string   `json:"role"`
		Provider string   `json:"provider"`
		Model    string   `json:"model"`
		Usage    *msgUsage `json:"usage"`
	} `json:"message"`
}

func (s *Server) reportUsage(ctx context.Context, ev *taskpb.AgentEvent) {
	var p msgEndPayload
	if err := json.Unmarshal([]byte(ev.GetPayload()), &p); err != nil {
		return
	}
	m := p.Message
	if m.Role != "assistant" || m.Usage == nil || m.Usage.TotalTokens == 0 {
		return
	}
	t, err := s.store.Get(ctx, ev.GetTaskId())
	if err != nil {
		return
	}
	s.usage.Report(ctx, ev.GetTaskId(), t.UserID, m.Provider, m.Model, usageDelta{
		Input: m.Usage.Input, Output: m.Usage.Output,
		CacheRead: m.Usage.CacheRead, CacheWrite: m.Usage.CacheWrite,
		CostUSD: m.Usage.Cost.Total,
	})
}

// ---- history ----

func (s *Server) GetMessages(ctx context.Context, req *taskpb.GetMessagesRequest) (*taskpb.GetMessagesResponse, error) {
	t, err := s.store.Get(ctx, req.GetTaskId())
	if err != nil {
		return nil, errCode(err)
	}
	if req.GetUserId() != "" && t.UserID != req.GetUserId() && mdGet(ctx, "x-user-role") != "admin" {
		return nil, status.Error(codes.PermissionDenied, "not your task")
	}
	// history = message_end events from the replay stream
	hist, err := s.pipe.Replay(ctx, req.GetTaskId(), 0, 100000)
	if err != nil {
		return nil, errCode(err)
	}
	msgs := make([]json.RawMessage, 0, len(hist))
	for _, ev := range hist {
		if ev.GetType() != "message_end" {
			continue
		}
		var p msgEndPayload
		if json.Unmarshal([]byte(ev.GetPayload()), &p) == nil && p.Message.Role != "" {
			msgs = append(msgs, json.RawMessage(ev.GetPayload()))
		}
	}
	b, _ := json.Marshal(msgs)
	return &taskpb.GetMessagesResponse{MessagesJson: string(b)}, nil
}

// ---- helpers ----

func mdGet(ctx context.Context, k string) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	if v := md.Get(k); len(v) > 0 {
		return v[0]
	}
	return ""
}

func toPb(t *Task) *taskpb.TaskInfo {
	return &taskpb.TaskInfo{
		Id: t.ID, UserId: t.UserID, Title: t.Title,
		Mode: modeEnum(t.Mode),
		Model: &runtimpb.ModelRef{Provider: t.Provider, ModelId: t.ModelID},
		Status:      statusEnum(t.Status),
		RuntimeId:   t.RuntimeID,
		SessionPath: t.SessionPath,
		FirstMessage: t.FirstMessage,
		CreatedAt:   t.CreatedAt, UpdatedAt: t.UpdatedAt,
	}
}

func statusEnum(s string) taskpb.TaskStatus {
	switch s {
	case "pending":
		return taskpb.TaskStatus_TASK_STATUS_PENDING
	case "running":
		return taskpb.TaskStatus_TASK_STATUS_RUNNING
	case "failed":
		return taskpb.TaskStatus_TASK_STATUS_FAILED
	case "archived":
		return taskpb.TaskStatus_TASK_STATUS_ARCHIVED
	}
	return taskpb.TaskStatus_TASK_STATUS_IDLE
}

var _ = fmt.Sprintf

// MDGet exposes metadata lookup for other services (modelmgt reuse).
func MDGet(ctx context.Context, k string) string { return mdGet(ctx, k) }
