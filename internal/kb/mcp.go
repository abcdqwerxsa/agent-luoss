// Per-KB MCP server (streamable HTTP): one URL per knowledge base,
// registered in caps. Speaks JSON-RPC 2.0 per MCP streamable-http:
// POST application/json responses; stateless (no session id needed).
package kb

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	kbpb "agentluoss/proto/gen/kb"
)

// MCPHandler serves /mcp/{kbId}.
func (s *Server) MCPHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		kbID := strings.TrimPrefix(r.URL.Path, "/mcp/")
		if kbID == "" || strings.Contains(kbID, "/") {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodPost:
			s.mcpPost(w, r, kbID)
		default:
			// streamable-http: no server-initiated SSE stream
			w.Header().Set("Allow", "POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func (s *Server) mcpPost(w http.ResponseWriter, r *http.Request, kbID string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	var req rpcReq
	if err := json.Unmarshal(body, &req); err != nil {
		writeRPCError(w, nil, -32700, "parse error")
		return
	}
	if len(req.ID) == 0 { // notification (e.g. notifications/initialized)
		w.WriteHeader(http.StatusAccepted)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	var result any
	switch req.Method {
	case "initialize":
		result = s.mcpInitialize(req.Params)
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": kbTools()}
	case "tools/call":
		res, rpcErr := s.mcpToolCall(r.Context(), kbID, req.Params)
		if rpcErr != nil {
			writeRPCError(w, req.ID, rpcErr.code, rpcErr.message)
			return
		}
		result = res
	default:
		writeRPCError(w, req.ID, -32601, "method not found: "+req.Method)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": req.ID, "result": result,
	})
}

func (s *Server) mcpInitialize(params json.RawMessage) any {
	// echo the client's requested version (always within its supported set)
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	ver := "2025-06-18"
	if json.Unmarshal(params, &p) == nil && p.ProtocolVersion != "" {
		ver = p.ProtocolVersion
	}
	return map[string]any{
		"protocolVersion": ver,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "agentluoss-kb", "version": "1.0.0"},
	}
}

func kbTools() []map[string]any {
	return []map[string]any{
		{
			"name":        "search",
			"description": "在知识库中检索与问题相关的段落，返回文档标题、章节、片段与相关度分数。答案中的事实应引用来源（doc_id 与 section）。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{"type": "string", "description": "检索问题或关键词"},
					"top_k": map[string]any{"type": "integer", "description": "返回条数，默认 8"},
				},
				"required": []string{"query"},
			},
		},
		{
			"name":        "read_doc",
			"description": "读取一篇文档的完整内容（markdown）。search 片段不够、需要上下文或精确数字时使用；可只读某一章节。",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"doc_id":  map[string]any{"type": "string", "description": "search 返回的 doc_id"},
					"section": map[string]any{"type": "string", "description": "可选：章节名（search 返回的 section）"},
				},
				"required": []string{"doc_id"},
			},
		},
	}
}

type rpcErr struct {
	code    int
	message string
}

func (s *Server) mcpToolCall(ctx context.Context, kbID string, params json.RawMessage) (any, *rpcErr) {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, &rpcErr{-32602, "invalid params"}
	}
	var out string
	switch p.Name {
	case "search":
		var a struct {
			Query string `json:"query"`
			TopK  int32  `json:"top_k"`
		}
		_ = json.Unmarshal(p.Arguments, &a)
		resp, err := s.Search(ctx, &kbpb.SearchRequest{KbId: kbID, Query: a.Query, TopK: a.TopK})
		if err != nil {
			return toolError(err.Error()), nil
		}
		if len(resp.GetHits()) == 0 {
			out = `{"hits": [], "hint": "没有检索到相关内容。可尝试：换关键词、拆分问题、或用更具体的术语。"}`
		} else {
			b, _ := json.Marshal(map[string]any{"hits": resp.GetHits()})
			out = string(b)
		}
	case "read_doc":
		var a struct {
			DocID   string `json:"doc_id"`
			Section string `json:"section"`
		}
		_ = json.Unmarshal(p.Arguments, &a)
		resp, err := s.ReadDoc(ctx, &kbpb.ReadDocRequest{DocId: a.DocID, Section: a.Section})
		if err != nil {
			return toolError(err.Error()), nil
		}
		b, _ := json.Marshal(map[string]any{"doc_id": resp.GetDocId(), "title": resp.GetTitle(), "markdown": resp.GetMarkdown()})
		out = string(b)
	default:
		return nil, &rpcErr{-32602, "unknown tool: " + p.Name}
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": out}},
		"isError": false,
	}, nil
}

func toolError(msg string) any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": msg}},
		"isError": true,
	}
}

func writeRPCError(w http.ResponseWriter, id json.RawMessage, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	if id == nil {
		id = json.RawMessage("null")
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": msg},
	})
}
