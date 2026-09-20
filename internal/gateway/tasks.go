// Task REST endpoints + SSE event proxy on the gateway.
package gateway

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	taskpb "agentluoss/proto/gen/task"
	runtimpb "agentluoss/proto/gen/runtime"
)

func (a *App) registerTaskRoutes(authed *gin.RouterGroup) {
	authed.POST("/tasks", a.createTask)
	authed.GET("/tasks", a.listTasks)
	authed.GET("/tasks/:id", a.getTask)
	authed.PATCH("/tasks/:id", a.updateTask)
	authed.DELETE("/tasks/:id", a.deleteTask)
	authed.POST("/tasks/:id/messages", a.sendPrompt)
	authed.POST("/tasks/:id/steer", a.steerTask)
	authed.POST("/tasks/:id/abort", a.abortTask)
	authed.GET("/tasks/:id/messages", a.taskHistory)
	authed.GET("/tasks/:id/events", a.taskEvents)
}

// ---- helpers ----

func modeEnum(s string) runtimpb.TaskMode {
	switch s {
	case "ask":
		return runtimpb.TaskMode_TASK_MODE_ASK
	case "plan":
		return runtimpb.TaskMode_TASK_MODE_PLAN
	}
	return runtimpb.TaskMode_TASK_MODE_CRAFT
}

func modeString(m runtimpb.TaskMode) string {
	switch m {
	case runtimpb.TaskMode_TASK_MODE_ASK:
		return "ask"
	case runtimpb.TaskMode_TASK_MODE_PLAN:
		return "plan"
	}
	return "craft"
}

func statusString(s taskpb.TaskStatus) string {
	switch s {
	case taskpb.TaskStatus_TASK_STATUS_PENDING:
		return "pending"
	case taskpb.TaskStatus_TASK_STATUS_RUNNING:
		return "running"
	case taskpb.TaskStatus_TASK_STATUS_FAILED:
		return "failed"
	case taskpb.TaskStatus_TASK_STATUS_ARCHIVED:
		return "archived"
	}
	return "idle"
}

func taskJSON(t *taskpb.TaskInfo) gin.H {
	return gin.H{
		"id": t.GetId(), "user_id": t.GetUserId(), "title": t.GetTitle(),
		"mode": modeString(t.GetMode()),
		"provider": t.GetModel().GetProvider(), "model_id": t.GetModel().GetModelId(),
		"status":      statusString(t.GetStatus()),
		"first_message": t.GetFirstMessage(),
		"expert_id":   t.GetExpertId(),
		"created_at":  t.GetCreatedAt(), "updated_at": t.GetUpdatedAt(),
	}
}

// ---- handlers ----

func (a *App) createTask(c *gin.Context) {
	var req struct {
		Title        string `json:"title"`
		Mode         string `json:"mode"`
		Provider     string `json:"provider" binding:"required"`
		ModelID      string `json:"model_id" binding:"required"`
		FirstMessage string `json:"first_message"`
		ExpertID     string `json:"expert_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "provider and model_id required"})
		return
	}
	resp, err := a.task.CreateTask(outCtx(c), &taskpb.CreateTaskRequest{
		UserId:       c.GetString("user_id"),
		Title:        req.Title,
		Mode:         modeEnum(req.Mode),
		Model:        &taskModel{Provider: req.Provider, ModelId: req.ModelID},
		FirstMessage: req.FirstMessage,
		ExpertId:     req.ExpertID,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"task": taskJSON(resp.Task)})
}

func (a *App) listTasks(c *gin.Context) {
	userID := c.GetString("user_id")
	if c.GetString("role") == "admin" && c.Query("all") == "true" {
		userID = ""
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	resp, err := a.task.ListTasks(outCtx(c), &taskpb.ListTasksRequest{
		UserId: userID, Query: c.Query("q"), Limit: int32(limit), Offset: int32(offset),
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	tasks := make([]gin.H, 0, len(resp.Tasks))
	for _, t := range resp.Tasks {
		tasks = append(tasks, taskJSON(t))
	}
	c.JSON(200, gin.H{"tasks": tasks, "total": resp.Total})
}

func (a *App) getTask(c *gin.Context) {
	resp, err := a.task.GetTask(outCtx(c), &taskpb.GetTaskRequest{TaskId: c.Param("id")})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{
		"task": taskJSON(resp.Task),
		"context_tokens": resp.ContextTokens, "context_window": resp.ContextWindow,
	})
}

func (a *App) updateTask(c *gin.Context) {
	var req struct {
		Title   string `json:"title"`
		Archive bool   `json:"archive"`
	}
	_ = c.ShouldBindJSON(&req)
	resp, err := a.task.UpdateTask(outCtx(c), &taskpb.UpdateTaskRequest{TaskId: c.Param("id"), Title: req.Title, Archive: req.Archive})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"task": taskJSON(resp.Task)})
}

func (a *App) deleteTask(c *gin.Context) {
	_, err := a.task.DeleteTask(outCtx(c), &taskpb.DeleteTaskRequest{TaskId: c.Param("id")})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) sendPrompt(c *gin.Context) {
	var req struct {
		Message          string   `json:"message" binding:"required"`
		Images           []gin.H  `json:"images"`
		StreamingBehavior string  `json:"streaming_behavior"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "message required"})
		return
	}
	pbImages := make([]*imageContent, 0, len(req.Images))
	for _, im := range req.Images {
		data, _ := im["data"].(string)
		mediaType, _ := im["media_type"].(string)
		if data == "" {
			continue
		}
		pbImages = append(pbImages, &imageContent{Data: data, MediaType: mediaType})
	}
	resp, err := a.task.SendPrompt(outCtx(c), &taskpb.SendPromptRequest{
		TaskId: c.Param("id"), UserId: c.GetString("user_id"),
		Message: req.Message, Images: pbImages, StreamingBehavior: req.StreamingBehavior,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"accepted": resp.Accepted})
}

