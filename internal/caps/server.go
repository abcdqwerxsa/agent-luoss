package caps

import (
	"archive/zip"
	"crypto/cipher"
	"bytes"
	"context"
	"fmt"
	"log"
	"path/filepath"
	"regexp"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/metadata"

	"github.com/redis/go-redis/v9"

	"agentluoss/internal/auditx"
	"agentluoss/internal/cryptx"
	capspb "agentluoss/proto/gen/caps"
	iampb "agentluoss/proto/gen/iam"
)

type Server struct {
	capspb.UnimplementedCapsServer
	store     *Store
	rdb       *redis.Client
	aead      cipher.AEAD
	skillsDir string
	iam       iampb.IAMClient
}

func NewServer(store *Store, rdb *redis.Client, master, skillsDir string, iam iampb.IAMClient) *Server {
	return &Server{
		store:     store,
		rdb:       rdb,
		aead:      cryptx.Cipher(master),
		skillsDir: skillsDir,
		iam:       iam,
	}
}

func (s *Server) Register(g *grpc.Server) { capspb.RegisterCapsServer(g, s) }

func mdRole(ctx context.Context) string {
	md, _ := metadata.FromIncomingContext(ctx)
	if v := md.Get("x-user-role"); len(v) > 0 {
		return v[0]
	}
	return ""
}

func (s *Server) adminOnly(ctx context.Context) error {
	if mdRole(ctx) != "admin" {
		return status.Error(codes.PermissionDenied, "admin only")
	}
	return nil
}

func errCode(err error) error {
	if err == nil {
		return nil
	}
	return status.Error(codes.Internal, err.Error())
}

// ---- MCP servers ----

var transports = map[string]bool{"stdio": true, "http": true, "sse": true}

func validateMcp(m *capspb.McpServerDef) error {
	if m.GetId() == "" {
		return status.Error(codes.InvalidArgument, "id required")
	}
	if !transports[m.GetTransport()] {
		return status.Error(codes.InvalidArgument, "transport must be stdio|http|sse")
	}
	if m.GetTransport() == "stdio" && m.GetCommand() == "" {
		return status.Error(codes.InvalidArgument, "command required for stdio")
	}
	if m.GetTransport() != "stdio" && m.GetUrl() == "" {
		return status.Error(codes.InvalidArgument, "url required for http/sse")
	}
	return nil
}

func scopesFromPb(in []*capspb.Scope) []Scope {
	out := make([]Scope, 0, len(in))
	for _, s := range in {
		out = append(out, Scope{Type: s.GetType(), Value: s.GetValue()})
	}
	return out
}

func (s *Server) UpsertMcpServer(ctx context.Context, req *capspb.UpsertMcpServerRequest) (*capspb.UpsertMcpServerResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	p := req.GetServer()
	if err := validateMcp(p); err != nil {
		return nil, err
	}
	// encrypt env values
	env := map[string]string{}
	for k, v := range p.GetEnv() {
		if v == "" {
			continue
		}
		enc, err := cryptx.Encrypt(s.aead, v)
		if err != nil {
			return nil, errCode(err)
		}
		env[k] = enc
	}
	m := &McpServer{
		ID: p.GetId(), Name: p.GetName(), Transport: p.GetTransport(),
		Command: p.GetCommand(), Args: p.GetArgs(), Env: env, URL: p.GetUrl(),
		Enabled: p.GetEnabled(), Scopes: scopesFromPb(p.GetScopes()),
	}
	if err := s.store.UpsertMcpServer(ctx, m); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.mcp_upsert", Resource: "mcp/" + m.ID})
	return &capspb.UpsertMcpServerResponse{}, nil
}

func mdActor(ctx context.Context) string {
	md, _ := metadata.FromIncomingContext(ctx)
	if v := md.Get("x-user-id"); len(v) > 0 {
		return v[0]
	}
	return ""
}

func (s *Server) DeleteMcpServer(ctx context.Context, req *capspb.DeleteMcpServerRequest) (*capspb.DeleteMcpServerResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if err := s.store.DeleteMcpServer(ctx, req.GetId()); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.mcp_delete", Resource: "mcp/" + req.GetId()})
	return &capspb.DeleteMcpServerResponse{}, nil
}

func scopesToPb(in []Scope) []*capspb.Scope {
	out := make([]*capspb.Scope, 0, len(in))
	for _, s := range in {
		out = append(out, &capspb.Scope{Type: s.Type, Value: s.Value})
	}
	return out
}

