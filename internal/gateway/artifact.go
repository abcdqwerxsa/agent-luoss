// Artifact REST endpoints: workspace file tree, upload, download.
package gateway

import (
	"fmt"
	"io"
	"path"

	"github.com/gin-gonic/gin"
	"google.golang.org/grpc/status"

	artifactpb "agentluoss/proto/gen/artifact"
)

func (a *App) registerArtifactRoutes(authed *gin.RouterGroup) {
	authed.GET("/files", a.listFiles)
	authed.GET("/files/download", a.downloadFile)
	authed.POST("/files/upload", a.uploadFile)
	authed.DELETE("/files", a.deleteFile)
}

func (a *App) listFiles(c *gin.Context) {
	resp, err := a.artifact.ListDir(outCtx(c), &artifactpb.ListDirRequest{
		UserId: c.GetString("user_id"), Path: c.Query("path"),
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	nodes := make([]gin.H, 0, len(resp.Nodes))
	for _, n := range resp.Nodes {
		nodes = append(nodes, gin.H{
			"name": n.Name, "is_dir": n.IsDir, "size": n.Size, "modified_at": n.ModifiedAt,
		})
	}
	c.JSON(200, gin.H{"path": resp.Path, "nodes": nodes})
}

func (a *App) downloadFile(c *gin.Context) {
	rel := c.Query("path")
	if rel == "" {
		c.JSON(400, gin.H{"error": "path required"})
		return
	}
	stream, err := a.artifact.Download(outCtx(c), &artifactpb.DownloadRequest{
		UserId: c.GetString("user_id"), Path: rel,
	})
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.Writer.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, path.Base(rel)))
	first := true
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			return
		}
		if err != nil {
			if first {
				grpcStatus(c, err)
			}
			return
		}
		if first {
			c.Writer.Header().Set("Content-Type", "application/octet-stream")
			first = false
		}
		if _, err := c.Writer.Write(chunk.Data); err != nil {
			return
		}
	}
}

func (a *App) uploadFile(c *gin.Context) {
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(400, gin.H{"error": "file field required"})
		return
	}
	src, err := fh.Open()
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	defer src.Close()

	target := c.PostForm("path")
	if target == "" {
		target = "uploads/" + fh.Filename
	}

	stream, err := a.artifact.Upload(outCtx(c))
	if err != nil {
		grpcStatus(c, err)
		return
	}
	if err := stream.Send(&artifactpb.UploadChunk{Part: &artifactpb.UploadChunk_Meta{
		Meta: &artifactpb.UploadMeta{UserId: c.GetString("user_id"), Path: target},
	}}); err != nil {
		grpcStatus(c, err)
		return
	}
	buf := make([]byte, 64*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if serr := stream.Send(&artifactpb.UploadChunk{Part: &artifactpb.UploadChunk_Data{Data: buf[:n]}}); serr != nil {
				grpcStatus(c, serr)
				return
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			grpcStatus(c, err)
			return
		}
	}
	resp, err := stream.CloseAndRecv()
	if err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"path": target, "size": resp.Size})
}

func (a *App) deleteFile(c *gin.Context) {
	rel := c.Query("path")
	if rel == "" {
		c.JSON(400, gin.H{"error": "path required"})
		return
	}
	if _, err := a.artifact.Delete(outCtx(c), &artifactpb.DeleteRequest{
		UserId: c.GetString("user_id"), Path: rel,
	}); err != nil {
		grpcStatus(c, err)
		return
	}
	c.JSON(200, gin.H{"ok": true})
}

var _ = status.Code
