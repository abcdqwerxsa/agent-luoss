// Package gateway is the HTTP edge: JWT auth, REST for the frontend,
// proxying to backend gRPC services with actor metadata.
package gateway

import (
	"context"
	"log"
	"net/http"
	"strings"

	"agentluoss/internal/auditx"
	"agentluoss/internal/jwtx"
	iampb "agentluoss/proto/gen/iam"

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
	audit     *auditx.Event
	router    *gin.Engine
}

func New(jwtSecret, iamAddr string) *App {
	conn, err := grpc.NewClient(iamAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatalf("dial iam: %v", err)
	}
	a := &App{
		jwtSecret: jwtSecret,
		iam:       iampb.NewIAMClient(conn),
	}
	a.router = a.build()
	return a
}

func (a *App) Handler() http.Handler { return a.router }

func (a *App) build() *gin.Engine {
	r := gin.New()
	r.Use(gin.Recovery())

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

	r.GET("/healthz", func(c *gin.Context) { c.String(200, "ok") })
	return r
}

// ---- middleware ----

func (a *App) authMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.GetHeader("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			c.AbortWithStatusJSON(401, gin.H{"error": "missing bearer token"})
			return
		}
		claims, err := jwtx.Verify(a.jwtSecret, strings.TrimPrefix(h, "Bearer "))
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
		Username    string `json:"username" binding:"required"`
		Password    string `json:"password" binding:"required,min=8"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resp, err := a.iam.CreateUser(outCtx(c), &iampb.CreateUserRequest{
		Username: req.Username, Password: req.Password,
		DisplayName: req.DisplayName, Role: req.Role,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"user": pbUserJSON(resp.User)})
}

func (a *App) updateUser(c *gin.Context) {
	var req struct {
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
		Status      string `json:"status"`
		Password    string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	resp, err := a.iam.UpdateUser(outCtx(c), &iampb.UpdateUserRequest{
		UserId: c.Param("id"), DisplayName: req.DisplayName, Role: req.Role,
		Status: req.Status, Password: req.Password,
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
		"role": u.GetRole(), "status": u.GetStatus(), "created_at": u.GetCreatedAt(),
	}
}
