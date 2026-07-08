package main

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// seedAutopilotRunRow inserts a single autopilot_run with the given terminal
// status (and optional failure_reason) and returns its id. The row is removed
// when the owning autopilot is deleted (ON DELETE CASCADE), so callers only
// need to register cleanup for the autopilot via seedAutopilot.
func seedAutopilotRunRow(t *testing.T, autopilotID pgtype.UUID, status, failureReason string) pgtype.UUID {
	t.Helper()
	var runID string
	err := testPool.QueryRow(context.Background(), `
		INSERT INTO autopilot_run (autopilot_id, source, status, failure_reason, completed_at)
		VALUES ($1, 'manual', $2, NULLIF($3, ''), now())
		RETURNING id::text
	`, autopilotID, status, failureReason).Scan(&runID)
	if err != nil {
		t.Fatalf("seed autopilot_run: %v", err)
	}
	return parseUUID(runID)
}

// publishRunDone fires the terminal autopilot run event the way the service
// does (system actor, run_id/autopilot_id/status payload).
func publishRunDone(bus *events.Bus, ap db.Autopilot, runID pgtype.UUID, status string) {
	bus.Publish(events.Event{
		Type:        protocol.EventAutopilotRunDone,
		WorkspaceID: testWorkspaceID,
		ActorType:   "system",
		Payload: map[string]any{
			"run_id":       util.UUIDToString(runID),
			"autopilot_id": util.UUIDToString(ap.ID),
			"status":       status,
		},
	})
}

func TestAutopilotRunDoneNotify_CompletedNotifiesOwner(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerNotificationListeners(bus, queries)

	agentID := pickFixtureAgent(t)
	ap := seedAutopilot(t, queries, "Run done: completed", "member", parseUUID(testUserID), agentID)
	runID := seedAutopilotRunRow(t, ap.ID, "completed", "")

	var inboxEvents []events.Event
	bus.Subscribe(protocol.EventInboxNew, func(e events.Event) {
		inboxEvents = append(inboxEvents, e)
	})

	publishRunDone(bus, ap, runID, "completed")

	if len(inboxEvents) != 1 {
		t.Fatalf("expected 1 inbox:new event, got %d", len(inboxEvents))
	}
	item := inboxEvents[0].Payload.(map[string]any)["item"].(map[string]any)
	if got := item["type"]; got != "autopilot_completed" {
		t.Fatalf("expected type autopilot_completed, got %v", got)
	}
	if got := item["severity"]; got != "info" {
		t.Fatalf("expected severity info, got %v", got)
	}
	if got := item["recipient_id"]; got != testUserID {
		t.Fatalf("expected recipient %s, got %v", testUserID, got)
	}
	if got := item["recipient_type"]; got != "member" {
		t.Fatalf("expected recipient_type member, got %v", got)
	}
	// run_only autopilot creates no issue, so the inbox item carries no issue.
	if got, _ := item["issue_id"].(*string); got != nil {
		t.Fatalf("expected nil issue_id for run_only completion, got %v", *got)
	}
}

func TestAutopilotRunDoneNotify_FailedCarriesReason(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerNotificationListeners(bus, queries)

	agentID := pickFixtureAgent(t)
	ap := seedAutopilot(t, queries, "Run done: failed", "member", parseUUID(testUserID), agentID)
	runID := seedAutopilotRunRow(t, ap.ID, "failed", "agent runtime offline at dispatch time")

	var inboxEvents []events.Event
	bus.Subscribe(protocol.EventInboxNew, func(e events.Event) {
		inboxEvents = append(inboxEvents, e)
	})

	publishRunDone(bus, ap, runID, "failed")

	if len(inboxEvents) != 1 {
		t.Fatalf("expected 1 inbox:new event, got %d", len(inboxEvents))
	}
	item := inboxEvents[0].Payload.(map[string]any)["item"].(map[string]any)
	if got := item["type"]; got != "autopilot_failed" {
		t.Fatalf("expected type autopilot_failed, got %v", got)
	}
	if got := item["severity"]; got != "action_required" {
		t.Fatalf("expected severity action_required, got %v", got)
	}
	body, _ := item["body"].(*string)
	if body == nil || *body != "agent runtime offline at dispatch time" {
		t.Fatalf("expected body to carry failure reason, got %v", item["body"])
	}
}

func TestAutopilotRunDoneNotify_SkippedIsSilent(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerNotificationListeners(bus, queries)

	agentID := pickFixtureAgent(t)
	ap := seedAutopilot(t, queries, "Run done: skipped", "member", parseUUID(testUserID), agentID)
	runID := seedAutopilotRunRow(t, ap.ID, "skipped", "assignee offline at dispatch time")

	var inboxEvents []events.Event
	bus.Subscribe(protocol.EventInboxNew, func(e events.Event) {
		inboxEvents = append(inboxEvents, e)
	})

	publishRunDone(bus, ap, runID, "skipped")

	if len(inboxEvents) != 0 {
		t.Fatalf("skipped runs must not notify, got %d inbox events", len(inboxEvents))
	}
}

func TestAutopilotRunDoneNotify_AgentCreatorRoutesToOwner(t *testing.T) {
	queries := db.New(testPool)
	bus := events.New()
	registerNotificationListeners(bus, queries)

	agentID := pickFixtureAgent(t)
	// The fixture agent's owner_id is testUserID.
	ap := seedAutopilot(t, queries, "Run done: agent-created", "agent", agentID, agentID)
	runID := seedAutopilotRunRow(t, ap.ID, "completed", "")

	var inboxEvents []events.Event
	bus.Subscribe(protocol.EventInboxNew, func(e events.Event) {
		inboxEvents = append(inboxEvents, e)
	})

	publishRunDone(bus, ap, runID, "completed")

	if len(inboxEvents) != 1 {
		t.Fatalf("expected 1 inbox event for the agent's owner, got %d", len(inboxEvents))
	}
	item := inboxEvents[0].Payload.(map[string]any)["item"].(map[string]any)
	if got := item["recipient_id"]; got != testUserID {
		t.Fatalf("expected recipient owner %s, got %v", testUserID, got)
	}
}
