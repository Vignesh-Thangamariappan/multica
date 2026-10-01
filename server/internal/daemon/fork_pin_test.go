package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
)

// The pre-existing update tests exercise the upstream update path, so they run
// with the opt-in set; the tests below flip it explicitly.
func init() { _ = os.Setenv(allowUpstreamUpdateEnv, "true") }

func TestHandleUpdateRefusedOnPinnedForkBuild(t *testing.T) {
	t.Setenv(allowUpstreamUpdateEnv, "")
	var payload map[string]any
	d, reportCalls := updateReportDaemon(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode update report: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	})
	d.runUpdateFn = func(string) (string, error) {
		t.Fatal("runUpdateFn must not run on a pinned fork build")
		return "", nil
	}

	d.handleUpdate(context.Background(), "runtime-1", &PendingUpdate{ID: "update-1", TargetVersion: "v0.6.0"})

	if got := atomic.LoadInt32(reportCalls); got != 1 {
		t.Fatalf("update reports = %d, want 1", got)
	}
	if payload["status"] != "failed" || payload["error"] != forkPinnedUpdateError {
		t.Fatalf("payload = %v, want failed/%q", payload, forkPinnedUpdateError)
	}
}

func TestForkBuildPinnedDefaultsOnAndOptsOut(t *testing.T) {
	t.Setenv(allowUpstreamUpdateEnv, "")
	if !forkBuildPinned() {
		t.Fatal("unset env must pin the fork build")
	}
	t.Setenv(allowUpstreamUpdateEnv, "true")
	if forkBuildPinned() {
		t.Fatal("=true must allow upstream updates")
	}
}
