package clickup

import "strings"

// DefaultMulticaStatus maps a ClickUp list status to a Multica issue
// status (ADR E1 heuristics). ClickUp statuses are arbitrary per-list
// strings, but every one carries a `type`:
//
//	closed/done → done
//	open        → todo
//	custom      → name heuristics, falling back to todo
//
// The seeded map is stored per link (clickup_status_map) and editable by
// admins, so these defaults only have to be sensible, not perfect.
func DefaultMulticaStatus(s Status) string {
	switch s.Type {
	case "done", "closed":
		return "done"
	}
	name := strings.ToLower(s.Status)
	switch {
	case strings.Contains(name, "review") || strings.Contains(name, "qa") || strings.Contains(name, "test"):
		return "in_review"
	case strings.Contains(name, "progress") || strings.Contains(name, "doing") || strings.Contains(name, "active") || strings.Contains(name, "develop"):
		return "in_progress"
	case strings.Contains(name, "backlog") || strings.Contains(name, "icebox") || strings.Contains(name, "later"):
		return "backlog"
	case strings.Contains(name, "block") || strings.Contains(name, "hold") || strings.Contains(name, "wait"):
		return "blocked"
	case strings.Contains(name, "cancel") || strings.Contains(name, "won't") || strings.Contains(name, "wont"):
		return "cancelled"
	default:
		return "todo"
	}
}
