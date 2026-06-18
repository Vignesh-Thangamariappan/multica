package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// MeetingTurnContextType marks an agent task as a meeting debate turn. The
// daemon detects this via context.type and runs the agent with Prompt as a
// text-only contribution (see daemon/prompt.go buildMeetingPrompt).
const MeetingTurnContextType = "meeting_turn"

// turnIndexSummary is the sentinel turn_index for the final summarization turn.
const turnIndexSummary = int32(-1)

// MeetingTurnContext is the task context JSONB for a meeting debate turn.
type MeetingTurnContext struct {
	Type        string `json:"type"`
	Prompt      string `json:"prompt"`
	WorkspaceID string `json:"workspace_id"`
	MeetingID   string `json:"meeting_id"`
}

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

	// Kick off round 1, turn 0. Each turn runs as an agent task; OnTaskTerminal
	// appends the reply and advances to the next turn/round, then summarizes.
	s.enqueueTurn(ctx, started, parts, 1, 0)
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

// ─── Turn engine ─────────────────────────────────────────────────────────────

// enqueueTurn enqueues the debate turn for parts[turnIndex] in the given round.
// If that agent can't be dispatched (archived / no runtime), it records a note
// and advances past them rather than stalling the meeting.
func (s *MeetingService) enqueueTurn(ctx context.Context, m db.Meeting, parts []db.MeetingParticipant, round, turnIndex int32) {
	if int(turnIndex) >= len(parts) {
		return
	}
	p := parts[turnIndex]
	prompt := s.buildTurnPrompt(ctx, m, parts, p.AgentID, round)
	if err := s.enqueueAgentTask(ctx, m, p.AgentID, round, turnIndex, prompt); err != nil {
		slog.Warn("meeting turn skipped", "meeting_id", util.UUIDToString(m.ID), "agent_id", util.UUIDToString(p.AgentID), "error", err)
		_, _ = s.Queries.AddMeetingMessage(ctx, db.AddMeetingMessageParams{
			MeetingID: m.ID, Round: round, AuthorType: "system",
			Content: "An agent was unavailable and was skipped this turn.",
		})
		s.publish(protocol.EventMeetingMessage, m, nil)
		s.advance(ctx, m, parts, round, turnIndex)
	}
}

// enqueueSummary asks the first participant to summarize the debate. Recorded
// as a turn with turn_index == turnIndexSummary so OnTaskTerminal finalizes.
func (s *MeetingService) enqueueSummary(ctx context.Context, m db.Meeting, parts []db.MeetingParticipant) {
	if len(parts) == 0 {
		s.finishMeeting(ctx, m, "")
		return
	}
	prompt := s.buildSummaryPrompt(ctx, m, parts)
	if err := s.enqueueAgentTask(ctx, m, parts[0].AgentID, m.Rounds, turnIndexSummary, prompt); err != nil {
		// No one to summarize — complete with an empty summary.
		s.finishMeeting(ctx, m, "")
	}
}

func (s *MeetingService) enqueueAgentTask(ctx context.Context, m db.Meeting, agentID pgtype.UUID, round, turnIndex int32, prompt string) error {
	agent, err := s.Queries.GetAgent(ctx, agentID)
	if err != nil {
		return fmt.Errorf("load agent: %w", err)
	}
	if agent.ArchivedAt.Valid {
		return fmt.Errorf("agent archived")
	}
	if !agent.RuntimeID.Valid {
		return fmt.Errorf("agent has no runtime")
	}
	ctxJSON, err := json.Marshal(MeetingTurnContext{
		Type:        MeetingTurnContextType,
		Prompt:      prompt,
		WorkspaceID: util.UUIDToString(m.WorkspaceID),
		MeetingID:   util.UUIDToString(m.ID),
	})
	if err != nil {
		return fmt.Errorf("marshal meeting context: %w", err)
	}
	task, err := s.Queries.CreateMeetingTask(ctx, db.CreateMeetingTaskParams{
		AgentID:   agentID,
		RuntimeID: agent.RuntimeID,
		Priority:  priorityToInt("high"),
		Context:   ctxJSON,
	})
	if err != nil {
		return fmt.Errorf("create meeting task: %w", err)
	}
	if _, err := s.Queries.CreateMeetingTurn(ctx, db.CreateMeetingTurnParams{
		MeetingID: m.ID,
		TaskID:    task.ID,
		AgentID:   agentID,
		Round:     round,
		TurnIndex: turnIndex,
	}); err != nil {
		return fmt.Errorf("create meeting turn: %w", err)
	}
	s.Tasks.NotifyTaskEnqueued(ctx, task)
	return nil
}

