package caps

import (
	"testing"
)

func TestEffectiveScope(t *testing.T) {
	cases := []struct {
		name string
		sc   []Scope
		dept string
		role string
		want bool
	}{
		{"empty scopes = everyone", nil, "", "", true},
		{"empty scopes = everyone (disabled user dept)", nil, "d1", "member", true},
		{"all matches", []Scope{{"all", ""}}, "", "", true},
		{"dept match", []Scope{{"department", "d1"}}, "d1", "member", true},
		{"dept mismatch", []Scope{{"department", "d1"}}, "d2", "member", false},
		{"dept but no dept", []Scope{{"department", "d1"}}, "", "member", false},
		{"role match", []Scope{{"role", "admin"}}, "", "admin", true},
		{"role mismatch", []Scope{{"role", "admin"}}, "", "member", false},
		{"dept OR role", []Scope{{"role", "admin"}, {"department", "d1"}}, "d1", "member", true},
		{"dept OR role miss", []Scope{{"role", "admin"}, {"department", "d1"}}, "d2", "member", false},
		{"no dept user excluded from dept-only", []Scope{{"department", "d1"}}, "", "admin", false},
	}
	for _, c := range cases {
		if got := EffectiveScope(c.sc, c.dept, c.role); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestNormalizeScopes(t *testing.T) {
	got := NormalizeScopes([]Scope{
		{" department ", " d1 "},
		{"department", ""},  // dropped: matches nothing
		{"bogus", "x"},      // dropped: unknown type
		{"all", "ignored"},  // value cleared
		{"all", ""},
		{"department", "d1"}, // dedup
	})
	want := []Scope{{"all", ""}, {"department", "d1"}}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
}

func TestNormalizeScopesEmpty(t *testing.T) {
	if got := NormalizeScopes(nil); len(got) != 0 {
		t.Fatalf("nil stays nil, got %v", got)
	}
	if got := NormalizeScopes([]Scope{{"bogus", "x"}}); len(got) != 0 {
		t.Fatalf("all-invalid becomes empty (=everyone), got %v", got)
	}
}
