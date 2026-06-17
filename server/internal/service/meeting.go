package service

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// MeetingService owns the lifecycle of a meeting — a turn-based debate where
// participating agents take turns responding to a topic over a number of
// rounds, building a transcript and (on completion) a summary.
//
// v1 covers creation, participant management, the transcript, and starting a
// meeting. The live turn engine (enqueue an agent task per turn, append its
// reply on completion, advance to the next turn) plugs into StartMeeting /
// OnTaskCompleted once the turn-execution mechanism is settled — see the
// TODO(turn-engine) markers.
type MeetingService struct {
	Queries *db.Queries
	Bus     *events.Bus
	Tasks   *TaskService
}

func NewMeetingService(q *db.Queries, bus *events.Bus, tasks *TaskService) *MeetingService {
	return &MeetingService{Queries: q, Bus: bus, Tasks: tasks}
}

// CreateMeeting persists a meeting plus its ordered agent participants.
// agentIDs define the round-robin speaking order.
func (s *MeetingService) CreateMeeting(ctx context.Context, p db.CreateMeetingParams, agentIDs []pgtype.UUID) (db.Meeting, error) {
	if p.Rounds <= 0 {
		p.Rounds = 2
	}
	if p.Type == "" {
		p.Type = "issue_discussion"
	}
	m, err := s.Queries.CreateMeeting(ctx, p)
	if err != nil {
		return db.Meeting{}, fmt.Errorf("create meeting: %w", err)
	}
	for i, aid := range agentIDs {
		if _, err := s.Queries.AddMeetingParticipant(ctx, db.AddMeetingParticipantParams{
			MeetingID:     m.ID,
			AgentID:       aid,
			SpeakingOrder: int32(i),
		}); err != nil {
			slog.Error("add meeting participant",
				"meeting_id", util.UUIDToString(m.ID),
				"agent_id", util.UUIDToString(aid),
				"error", err)
		}
	}
	s.publish(protocol.EventMeetingCreated, m, nil)
	return m, nil
}

// StartMeeting moves a scheduled meeting to in_progress, opens the transcript
// with a system note, and (TODO) kicks off the first agent turn.
func (s *MeetingService) StartMeeting(ctx context.Context, m db.Meeting) (db.Meeting, error) {
	if m.Status != "scheduled" {
		return m, fmt.Errorf("meeting is not scheduled (status=%s)", m.Status)
	}
	parts, err := s.Queries.ListMeetingParticipants(ctx, m.ID)
	if err != nil {
		return m, fmt.Errorf("list participants: %w", err)
	}
	if len(parts) == 0 {
		return m, fmt.Errorf("meeting has no participants")
	}

	started, err := s.Queries.StartMeeting(ctx, m.ID)
	if err != nil {
		return m, fmt.Errorf("start meeting: %w", err)
	}

	if _, err := s.Queries.AddMeetingMessage(ctx, db.AddMeetingMessageParams{
		MeetingID:  started.ID,
		Round:      0,
		AuthorType: "system",
		Content:    fmt.Sprintf("Meeting started — %d participants, %d rounds.", len(parts), started.Rounds),
	}); err != nil {
		slog.Error("open meeting transcript", "meeting_id", util.UUIDToString(started.ID), "error", err)
	}

	s.publish(protocol.EventMeetingStarted, started, nil)
	s.publish(protocol.EventMeetingMessage, started, nil)

	// TODO(turn-engine): enqueue the first agent turn (parts[0]) here. Each
	// turn runs as an agent task seeded with the topic + transcript so far;
	// OnTaskCompleted appends the reply and advances to the next turn/round,
	// then summarizes. Pending the turn-execution mechanism decision.
	return started, nil
}

// AddManualMessage appends a human/agent note to the transcript (e.g. a member
// chiming in). Author is a member or agent.
func (s *MeetingService) AddManualMessage(ctx context.Context, m db.Meeting, authorType string, authorID pgtype.UUID, content string) (db.MeetingMessage, error) {
	msg, err := s.Queries.AddMeetingMessage(ctx, db.AddMeetingMessageParams{
		MeetingID:  m.ID,
		Round:      m.CurrentRound,
		AuthorType: authorType,
		AuthorID:   authorID,
		Content:    content,
	})
	if err != nil {
		return db.MeetingMessage{}, fmt.Errorf("add meeting message: %w", err)
	}
	s.publish(protocol.EventMeetingMessage, m, nil)
	return msg, nil
}

// Cancel marks an in-flight or scheduled meeting cancelled.
func (s *MeetingService) Cancel(ctx context.Context, m db.Meeting) (db.Meeting, error) {
	cancelled, err := s.Queries.CancelMeeting(ctx, db.CancelMeetingParams{
		ID:          m.ID,
		WorkspaceID: m.WorkspaceID,
	})
	if err != nil {
		return m, fmt.Errorf("cancel meeting: %w", err)
	}
	s.publish(protocol.EventMeetingUpdated, cancelled, nil)
	return cancelled, nil
}

// publish emits a lightweight meeting event. Per the project's realtime model,
// WS events invalidate frontend queries — the payload only needs to identify
// the meeting, not carry its full state.
func (s *MeetingService) publish(eventType string, m db.Meeting, extra map[string]any) {
	payload := map[string]any{
		"meeting_id": util.UUIDToString(m.ID),
		"status":     m.Status,
	}
	for k, v := range extra {
		payload[k] = v
	}
	s.Bus.Publish(events.Event{
		Type:        eventType,
		WorkspaceID: util.UUIDToString(m.WorkspaceID),
		ActorType:   "system",
		Payload:     payload,
	})
}
