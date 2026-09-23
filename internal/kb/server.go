// gRPC service surface + async ingest worker + caps linkage.
package kb

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"agentluoss/internal/auditx"
	capspb "agentluoss/proto/gen/caps"
	iampb "agentluoss/proto/gen/iam"
	kbpb "agentluoss/proto/gen/kb"
)

type Server struct {
	kbpb.UnimplementedKbServer
	store     *Store
	rdb       *redis.Client
	caps       capspb.CapsClient // optional: auto-register per-KB MCP entries
	iam       iampb.IAMClient   // optional: user scope checks
	mineruURL    string // optional: external parser (Phase 1)
	mineruBackend string
	advertised string           // MCP URL base, e.g. http://kb:9098
	httpClient *http.Client
}

func NewServer(store *Store, rdb *redis.Client, caps capspb.CapsClient, iam iampb.IAMClient, mineruURL, advertised string) *Server {
	return &Server{
		store: store, rdb: rdb, caps: caps, iam: iam,
		mineruURL: mineruURL, mineruBackend: "pipeline", advertised: strings.TrimSuffix(advertised, "/"),
		httpClient: &http.Client{Timeout: 5 * time.Minute},
	}
}

func (s *Server) Register(g *grpc.Server) { kbpb.RegisterKbServer(g, s) }

func errCode(err error) error {
	if errors.Is(err, ErrNotFound) {
		return status.Error(codes.NotFound, err.Error())
	}
	return status.Error(codes.Internal, err.Error())
}

func newID(prefix string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// ---- lifecycle ----

func validScope(t string) bool { return t == "all" || t == "department" || t == "role" }

func (s *Server) CreateKb(ctx context.Context, req *kbpb.CreateKbRequest) (*kbpb.CreateKbResponse, error) {
	name := strings.TrimSpace(req.GetName())
	if name == "" {
		return nil, status.Error(codes.InvalidArgument, "name required")
	}
	sc := req.GetScope()
	if sc == nil || !validScope(sc.GetType()) {
		return nil, status.Error(codes.InvalidArgument, "scope type must be all|department|role")
	}
	if sc.GetType() != "all" && sc.GetValue() == "" {
		return nil, status.Error(codes.InvalidArgument, "scope value required for department/role")
	}
	k := &KB{ID: newID("kb_"), Name: name, ScopeType: sc.GetType(), ScopeValue: sc.GetValue()}
	if err := s.store.CreateKB(ctx, k); err != nil {
		return nil, errCode(err)
	}
	// per-KB caps MCP entry: visibility = caps scope governance, zero new code
	if s.caps != nil {
		if _, err := s.caps.UpsertMcpServer(ctx, &capspb.UpsertMcpServerRequest{
			Server: &capspb.McpServerDef{
				Id: "kb-" + k.ID, Name: "知识库:" + name, Transport: "http",
				Url: s.advertised + "/mcp/" + k.ID, Enabled: true,
				Scopes: []*capspb.Scope{{Type: k.ScopeType, Value: k.ScopeValue}},
			},
		}); err != nil {
			// KB exists but agents won't see it; surface loudly, keep the KB
			log.Printf("kb: caps registration for %s failed: %v", k.ID, err)
		}
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: actorOf(ctx), Action: "kb.create", Resource: "kb/" + k.ID})
	return &kbpb.CreateKbResponse{Kb: toPbKB(k)}, nil
}

func (s *Server) DeleteKb(ctx context.Context, req *kbpb.DeleteKbRequest) (*kbpb.DeleteKbResponse, error) {
	if err := s.store.DeleteKB(ctx, req.GetId()); err != nil {
		return nil, errCode(err)
	}
	if s.caps != nil {
		if _, err := s.caps.DeleteMcpServer(ctx, &capspb.DeleteMcpServerRequest{Id: "kb-" + req.GetId()}); err != nil {
			log.Printf("kb: caps deregistration for %s failed: %v", req.GetId(), err)
		}
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: actorOf(ctx), Action: "kb.delete", Resource: "kb/" + req.GetId()})
	return &kbpb.DeleteKbResponse{}, nil
}

