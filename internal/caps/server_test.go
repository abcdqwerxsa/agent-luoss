package caps

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func zipBytes(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestExtractZipRejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"../../escape.txt", "/abs.txt"} {
		if err := extractZip(zipBytes(t, map[string]string{name: "x"}), filepath.Join(dir, "sk")); err == nil {
			t.Errorf("expected rejection for %q", name)
		}
	}
	// nested traversal via path segments
	if err := extractZip(zipBytes(t, map[string]string{"a/../../escape.txt": "x"}), filepath.Join(dir, "sk2")); err == nil {
		t.Error("expected rejection for nested traversal")
	}
}

func TestExtractZipAndFindSkillMd(t *testing.T) {
	dir := t.TempDir()
	skillZip := zipBytes(t, map[string]string{
		"my-skill/SKILL.md":      "---\nname: My Skill\ndescription: does things\n---\n# Body\n",
		"my-skill/scripts/run.sh": "echo hi\n",
	})
	dest := filepath.Join(dir, "s1")
	if err := extractZip(skillZip, dest); err != nil {
		t.Fatal(err)
	}
	skillDir, name, desc, err := findSkillMd(dest)
	if err != nil {
		t.Fatal(err)
	}
	if name != "My Skill" || desc != "does things" {
		t.Fatalf("got name=%q desc=%q", name, desc)
	}
	if !fileExists(filepath.Join(skillDir, "scripts", "run.sh")) {
		t.Error("extra file not extracted")
	}
}

func TestFindSkillMdRootLevel(t *testing.T) {
	dir := t.TempDir()
	rootZip := zipBytes(t, map[string]string{"SKILL.md": "---\nname: root-skill\n---\nbody\n"})
	dest := filepath.Join(dir, "s2")
	if err := extractZip(rootZip, dest); err != nil {
		t.Fatal(err)
	}
	_, name, _, err := findSkillMd(dest)
	if err != nil || name != "root-skill" {
		t.Fatalf("got name=%q err=%v", name, err)
	}
}

func TestFindSkillMdAmbiguous(t *testing.T) {
	dir := t.TempDir()
	badZip := zipBytes(t, map[string]string{
		"a/SKILL.md": "---\nname: a\n---\nx",
		"b/SKILL.md": "---\nname: b\n---\nx",
	})
	dest := filepath.Join(dir, "s3")
	if err := extractZip(badZip, dest); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := findSkillMd(dest); err == nil {
		t.Fatal("expected ambiguity error")
	}
}

func TestRemoveSkillDirGuard(t *testing.T) {
	base := t.TempDir()
	if err := removeSkillDir(base, base); err == nil {
		t.Fatal("refuses to remove base itself")
	}
	if err := removeSkillDir(base, filepath.Dir(base)); err == nil {
		t.Fatal("refuses parent")
	}
	sub := filepath.Join(base, "sk")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := removeSkillDir(base, sub); err != nil {
		t.Fatalf("should remove sub: %v", err)
	}
	if _, err := os.Stat(sub); !os.IsNotExist(err) {
		t.Fatal("sub not removed")
	}
}
