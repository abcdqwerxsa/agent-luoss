package kb

import "strings"

// RankScores orders recall candidates. Pure function (testable): score =
// weighted sum over terms present in the chunk; longer terms weigh more
// (exponentially — a 4-rune term match says far more than four bigrams);
// density and early position give small boosts. Section matches nudge.
func RankScores(cands []*ChunkText, terms []string) []Scored {
	// de-overlap bigrams from the same long run would double-count; acceptable
	// noise for lexical ranking (ponytail: evals will tell if it matters).
	out := make([]Scored, 0, len(cands))
	for _, c := range cands {
		lower := strings.ToLower(c.Text)
		secLower := strings.ToLower(c.Section)
		var score float64
		runes := len([]rune(lower))
		if runes == 0 {
			runes = 1
		}
		for _, t := range terms {
			n := strings.Count(lower, t)
			if n == 0 {
				if strings.Contains(secLower, strings.ToLower(t)) {
					score += 0.5 // section (heading) hit without body hit
				}
				continue
			}
			w := 1.0
			for i := 1; i < len([]rune(t)); i++ {
				w *= 2 // exponential in term length
			}
			pos := strings.Index(lower, t)
			posBoost := 1.0
			if pos >= 0 && pos < runes/4 {
				posBoost = 1.15
			}
			density := float64(n*len([]rune(t))) / float64(runes)
			score += w * float64(n) * posBoost * (1.0 + min(density, 0.3))
		}
		if score > 0 {
			out = append(out, Scored{Chunk: c, Score: score})
		}
	}
	// insertion sort by score desc (candidate sets are small: ≤200)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Score > out[j-1].Score; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

type Scored struct {
	Chunk *ChunkText
	Score float64
}

// FuseRRV merges lexical and vector candidate lists with weighted
// reciprocal-rank fusion: score(chunk) = Σ w/(k+rank) over the lists it
// appears in. k=60 (standard). Pure function (testable).
func FuseRRF(lex, vec []*ChunkText, wVec float64) []*ChunkText {
	if wVec <= 0 || len(vec) == 0 {
		return chunkPtrs(lex)
	}
	if wVec >= 1 || len(lex) == 0 {
		return chunkPtrs(vec)
	}
	const k = 60.0
	wLex := 1 - wVec
	type pair struct {
		c *ChunkText
		s float64
	}
	m := map[int64]*pair{}
	add := func(list []*ChunkText, w float64) {
		for i, c := range list {
			e, ok := m[c.ID]
			if !ok {
				e = &pair{c: c}
				m[c.ID] = e
			}
			e.s += w / (k + float64(i+1))
		}
	}
	add(lex, wLex)
	add(vec, wVec)
	ps := make([]pair, 0, len(m))
	for _, e := range m {
		ps = append(ps, *e)
	}
	for i := 1; i < len(ps); i++ {
		for j := i; j > 0 && ps[j].s > ps[j-1].s; j-- {
			ps[j], ps[j-1] = ps[j-1], ps[j]
		}
	}
	res := make([]*ChunkText, len(ps))
	for i, p := range ps {
		res[i] = p.c
	}
	return res
}

func chunkPtrs(cs []*ChunkText) []*ChunkText { return cs }
