// Package jwtx signs and verifies platform access tokens (HS256).
// Shared by iam (sign) and gateway (verify) via JWT_SECRET.
package jwtx

import (
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	TypAccess  = "access"
	AccessTTL  = 2 * time.Hour
	RefreshTTL = 30 * 24 * time.Hour
)

var ErrInvalid = errors.New("invalid token")

type Claims struct {
	UserID string `json:"sub"`
	Role   string `json:"role"`
	Typ    string `json:"typ"`
	jwt.RegisteredClaims
}

func Sign(secret, userID, role string) (string, error) {
	now := time.Now()
	c := Claims{
		UserID: userID, Role: role, Typ: TypAccess,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTTL)),
			Issuer:    "agentluoss",
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte(secret))
}

// Verify returns claims for a valid, unexpired access token.
func Verify(secret, token string) (*Claims, error) {
	var c Claims
	t, err := jwt.ParseWithClaims(token, &c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrInvalid
		}
		return []byte(secret), nil
	})
	if err != nil || !t.Valid || c.Typ != TypAccess {
		return nil, ErrInvalid
	}
	return &c, nil
}