func (a *App) steerTask(c *gin.Context) {
	var req struct {
		Message string `json:"message" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "message required"})
		return
	}
	if _, err := a.task.SteerTask(outCtx(c), &taskpb.SteerTaskRequest{
		TaskId: c.Param("id"), UserId: c.GetString("user_id"), Message: req.Message,
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) abortTask(c *gin.Context) {
	if _, err := a.task.AbortTask(outCtx(c), &taskpb.AbortTaskRequest{
		TaskId: c.Param("id"), UserId: c.GetString("user_id"),
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) taskHistory(c *gin.Context) {
	resp, err := a.task.GetMessages(outCtx(c), &taskpb.GetMessagesRequest{
		TaskId: c.Param("id"), UserId: c.GetString("user_id"),
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	var msgs []json.RawMessage
	_ = json.Unmarshal([]byte(resp.GetMessagesJson()), &msgs)
	out := make([]gin.H, 0, len(msgs))
	for _, m := range msgs {
		var p struct {
			Message struct {
				Role    string `json:"role"`
				Content json.RawMessage `json:"content"`
				Model   string `json:"model"`
				// toolResult extras (role == "toolResult")
				ToolCallId string `json:"toolCallId"`
				ToolName   string `json:"toolName"`
				IsError    bool   `json:"isError"`
			} `json:"message"`
		}
		if json.Unmarshal(m, &p) == nil && p.Message.Role != "" {
			out = append(out, gin.H{
				"role": p.Message.Role, "content": p.Message.Content, "model": p.Message.Model,
				"toolCallId": p.Message.ToolCallId, "toolName": p.Message.ToolName,
				"isError": p.Message.IsError,
			})
		}
	}
	c.JSON(200, gin.H{"messages": out})
}

// taskEvents proxies the gRPC event stream as SSE with Last-Event-ID replay.
func (a *App) taskEvents(c *gin.Context) {
	since := int64(0)
	if id := c.GetHeader("Last-Event-ID"); id != "" {
		if n, err := strconv.ParseInt(id, 10, 64); err == nil {
			since = n
		}
	}
	stream, err := a.task.StreamEvents(outCtx(c), &taskpb.StreamEventsRequest{
		TaskId: c.Param("id"), UserId: c.GetString("user_id"), SinceSeq: since,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.Flush()

	// stop when client disconnects
	clientGone := c.Request.Context().Done()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-clientGone:
			stream.CloseSend()
			return
		case <-ping.C:
			if _, err := io.WriteString(c.Writer, ": ping\n\n"); err != nil {
				return
			}
			c.Writer.Flush()
		default:
			ev, err := stream.Recv()
			if err != nil {
				return // stream ended (task deleted / timeout); browser reconnects
			}
			data, _ := json.Marshal(gin.H{
				"type": ev.GetType(), "payload": json.RawMessage(ev.GetPayload()),
				"session_id": ev.GetSessionId(), "seq": ev.GetSeq(), "ts": ev.GetTimestamp(),
			})
			if _, err := fmt.Fprintf(c.Writer, "id: %d\ndata: %s\n\n", ev.GetSeq(), data); err != nil {
				return
			}
			c.Writer.Flush()
		}
	}
}

var _ = base64.StdEncoding
var _ = codes.InvalidArgument
var _ = status.Code
