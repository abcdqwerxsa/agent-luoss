// Package iam implements the IAM gRPC service: accounts, roles, JWT issuing.
package iam

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"agentluoss/internal/auditx"
	"agentluoss/internal/jwtx"
	iampb "agentluoss/proto/gen/iam"

	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/bcrypt"
)

func HashPassword(pw string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(b), err
}

func checkPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

type Server struct {
	iampb.UnimplementedIAMServer
	store  *Store
	secret string
	audit  auditq
}

type auditq interface {
	Publish(ctx context.Context, rdb *redis.Client, ev auditx.Event)
	Redis() *redis.Client
}

// auditHub adapts auditx for the server (kept tiny for testability).
type auditHub struct{ rdb *redis.Client }

func (h auditHub) Publish(ctx context.Context, rdb *redis.Client, ev auditx.Event) {
	auditx.Publish(ctx, rdb, ev)
}
func (h auditHub) Redis() *redis.Client { return h.rdb }

func NewServer(store *Store, secret string, rdb *redis.Client) *Server {
	return &Server{store: store, secret: secret, audit: auditHub{rdb: rdb}}
}

func (s *Server) Register(g *grpc.Server) { iampb.RegisterIAMServer(g, s) }

// actor returns (userID, role) injected by the gateway as gRPC metadata.
func actor(ctx context.Context) (string, string) {
	md, _ := metadata.FromIncomingContext(ctx)
	id := first(md, "x-user-id")
	role := first(md, "x-user-role")
	return id, role
}

func first(md metadata.MD, k string) string {
	if v := md.Get(k); len(v) > 0 {
		return v[0]
	}
	return ""
}

func errCode(err error) error {
	switch {
	case errors.Is(err, ErrBadCredentials):
		return status.Error(codes.Unauthenticated, err.Error())
	case errors.Is(err, ErrUserExists):
		return status.Error(codes.AlreadyExists, err.Error())
	case errors.Is(err, ErrNotFound):
		return status.Error(codes.NotFound, err.Error())
	}
	return status.Error(codes.Internal, "internal error")
}

func (s *Server) Login(ctx context.Context, req *iampb.LoginRequest) (*iampb.LoginResponse, error) {
	u, hash, err := s.store.GetUserByUsername(ctx, req.GetUsername())
	if err != nil {
		return nil, errCode(err)
	}
	if u.Status != "active" || !checkPassword(hash, req.GetPassword()) {
		return nil, status.Error(codes.Unauthenticated, "bad credentials")
	}
	access, err := jwtx.Sign(s.secret, u.ID, u.Role)
	if err != nil {
		return nil, errCode(err)
	}
	refresh, err := s.store.SaveRefreshToken(ctx, u.ID, jwtx.RefreshTTL)
	if err != nil {
		return nil, errCode(err)
	}
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: u.ID, Action: "auth.login", Resource: "user/" + u.ID,
		IP: firstMd(ctx, "x-user-ip"),
	})
	return &iampb.LoginResponse{
		AccessToken:  access,
		RefreshToken: refresh,
		ExpiresIn:    int64(jwtx.AccessTTL.Seconds()),
		User:         toPb(u),
	}, nil
}

func firstMd(ctx context.Context, k string) string {
	md, _ := metadata.FromIncomingContext(ctx)
	return first(md, k)
}

func (s *Server) Refresh(ctx context.Context, req *iampb.RefreshRequest) (*iampb.RefreshResponse, error) {
	userID, err := s.store.ConsumeRefreshToken(ctx, req.GetRefreshToken())
	if err != nil {
		return nil, errCode(err)
	}
	// rotate: single-use refresh consumed above, issue a fresh pair
	u, _, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, errCode(err)
	}
	access, err := jwtx.Sign(s.secret, u.ID, u.Role)
	if err != nil {
		return nil, errCode(err)
	}
	refresh, err := s.store.SaveRefreshToken(ctx, u.ID, jwtx.RefreshTTL)
	if err != nil {
		return nil, errCode(err)
	}
	return &iampb.RefreshResponse{
		AccessToken:  access,
		RefreshToken: refresh,
		ExpiresIn:    int64(jwtx.AccessTTL.Seconds()),
	}, nil
}

func (s *Server) Logout(ctx context.Context, req *iampb.LogoutRequest) (*iampb.LogoutResponse, error) {
	_ = s.store.DeleteRefreshToken(ctx, req.GetRefreshToken())
	return &iampb.LogoutResponse{}, nil
}

// adminOnly guards user management RPCs (defense in depth under gateway RBAC).
func (s *Server) adminOnly(ctx context.Context) error {
	_, role := actor(ctx)
	if role != "admin" {
		return status.Error(codes.PermissionDenied, "admin only")
	}
	return nil
}

func (s *Server) CreateUser(ctx context.Context, req *iampb.CreateUserRequest) (*iampb.CreateUserResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if req.GetUsername() == "" || len(req.GetPassword()) < 8 {
		return nil, status.Error(codes.InvalidArgument, "username required, password >= 8 chars")
	}
	role := req.GetRole()
	if role != "admin" && role != "member" {
		role = "member"
	}
	u, err := s.store.CreateUser(ctx, req.GetUsername(), req.GetPassword(), req.GetDisplayName(), role, req.GetDepartmentId())
	if err != nil {
		return nil, errCode(err)
	}
	actorID, _ := actor(ctx)
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: actorID, Action: "user.create", Resource: "user/" + u.ID,
	})
	return &iampb.CreateUserResponse{User: toPb(u)}, nil
}

