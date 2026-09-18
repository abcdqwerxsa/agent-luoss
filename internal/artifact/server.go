// Package artifact implements workspace file management with strict
// path-traversal protection. Each user is rooted at <root>/<userID>.
package artifact

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	artifactpb "agentluoss/proto/gen/artifact"
)

type Server struct {
	artifactpb.UnimplementedArtifactServer
	root string
}

func NewServer(root string) *Server {
	return &Server{root: root}
}

func (s *Server) Register(g *grpc.Server) { artifactpb.RegisterArtifactServer(g, s) }

// resolve maps (userID, relPath) to an absolute path inside the user root.
// It rejects traversal, symlinks that escape, and absolute paths.
func (s *Server) resolve(userID, relPath string) (string, error) {
	if userID == "" || strings.Contains(userID, "/") || strings.Contains(userID, "..") {
		return "", status.Error(codes.InvalidArgument, "bad user id")
	}
	if filepath.IsAbs(relPath) {
		return "", status.Error(codes.InvalidArgument, "absolute paths not allowed")
	}
	relPath = strings.TrimPrefix(relPath, "/")
	if relPath == "" || relPath == "." {
		return filepath.Join(s.root, userID), nil
	}
	// explicit rejection beats silent reinterpretation
	if strings.Contains(relPath, "..") {
		return "", status.Error(codes.InvalidArgument, "path traversal rejected")
	}
	clean := filepath.Clean(relPath)
	userRoot := filepath.Join(s.root, userID)
	full := filepath.Join(userRoot, clean)
	// defense in depth: eval symlinks when the file exists
	if resolved, err := filepath.EvalSymlinks(full); err == nil {
		full = resolved
	}
	if !strings.HasPrefix(full+string(filepath.Separator), userRoot+string(filepath.Separator)) && full != userRoot {
		return "", status.Error(codes.InvalidArgument, "path escapes workspace")
	}
	return full, nil
}

func (s *Server) ListDir(ctx context.Context, req *artifactpb.ListDirRequest) (*artifactpb.ListDirResponse, error) {
	full, err := s.resolve(req.GetUserId(), req.GetPath())
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(full)
	if err != nil {
		if os.IsNotExist(err) {
			return &artifactpb.ListDirResponse{Path: req.GetPath()}, nil
		}
		return nil, status.Error(codes.NotFound, "cannot list directory")
	}
	resp := &artifactpb.ListDirResponse{Path: req.GetPath()}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		resp.Nodes = append(resp.Nodes, &artifactpb.FileNode{
			Name: e.Name(), IsDir: e.IsDir(), Size: info.Size(),
			ModifiedAt: info.ModTime().UnixMilli(),
		})
	}
	return resp, nil
}

func (s *Server) Download(req *artifactpb.DownloadRequest, stream artifactpb.Artifact_DownloadServer) error {
	full, err := s.resolve(req.GetUserId(), req.GetPath())
	if err != nil {
		return err
	}
	f, err := os.Open(full)
	if err != nil {
		return status.Error(codes.NotFound, "file not found")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return status.Error(codes.InvalidArgument, "not a file")
	}
	buf := make([]byte, 64*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if err := stream.Send(&artifactpb.FileChunk{Data: buf[:n]}); err != nil {
				return err
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return status.Error(codes.Internal, "read failed")
		}
	}
}

func (s *Server) Upload(stream artifactpb.Artifact_UploadServer) error {
	var (
		f        *os.File
		fullPath string
		total    int64
	)
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		switch p := chunk.GetPart().(type) {
		case *artifactpb.UploadChunk_Meta:
			if f != nil {
				f.Close()
			}
			fullPath, err = s.resolve(p.Meta.GetUserId(), p.Meta.GetPath())
			if err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
				return status.Error(codes.Internal, "mkdir failed")
			}
			tmp := fullPath + ".upload-" + randHex(6)
			f, err = os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return status.Error(codes.Internal, "open failed")
			}
			defer func() {
				if f != nil {
					f.Close()
					os.Remove(tmp)
				}
			}()
		case *artifactpb.UploadChunk_Data:
			if f == nil {
				return status.Error(codes.InvalidArgument, "meta chunk must come first")
			}
			if _, err := f.Write(p.Data); err != nil {
				return status.Error(codes.Internal, "write failed")
			}
			total += int64(len(p.Data))
		}
	}
	if f == nil {
		return status.Error(codes.InvalidArgument, "empty upload")
	}
	tmpName := f.Name()
	if err := f.Close(); err != nil {
		return status.Error(codes.Internal, "close failed")
	}
	f = nil
	if err := os.Rename(tmpName, fullPath); err != nil {
		os.Remove(tmpName)
		return status.Error(codes.Internal, "rename failed")
	}
	return stream.SendAndClose(&artifactpb.UploadResponse{Path: fullPath, Size: total})
}

func (s *Server) Delete(ctx context.Context, req *artifactpb.DeleteRequest) (*artifactpb.DeleteResponse, error) {
	full, err := s.resolve(req.GetUserId(), req.GetPath())
	if err != nil {
		return nil, err
	}
	if full == filepath.Join(s.root, req.GetUserId()) {
		return nil, status.Error(codes.InvalidArgument, "refusing to delete workspace root")
	}
	if err := os.RemoveAll(full); err != nil {
		return nil, status.Error(codes.Internal, "delete failed")
	}
	return &artifactpb.DeleteResponse{}, nil
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

var (
	_ = errors.New
	_ = fmt.Sprintf
	_ = time.Now
)
