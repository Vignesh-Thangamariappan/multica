package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/integrations/clickup"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// requireClickUp gates every ClickUp route on the service being
// configured (MULTICA_CLICKUP_SECRET_KEY set). Lark precedent: 503 with
// a clear message instead of 404, so the UI can distinguish "not
// configured" from "wrong URL".
func (h *Handler) requireClickUp(w http.ResponseWriter) bool {
	if h.ClickUp == nil {
		writeError(w, http.StatusServiceUnavailable, "clickup integration not configured")
		return false
	}
	return true
}

// ClickUpInstallationResponse is the wire shape for the connection card.
// The encrypted token is INTENTIONALLY absent (Lark precedent).
type ClickUpInstallationResponse struct {
	Configured  bool    `json:"configured"`
	Connected   bool    `json:"connected"`
	TeamID      string  `json:"team_id,omitempty"`
	TeamName    string  `json:"team_name,omitempty"`
	ConnectedBy *string `json:"connected_by,omitempty"`
	CreatedAt   string  `json:"created_at,omitempty"`
}

// GetClickUpInstallation (GET /api/clickup/installation) is
// member-visible so the settings tab renders for non-admins.
func (h *Handler) GetClickUpInstallation(w http.ResponseWriter, r *http.Request) {
	if h.ClickUp == nil {
		// Not configured is a renderable state for this endpoint, not an
		// error: the tab shows "integration disabled on this server".
		writeJSON(w, http.StatusOK, ClickUpInstallationResponse{Configured: false})
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	inst, err := h.ClickUp.Installation(r.Context(), wsUUID)
	if err != nil {
		if errors.Is(err, clickup.ErrNotConnected) {
			writeJSON(w, http.StatusOK, ClickUpInstallationResponse{Configured: true})
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load clickup installation")
		return
	}
	resp := ClickUpInstallationResponse{
		Configured: true,
		Connected:  true,
		TeamID:     inst.TeamID,
		TeamName:   inst.TeamName,
		CreatedAt:  inst.CreatedAt.Time.UTC().Format(time.RFC3339),
	}
	if inst.ConnectedBy.Valid {
		id := uuidToString(inst.ConnectedBy)
		resp.ConnectedBy = &id
	}
	writeJSON(w, http.StatusOK, resp)
}

// ConnectClickUp (POST /api/clickup/installation, admin) validates the
// personal token against ClickUp and stores it encrypted.
func (h *Handler) ConnectClickUp(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user_id")
	if !ok {
		return
	}

	var req struct {
		APIToken string `json:"api_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	req.APIToken = strings.TrimSpace(req.APIToken)
	if req.APIToken == "" {
		writeError(w, http.StatusBadRequest, "api_token is required")
		return
	}

	inst, err := h.ClickUp.Connect(r.Context(), wsUUID, userUUID, req.APIToken)
	if err != nil {
		if errors.Is(err, clickup.ErrTokenInvalid) {
			writeError(w, http.StatusBadRequest, "clickup rejected the token")
			return
		}
		writeError(w, http.StatusBadGateway, "failed to reach clickup")
		return
	}
	writeJSON(w, http.StatusCreated, ClickUpInstallationResponse{
		Configured: true,
		Connected:  true,
		TeamID:     inst.TeamID,
		TeamName:   inst.TeamName,
		CreatedAt:  inst.CreatedAt.Time.UTC().Format(time.RFC3339),
	})
}

// DisconnectClickUp (DELETE /api/clickup/installation, admin).
func (h *Handler) DisconnectClickUp(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	removed, err := h.ClickUp.Disconnect(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to disconnect clickup")
		return
	}
	if !removed {
		writeError(w, http.StatusNotFound, "clickup not connected")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// DiscoverClickUpLists (GET /api/clickup/spaces, admin) returns the
// space → folder → list tree for the link picker.
func (h *Handler) DiscoverClickUpLists(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	tree, err := h.ClickUp.DiscoverLists(r.Context(), wsUUID)
	if err != nil {
		if errors.Is(err, clickup.ErrNotConnected) {
			writeError(w, http.StatusNotFound, "clickup not connected")
			return
		}
		writeError(w, http.StatusBadGateway, "failed to reach clickup")
		return
	}
	writeJSON(w, http.StatusOK, tree)
}

// ClickUpLinkResponse is the wire shape for a project↔list link.
type ClickUpLinkResponse struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	ListID      string `json:"list_id"`
	ListName    string `json:"list_name"`
	SyncEnabled bool   `json:"sync_enabled"`
	LastError   string `json:"last_error"`
	CreatedAt   string `json:"created_at"`
}

func clickupLinkToResponse(l db.ClickupListLink) ClickUpLinkResponse {
	return ClickUpLinkResponse{
		ID:          uuidToString(l.ID),
		ProjectID:   uuidToString(l.ProjectID),
		ListID:      l.ListID,
		ListName:    l.ListName,
		SyncEnabled: l.SyncEnabled,
		LastError:   l.LastError,
		CreatedAt:   l.CreatedAt.Time.UTC().Format(time.RFC3339),
	}
}

// ListClickUpLinks (GET /api/clickup/links) is member-visible.
func (h *Handler) ListClickUpLinks(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	links, err := h.Queries.ListClickUpListLinks(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list clickup links")
		return
	}
	resp := make([]ClickUpLinkResponse, len(links))
	for i, l := range links {
		resp[i] = clickupLinkToResponse(l)
	}
	writeJSON(w, http.StatusOK, resp)
}

// CreateClickUpLink (POST /api/clickup/links, admin) links a project to
// a list and seeds the status map.
func (h *Handler) CreateClickUpLink(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	var req struct {
		ProjectID string `json:"project_id"`
		ListID    string `json:"list_id"`
		ListName  string `json:"list_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	projectUUID, ok := parseUUIDOrBadRequest(w, req.ProjectID, "project_id")
	if !ok {
		return
	}
	if strings.TrimSpace(req.ListID) == "" {
		writeError(w, http.StatusBadRequest, "list_id is required")
		return
	}
	// Project must exist in this workspace (cross-workspace guard).
	if _, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
		ID:          projectUUID,
		WorkspaceID: wsUUID,
	}); err != nil {
		writeError(w, http.StatusNotFound, "project not found in this workspace")
		return
	}

	link, err := h.ClickUp.CreateLink(r.Context(), wsUUID, projectUUID, req.ListID, req.ListName)
	if err != nil {
		if errors.Is(err, clickup.ErrNotConnected) {
			writeError(w, http.StatusNotFound, "clickup not connected")
			return
		}
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "project or list already linked")
			return
		}
		writeError(w, http.StatusBadGateway, "failed to create clickup link")
		return
	}
	writeJSON(w, http.StatusCreated, clickupLinkToResponse(link))
}

