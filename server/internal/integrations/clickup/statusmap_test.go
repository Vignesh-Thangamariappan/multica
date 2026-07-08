package clickup

import "testing"

func TestDefaultMulticaStatus(t *testing.T) {
	t.Parallel()
	cases := []struct {
		status Status
		want   string
	}{
		{Status{Status: "Complete", Type: "done"}, "done"},
		{Status{Status: "Closed", Type: "closed"}, "done"},
		{Status{Status: "to do", Type: "open"}, "todo"},
		{Status{Status: "In Review", Type: "custom"}, "in_review"},
		{Status{Status: "QA Testing", Type: "custom"}, "in_review"},
		{Status{Status: "In Progress", Type: "custom"}, "in_progress"},
		{Status{Status: "Developing", Type: "custom"}, "in_progress"},
		{Status{Status: "Backlog", Type: "custom"}, "backlog"},
		{Status{Status: "On Hold", Type: "custom"}, "blocked"},
		{Status{Status: "Blocked", Type: "custom"}, "blocked"},
		{Status{Status: "Won't Do", Type: "custom"}, "cancelled"},
		{Status{Status: "Some Custom Thing", Type: "custom"}, "todo"},
	}
	for _, tc := range cases {
		if got := DefaultMulticaStatus(tc.status); got != tc.want {
			t.Errorf("DefaultMulticaStatus(%q/%s) = %q, want %q", tc.status.Status, tc.status.Type, got, tc.want)
		}
	}
}

func TestNormalizeStatus(t *testing.T) {
	t.Parallel()
	if got := normalizeStatus("In Progress"); got != "in progress" {
		t.Fatalf("normalizeStatus = %q", got)
	}
}