// OnTaskTerminal advances a meeting when one of its debate-turn tasks finishes.
// Wire it to task:completed (succeeded=true) and task:failed (succeeded=false).
// No-op for tasks that aren't meeting turns.
func (s *MeetingService) OnTaskTerminal(ctx context.Context, taskID pgtype.UUID, succeeded bool) {
	turn, err := s.Queries.GetMeetingTurnByTask(ctx, taskID)
	if err != nil {
		return // not a meeting turn
	}
	if turn.Status != "pending" {
		return // already handled (idempotent against duplicate events)
	}
	m, err := s.Queries.GetMeeting(ctx, turn.MeetingID)
	if err != nil {
		return
	}
	_ = s.Queries.UpdateMeetingTurnStatus(ctx, db.UpdateMeetingTurnStatusParams{ID: turn.ID, Status: statusOf(succeeded)})
	if m.Status != "in_progress" {
		return // meeting was cancelled / already finished
	}

	content := ""
	if succeeded {
		if task, err := s.Queries.GetAgentTask(ctx, taskID); err == nil {
			content = extractTurnOutput(task.Result)
		}
	}

	// Final summarization turn → finish the meeting.
	if turn.TurnIndex == turnIndexSummary {
		s.finishMeeting(ctx, m, content)
		return
	}

	// Normal debate turn → record the contribution, then advance.
	if content != "" {
		_, _ = s.Queries.AddMeetingMessage(ctx, db.AddMeetingMessageParams{
			MeetingID: m.ID, Round: turn.Round, AuthorType: "agent", AuthorID: turn.AgentID, Content: content,
		})
	} else {
		_, _ = s.Queries.AddMeetingMessage(ctx, db.AddMeetingMessageParams{
			MeetingID: m.ID, Round: turn.Round, AuthorType: "system",
			Content: "An agent did not contribute this turn.",
		})
	}
	s.publish(protocol.EventMeetingMessage, m, nil)

	parts, err := s.Queries.ListMeetingParticipants(ctx, m.ID)
	if err != nil {
		return
	}
	s.advance(ctx, m, parts, turn.Round, turn.TurnIndex)
}

// advance moves to the next turn; wraps to the next round; summarizes after the
// last round.
func (s *MeetingService) advance(ctx context.Context, m db.Meeting, parts []db.MeetingParticipant, round, turnIndex int32) {
	next := turnIndex + 1
	r := round
	if int(next) >= len(parts) {
		next = 0
		r++
	}
	if r > m.Rounds {
		s.enqueueSummary(ctx, m, parts)
		return
	}
	updated, err := s.Queries.UpdateMeetingProgress(ctx, db.UpdateMeetingProgressParams{
		ID: m.ID, CurrentRound: r, CurrentTurn: next, Status: "in_progress",
	})
	if err != nil {
		updated = m
	}
	s.enqueueTurn(ctx, updated, parts, r, next)
}

func (s *MeetingService) finishMeeting(ctx context.Context, m db.Meeting, summary string) {
	if strings.TrimSpace(summary) == "" {
		summary = "Meeting concluded."
	}
	completed, err := s.Queries.CompleteMeeting(ctx, db.CompleteMeetingParams{ID: m.ID, Summary: summary})
	if err != nil {
		slog.Error("complete meeting", "meeting_id", util.UUIDToString(m.ID), "error", err)
		return
	}
	// Short transcript end-cap only — the full structured outcome lives in
	// meeting.summary and renders in the Outcome card (posting the whole thing
	// as a system message would dump a wall of text mid-transcript).
	_, _ = s.Queries.AddMeetingMessage(ctx, db.AddMeetingMessageParams{
		MeetingID: completed.ID, Round: completed.CurrentRound, AuthorType: "system",
		Content: "Meeting concluded — outcome recorded.",
	})
	s.publish(protocol.EventMeetingMessage, completed, nil)
	s.publish(protocol.EventMeetingCompleted, completed, nil)
}

