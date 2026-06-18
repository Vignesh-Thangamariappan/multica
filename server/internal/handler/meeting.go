package handler

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ─── Wire types ──────────────────────────────────────────────────────────────

type createMeetingRequest struct {
	Title    string   `json:"title"`
	Type     string   `json:"type"`
	Topic    string   `json:"topic"`
	IssueID  string   `json:"issue_id"`
	Rounds   int32    `json:"rounds"`
	AgentIDs []string `json:"agent_ids"`
}

type addMeetingMessageRequest struct {
	Content string `json:"content"`
}

type meetingParticipantResponse struct {
	ID            string `json:"id"`
	AgentID       string `json:"agent_id"`
	SpeakingOrder int32  `json:"speaking_order"`
}

type meetingMessageResponse struct {
	ID         string  `json:"id"`
	Seq        int32   `json:"seq"`
	Round      int32   `json:"round"`
	AuthorType string  `json:"author_type"`
	AuthorID   *string `json:"author_id,omitempty"`
	Content    string  `json:"content"`
	CreatedAt  string  `json:"created_at"`
}

type meetingResponse struct {
	ID           string                       `json:"id"`
	WorkspaceID  string                       `json:"workspace_id"`
	Title        string                       `json:"title"`
	Type         string                       `json:"type"`
	Topic        string                       `json:"topic"`
	IssueID      *string                      `json:"issue_id,omitempty"`
	Status       string                       `json:"status"`
	Rounds       int32                        `json:"rounds"`
	CurrentRound int32                        `json:"current_round"`
	CurrentTurn  int32                        `json:"current_turn"`
	Summary      string                       `json:"summary"`
	CreatedAt    string                       `json:"created_at"`
	StartedAt    *string                      `json:"started_at,omitempty"`
	CompletedAt  *string                      `json:"completed_at,omitempty"`
	Participants []meetingParticipantResponse `json:"participants"`
	Messages     []meetingMessageResponse     `json:"messages"`
}

func meetingToResponse(m db.Meeting, parts []db.MeetingParticipant, msgs []db.MeetingMessage) meetingResponse {
	resp := meetingResponse{
		ID:           uuidToString(m.ID),
		WorkspaceID:  uuidToString(m.WorkspaceID),
		Title:        m.Title,
		Type:         m.Type,
		Topic:        m.Topic,
		IssueID:      uuidToPtr(m.IssueID),
		Status:       m.Status,
		Rounds:       m.Rounds,
		CurrentRound: m.CurrentRound,
		CurrentTurn:  m.CurrentTurn,
		Summary:      m.Summary,
		CreatedAt:    tsToString(m.CreatedAt),
		StartedAt:    tsToPtr(m.StartedAt),
		CompletedAt:  tsToPtr(m.CompletedAt),
		Participants: make([]meetingParticipantResponse, 0, len(parts)),
		Messages:     make([]meetingMessageResponse, 0, len(msgs)),
	}
	for _, p := range parts {
		resp.Participants = append(resp.Participants, meetingParticipantResponse{
			ID:            uuidToString(p.ID),
			AgentID:       uuidToString(p.AgentID),
			SpeakingOrder: p.SpeakingOrder,
		})
	}
	for _, msg := range msgs {
		resp.Messages = append(resp.Messages, meetingMessageResponse{
			ID:         uuidToString(msg.ID),
			Seq:        msg.Seq,
			Round:      msg.Round,
			AuthorType: msg.AuthorType,
			AuthorID:   uuidToPtr(msg.AuthorID),
			Content:    msg.Content,
			CreatedAt:  tsToString(msg.CreatedAt),
		})
	}
	return resp
}

func tsToString(t pgtype.Timestamptz) string {
	if !t.Valid {
		return ""
	}
	return t.Time.UTC().Format(time.RFC3339)
}

func tsToPtr(t pgtype.Timestamptz) *string {
	if !t.Valid {
		return nil
	}
	s := t.Time.UTC().Format(time.RFC3339)
	return &s
}

// ─── Handlers ────────────────────────────────────────────────────────────────

