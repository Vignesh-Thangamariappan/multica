package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type KnowledgeResponse struct {
	ID          string  `json:"id"`
	WorkspaceID string  `json:"workspace_id"`
	AgentID     *string `json:"agent_id,omitempty"`
	Content     string  `json:"content"`
	Status      string  `json:"status"`
	CreatedAt   string  `json:"created_at"`
}

func knowledgeToResponse(k db.WorkspaceKnowledge) KnowledgeResponse {
	return KnowledgeResponse{
		ID:          uuidToString(k.ID),
		WorkspaceID: uuidToString(k.WorkspaceID),
		AgentID:     uuidToPtr(k.AgentID),
		Content:     k.Content,
		Status:      k.Status,
		CreatedAt:   timestampToString(k.CreatedAt),
	}
}

// ListWorkspaceKnowledge returns knowledge entries for a workspace.
// Query param ?status=active|pending|rejected (default: active).
func (h *Handler) ListWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	wsID := workspaceIDFromURL(r, "id")
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "active"
	}
	if status != "active" && status != "pending" && status != "rejected" {
		writeError(w, http.StatusBadRequest, "status must be active, pending, or rejected")
		return
	}

	entries, err := h.Queries.ListWorkspaceKnowledgeByStatus(r.Context(), db.ListWorkspaceKnowledgeByStatusParams{
		WorkspaceID: parseUUID(wsID),
		Status:      status,
		Limit:       100,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list knowledge")
		return
	}

	resp := make([]KnowledgeResponse, len(entries))
	for i, e := range entries {
		resp[i] = knowledgeToResponse(e)
	}
	writeJSON(w, http.StatusOK, resp)
}

type CreateKnowledgeRequest struct {
	Content string `json:"content"`
}

// CreateWorkspaceKnowledge creates an active knowledge entry (human-authored).
func (h *Handler) CreateWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	wsID := workspaceIDFromURL(r, "id")

	var req CreateKnowledgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	entry, err := h.Queries.CreateWorkspaceKnowledge(r.Context(), db.CreateWorkspaceKnowledgeParams{
		WorkspaceID: parseUUID(wsID),
		Content:     req.Content,
		Status:      "active",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge entry")
		return
	}

	writeJSON(w, http.StatusCreated, knowledgeToResponse(entry))
}

// ProposeWorkspaceKnowledge creates a pending knowledge proposal (agent-authored).
// The agent's ID is read from the X-Agent-ID header set by the daemon.
func (h *Handler) ProposeWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	wsID := workspaceIDFromURL(r, "id")

	var req CreateKnowledgeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.Content = strings.TrimSpace(req.Content)
	if req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}

	// Resolve agent ID from context (set by daemon via X-Agent-ID header).
	agentIDStr := r.Header.Get("X-Agent-ID")
	var agentID pgtype.UUID
	if agentIDStr != "" {
		agentID = parseUUID(agentIDStr)
	}

	// Resolve source task from context (set by daemon via X-Task-ID header).
	taskIDStr := r.Header.Get("X-Task-ID")
	var taskID pgtype.UUID
	if taskIDStr != "" {
		taskID = parseUUID(taskIDStr)
	}

	entry, err := h.Queries.CreateWorkspaceKnowledge(r.Context(), db.CreateWorkspaceKnowledgeParams{
		WorkspaceID:  parseUUID(wsID),
		AgentID:      agentID,
		Content:      req.Content,
		SourceTaskID: taskID,
		Status:       "pending",
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create knowledge proposal")
		return
	}

	writeJSON(w, http.StatusCreated, knowledgeToResponse(entry))
}

// ApproveWorkspaceKnowledge promotes a pending proposal to active.
func (h *Handler) ApproveWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	wsID := workspaceIDFromURL(r, "id")
	kid := chi.URLParam(r, "kid")

	entry, err := h.Queries.UpdateWorkspaceKnowledgeStatus(r.Context(), db.UpdateWorkspaceKnowledgeStatusParams{
		ID:          parseUUID(kid),
		WorkspaceID: parseUUID(wsID),
		Status:      "active",
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "knowledge entry not found")
		return
	}
	writeJSON(w, http.StatusOK, knowledgeToResponse(entry))
}

// RejectWorkspaceKnowledge marks a pending proposal as rejected.
func (h *Handler) RejectWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	wsID := workspaceIDFromURL(r, "id")
	kid := chi.URLParam(r, "kid")

	entry, err := h.Queries.UpdateWorkspaceKnowledgeStatus(r.Context(), db.UpdateWorkspaceKnowledgeStatusParams{
		ID:          parseUUID(kid),
		WorkspaceID: parseUUID(wsID),
		Status:      "rejected",
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "knowledge entry not found")
		return
	}
	writeJSON(w, http.StatusOK, knowledgeToResponse(entry))
}

// DeleteWorkspaceKnowledge removes a knowledge entry.
func (h *Handler) DeleteWorkspaceKnowledge(w http.ResponseWriter, r *http.Request) {
	wsID := workspaceIDFromURL(r, "id")
	kid := chi.URLParam(r, "kid")

	if err := h.Queries.DeleteWorkspaceKnowledge(r.Context(), db.DeleteWorkspaceKnowledgeParams{
		ID:          parseUUID(kid),
		WorkspaceID: parseUUID(wsID),
	}); err != nil {
		writeError(w, http.StatusNotFound, "knowledge entry not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
