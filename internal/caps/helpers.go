package caps

import (
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ---- small fs + frontmatter helpers (kept dependency-free) ----

func hash64(b []byte) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(b)
	return h.Sum64()
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func readDirNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func writeFileSyncMkdir(target string, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, r)
	return err
}

// removeSkillDir deletes dir if (and only if) it lives under base.
func removeSkillDir(base, dir string) error {
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return err
	}
	dirAbs, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if dirAbs == baseAbs || !strings.HasPrefix(dirAbs, baseAbs+string(filepath.Separator)) {
		return fmt.Errorf("refusing to remove outside skills dir")
	}
	return os.RemoveAll(dirAbs)
}

// parseFrontmatter reads SKILL.md frontmatter for name/description.
// Frontmatter is the leading `---` block with `key: value` lines.
func parseFrontmatter(dir, mdPath string) (skillDir, name, description string, err error) {
	b, err := os.ReadFile(mdPath)
	if err != nil {
		return "", "", "", err
	}
	name, description = filepath.Base(dir), ""
	lines := strings.Split(string(b), "\n")
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "---" {
		for _, ln := range lines[1:] {
			if strings.TrimSpace(ln) == "---" {
				break
			}
			if v, ok := kv(ln, "name"); ok {
				name = v
			}
			if v, ok := kv(ln, "description"); ok {
				description = v
			}
		}
	}
	if strings.TrimSpace(name) == "" {
		return "", "", "", fmt.Errorf("SKILL.md frontmatter has empty name")
	}
	return dir, name, description, nil
}

func kv(ln, key string) (string, bool) {
	if !strings.HasPrefix(ln, key+":") {
		return "", false
	}
	v := strings.TrimSpace(strings.TrimPrefix(ln, key+":"))
	return strings.Trim(v, `"'`), true
}