// buildTurnPrompt composes the full per-turn prompt: meeting framing, topic,
// the transcript so far, and this agent's turn instruction.
func (s *MeetingService) buildTurnPrompt(ctx context.Context, m db.Meeting, parts []db.MeetingParticipant, agentID pgtype.UUID, round int32) string {
	names := s.participantNames(ctx, parts)
	var b strings.Builder
	you := names[util.UUIDToString(agentID)]
	if you == "" {
		you = "an agent"
	}
	fmt.Fprintf(&b, "You are %s, one of the agents in a team meeting (%s) with other AI agents.\n\n", you, meetingTypeLabel(m.Type))
	fmt.Fprintf(&b, "Meeting: %s\n", m.Title)
	if strings.TrimSpace(m.Topic) != "" {
		fmt.Fprintf(&b, "Topic / agenda: %s\n", m.Topic)
	}
	roster := make([]string, 0, len(parts))
	for _, p := range parts {
		if n := names[util.UUIDToString(p.AgentID)]; n != "" {
			roster = append(roster, n)
		}
	}
	if len(roster) > 0 {
		fmt.Fprintf(&b, "Participants: %s\n", strings.Join(roster, ", "))
	}
	b.WriteString("\nTranscript so far:\n")
	b.WriteString(s.renderTranscript(ctx, m, names))
	fmt.Fprintf(&b, "\nIt is now your turn (round %d of %d). Contribute your view in a few sentences — react to what others said, add something new, raise a concern, or propose a next step. Don't repeat points already made. Reply with your contribution only, as plain prose.\n", round, m.Rounds)
	return b.String()
}

func (s *MeetingService) buildSummaryPrompt(ctx context.Context, m db.Meeting, parts []db.MeetingParticipant) string {
	names := s.participantNames(ctx, parts)
	var b strings.Builder
	fmt.Fprintf(&b, "The %s meeting \"%s\" has concluded.\n\n", meetingTypeLabel(m.Type), m.Title)
	if strings.TrimSpace(m.Topic) != "" {
		fmt.Fprintf(&b, "Topic / agenda: %s\n\n", m.Topic)
	}
	b.WriteString("Full transcript:\n")
	b.WriteString(s.renderTranscript(ctx, m, names))
	b.WriteString("\nYou are the facilitator. Capture the OUTCOME of this meeting as Markdown with exactly these three sections, each a short, scannable bullet list — concrete and concise, no preamble and no recap of who said what:\n\n")
	b.WriteString("## Decisions\n- the concrete decisions the group actually reached\n\n")
	b.WriteString("## Action items\n- **Owner** — the specific next step they committed to (name the owner from the participants when one was assigned)\n\n")
	b.WriteString("## Learnings\n- the key takeaways or insights from this discussion that are worth remembering next time\n\n")
	b.WriteString("If a section genuinely has nothing real to record, put a single \"- None\" under it. Reply with only these three sections.\n")
	return b.String()
}

func (s *MeetingService) renderTranscript(ctx context.Context, m db.Meeting, names map[string]string) string {
	msgs, err := s.Queries.ListMeetingMessages(ctx, m.ID)
	if err != nil || len(msgs) == 0 {
		return "(nothing said yet — you're opening the discussion)\n"
	}
	var b strings.Builder
	for _, msg := range msgs {
		switch msg.AuthorType {
		case "agent":
			name := names[util.UUIDToString(msg.AuthorID)]
			if name == "" {
				name = "Agent"
			}
			fmt.Fprintf(&b, "%s: %s\n", name, msg.Content)
		case "member":
			fmt.Fprintf(&b, "Facilitator: %s\n", msg.Content)
		default:
			fmt.Fprintf(&b, "(%s)\n", msg.Content)
		}
	}
	return b.String()
}

func (s *MeetingService) participantNames(ctx context.Context, parts []db.MeetingParticipant) map[string]string {
	names := make(map[string]string, len(parts))
	for _, p := range parts {
		if agent, err := s.Queries.GetAgent(ctx, p.AgentID); err == nil {
			names[util.UUIDToString(p.AgentID)] = agent.Name
		}
	}
	return names
}

func extractTurnOutput(result []byte) string {
	if len(result) == 0 {
		return ""
	}
	var payload protocol.TaskCompletedPayload
	if err := json.Unmarshal(result, &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(util.UnescapeBackslashEscapes(payload.Output))
}

func statusOf(succeeded bool) string {
	if succeeded {
		return "done"
	}
	return "failed"
}

func meetingTypeLabel(t string) string {
	switch t {
	case "standup":
		return "daily standup"
	case "issue_discussion":
		return "issue discussion"
	case "planning":
		return "planning"
	case "retro":
		return "retrospective"
	default:
		return "team"
	}
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
