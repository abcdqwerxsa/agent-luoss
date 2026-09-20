// Expert CRUD RPCs: bundles of skills/MCP servers for quick-start.
package caps

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	capspb "agentluoss/proto/gen/caps"
	iampb "agentluoss/proto/gen/iam"

	"agentluoss/internal/auditx"
)

func expertPb(e *Expert) *capspb.ExpertDef {
	return &capspb.ExpertDef{
		Id: e.ID, Name: e.Name, Description: e.Description, Enabled: e.Enabled,
		SkillIds: e.SkillIDs, McpIds: e.McpIDs, Scopes: scopesToPb(e.Scopes), UpdatedAt: e.UpdatedAt,
	}
}

func (s *Server) UpsertExpert(ctx context.Context, req *capspb.UpsertExpertRequest) (*capspb.UpsertExpertResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	e := req.GetExpert()
	if e.GetId() == "" || e.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "id and name required")
	}
	if err := s.store.UpsertExpert(ctx, &Expert{
		ID: e.GetId(), Name: e.GetName(), Description: e.GetDescription(),
		Enabled: e.GetEnabled(), SkillIDs: e.GetSkillIds(), McpIDs: e.GetMcpIds(),
		Scopes: scopesFromPb(e.GetScopes()),
	}); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.expert_upsert", Resource: "expert/" + e.GetId()})
	return &capspb.UpsertExpertResponse{}, nil
}

func (s *Server) DeleteExpert(ctx context.Context, req *capspb.DeleteExpertRequest) (*capspb.DeleteExpertResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if err := s.store.DeleteExpert(ctx, req.GetId()); err != nil {
		return nil, errCode(err)
	}
	auditx.Publish(ctx, s.rdb, auditx.Event{Actor: mdActor(ctx), Action: "caps.expert_delete", Resource: "expert/" + req.GetId()})
	return &capspb.DeleteExpertResponse{}, nil
}

func (s *Server) ListExperts(ctx context.Context, _ *capspb.ListExpertsRequest) (*capspb.ListExpertsResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	experts, err := s.store.ListExperts(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &capspb.ListExpertsResponse{}
	for _, e := range experts {
		out.Experts = append(out.Experts, expertPb(e))
	}
	return out, nil
}

// ListExpertsForUser returns enabled experts visible to the user (scope applied).
// Fail-open on iam errors (unknown dept = platform-wide experts only).
func (s *Server) ListExpertsForUser(ctx context.Context, req *capspb.ListExpertsForUserRequest) (*capspb.ListExpertsForUserResponse, error) {
	department, role := "", ""
	if s.iam != nil {
		if u, err := s.iam.GetUser(ctx, &iampb.GetUserRequest{UserId: req.GetUserId()}); err == nil && u.GetUser() != nil {
			department = u.GetUser().GetDepartmentId()
			role = u.GetUser().GetRole()
		}
	}
	experts, err := s.store.ListExperts(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &capspb.ListExpertsForUserResponse{}
	for _, e := range experts {
		if e.Enabled && EffectiveScope(e.Scopes, department, role) {
			out.Experts = append(out.Experts, expertPb(e))
		}
	}
	return out, nil
}

// ExpertCaps augments a caps list with the expert's member caps.
func (s *Server) ExpertCaps(ctx context.Context, expertID string) (skills, mcps []string, err error) {
	return s.store.ExpertItems(ctx, expertID)
}