func (s *Server) ListKbs(ctx context.Context, _ *kbpb.ListKbsRequest) (*kbpb.ListKbsResponse, error) {
	ks, err := s.store.ListKBs(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &kbpb.ListKbsResponse{}
	for _, k := range ks {
		out.Kbs = append(out.Kbs, toPbKB(k))
	}
	return out, nil
}

func (s *Server) ListKbsForUser(ctx context.Context, req *kbpb.ListKbsForUserRequest) (*kbpb.ListKbsForUserResponse, error) {
	ks, err := s.store.ListKBs(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	dept, role := "", ""
	if s.iam != nil && req.GetUserId() != "" {
		if u, err := s.iam.GetUser(ctx, &iampb.GetUserRequest{UserId: req.GetUserId()}); err == nil && u.GetUser() != nil {
			dept = u.GetUser().GetDepartmentId()
			role = u.GetUser().GetRole()
		} else if err != nil {
			log.Printf("kb: GetUser %s failed (fail-open to no dept): %v", req.GetUserId(), err)
		}
	}
	out := &kbpb.ListKbsForUserResponse{}
	for _, k := range ks {
		if k.ScopeType == "all" ||
			(k.ScopeType == "department" && k.ScopeValue == dept) ||
			(k.ScopeType == "role" && k.ScopeValue == role) {
			out.Kbs = append(out.Kbs, toPbKB(k))
		}
	}
	return out, nil
}

// ---- docs ----

const maxUpload = 50 << 20 // 50MB per doc

func (s *Server) UploadDoc(ctx context.Context, req *kbpb.UploadDocRequest) (*kbpb.UploadDocResponse, error) {
	k, err := s.store.GetKB(ctx, req.GetKbId())
	if err != nil {
		return nil, errCode(err)
	}
	if req.GetFilename() == "" || len(req.GetContent()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "filename and content required")
	}
	if len(req.GetContent()) > maxUpload {
		return nil, status.Error(codes.InvalidArgument, "file exceeds 50MB")
	}
	if req.GetUploaderRole() != "admin" && !userInScope(ctx, s.iam, k, req.GetUploader()) {
		return nil, status.Error(codes.PermissionDenied, "not a member of this knowledge base")
	}
	d := &Doc{
		ID: newID("doc_"), KBID: k.ID, Filename: req.GetFilename(),
		Title: TitleFromFilename(req.GetFilename()), Size: int64(len(req.GetContent())),
		Uploader: req.GetUploader(),
	}
	if err := s.store.InsertDoc(ctx, d, req.GetContent()); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: req.GetUploader(), Action: "kb.upload_doc", Resource: "kb/" + k.ID + "/doc/" + d.ID})
	s.IngestNow() // kick worker immediately
	return &kbpb.UploadDocResponse{Doc: toPbDoc(d)}, nil
}

func userInScope(ctx context.Context, iam iampb.IAMClient, k *KB, userID string) bool {
	if k.ScopeType == "all" {
		return true
	}
	if iam == nil || userID == "" {
		return false
	}
	u, err := iam.GetUser(ctx, &iampb.GetUserRequest{UserId: userID})
	if err != nil || u.GetUser() == nil {
		return false
	}
	if k.ScopeType == "department" {
		return u.GetUser().GetDepartmentId() == k.ScopeValue
	}
	return u.GetUser().GetRole() == k.ScopeValue
}

func (s *Server) DeleteDoc(ctx context.Context, req *kbpb.DeleteDocRequest) (*kbpb.DeleteDocResponse, error) {
	if err := s.store.DeleteDoc(ctx, req.GetId()); err != nil {
		return nil, errCode(err)
	}
	return &kbpb.DeleteDocResponse{}, nil
}

func (s *Server) ListDocs(ctx context.Context, req *kbpb.ListDocsRequest) (*kbpb.ListDocsResponse, error) {
	ds, err := s.store.ListDocs(ctx, req.GetKbId())
	if err != nil {
		return nil, errCode(err)
	}
	out := &kbpb.ListDocsResponse{}
	for _, d := range ds {
		out.Docs = append(out.Docs, toPbDoc(d))
	}
	return out, nil
}

