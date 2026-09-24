package kb

import (
	"strings"
	"unicode/utf8"
)

// Chunking targets. ponytail: rune-count proxy for tokens (CJK ≈ 1 token per
// rune, latin ~0.3); tune via evals if recall suffers.
const (
	chunkTargetRunes = 700
	chunkMaxRunes    = 1500
)

// ChunkMarkdown splits markdown into retrieval chunks:
//   - heading boundaries reset accumulation; section = heading trail
//     ("手册 > 报销流程")
//   - HTML <table> blocks are atomic (tables are the Chinese-enterprise
//     retrieval gold); oversized tables split on </tr> with the header row
//     repeated
func ChunkMarkdown(md string) []*Chunk0 {
	var out []*Chunk0
	var headings []string // trail
	var buf strings.Builder
	var bufSection string

	flush := func() {
		if s := strings.TrimSpace(buf.String()); s != "" {
			out = append(out, &Chunk0{Section: bufSection, Text: s})
		}
		buf.Reset()
	}

	lines := strings.Split(md, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]

		// atomic HTML table: consume until </table>
		if strings.HasPrefix(strings.TrimSpace(strings.ToLower(line)), "<table") {
			flush()
			var tbl []string
			for ; i < len(lines); i++ {
				tbl = append(tbl, lines[i])
				if strings.Contains(strings.ToLower(lines[i]), "</table>") {
					break
				}
			}
			out = append(out, splitTable(tbl, trail(headings))...)
			continue
		}

		if hd := headingDepth(line); hd > 0 {
			flush()
			title := strings.TrimSpace(strings.TrimLeft(line, "#"))
			headings = headings[:min(hd-1, len(headings))]
			headings = append(headings, title)
			bufSection = trail(headings)
			buf.WriteString(line + "\n") // keep the heading in the chunk
			continue
		}

		buf.WriteString(line + "\n")
		if utf8.RuneCountInString(buf.String()) >= chunkTargetRunes {
			// prefer paragraph boundary: backtrack last blank line within window
			flushAtBoundary(&buf)
		}
	}
	flush()
	return out
}

// Chunk0 is a chunker output before doc/kb ids are attached.
type Chunk0 struct {
	Section string
	Text    string
}

func flushAtBoundary(buf *strings.Builder) {
	s := buf.String()
	if i := strings.LastIndex(s, "\n\n"); i > utf8.RuneCountInString(s)/2 {
		buf.Reset()
		buf.WriteString(s[i+1:])
		return
	}
	buf.Reset()
}

func splitTable(lines []string, section string) []*Chunk0 {
	if utf8.RuneCountInString(strings.Join(lines, "")) <= chunkMaxRunes {
		return []*Chunk0{{Section: section, Text: strings.TrimSpace(strings.Join(lines, "\n"))}}
	}
	// header = first row; split rows, repeat header in each part
	var header string
	for i, l := range lines {
		if strings.Contains(strings.ToLower(l), "</tr>") {
			header = strings.Join(lines[:i+1], "\n")
			lines = lines[i+1:]
			break
		}
	}
	var out []*Chunk0
	var part strings.Builder
	part.WriteString(header + "\n")
	for _, l := range lines {
		part.WriteString(l + "\n")
		if strings.Contains(strings.ToLower(l), "</tr>") && utf8.RuneCountInString(part.String()) >= chunkTargetRunes {
			out = append(out, &Chunk0{Section: section, Text: strings.TrimSpace(part.String())})
			part.Reset()
			part.WriteString(header + "\n")
		}
	}
	if strings.TrimSpace(strings.TrimPrefix(part.String(), header)) != "" {
		out = append(out, &Chunk0{Section: section, Text: strings.TrimSpace(part.String())})
	}
	return out
}

func headingDepth(line string) int {
	t := strings.TrimLeft(line, " ")
	if !strings.HasPrefix(t, "#") {
		return 0
	}
	d := 0
	for d < len(t) && t[d] == '#' {
		d++
	}
	if d <= 6 && len(t) > d && t[d] == ' ' {
		return d
	}
	return 0
}

func trail(headings []string) string { return strings.Join(headings, " > ") }

// BuiltinParse handles plain-text formats without external services.
// Returns ("", false) when the extension needs an external parser.
func BuiltinParse(filename, content string) (string, bool) {
	lower := strings.ToLower(filename)
	switch {
	case strings.HasSuffix(lower, ".md"), strings.HasSuffix(lower, ".markdown"),
		strings.HasSuffix(lower, ".txt"), strings.HasSuffix(lower, ".csv"):
		return content, true
	}
	return "", false
}

// TitleFromFilename strips the extension for display.
func TitleFromFilename(filename string) string {
	if i := strings.LastIndex(filename, "."); i > 0 {
		return filename[:i]
	}
	return filename
}

// SplitQueryTerms splits a search query into recall terms. Latin words are
// lowercased whole terms; CJK runs ≤4 runes stay whole, longer runs emit
// sliding bigrams only (a 5+ rune phrase rarely appears verbatim, but its
// bigrams do; ranking favors chunks matching more/longer terms anyway).
func SplitQueryTerms(q string) []string {
	var terms []string
	seen := map[string]bool{}
	add := func(t string) {
		if t != "" && !seen[t] {
			seen[t] = true
			terms = append(terms, t)
		}
	}
	var word, cjk []rune
	flushWord := func() {
		if len(word) > 0 {
			add(strings.ToLower(string(word)))
			word = word[:0]
		}
	}
	flushCJK := func() {
		r := cjk
		cjk = cjk[:0]
		if len(r) == 0 {
			return
		}
		if len(r) <= 4 {
			add(string(r))
			return
		}
		for i := 0; i+2 <= len(r); i++ {
			add(string(r[i : i+2]))
		}
	}
	for _, r := range q {
		switch {
		case isCJK(r):
			flushWord()
			cjk = append(cjk, r)
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-':
			flushCJK()
			word = append(word, r)
		default:
			flushWord()
			flushCJK()
		}
	}
	flushWord()
	flushCJK()
	return terms
}

func isCJK(r rune) bool {
	return (r >= 0x4e00 && r <= 0x9fff) || (r >= 0x3400 && r <= 0x4dbf) ||
		(r >= 0xf900 && r <= 0xfaff) || (r >= 0x3000 && r <= 0x303f)
}
