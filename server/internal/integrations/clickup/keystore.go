package clickup

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/internal/util/secretbox"
)

// Key resolution order:
//
//  1. MULTICA_CLICKUP_SECRET_KEY env var (operator-managed, wins always)
//  2. <secrets dir>/clickup_secret.key — written by the admin "activate
//     from the UI" flow (SetClickUpKey handler), so a self-hoster can
//     enable the integration without editing .env + restarting.
//
// The file holds the base64 key with 0600 perms. Same trust model as
// .env on the same disk; the key is never returned by any API.

const (
	keyEnvName     = "MULTICA_CLICKUP_SECRET_KEY"
	secretsDirEnv  = "MULTICA_SECRETS_DIR"
	keyFileName    = "clickup_secret.key"
	defaultSecrets = "data/secrets"
)

// ErrInvalidSecretKey signals a key that is not base64 of exactly 32 bytes.
var ErrInvalidSecretKey = errors.New("clickup: secret key must be base64-encoded 32 bytes")

// ErrKeyFromEnv signals the key is operator-managed via env — the UI flow
// must not shadow it with a file the operator doesn't know about.
var ErrKeyFromEnv = errors.New("clickup: secret key is managed via environment variable")

func secretsDir() string {
	if dir := strings.TrimSpace(os.Getenv(secretsDirEnv)); dir != "" {
		return dir
	}
	return defaultSecrets
}

func keyFilePath() string {
	return filepath.Join(secretsDir(), keyFileName)
}

// ParseKeyB64 validates and decodes a base64 secret key.
func ParseKeyB64(b64 string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(key) != secretbox.KeySize {
		return nil, ErrInvalidSecretKey
	}
	return key, nil
}

// ResolveSecretKey returns the active key from env or the key file.
// (nil, nil) when neither source is set — integration stays dormant.
func ResolveSecretKey() ([]byte, error) {
	if raw := strings.TrimSpace(os.Getenv(keyEnvName)); raw != "" {
		key, err := ParseKeyB64(raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", keyEnvName, err)
		}
		return key, nil
	}
	raw, err := os.ReadFile(keyFilePath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("clickup: read key file: %w", err)
	}
	key, err := ParseKeyB64(string(raw))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", keyFilePath(), err)
	}
	return key, nil
}

// SaveSecretKey validates and persists a key to the secrets dir for the
// UI activation flow. Refuses to run when the env var is set: the file
// would silently lose to env on the next boot, which reads as data loss
// (token undecryptable) instead of a config conflict.
func SaveSecretKey(b64 string) ([]byte, error) {
	if strings.TrimSpace(os.Getenv(keyEnvName)) != "" {
		return nil, ErrKeyFromEnv
	}
	key, err := ParseKeyB64(b64)
	if err != nil {
		return nil, err
	}
	dir := secretsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("clickup: create secrets dir: %w", err)
	}
	if err := os.WriteFile(keyFilePath(), []byte(strings.TrimSpace(b64)+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("clickup: write key file: %w", err)
	}
	return key, nil
}
