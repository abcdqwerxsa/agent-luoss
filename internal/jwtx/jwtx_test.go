package jwtx

import "testing"

func TestSignVerifyRoundtrip(t *testing.T) {
	tok, err := Sign("s3cret", "u_1", "admin")
	if err != nil {
		t.Fatal(err)
	}
	c, err := Verify("s3cret", tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if c.UserID != "u_1" || c.Role != "admin" || c.Typ != TypAccess {
		t.Fatalf("claims mismatch: %+v", c)
	}
	// wrong secret rejected
	if _, err := Verify("wrong", tok); err == nil {
		t.Fatal("wrong secret must fail")
	}
	// tampered token rejected
	if _, err := Verify("s3cret", tok+"x"); err == nil {
		t.Fatal("tampered token must fail")
	}
}
