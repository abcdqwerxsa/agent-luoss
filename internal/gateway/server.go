// Package gateway is the HTTP edge: JWT auth, REST for the frontend,
// proxying to backend gRPC services with actor metadata.
package gateway

import (
	"context"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"agentluoss/internal/auditx"
	"agentluoss/internal/jwtx"
	"agentluoss/internal/metricsx"
	artifactpb "agentluoss/proto/gen/artifact"
	modelmgtpb "agentluoss/proto/gen/modelmgt"
	usagepb "agentluoss/proto/gen/usage"
	capspb "agentluoss/proto/gen/caps"
	iampb "agentluoss/proto/gen/iam"
	taskpb "agentluoss/proto/gen/task"
	runtimpb "agentluoss/proto/gen/runtime"

	"github.com/gin-gonic/gin"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

type App struct {
	jwtSecret string
	iam       iampb.IAMClient
	task      taskpb.TaskClient
	artifact  artifactpb.ArtifactClient
	modelmgt  modelmgtpb.ModelMgtClient
	usage     usagepb.UsageClient
	caps      capspb.CapsClient
	audit     *auditx.Event
	router    *gin.Engine
}

func New(jwtSecret, iamAddr, taskAddr, artifactAddr, modelmgtAddr, usageAddr, capsAddr string) *App {
	iamConn, err := grpc.NewClient(iamAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("dial iam: %v", err)
	}
	var taskConn *grpc.ClientConn
	var artifactConn *grpc.ClientConn
	if artifactAddr != "" {
		artifactConn, err = grpc.NewClient(artifactAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial artifact: %v", err)
		}
	}
	var modelmgtConn *grpc.ClientConn
	if modelmgtAddr != "" {
		modelmgtConn, err = grpc.NewClient(modelmgtAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial modelmgt: %v", err)
		}
	}
	var usageConn *grpc.ClientConn
	if usageAddr != "" {
		usageConn, err = grpc.NewClient(usageAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial usage: %v", err)
		}
	}
	var capsConn *grpc.ClientConn
	if capsAddr != "" {
		capsConn, err = grpc.NewClient(capsAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial caps: %v", err)
		}
	}
	if taskAddr != "" {
		taskConn, err = grpc.NewClient(taskAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			log.Fatalf("dial task: %v", err)
		}
	}
	a := &App{
		jwtSecret: jwtSecret,
		iam:       iampb.NewIAMClient(iamConn),
		task:      taskpb.NewTaskClient(taskConn),
		artifact:  artifactpb.NewArtifactClient(artifactConn),
		modelmgt:  modelmgtpb.NewModelMgtClient(modelmgtConn),
		usage:     usagepb.NewUsageClient(usageConn),
		caps:      capspb.NewCapsClient(capsConn),
		router:    nil,
	}
	a.router = a.build()
	return a
}

func (a *App) Handler() http.Handler { return metricsx.HTTPMiddleware(a.router) }

func (a *App) build() *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.SetTrustedProxies(nil)
	r.Use(gin.Recovery(), a.rateLimit(), securityHeaders())

	api := r.Group("/api/v1")

	// public
	api.POST("/auth/login", a.login)
	api.POST("/auth/refresh", a.refresh)

	// authenticated
	authed := api.Group("", a.authMiddleware())
	authed.POST("/auth/logout", a.logout)
	authed.GET("/me", a.me)

	admin := authed.Group("", a.requireAdmin())
	admin.GET("/users", a.listUsers)
	admin.POST("/users", a.createUser)
	admin.PATCH("/users/:id", a.updateUser)
	admin.DELETE("/users/:id", a.deleteUser)

	if a.task != nil {
		a.registerTaskRoutes(authed)
	}
	if a.artifact != nil {
		a.registerArtifactRoutes(authed)
	}
	if a.modelmgt != nil {
		a.registerModelRoutes(authed, admin)
	}
	if a.usage != nil {
		a.registerUsageRoutes(authed, admin)
	}
	if a.caps != nil {
		a.registerCapsRoutes(admin)
		a.registerExpertAdminRoutes(admin)
		a.registerExpertUserRoutes(authed)
	}

	r.GET("/healthz", func(c *gin.Context) { c.String(200, "ok") })

	// static frontend (web/dist) with SPA fallback
	staticDir := envOr("WEB_DIR", "")
	if staticDir != "" {
		r.Use(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/api") {
				c.Next()
				return
			}
			p := filepath.Join(staticDir, filepath.Clean("/"+c.Request.URL.Path))
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				c.File(p)
				c.Abort()
				return
			}
			c.File(filepath.Join(staticDir, "index.html"))
			c.Abort()
		})
	}
	return r
}

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// ---- middleware ----

func (a *App) authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		token := strings.TrimPrefix(h, "Bearer ")
		// EventSource cannot send headers; SSE endpoint accepts query token.
		// Downloads (<a href>) cannot either: /export paths accept it too.
		if token == "" && (strings.HasSuffix(c.Request.URL.Path, "/events") || strings.HasSuffix(c.Request.URL.Path, "/export")) {
			token = c.Query("access_token")
		}
		if token == "" {
			c.AbortWithStatusJSON(401, gin.H{"error": "missing bearer token"})
			return
		}
		claims, err := jwtx.Verify(a.jwtSecret, token)
		if err != nil {
			c.AbortWithStatusJSON(401, gin.H{"error": "invalid token"})
			return
		}
		c.Set("user_id", claims.UserID)
		c.Set("role", claims.Role)
		c.Next()
	}
}

