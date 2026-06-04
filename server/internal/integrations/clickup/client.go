// Package clickup implements the ClickUp integration (Phase 1: import &
// push-create). Design: docs/clickup-integration-rfc.md; decisions:
// docs/clickup-integration-adr.md.
//
// The package is inert unless MULTICA_CLICKUP_SECRET_KEY is set — the
// router constructs a Service only when the key loads, and handlers
// return 503 otherwise (Lark precedent).
package clickup

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const apiBase = "https://api.clickup.com/api/v2"

// Client is a minimal typed ClickUp REST client. One Client per request
// scope (it carries the decrypted token); the rate limiter is shared
// process-wide so concurrent callers cannot exceed ClickUp's
// ~100 req/min/token budget.
type Client struct {
	httpClient *http.Client
	token      string
	baseURL    string
	limiter    *intervalLimiter
}

// intervalLimiter spaces calls at a fixed minimum interval. Deliberately
// minimal — avoids pulling golang.org/x/time into go.mod for one
// integration (fork-maintenance driver D6 in the ADR).
type intervalLimiter struct {
	mu       sync.Mutex
	next     time.Time
	interval time.Duration
}

func (l *intervalLimiter) Wait(ctx context.Context) error {
	l.mu.Lock()
	now := time.Now()
	if l.next.Before(now) {
		l.next = now
	}
	wait := l.next.Sub(now)
	l.next = l.next.Add(l.interval)
	l.mu.Unlock()
	if wait <= 0 {
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(wait):
		return nil
	}
}

// sharedLimiter paces all outbound ClickUp calls. 90/min leaves headroom
// under the documented 100/min cap.
var sharedLimiter = &intervalLimiter{interval: time.Minute / 90}

// NewClient builds a client for the given personal API token. baseURL is
// overridable for tests; pass "" for production.
func NewClient(token, baseURL string) *Client {
	if baseURL == "" {
		baseURL = apiBase
	}
	return &Client{
		httpClient: &http.Client{Timeout: 30 * time.Second},
		token:      token,
		baseURL:    baseURL,
		limiter:    sharedLimiter,
	}
}

// Team is a ClickUp team (a.k.a. ClickUp Workspace).
type Team struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Space groups lists inside a team.
type Space struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Folder optionally groups lists inside a space.
type Folder struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Lists []List `json:"lists"`
}

// List is the container tasks live in — and the unit Multica links to a
// project (ADR C2: statuses are defined per-List).
type List struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Status is one entry of a List's status scheme.
type Status struct {
	Status string `json:"status"`
	Type   string `json:"type"` // open | custom | done | closed
}

// Task carries the fields Phase 1 consumes. date_updated is a ms-epoch
// string in ClickUp's JSON.
type Task struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Status      Status  `json:"status"`
	DateUpdated string  `json:"date_updated"`
	DueDate     *string `json:"due_date"`
	URL         string  `json:"url"`
}

// DateUpdatedMs parses the ms-epoch string; 0 when absent/garbled.
func (t Task) DateUpdatedMs() int64 {
	ms, err := strconv.ParseInt(t.DateUpdated, 10, 64)
	if err != nil {
		return 0
	}
	return ms
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	if err := c.limiter.Wait(ctx); err != nil {
		return err
	}
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("clickup: marshal request: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reqBody)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("clickup: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	// One retry on 429, honoring Retry-After when present.
	if resp.StatusCode == http.StatusTooManyRequests {
		delay := 5 * time.Second
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if secs, err := strconv.Atoi(ra); err == nil && secs > 0 && secs <= 60 {
				delay = time.Duration(secs) * time.Second
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
		return c.do(ctx, method, path, body, out)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Surface a short error body for diagnosis; never log the token.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return &APIError{Status: resp.StatusCode, Body: string(snippet)}
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("clickup: decode %s %s: %w", method, path, err)
	}
	return nil
}

// APIError is a non-2xx ClickUp response.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("clickup: HTTP %d: %s", e.Status, e.Body)
}

// GetAuthorizedTeams validates the token and returns the teams it can see.
func (c *Client) GetAuthorizedTeams(ctx context.Context) ([]Team, error) {
	var out struct {
		Teams []Team `json:"teams"`
	}
	if err := c.do(ctx, http.MethodGet, "/team", nil, &out); err != nil {
		return nil, err
	}
	return out.Teams, nil
}

// GetSpaces lists a team's spaces.
func (c *Client) GetSpaces(ctx context.Context, teamID string) ([]Space, error) {
	var out struct {
		Spaces []Space `json:"spaces"`
	}
	path := fmt.Sprintf("/team/%s/space?archived=false", url.PathEscape(teamID))
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Spaces, nil
}

// GetFolders lists a space's folders (each carrying its lists).
func (c *Client) GetFolders(ctx context.Context, spaceID string) ([]Folder, error) {
	var out struct {
		Folders []Folder `json:"folders"`
	}
	path := fmt.Sprintf("/space/%s/folder?archived=false", url.PathEscape(spaceID))
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Folders, nil
}

// GetFolderlessLists lists a space's lists that live outside any folder.
func (c *Client) GetFolderlessLists(ctx context.Context, spaceID string) ([]List, error) {
	var out struct {
		Lists []List `json:"lists"`
	}
	path := fmt.Sprintf("/space/%s/list?archived=false", url.PathEscape(spaceID))
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Lists, nil
}

// GetListStatuses returns the status scheme of a list.
func (c *Client) GetListStatuses(ctx context.Context, listID string) ([]Status, error) {
	var out struct {
		Statuses []Status `json:"statuses"`
	}
	path := fmt.Sprintf("/list/%s", url.PathEscape(listID))
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Statuses, nil
}

// GetTasksPage fetches one page of a list's tasks. includeClosed mirrors
// the RFC open question #2 resolution: import defaults to open-only,
// caller opts into closed. lastPage is ClickUp's own pagination signal.
func (c *Client) GetTasksPage(ctx context.Context, listID string, page int, includeClosed bool) (tasks []Task, lastPage bool, err error) {
	var out struct {
		Tasks    []Task `json:"tasks"`
		LastPage bool   `json:"last_page"`
	}
	path := fmt.Sprintf("/list/%s/task?page=%d&include_closed=%t&subtasks=false",
		url.PathEscape(listID), page, includeClosed)
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, false, err
	}
	return out.Tasks, out.LastPage, nil
}

// CreateTaskParams is the outbound shape for push-create.
type CreateTaskParams struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	DueDate     int64  `json:"due_date,omitempty"` // ms epoch
}

// CreateTask creates a task in a list and returns it.
func (c *Client) CreateTask(ctx context.Context, listID string, p CreateTaskParams) (Task, error) {
	var out Task
	path := fmt.Sprintf("/list/%s/task", url.PathEscape(listID))
	if err := c.do(ctx, http.MethodPost, path, p, &out); err != nil {
		return Task{}, err
	}
	return out, nil
}