// DeleteClickUpLink (DELETE /api/clickup/links/{linkId}, admin).
func (h *Handler) DeleteClickUpLink(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	linkUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "linkId"), "link_id")
	if !ok {
		return
	}
	n, err := h.Queries.DeleteClickUpListLink(r.Context(), db.DeleteClickUpListLinkParams{
		ID:          linkUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete clickup link")
		return
	}
	if n == 0 {
		writeError(w, http.StatusNotFound, "clickup link not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ImportClickUpList (POST /api/clickup/links/{linkId}/import, admin)
// runs a synchronous bulk import and returns the summary. Bounded by the
// client's rate limiter; large boards take a while — the frontend shows
// a progress toast and this handler simply blocks (Phase 1 simplicity).
func (h *Handler) ImportClickUpList(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceIDFromURL(r, "id"), "workspace_id")
	if !ok {
		return
	}
	linkUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "linkId"), "link_id")
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user_id")
	if !ok {
		return
	}

	var req struct {
		IncludeClosed bool `json:"include_closed"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // empty body = defaults
	}

	link, err := h.Queries.GetClickUpListLinkInWorkspace(r.Context(), db.GetClickUpListLinkInWorkspaceParams{
		ID:          linkUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "clickup link not found")
		return
	}

	summary, err := h.ClickUp.ImportList(r.Context(), link, userUUID, req.IncludeClosed)
	if err != nil {
		writeError(w, http.StatusBadGateway, "clickup import failed")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

// PushIssueToClickUp (POST /api/issues/{id}/clickup, member) creates a
// ClickUp task from this issue in its project's linked list. Member-level
// on purpose: agents push through this route via the CLI.
func (h *Handler) PushIssueToClickUp(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, _ := requireUserID(w, r)
	userUUID, ok := parseUUIDOrBadRequest(w, userID, "user_id")
	if !ok {
		return
	}

	link, err := h.ClickUp.PushCreate(r.Context(), issue.WorkspaceID, issue, "member", userUUID)
	if err != nil {
		switch {
		case errors.Is(err, clickup.ErrAlreadyLinked):
			writeError(w, http.StatusConflict, "issue already linked to a clickup task")
		case errors.Is(err, clickup.ErrProjectNotLinked):
			writeError(w, http.StatusBadRequest, "issue's project is not linked to a clickup list")
		case errors.Is(err, clickup.ErrNotConnected):
			writeError(w, http.StatusNotFound, "clickup not connected")
		default:
			writeError(w, http.StatusBadGateway, "failed to create clickup task")
		}
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{
		"task_id":  link.TaskID,
		"task_url": link.TaskUrl,
	})
}

// GetIssueClickUpLink (GET /api/issues/{id}/clickup, member) returns the
// task link for an issue, or 404.
func (h *Handler) GetIssueClickUpLink(w http.ResponseWriter, r *http.Request) {
	if !h.requireClickUp(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	link, err := h.Queries.GetClickUpTaskLinkByIssue(r.Context(), issue.ID)
	if err != nil {
		writeError(w, http.StatusNotFound, "issue not linked to clickup")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"task_id":  link.TaskID,
		"task_url": link.TaskUrl,
	})
}
