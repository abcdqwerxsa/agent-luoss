package kb

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestChunkMarkdownHeadingBoundaries(t *testing.T) {
	md := "# 手册\n\n" + strings.Repeat("总则内容。", 30) +
		"\n\n## 报销流程\n\n" + strings.Repeat("报销说明。", 60) +
		"\n\n# 第二篇\n\n尾部。"
	chunks := ChunkMarkdown(md)
	if len(chunks) < 3 {
		t.Fatalf("want >=3 chunks, got %d", len(chunks))
	}
	var found bool
	for _, c := range chunks {
		if c.Section == "手册 > 报销流程" {
			found = true
			if !strings.Contains(c.Text, "报销说明") {
				t.Fatalf("section chunk missing body: %q", c.Text[:40])
			}
		}
	}
	if !found {
		t.Fatalf("section trail missing; got %+v", sections(chunks))
	}
	for _, c := range chunks {
		if utf8.RuneCountInString(c.Text) > chunkMaxRunes+2000 {
			t.Fatalf("chunk exceeds max: %d", utf8.RuneCountInString(c.Text))
		}
	}
}

func TestChunkMarkdownTableAtomic(t *testing.T) {
	rows := make([]string, 200)
	for i := range rows {
		rows[i] = "<tr><td>项目" + strings.Repeat("很长的单元格内容", 10) + "</td><td>金额</td></tr>"
	}
	md := "<table>\n<tr><th>名称</th><th>数值</th></tr>\n" + strings.Join(rows, "\n") + "\n</table>"
	chunks := ChunkMarkdown(md)
	if len(chunks) < 2 {
		t.Fatalf("oversized table must split, got %d chunk(s)", len(chunks))
	}
	for _, c := range chunks {
		if !strings.Contains(c.Text, "<table") {
			// every fragment repeats the header table opening
			t.Fatalf("split fragment lost table header: %.60s", c.Text)
		}
	}
	// small table stays whole
	small := "<table>\n<tr><th>a</th></tr>\n<tr><td>b</td></tr>\n</table>"
	if got := ChunkMarkdown(small); len(got) != 1 || !strings.Contains(got[0].Text, "<td>b</td>") {
		t.Fatalf("small table should stay atomic, got %+v", sections(got))
	}
}

func TestSplitQueryTerms(t *testing.T) {
	cases := []struct {
		q    string
		want []string
	}{
		{"报销 流程", []string{"报销", "流程"}},
		{"差旅报销标准", []string{"差旅", "旅报", "报销", "销标", "标准"}},
		{"Q3 budget 2024", []string{"q3", "budget", "2024"}},
		{"怎么申请权限？", []string{"怎么", "么申", "申请", "请权", "权限"}},
	}
	for _, c := range cases {
		got := SplitQueryTerms(c.q)
		if strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Fatalf("SplitQueryTerms(%q) = %v, want %v", c.q, got, c.want)
		}
	}
}

func TestBuiltinParse(t *testing.T) {
	if _, ok := BuiltinParse("a.md", "x"); !ok {
		t.Fatal("md should be builtin")
	}
	if _, ok := BuiltinParse("a.PDF", "x"); ok {
		t.Fatal("pdf must not be builtin")
	}
}

func sections(cs []*Chunk0) []string {
	out := make([]string, len(cs))
	for i, c := range cs {
		out[i] = c.Section
	}
	return out
}
