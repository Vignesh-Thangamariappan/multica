package clickup

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// fastClient returns a client against the stub with an effectively
// unlimited rate (tests must not wait out the shared production limiter).
func fastClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c := NewClient("pk_test_token", srv.URL)
	c.limiter = &intervalLimiter{interval: time.Nanosecond}
	return c
}

func TestGetAuthorizedTeams(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/team" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "pk_test_token" {
			t.Errorf("missing token header, got %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"teams":[{"id":"9001","name":"Acme"}]}`))
	}))
	defer srv.Close()

	teams, err := fastClient(t, srv).GetAuthorizedTeams(context.Background())
	if err != nil {
		t.Fatalf("GetAuthorizedTeams: %v", err)
	}
	if len(teams) != 1 || teams[0].ID != "9001" || teams[0].Name != "Acme" {
		t.Fatalf("unexpected teams: %+v", teams)
	}
}

func TestGetTasksPagePagination(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Query().Get("page") {
		case "0":
			_, _ = w.Write([]byte(`{"tasks":[{"id":"t1","name":"One","status":{"status":"to do","type":"open"},"date_updated":"1700000000000"}],"last_page":false}`))
		default:
			_, _ = w.Write([]byte(`{"tasks":[],"last_page":true}`))
		}
	}))
	defer srv.Close()

	c := fastClient(t, srv)
	tasks, last, err := c.GetTasksPage(context.Background(), "list1", 0, false)
	if err != nil {
		t.Fatalf("page 0: %v", err)
	}
	if last || len(tasks) != 1 || tasks[0].ID != "t1" {
		t.Fatalf("unexpected page 0: last=%v tasks=%+v", last, tasks)
	}
	if got := tasks[0].DateUpdatedMs(); got != 1700000000000 {
		t.Fatalf("DateUpdatedMs = %d", got)
	}
	_, last, err = c.GetTasksPage(context.Background(), "list1", 1, false)
	if err != nil || !last {
		t.Fatalf("page 1: last=%v err=%v", last, err)
	}
}

func TestRateLimitRetry(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"teams":[{"id":"1","name":"T"}]}`))
	}))
	defer srv.Close()

	teams, err := fastClient(t, srv).GetAuthorizedTeams(context.Background())
	if err != nil {
		t.Fatalf("expected retry to succeed: %v", err)
	}
	if calls.Load() != 2 || len(teams) != 1 {
		t.Fatalf("expected exactly one retry, calls=%d teams=%+v", calls.Load(), teams)
	}
}

func TestAPIErrorSurfaced(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"err":"Token invalid"}`))
	}))
	defer srv.Close()

	_, err := fastClient(t, srv).GetAuthorizedTeams(context.Background())
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T: %v", err, err)
	}
	if apiErr.Status != http.StatusUnauthorized {
		t.Fatalf("status = %d", apiErr.Status)
	}
}
