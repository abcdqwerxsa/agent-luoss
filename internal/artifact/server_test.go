package artifact

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveBlocksTraversal(t *testing.T) {
	root := t.TempDir()
	s := NewServer(root)
	os.MkdirAll(filepath.Join(root, "u1"), 0o755)

	ok, err := s.resolve("u1", "docs/a.txt")
	if err != nil || ok != filepath.Join(root, "u1", "docs/a.txt") {
		t.Fatalf("valid path rejected: %v %v", ok, err)
	}
	for _, bad := range []string{"../u2/secret", "a/../../u2/x", "/etc/passwd", "docs/../../u1/../u2"} {
		if _, err := s.resolve("u1", bad); err == nil {
			t.Errorf("traversal accepted: %q", bad)
		}
	}
	if _, err := s.resolve("u1/../u2", "x"); err == nil {
		t.Error("bad user id accepted")
	}
	// symlink escape
	os.Symlink("/etc", filepath.Join(root, "u1", "evil"))
	if _, err := s.resolve("u1", "evil/passwd"); err == nil {
		t.Error("symlink escape accepted")
	}
}
