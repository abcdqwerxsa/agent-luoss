package kb

import "testing"

func ct(id int64, doc string) *ChunkText { return &ChunkText{ID: id, DocID: doc} }

func TestFuseRRF(t *testing.T) {
	lex := []*ChunkText{ct(1, "a"), ct(2, "a"), ct(3, "b")}
	vec := []*ChunkText{ct(3, "b"), ct(4, "b"), ct(2, "a")}

	// balanced weights: chunk 3 (rank1 vec + rank3 lex) vs 2 (rank2 both) vs 1 (rank1 lex)
	got := FuseRRF(lex, vec, 0.5)
	if len(got) != 4 {
		t.Fatalf("union size: %d", len(got))
	}
	// 3: .5/61 + .5/61 = 0.01639; 2: .5/62+.5/62=0.01613; 4: .5/62; 1: .5/61
	if got[0].ID != 3 || got[1].ID != 2 {
		t.Fatalf("order: got %d,%d want 3,2", got[0].ID, got[1].ID)
	}
	// vector off -> lexical passthrough
	if r := FuseRRF(lex, vec, 0); len(r) != 3 || r[0].ID != 1 {
		t.Fatalf("wVec=0 must pass lexical through, got %d", r[0].ID)
	}
	// vector full -> vector passthrough
	if r := FuseRRF(lex, vec, 1); len(r) != 3 || r[0].ID != 3 {
		t.Fatalf("wVec=1 must pass vector through, got %d", r[0].ID)
	}
	// empty vector list
	if r := FuseRRF(lex, nil, 0.5); len(r) != 3 {
		t.Fatalf("empty vec list -> lexical, got %d", len(r))
	}
}

func TestVecToLiteral(t *testing.T) {
	if s := VecToLiteral([]float32{0.5, -1.25}); s != "[0.5,-1.25]" {
		t.Fatalf("literal: %s", s)
	}
}
