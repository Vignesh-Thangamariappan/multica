package handler

import (
	"context"
	"encoding/json"
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

// TestProposeKnowledge_UntrustedAgentHeaders_AttributedToMember verifies that
// ProposeWorkspaceKnowledge only attributes a proposal to an agent once
// resolveActor has verified the agent belongs to this workspace and the task
// belongs to that agent — it must not trust a bare client-supplied
// X-Agent-ID/X-Task-ID pair, which would let any workspace member forge a
// proposal's provenance to look like an agent-distilled lesson. Regression
// test for a header-trust bug found in security review: the handler used to
// persist whatever X-Agent-ID/X-Task-ID the client sent as long as it parsed
// as a UUID, with no ownership check.
func TestProposeKnowledge_UntrustedAgentHeaders_AttributedToMember(t *testing.T) {
	if testHandler == nil {
		t.Skip("no test database available")
	}

	foreignAgentID := "11111111-1111-1111-1111-111111111111"

	cases := []struct {
		name        string
		agentHeader string
		taskHeader  string
	}{
		{"malformed X-Agent-ID", "not-a-uuid", ""},
		{"malformed X-Task-ID with well-formed agent", foreignAgentID, "not-a-uuid"},
		{"well-formed but unowned/nonexistent agent, no task", foreignAgentID, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := newRequest(http.MethodPost, "/api/knowledge/propose",
				map[string]string{"content": "some knowledge " + tc.name})
			req = withURLParam(req, "id", testWorkspaceID)
			if tc.agentHeader != "" {
				req.Header.Set("X-Agent-ID", tc.agentHeader)
			}
			if tc.taskHeader != "" {
				req.Header.Set("X-Task-ID", tc.taskHeader)
			}

			w := httptest.NewRecorder()
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("handler panicked: %v", r)
				}
			}()
			testHandler.ProposeWorkspaceKnowledge(w, req)
			if w.Code != http.StatusCreated {
				t.Fatalf("expected 201, got %d: %s", w.Code, w.Body.String())
			}

			var resp KnowledgeResponse
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if resp.AgentID != nil {
				t.Fatalf("expected proposal attributed to member (nil agent_id) for untrusted headers, got agent_id=%s", *resp.AgentID)
			}
		})
	}
}

// TestProposeKnowledge_TaskTokenMalformedHeaders_Return400 covers the
// task-token path, where resolveActor trusts X-Agent-ID without a UUID check:
// the handler itself must reject a malformed X-Agent-ID / X-Task-ID with a 400
// instead of feeding it to the panicking parseUUID. Regression test for the
// header hardening lost in an earlier squash.
func TestProposeKnowledge_TaskTokenMalformedHeaders_Return400(t *testing.T) {
	h := &Handler{}
	const validUUID = "11111111-1111-1111-1111-111111111111"

	cases := []struct {
		name        string
		agentHeader string
		taskHeader  string
	}{
		{"malformed X-Agent-ID", "not-a-uuid", ""},
		{"malformed X-Task-ID", validUUID, "not-a-uuid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/knowledge/propose",
				strings.NewReader(`{"content":"some knowledge"}`))
			rctx := chi.NewRouteContext()
			rctx.URLParams.Add("id", validUUID)
			req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
			req.Header.Set("X-Actor-Source", "task_token")
			req.Header.Set("X-Agent-ID", tc.agentHeader)
			if tc.taskHeader != "" {
				req.Header.Set("X-Task-ID", tc.taskHeader)
			}

			w := httptest.NewRecorder()
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("handler panicked: %v", r)
				}
			}()
			h.ProposeWorkspaceKnowledge(w, req)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d: %s", w.Code, w.Body.String())
			}
		})
	}
}
