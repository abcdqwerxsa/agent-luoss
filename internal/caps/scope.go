// Package caps implements the Caps gRPC service: admin-managed MCP servers
// and skills with department/role assignment, resolved per user on demand.
package caps

import (
	"sort"
	"strings"
)

// Scope assigns a capability to a set of viewers. Empty scopes = everyone.
type Scope struct {
	Type  string // all | department | role
	Value string
}

// EffectiveScope reports whether a capability with the given scopes is
// visible to a user with the given department/role.
func EffectiveScope(scopes []Scope, department, role string) bool {
	if len(scopes) == 0 {
		return true
	}
	for _, s := range scopes {
		switch s.Type {
		case "all":
			return true
		case "department":
			if department != "" && s.Value == department {
				return true
			}
		case "role":
			if role != "" && s.Value == role {
				return true
			}
		}
	}
	return false
}

// NormalizeScopes canonicalizes raw scopes: drops unknown types, drops
// empty-valued department/role scopes (they match nothing), dedups.
func NormalizeScopes(in []Scope) []Scope {
	seen := map[Scope]bool{}
	out := make([]Scope, 0, len(in))
	for _, s := range in {
		s.Type = strings.TrimSpace(s.Type)
		s.Value = strings.TrimSpace(s.Value)
		switch s.Type {
		case "all":
			s.Value = ""
		case "department", "role":
			if s.Value == "" {
				continue
			}
		default:
			continue
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type < out[j].Type
		}
		return out[i].Value < out[j].Value
	})
	return out
}