func (s *Server) ListMcpServers(ctx context.Context, _ *capspb.ListMcpServersRequest) (*capspb.ListMcpServersResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	servers, err := s.store.ListMcpServers(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &capspb.ListMcpServersResponse{}
	for _, m := range servers {
		envKeys := make(map[string]string, len(m.Env))
		for k := range m.Env {
			envKeys[k] = "" // masked
		}
		out.Servers = append(out.Servers, &capspb.McpServerDef{
			Id: m.ID, Name: m.Name, Transport: m.Transport, Command: m.Command,
			Args: m.Args, Env: envKeys, Url: m.URL, Enabled: m.Enabled,
			Scopes: scopesToPb(m.Scopes), UpdatedAt: m.UpdatedAt,
		})
	}
	return out, nil
}

// ---- skills ----

func (s *Server) UpsertSkill(ctx context.Context, req *capspb.UpsertSkillRequest) (*capspb.UpsertSkillResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if req.GetSkill().GetId() == "" {
		return nil, status.Error(codes.InvalidArgument, "id required")
	}
	k := &Skill{
		ID: req.GetSkill().GetId(), Enabled: req.GetSkill().GetEnabled(),
		Scopes: scopesFromPb(req.GetSkill().GetScopes()),
	}
	if err := s.store.UpsertSkillMeta(ctx, k); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.skill_update", Resource: "skill/" + k.ID})
	return &capspb.UpsertSkillResponse{}, nil
}

func (s *Server) DeleteSkill(ctx context.Context, req *capspb.DeleteSkillRequest) (*capspb.DeleteSkillResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	skill, _ := s.store.GetSkill(ctx, req.GetId())
	if err := s.store.DeleteSkill(ctx, req.GetId()); err != nil {
		return nil, errCode(err)
	}
	if skill != nil && skill.Path != "" {
		_ = removeSkillDir(s.skillsDir, skill.Path) // best effort; DB row is gone
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.skill_delete", Resource: "skill/" + req.GetId()})
	return &capspb.DeleteSkillResponse{}, nil
}

func (s *Server) ListSkills(ctx context.Context, _ *capspb.ListSkillsRequest) (*capspb.ListSkillsResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	skills, err := s.store.ListSkills(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &capspb.ListSkillsResponse{}
	for _, k := range skills {
		out.Skills = append(out.Skills, &capspb.SkillDef{
			Id: k.ID, Name: k.Name, Description: k.Description, Path: k.Path,
			Enabled: k.Enabled, Scopes: scopesToPb(k.Scopes), UpdatedAt: k.UpdatedAt,
		})
	}
	return out, nil
}

var slugRe = regexp.MustCompile(`[^a-z0-9-]+`)

// UploadSkill extracts a zip into <skillsDir>/<id>/, finds SKILL.md (root or
// one level down), parses frontmatter, and upserts the record.
func (s *Server) UploadSkill(ctx context.Context, req *capspb.UploadSkillRequest) (*capspb.UploadSkillResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if len(req.GetZip()) == 0 {
		return nil, status.Error(codes.InvalidArgument, "zip required")
	}
	id := req.GetId()
	if id == "" {
		id = "s_" + fmt.Sprintf("%x", hash64(req.GetZip()))
	}
	dest := filepath.Join(s.skillsDir, id)
	if err := extractZip(req.GetZip(), dest); err != nil {
		return nil, errCode(err)
	}
	skillDir, name, desc, err := findSkillMd(dest)
	if err != nil {
		_ = removeSkillDir(s.skillsDir, dest)
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	k := &Skill{
		ID: id, Name: name, Description: desc, Path: skillDir,
		Enabled: req.GetEnabled(), Scopes: scopesFromPb(req.GetScopes()),
	}
	if err := s.store.UpsertSkill(ctx, k); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.skill_upload", Resource: "skill/" + id})
	return &capspb.UploadSkillResponse{Skill: &capspb.SkillDef{
		Id: k.ID, Name: k.Name, Description: k.Description, Path: k.Path,
		Enabled: k.Enabled, Scopes: scopesToPb(k.Scopes),
	}}, nil
}

// ---- effective caps (internal) ----

// GetEffectiveCaps resolves the caps visible to a user, unioned with the
// member caps of the requested expert (if any). Fail-open on iam errors.
func (s *Server) GetEffectiveCaps(ctx context.Context, req *capspb.GetEffectiveCapsRequest) (*capspb.GetEffectiveCapsResponse, error) {
	department, role := "", ""
	if s.iam != nil {
		if u, err := s.iam.GetUser(ctx, &iampb.GetUserRequest{UserId: req.GetUserId()}); err == nil && u.GetUser() != nil {
			department = u.GetUser().GetDepartmentId()
			role = u.GetUser().GetRole()
		} else if err != nil {
			log.Printf("caps: GetUser %s failed (fail-open to no-dept): %v", req.GetUserId(), err)
		}
	}
	mcp, err := s.store.ListMcpServers(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	skills, err := s.store.ListSkills(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	mcp, skills = EffectiveCaps(mcp, skills, department, role)

	// union in expert member caps (expert binding chosen at task creation;
	// scope was already checked when the expert was listed for the user)
	if req.GetExpertId() != "" {
		eSkillIDs, eMcpIDs, err := s.store.ExpertItems(ctx, req.GetExpertId())
		if err == nil {
			wantSkill := map[string]bool{}
			for _, id := range eSkillIDs {
				wantSkill[id] = true
			}
			wantMcp := map[string]bool{}
			for _, id := range eMcpIDs {
				wantMcp[id] = true
			}
			allMcp, _ := s.store.ListMcpServers(ctx)
			allSkills, _ := s.store.ListSkills(ctx)
			for _, m := range allMcp {
				if wantMcp[m.ID] && !containsServer(mcp, m.ID) {
					mcp = append(mcp, m)
				}
			}
			for _, k := range allSkills {
				if wantSkill[k.ID] && !containsSkill(skills, k.ID) {
					skills = append(skills, k)
				}
			}
		}
	}

	out := &capspb.GetEffectiveCapsResponse{}
	for _, m := range mcp {
		env := map[string]string{}
		for k, v := range m.Env {
			if d, err := cryptx.Decrypt(s.aead, v); err == nil {
				env[k] = d
			} else {
				log.Printf("caps: decrypt env %s/%s failed: %v", m.ID, k, err)
			}
		}
		out.McpServers = append(out.McpServers, &capspb.McpServerDef{
			Id: m.ID, Name: m.Name, Transport: m.Transport, Command: m.Command,
			Args: m.Args, Env: env, Url: m.URL, Enabled: true,
		})
	}
	for _, k := range skills {
		out.Skills = append(out.Skills, &capspb.SkillDef{
			Id: k.ID, Name: k.Name, Description: k.Description, Path: k.Path,
		})
	}
	return out, nil
}

func containsServer(list []*McpServer, id string) bool {
	for _, m := range list {
		if m.ID == id {
			return true
		}
	}
	return false
}

func containsSkill(list []*Skill, id string) bool {
	for _, k := range list {
		if k.ID == id {
			return true
		}
	}
	return false
}

// ---- zip helpers ----

// extractZip unpacks zip data into dest, refusing path traversal and
// absolute paths (same policy as the artifact service).
func extractZip(data []byte, dest string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("bad zip: %w", err)
	}
	destAbs, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		name := filepath.Clean(f.Name)
		if strings.HasPrefix(name, "/") || strings.HasPrefix(name, "..") || filepath.IsAbs(name) {
			return fmt.Errorf("zip entry escapes: %s", f.Name)
		}
		target := filepath.Join(destAbs, name)
		if target != destAbs && !strings.HasPrefix(target, destAbs+string(filepath.Separator)) {
			return fmt.Errorf("zip entry escapes: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			continue
		}
		if err := extractFile(f, target); err != nil {
			return err
		}
	}
	return nil
}

func extractFile(f *zip.File, target string) error {
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	if err := writeFileSyncMkdir(target, rc); err != nil {
		return err
	}
	return nil
}

// findSkillMd locates SKILL.md at the root of dir, or under a single
// top-level subdirectory (zip of the skill folder itself). Returns the
// directory containing SKILL.md, plus name/description from frontmatter.
func findSkillMd(dir string) (skillDir, name, description string, err error) {
	root := filepath.Join(dir, "SKILL.md")
	if fileExists(root) {
		return parseFrontmatter(dir, root)
	}
	entries, err := readDirNames(dir)
	if err != nil {
		return "", "", "", err
	}
	var candidates []string
	for _, e := range entries {
		if fileExists(filepath.Join(dir, e, "SKILL.md")) {
			candidates = append(candidates, e)
		}
	}
	if len(candidates) != 1 {
		return "", "", "", fmt.Errorf("expected exactly one SKILL.md (root or single top-level dir), found %d", len(candidates))
	}
	return parseFrontmatter(filepath.Join(dir, candidates[0]), filepath.Join(dir, candidates[0], "SKILL.md"))
}
