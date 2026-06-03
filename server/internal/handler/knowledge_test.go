package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// knowledgeRequest builds a request with the given kid URL param and an
// (optionally invalid) workspace ID in the chi route context. The 400 paths
// under test return before any DB access, so a bare Handler is sufficient.
func knowledgeRequest(method, kid, wsID string) *http.Request {
	req := httptest.NewRequest(method, "/api/knowledge/"+kid+"/approve", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("kid", kid)
	if wsID != "" {
		rctx.URLParams.Add("id", wsID)
	}
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

// TestKnowledgeHandlers_InvalidUUIDs_Return400 verifies that malformed or
// missing UUIDs at the request boundary produce a 400, not a panic/500.
// Regression test: ApproveWorkspaceKnowledge previously round-tripped raw
// URL input through parseUUID (the trusted, panicking variant), so a request
// arriving without a resolvable workspace ID panicked into a 500.
func TestKnowledgeHandlers_InvalidUUIDs_Return400(t *testing.T) {
	h := &Handler{}
	validUUID := "11111111-1111-1111-1111-111111111111"

	cases := []struct {
		name string
		kid  string
		wsID string
		call func(w http.ResponseWriter, r *http.Request)
	}{
		{"approve: malformed kid", "not-a-uuid", validUUID, h.ApproveWorkspaceKnowledge},
		{"approve: empty workspace", validUUID, "", h.ApproveWorkspaceKnowledge},
		{"reject: malformed kid", "not-a-uuid", validUUID, h.RejectWorkspaceKnowledge},
		{"reject: empty workspace", validUUID, "", h.RejectWorkspaceKnowledge},
		{"delete: malformed kid", "not-a-uuid", validUUID, h.DeleteWorkspaceKnowledge},
		{"delete: empty workspace", validUUID, "", h.DeleteWorkspaceKnowledge},
		{"list: empty workspace", validUUID, "", h.ListWorkspaceKnowledge},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("handler panicked on boundary input: %v", r)
				}
			}()
			tc.call(w, knowledgeRequest(http.MethodPatch, tc.kid, tc.wsID))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}

// TestProposeKnowledge_MalformedOptionalHeaders_Return400 verifies the
// optional X-Agent-ID / X-Task-ID daemon headers are validated rather than
// fed to the panicking parseUUID variant.
func TestProposeKnowledge_MalformedOptionalHeaders_Return400(t *testing.T) {
	h := &Handler{}
	validUUID := "11111111-1111-1111-1111-111111111111"

	for _, header := range []string{"X-Agent-ID", "X-Task-ID"} {
		t.Run(header, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/knowledge/propose",
				strings.NewReader(`{"content":"some knowledge"}`))
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("id", validUUID)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
			req.Header.Set(header, "not-a-uuid")

			w := httptest.NewRecorder()
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("handler panicked on malformed %s: %v", header, r)
				}
			}()
			h.ProposeWorkspaceKnowledge(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}