// CreateMeeting creates a meeting + its ordered agent participants.
func (h *Handler) CreateMeeting(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}

	var req createMeetingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}
	if len(req.AgentIDs) < 2 {
		writeError(w, http.StatusBadRequest, "a meeting needs at least 2 agents")
		return
	}

	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	agentUUIDs := make([]pgtype.UUID, 0, len(req.AgentIDs))
	for _, a := range req.AgentIDs {
		u, ok := parseUUIDOrBadRequest(w, a, "agent_id")
		if !ok {
			return
		}
		agentUUIDs = append(agentUUIDs, u)
	}

	var issueID pgtype.UUID
	if req.IssueID != "" {
		u, ok := parseUUIDOrBadRequest(w, req.IssueID, "issue_id")
		if !ok {
			return
		}
		issueID = u
	}

	var createdBy pgtype.UUID
	if uid := requestUserID(r); uid != "" {
		if u, err := util.ParseUUID(uid); err == nil {
			createdBy = u
		}
	}

	m, err := h.MeetingService.CreateMeeting(r.Context(), db.CreateMeetingParams{
		WorkspaceID: wsUUID,
		Title:       req.Title,
		Type:        req.Type,
		Topic:       req.Topic,
		IssueID:     issueID,
		Rounds:      req.Rounds,
		CreatedBy:   createdBy,
	}, agentUUIDs)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create meeting")
		return
	}

	parts, _ := h.Queries.ListMeetingParticipants(r.Context(), m.ID)
	writeJSON(w, http.StatusCreated, meetingToResponse(m, parts, nil))
}

// ListMeetings returns the workspace's meetings (most recent first).
func (h *Handler) ListMeetings(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	meetings, err := h.Queries.ListMeetings(r.Context(), wsUUID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list meetings")
		return
	}
	resp := make([]meetingResponse, 0, len(meetings))
	for _, m := range meetings {
		// Include participants so the list can show the count. Transcript
		// (messages) is omitted from the list — it's only loaded on detail.
		parts, _ := h.Queries.ListMeetingParticipants(r.Context(), m.ID)
		resp = append(resp, meetingToResponse(m, parts, nil))
	}
	writeJSON(w, http.StatusOK, resp)
}

// GetMeeting returns a meeting with its participants and full transcript.
func (h *Handler) GetMeeting(w http.ResponseWriter, r *http.Request) {
	m, ok := h.loadMeetingForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	parts, _ := h.Queries.ListMeetingParticipants(r.Context(), m.ID)
	msgs, _ := h.Queries.ListMeetingMessages(r.Context(), m.ID)
	writeJSON(w, http.StatusOK, meetingToResponse(m, parts, msgs))
}

// StartMeeting moves a scheduled meeting to in_progress and opens the debate.
func (h *Handler) StartMeeting(w http.ResponseWriter, r *http.Request) {
	m, ok := h.loadMeetingForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	started, err := h.MeetingService.StartMeeting(r.Context(), m)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	parts, _ := h.Queries.ListMeetingParticipants(r.Context(), started.ID)
	msgs, _ := h.Queries.ListMeetingMessages(r.Context(), started.ID)
	writeJSON(w, http.StatusOK, meetingToResponse(started, parts, msgs))
}

// CancelMeeting cancels a scheduled or in-progress meeting.
func (h *Handler) CancelMeeting(w http.ResponseWriter, r *http.Request) {
	m, ok := h.loadMeetingForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	cancelled, err := h.MeetingService.Cancel(r.Context(), m)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to cancel meeting")
		return
	}
	writeJSON(w, http.StatusOK, meetingToResponse(cancelled, nil, nil))
}

// AddMeetingMessage lets a member chime in to the transcript.
func (h *Handler) AddMeetingMessage(w http.ResponseWriter, r *http.Request) {
	m, ok := h.loadMeetingForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req addMeetingMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Content == "" {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	var authorID pgtype.UUID
	if uid := requestUserID(r); uid != "" {
		if u, err := util.ParseUUID(uid); err == nil {
			authorID = u
		}
	}
	msg, err := h.MeetingService.AddManualMessage(r.Context(), m, "member", authorID, req.Content)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to add message")
		return
	}
	writeJSON(w, http.StatusCreated, meetingMessageResponse{
		ID:         uuidToString(msg.ID),
		Seq:        msg.Seq,
		Round:      msg.Round,
		AuthorType: msg.AuthorType,
		AuthorID:   uuidToPtr(msg.AuthorID),
		Content:    msg.Content,
		CreatedAt:  tsToString(msg.CreatedAt),
	})
}

// loadMeetingForUser resolves a meeting by UUID, scoped to the caller's
// workspace and gated by membership.
func (h *Handler) loadMeetingForUser(w http.ResponseWriter, r *http.Request, idStr string) (db.Meeting, bool) {
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return db.Meeting{}, false
	}
	if _, ok := h.workspaceMember(w, r, workspaceID); !ok {
		return db.Meeting{}, false
	}
	id, ok := parseUUIDOrBadRequest(w, idStr, "meeting id")
	if !ok {
		return db.Meeting{}, false
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return db.Meeting{}, false
	}
	m, err := h.Queries.GetMeetingInWorkspace(r.Context(), db.GetMeetingInWorkspaceParams{
		ID:          id,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "meeting not found")
		return db.Meeting{}, false
	}
	return m, true
}