// ---- retrieval ----

const (
	recallLimit = 200
	snippetRunes = 200
)

func (s *Server) Search(ctx context.Context, req *kbpb.SearchRequest) (*kbpb.SearchResponse, error) {
	q := strings.TrimSpace(req.GetQuery())
	if q == "" || req.GetKbId() == "" {
		return nil, status.Error(codes.InvalidArgument, "kb_id and query required")
	}
	topK := int(req.GetTopK())
	if topK <= 0 || topK > 50 {
		topK = 8
	}
	terms := SplitQueryTerms(q)
	if len(terms) == 0 {
		return &kbpb.SearchResponse{}, nil
	}
	cands, err := s.store.RecallChunks(ctx, req.GetKbId(), terms, recallLimit)
	if err != nil {
		return nil, errCode(err)
	}
	scored := RankScores(cands, terms)
	if len(scored) > topK {
		scored = scored[:topK]
	}
	titles, _ := s.store.DocTitles(ctx, docIDs(scored))
	out := &kbpb.SearchResponse{}
	for _, h := range scored {
		out.Hits = append(out.Hits, &kbpb.SearchHit{
			DocId: h.Chunk.DocID, Title: titles[h.Chunk.DocID],
			Section: h.Chunk.Section, Score: h.Score,
			Snippet: Snippet(h.Chunk.Text, terms),
		})
	}
	return out, nil
}

func (s *Server) ReadDoc(ctx context.Context, req *kbpb.ReadDocRequest) (*kbpb.ReadDocResponse, error) {
	d, err := s.store.GetDoc(ctx, req.GetDocId())
	if err != nil {
		return nil, errCode(err)
	}
	if req.GetSection() == "" {
		md, err := s.store.DocMarkdown(ctx, req.GetDocId())
		if err != nil {
			return nil, errCode(err)
		}
		if r := []rune(md); len(r) > 60000 { // ponytail: whole-doc cap; agent can ask per-section
			md = string(r[:60000]) + "\n\n…(已截断，可用 read_doc 的 section 参数读取具体章节)"
		}
		return &kbpb.ReadDocResponse{DocId: d.ID, Title: d.Title, Markdown: md}, nil
	}
	chunks, err := s.store.SectionChunks(ctx, req.GetDocId(), req.GetSection())
	if err != nil {
		return nil, errCode(err)
	}
	var b strings.Builder
	for _, c := range chunks {
		b.WriteString(c.Text + "\n\n")
	}
	if b.Len() == 0 {
		return nil, status.Error(codes.NotFound, "section not found")
	}
	return &kbpb.ReadDocResponse{DocId: d.ID, Title: d.Title + " · " + req.GetSection(), Markdown: b.String()}, nil
}

func docIDs(scored []Scored) []string {
	ids := make([]string, 0, len(scored))
	seen := map[string]bool{}
	for _, h := range scored {
		if !seen[h.Chunk.DocID] {
			seen[h.Chunk.DocID] = true
			ids = append(ids, h.Chunk.DocID)
		}
	}
	return ids
}

// Snippet centers on the first longest-term hit, rune-safe.
func Snippet(text string, terms []string) string {
	r := []rune(text)
	lower := strings.ToLower(text)
	best, bestAt := 0, -1
	for _, t := range terms {
		if at := strings.Index(lower, t); at >= 0 && len([]rune(t)) >= best {
			best = len([]rune(t))
			bestAt = at
		}
	}
	start, end := 0, len(r)
	if bestAt >= 0 {
		ru := len([]rune(text[:bestAt]))
		start = ru - snippetRunes/3
		if start < 0 {
			start = 0
		}
		end = start + snippetRunes
	}
	if end > len(r) {
		end = len(r)
	}
	out := string(r[start:end])
	if start > 0 {
		out = "…" + out
	}
	if end < len(r) {
		out += "…"
	}
	return strings.ReplaceAll(out, "\n", " ")
}

// ---- ingest worker ----