func (s *Server) ListUsers(ctx context.Context, _ *iampb.ListUsersRequest) (*iampb.ListUsersResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	users, err := s.store.ListUsers(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &iampb.ListUsersResponse{}
	for _, u := range users {
		out.Users = append(out.Users, toPb(u))
	}
	return out, nil
}

func (s *Server) UpdateUser(ctx context.Context, req *iampb.UpdateUserRequest) (*iampb.UpdateUserResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if req.GetPassword() != "" && len(req.GetPassword()) < 8 {
		return nil, status.Error(codes.InvalidArgument, "password >= 8 chars")
	}
	u, err := s.store.UpdateUser(ctx, req.GetUserId(), req.GetDisplayName(), req.GetRole(), req.GetStatus(), req.GetPassword(), req.GetDepartmentId())
	if err != nil {
		return nil, errCode(err)
	}
	actorID, _ := actor(ctx)
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: actorID, Action: "user.update", Resource: "user/" + u.ID,
	})
	return &iampb.UpdateUserResponse{User: toPb(u)}, nil
}

func (s *Server) DeleteUser(ctx context.Context, req *iampb.DeleteUserRequest) (*iampb.DeleteUserResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	actorID, _ := actor(ctx)
	if actorID == req.GetUserId() {
		return nil, status.Error(codes.InvalidArgument, "cannot delete self")
	}
	if err := s.store.DeleteUser(ctx, req.GetUserId()); err != nil {
		return nil, errCode(err)
	}
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: actorID, Action: "user.delete", Resource: "user/" + req.GetUserId(),
	})
	return &iampb.DeleteUserResponse{}, nil
}

func toPb(u *User) *iampb.User {
	return &iampb.User{
		Id: u.ID, Username: u.Username, DisplayName: u.DisplayName,
		Role: u.Role, Status: u.Status, DepartmentId: u.DepartmentID, CreatedAt: u.CreatedAt,
	}
}

// GetUser is called by caps-svc to resolve a user's department/role.
// Internal RPC: no gateway route exposes it.
func (s *Server) GetUser(ctx context.Context, req *iampb.GetUserRequest) (*iampb.GetUserResponse, error) {
	u, _, err := s.store.GetUserByID(ctx, req.GetUserId())
	if err != nil {
		return nil, errCode(err)
	}
	return &iampb.GetUserResponse{User: toPb(u)}, nil
}

// ---- departments ----

func deptPb(d *Department) *iampb.Department {
	return &iampb.Department{Id: d.ID, Name: d.Name, CreatedAt: d.CreatedAt}
}

func (s *Server) CreateDepartment(ctx context.Context, req *iampb.CreateDepartmentRequest) (*iampb.CreateDepartmentResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if req.GetName() == "" {
		return nil, status.Error(codes.InvalidArgument, "name required")
	}
	d, err := s.store.CreateDepartment(ctx, req.GetId(), req.GetName())
	if err != nil {
		return nil, errCode(err)
	}
	actorID, _ := actor(ctx)
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: actorID, Action: "iam.dept_create", Resource: "department/" + d.ID,
	})
	return &iampb.CreateDepartmentResponse{Department: deptPb(d)}, nil
}

func (s *Server) UpdateDepartment(ctx context.Context, req *iampb.UpdateDepartmentRequest) (*iampb.UpdateDepartmentResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	d, err := s.store.UpdateDepartment(ctx, req.GetId(), req.GetName())
	if err != nil {
		return nil, errCode(err)
	}
	actorID, _ := actor(ctx)
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: actorID, Action: "iam.dept_update", Resource: "department/" + d.ID,
	})
	return &iampb.UpdateDepartmentResponse{Department: deptPb(d)}, nil
}

func (s *Server) DeleteDepartment(ctx context.Context, req *iampb.DeleteDepartmentRequest) (*iampb.DeleteDepartmentResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	if err := s.store.DeleteDepartment(ctx, req.GetId()); err != nil {
		return nil, errCode(err)
	}
	actorID, _ := actor(ctx)
	s.audit.Publish(ctx, s.audit.Redis(), auditx.Event{
		Actor: actorID, Action: "iam.dept_delete", Resource: "department/" + req.GetId(),
	})
	return &iampb.DeleteDepartmentResponse{}, nil
}

func (s *Server) ListDepartments(ctx context.Context, _ *iampb.ListDepartmentsRequest) (*iampb.ListDepartmentsResponse, error) {
	if err := s.adminOnly(ctx); err != nil {
		return nil, err
	}
	depts, err := s.store.ListDepartments(ctx)
	if err != nil {
		return nil, errCode(err)
	}
	out := &iampb.ListDepartmentsResponse{}
	for _, d := range depts {
		out.Departments = append(out.Departments, deptPb(d))
	}
	return out, nil
}
