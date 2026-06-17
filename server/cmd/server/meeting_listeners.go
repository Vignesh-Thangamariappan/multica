package main

import (
	"context"

	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// registerMeetingListeners drives turn-based meetings forward. Each debate turn
// runs as an agent task; when one finishes (task:completed / task:failed) and
// it belongs to a meeting, MeetingService appends the agent's reply to the
// transcript and enqueues the next turn — or, after the last round, the summary.
// No-op for tasks that aren't meeting turns.
func registerMeetingListeners(bus *events.Bus, meetings *service.MeetingService) {
	if meetings == nil {
		return
	}
	handle := func(succeeded bool) events.Handler {
		return func(e events.Event) {
			payload, ok := e.Payload.(map[string]any)
			if !ok {
				return
			}
			taskIDStr, _ := payload["task_id"].(string)
			if taskIDStr == "" {
				return
			}
			taskID, err := util.ParseUUID(taskIDStr)
			if err != nil {
				return
			}
			meetings.OnTaskTerminal(context.Background(), taskID, succeeded)
		}
	}
	bus.Subscribe(protocol.EventTaskCompleted, handle(true))
	bus.Subscribe(protocol.EventTaskFailed, handle(false))
}