func (a *App) requireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetString("role") != "admin" {
			c.AbortWithStatusJSON(403, gin.H{"error": "admin only"})
			return
		}
		c.Next()
	}
}

// outCtx attaches actor metadata for backend gRPC calls.
func outCtx(c *gin.Context) context.Context {
	return metadata.AppendToOutgoingContext(c.Request.Context(),
		"x-user-id", c.GetString("user_id"),
		"x-user-role", c.GetString("role"),
		"x-user-ip", c.ClientIP(),
	)
}

func grpcStatus(c *gin.Context, err error) {
	c.JSON(502, gin.H{"error": err.Error()})
}

// ---- handlers ----

type loginReq struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (a *App) login(c *gin.Context) {
	var req loginReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "username and password required"})
		return
	}
	ctx := metadata.AppendToOutgoingContext(c.Request.Context(), "x-user-ip", c.ClientIP())
	resp, err := a.iam.Login(ctx, &iampb.LoginRequest{Username: req.Username, Password: req.Password})
	if err != nil {
		if status.Code(err) == codes.Unauthenticated {
			c.JSON(401, gin.H{"error": "bad credentials"})
			return
		}
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{
		"access_token":  resp.AccessToken,
		"refresh_token": resp.RefreshToken,
		"expires_in":    resp.ExpiresIn,
		"user":          pbUserJSON(resp.User),
	})
}

func (a *App) refresh(c *gin.Context) {
	var req struct {
		RefreshToken string `json:"refresh_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "refresh_token required"})
		return
	}
	resp, err := a.iam.Refresh(c.Request.Context(), &iampb.RefreshRequest{RefreshToken: req.RefreshToken})
	if err != nil {
		c.JSON(401, gin.H{"error": "invalid refresh token"})
		return
	}
	c.JSON(200, gin.H{
		"access_token":  resp.AccessToken,
		"refresh_token": resp.RefreshToken,
		"expires_in":    resp.ExpiresIn,
	})
}

func (a *App) logout(c *gin.Context) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = c.ShouldBindJSON(&req)
	if req.RefreshToken != "" {
		_, _ = a.iam.Logout(outCtx(c), &iampb.LogoutRequest{RefreshToken: req.RefreshToken})
	}
	c.JSON(200, gin.H{"ok": true})
}

func (a *App) me(c *gin.Context) {
	// user info comes from the token; admin listing fetches full records.
	c.JSON(200, gin.H{"user_id": c.GetString("user_id"), "role": c.GetString("role")})
}

func (a *App) listUsers(c *gin.Context) {
	resp, err := a.iam.ListUsers(outCtx(c), &iampb.ListUsersRequest{})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	out := make([]gin.H, 0, len(resp.Users))
	for _, u := range resp.Users {
		out = append(out, pbUserJSON(u))
	}
	c.JSON(200, gin.H{"users": out})
}

func (a *App) createUser(c *gin.Context) {
	var req struct {
		Username     string `json:"username" binding:"required"`
		Password     string `json:"password" binding:"required,min=8"`
		DisplayName  string `json:"display_name"`
		Role         string `json:"role"`
		DepartmentID string `json:"department_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resp, err := a.iam.CreateUser(outCtx(c), &iampb.CreateUserRequest{
		Username: req.Username, Password: req.Password,
		DisplayName: req.DisplayName, Role: req.Role, DepartmentId: req.DepartmentID,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"user": pbUserJSON(resp.User)})
}

func (a *App) updateUser(c *gin.Context) {
	var req struct {
		DisplayName  string `json:"display_name"`
		Role         string `json:"role"`
		Status       string `json:"status"`
		Password     string `json:"password"`
		DepartmentID string `json:"department_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resp, err := a.iam.UpdateUser(outCtx(c), &iampb.UpdateUserRequest{
		UserId: c.Param("id"), DisplayName: req.DisplayName, Role: req.Role,
		Status: req.Status, Password: req.Password, DepartmentId: req.DepartmentID,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"user": pbUserJSON(resp.User)})
}

func (a *App) deleteUser(c *gin.Context) {
	_, err := a.iam.DeleteUser(outCtx(c), &iampb.DeleteUserRequest{UserId: c.Param("id")})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

func pbUserJSON(u *iampb.User) gin.H {
	return gin.H{
		"id": u.GetId(), "username": u.GetUsername(), "display_name": u.GetDisplayName(),
		"role": u.GetRole(), "status": u.GetStatus(), "department_id": u.GetDepartmentId(),
		"created_at": u.GetCreatedAt(),
	}
}

// type aliases so tasks.go reads like the proto types
type (
	taskModel    = runtimpb.ModelRef
	imageContent = runtimpb.ImageContent
)

func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "DENY")
		c.Header("Referrer-Policy", "no-referrer")
		c.Next()
	}
}
