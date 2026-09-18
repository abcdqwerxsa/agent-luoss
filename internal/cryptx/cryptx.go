// Package cryptx provides AES-GCM encryption for secrets at rest
// (provider API keys). Nonce is prepended to the ciphertext.
package cryptx

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

func Cipher(master string) cipher.AEAD {
	key := sha256.Sum256([]byte(master))
	aead, err := aes.NewCipher(key[:])
	if err != nil {
		panic(err)
	}
	g, err := cipher.NewGCM(aead)
	if err != nil {
		panic(err)
	}
	return g
}

func Encrypt(g cipher.AEAD, plaintext string) (string, error) {
	nonce := make([]byte, g.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := g.Seal(nil, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(append(nonce, ct...)), nil
}

func Decrypt(g cipher.AEAD, encoded string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	ns := g.NonceSize()
	if len(b) < ns {
		return "", errors.New("ciphertext too short")
	}
	pt, err := g.Open(nil, b[:ns], b[ns:], nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(pt), nil
}