// StartIngest launches the async parse loop (ticker + upload kick).
func (s *Server) StartIngest() {
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for range t.C {
			s.ingestOnce(context.Background())
		}
	}()
}

// IngestNow kicks a non-blocking scan (called after upload).
func (s *Server) IngestNow() { go s.ingestOnce(context.Background()) }

func (s *Server) ingestOnce(ctx context.Context) {
	docs, err := s.store.ListParsing(ctx)
	if err != nil {
		return
	}
	for _, d := range docs {
		s.ingestDoc(ctx, d)
	}
}

func (s *Server) ingestDoc(ctx context.Context, d *Doc) {
	raw, err := s.store.DocRaw(ctx, d.ID)
	if err != nil {
		s.store.SetDocFailed(ctx, d.ID, "raw read: "+err.Error())
		return
	}
	md, ok := BuiltinParse(d.Filename, string(raw))
	if !ok {
		if s.mineruURL == "" {
			s.store.SetDocFailed(ctx, d.ID, "该文件类型需要外部解析器（MinerU 未配置）")
			return
		}
		md, err = s.mineruParse(ctx, d.Filename, raw)
		if err != nil {
			s.store.SetDocFailed(ctx, d.ID, "mineru: "+err.Error())
			return
		}
	}
	chunks := ChunkMarkdown(md)
	cs := make([]*Chunk, len(chunks))
	for i, c := range chunks {
		cs[i] = &Chunk{
			DocID: d.ID, KBID: d.KBID, Seq: i, Section: c.Section,
			Text: c.Text, Tokens: len([]rune(c.Text)),
		}
	}
	if err := s.store.SetDocParsed(ctx, d.ID, md, cs); err != nil {
		s.store.SetDocFailed(ctx, d.ID, "store: "+err.Error())
		return
	}
	log.Printf("kb: ingested %s (%s) -> %d chunks", d.ID, d.Filename, len(cs))
}

// mineruParse sends the raw file to the MinerU FastAPI service
// (POST {MINERU_URL}/file_parse, multipart; 2.x sync endpoint) and extracts
// the parsed markdown. Response is keyed by original filename with
// md_content/err_msg per file; tolerate wrapper shapes defensively.
func (s *Server) mineruParse(ctx context.Context, filename string, raw []byte) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("files", filename)
	if err != nil {
		return "", err
	}
	if _, err := fw.Write(raw); err != nil {
		return "", err
	}
	_ = mw.WriteField("output_dir", "/tmp")
	_ = mw.WriteField("return_md", "true")
	_ = mw.WriteField("backend", s.mineruBackend)
	_ = mw.WriteField("lang_list", "ch")
	if err := mw.Close(); err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.mineruURL+"/file_parse", &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("http %d: %.200s", resp.StatusCode, body)
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("bad json: %.200s", body)
	}
	md, ok := findMDContent(parsed)
	if !ok {
		return "", fmt.Errorf("md_content not found in response: %.200s", body)
	}
	if strings.TrimSpace(md) == "" {
		return "", fmt.Errorf("empty markdown (likely parse failure)")
	}
	return md, nil
}

// findMDContent walks the parsed response looking for the first non-empty
// md_content string (top-level is map[filename]{md_content,...} in 2.x).
func findMDContent(v any) (string, bool) {
	switch t := v.(type) {
	case map[string]any:
		if s, ok := t["md_content"].(string); ok && strings.TrimSpace(s) != "" {
			return s, true
		}
		if s, ok := t["err_msg"].(string); ok && s != "" {
			return "", false // surfaced by the not-found path below
		}
		for _, k := range []string{"data", "result", "results"} {
			if sub, ok := t[k]; ok {
				if md, found := findMDContent(sub); found {
					return md, true
				}
			}
		}
		for _, sub := range t {
			if md, found := findMDContent(sub); found {
				return md, true
			}
		}
	case []any:
		for _, sub := range t {
			if md, found := findMDContent(sub); found {
				return md, true
			}
		}
	}
	return "", false
}

func actorOf(ctx context.Context) string {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("x-user-id"); len(v) > 0 {
			return v[0]
		}
	}
	return "system"
}
