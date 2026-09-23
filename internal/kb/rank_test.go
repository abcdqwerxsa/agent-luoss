package kb

import "testing"

func c(text, section string, id int64) *ChunkText {
	return &ChunkText{ID: id, DocID: "d", Section: section, Text: text}
}

func TestRankScoresLongTermBeatsBigrams(t *testing.T) {
	cands := []*ChunkText{
		c("报销需要发票。", "财务", 1),                 // one 2-rune term
		c("差旅报销标准如下：…", "财务 > 差旅", 2),     // contains longer phrase pieces
		c("无关内容。", "其他", 3),                     // no match -> dropped
	}
	terms := []string{"报销", "差旅", "标准"}
	got := RankScores(cands, terms)
	if len(got) != 2 {
		t.Fatalf("want 2 scored (no-match dropped), got %d", len(got))
	}
	if got[0].Chunk.ID != 2 {
		t.Fatalf("chunk with more/longer term coverage should rank first, got %d", got[0].Chunk.ID)
	}
	if got[0].Score <= got[1].Score {
		t.Fatalf("scores not descending: %v %v", got[0].Score, got[1].Score)
	}
}

func TestRankScoresSectionOnlyHit(t *testing.T) {
	got := RankScores([]*ChunkText{c("正文没有关键词。", "报销管理办法", 1)}, []string{"报销"})
	if len(got) != 1 || got[0].Score <= 0 {
		t.Fatalf("heading hit alone should score >0, got %+v", got)
	}
}

func TestRankScoresEmpty(t *testing.T) {
	if got := RankScores(nil, []string{"x"}); len(got) != 0 {
		t.Fatalf("nil candidates should stay nil, got %d", len(got))
	}
}
