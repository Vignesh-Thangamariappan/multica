package handler

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/multica-ai/multica/server/internal/integrations/clickup"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
)

// stubClickUpServer fakes the subset of the ClickUp API Phase 1 touches.
// Task payloads are routing metadata only.
func stubClickUpServer(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/team", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"teams":[{"id":"team1","name":"Stub Team"}]}`))
	})
	mux.HandleFunc("/list/list1", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":"list1","name":"Stub List","statuses":[{"status":"to do","type":"open"},{"status":"in review","type":"custom"},{"status":"complete","type":"done"}]}`))
	})
	mux.HandleFunc("/list/list1/task", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`{"id":"pushed1","name":"Pushed","status":{"status":"to do","type":"open"},"date_updated":"1700000000000","url":"https://app.clickup.com/t/pushed1"}`))
			return
		}
		if r.URL.Query().Get("page") == "0" {
			_, _ = w.Write([]byte(`{"tasks":[
				{"id":"ct1","name":"Imported one","description":"From ClickUp","status":{"status":"to do","type":"open"},"date_updated":"1700000000001","url":"https://app.clickup.com/t/ct1"},
				{"id":"ct2","name":"Imported two","description":"","status":{"status":"in review","type":"custom"},"date_updated":"1700000000002","url":"https://app.clickup.com/t/ct2"}
			],"last_page":true}`))
			return
		}
		_, _ = w.Write([]byte(`{"tasks":[],"last_page":true}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// installClickUpForTest wires a test Service into testHandler with the
// stub API and connects the test workspace. Restores nil on cleanup so
// the rest of the suite keeps seeing "not configured".
func installClickUpForTest(t *testing.T) {
	t.Helper()
	srv := stubClickUpServer(t)
	key := make([]byte, secretbox.KeySize)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	testHandler.SetClickUpService(clickup.NewServiceForTest(
		testHandler.Queries, box, testHandler.IssueService, slog.Default(), srv.URL))
	t.Cleanup(func() {
		testHandler.SetClickUpService(nil)
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM clickup_installation WHERE workspace_id = $1`, testWorkspaceID)
		_, _ = testPool.Exec(context.Background(),
			`DELETE FROM issue WHERE workspace_id = $1 AND origin_type = 'clickup_import'`, testWorkspaceID)
	})

	w := httptest.NewRecorder()
	req := withURLParam(newRequest("POST", "/api/clickup/installation",
		map[string]string{"api_token": "pk_stub"}), "id", testWorkspaceID)
	testHandler.ConnectClickUp(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("connect: expected 201, got %d: %s", w.Code, w.Body.String())
	}
}

func createClickUpTestProject(t *testing.T) string {
	t.Helper()
	var projectID string
	err := testPool.QueryRow(context.Background(),
		`INSERT INTO project (workspace_id, title) VALUES ($1, 'ClickUp Test Project') RETURNING id`,
		testWorkspaceID).Scan(&projectID)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM project WHERE id = $1`, projectID)
	})
	return projectID
}

func TestClickUpUnconfigured(t *testing.T) {
	// GET installation renders configured:false (not an error).
	w := httptest.NewRecorder()
	testHandler.GetClickUpInstallation(w, withURLParam(newRequest("GET", "/api/clickup/installation", nil), "id", testWorkspaceID))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp ClickUpInstallationResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Configured {
		t.Fatal("expected configured=false when service is nil")
	}

	// Everything else 503s.
	w = httptest.NewRecorder()
	testHandler.ConnectClickUp(w, withURLParam(newRequest("POST", "/api/clickup/installation", map[string]string{"api_token": "x"}), "id", testWorkspaceID))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("connect unconfigured: expected 503, got %d", w.Code)
	}
}

func TestClickUpInvalidUUIDsReturn400(t *testing.T) {
	installClickUpForTest(t)

	w := httptest.NewRecorder()
	testHandler.DeleteClickUpLink(w, withURLParams(
		newRequest("DELETE", "/api/clickup/links/not-a-uuid", nil),
		"id", testWorkspaceID, "linkId", "not-a-uuid"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for malformed linkId, got %d: %s", w.Code, w.Body.String())
	}
}

func TestClickUpConnectListImportIdempotent(t *testing.T) {
	installClickUpForTest(t)
	projectID := createClickUpTestProject(t)

	// Installation reflects the stub team.
	w := httptest.NewRecorder()
	testHandler.GetClickUpInstallation(w, withURLParam(newRequest("GET", "/api/clickup/installation", nil), "id", testWorkspaceID))
	var inst ClickUpInstallationResponse
	_ = json.Unmarshal(w.Body.Bytes(), &inst)
	if !inst.Connected || inst.TeamName != "Stub Team" {
		t.Fatalf("unexpected installation: %+v", inst)
	}

	// Link project ↔ list1; status map seeds from the stub scheme.
	w = httptest.NewRecorder()
	testHandler.CreateClickUpLink(w, withURLParam(newRequest("POST", "/api/clickup/links",
		map[string]string{"project_id": projectID, "list_id": "list1", "list_name": "Stub List"}), "id", testWorkspaceID))
	if w.Code != http.StatusCreated {
		t.Fatalf("create link: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var link ClickUpLinkResponse
	_ = json.Unmarshal(w.Body.Bytes(), &link)

	var mapped string
	if err := testPool.QueryRow(context.Background(),
		`SELECT multica_status FROM clickup_status_map WHERE link_id = $1 AND clickup_status = 'in review'`,
		link.ID).Scan(&mapped); err != nil || mapped != "in_review" {
		t.Fatalf("status map seed: mapped=%q err=%v", mapped, err)
	}

	// First import creates 2 issues.
	w = httptest.NewRecorder()
	testHandler.ImportClickUpList(w, withURLParams(
		newRequest("POST", "/api/clickup/links/"+link.ID+"/import", map[string]bool{"include_closed": false}),
		"id", testWorkspaceID, "linkId", link.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("import: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var first clickup.ImportSummary
	_ = json.Unmarshal(w.Body.Bytes(), &first)
	if first.Created != 2 || first.Skipped != 0 || first.Failed != 0 {
		t.Fatalf("first import: %+v", first)
	}

	// Preview lists both tasks, flagging the imported ones.
	w = httptest.NewRecorder()
	testHandler.PreviewClickUpImport(w, withURLParams(
		newRequest("GET", "/api/clickup/links/"+link.ID+"/preview", nil),
		"id", testWorkspaceID, "linkId", link.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("preview: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var previews []clickup.TaskPreview
	_ = json.Unmarshal(w.Body.Bytes(), &previews)
	if len(previews) != 2 || !previews[0].AlreadyImported || !previews[1].AlreadyImported {
		t.Fatalf("preview after import: %+v", previews)
	}

	// Second import is fully idempotent.
	w = httptest.NewRecorder()
	testHandler.ImportClickUpList(w, withURLParams(
		newRequest("POST", "/api/clickup/links/"+link.ID+"/import", nil),
		"id", testWorkspaceID, "linkId", link.ID))
	var second clickup.ImportSummary
	_ = json.Unmarshal(w.Body.Bytes(), &second)
	if second.Created != 0 || second.Skipped != 2 {
		t.Fatalf("second import not idempotent: %+v", second)
	}

	// Imported issue carries origin stamping and the mapped status.
	var status, originType string
	if err := testPool.QueryRow(context.Background(),
		`SELECT i.status, i.origin_type FROM issue i
		 JOIN clickup_task_link tl ON tl.issue_id = i.id
		 WHERE tl.task_id = 'ct2'`).Scan(&status, &originType); err != nil {
		t.Fatalf("imported issue lookup: %v", err)
	}
	if status != "in_review" || originType != "clickup_import" {
		t.Fatalf("imported issue: status=%q origin=%q", status, originType)
	}
}

func TestClickUpPushCreate(t *testing.T) {
	installClickUpForTest(t)
	projectID := createClickUpTestProject(t)

	// Link the project first.
	w := httptest.NewRecorder()
	testHandler.CreateClickUpLink(w, withURLParam(newRequest("POST", "/api/clickup/links",
		map[string]string{"project_id": projectID, "list_id": "list1", "list_name": "Stub List"}), "id", testWorkspaceID))
	if w.Code != http.StatusCreated {
		t.Fatalf("create link: %d: %s", w.Code, w.Body.String())
	}

	// Create an issue in the linked project.
	var issueID string
	if err := testPool.QueryRow(context.Background(),
		`INSERT INTO issue (workspace_id, number, title, status, priority, creator_type, creator_id, project_id)
		 VALUES ($1, 999901, 'Push me', 'todo', 'medium', 'member', $2, $3) RETURNING id`,
		testWorkspaceID, testUserID, projectID).Scan(&issueID); err != nil {
		t.Fatalf("create issue: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM issue WHERE id = $1`, issueID)
	})

	w = httptest.NewRecorder()
	testHandler.PushIssueToClickUp(w, withURLParam(newRequest("POST", "/api/issues/"+issueID+"/clickup", nil), "id", issueID))
	if w.Code != http.StatusCreated {
		t.Fatalf("push: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var out map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["task_id"] != "pushed1" || out["task_url"] == "" {
		t.Fatalf("push response: %+v", out)
	}

	// Second push conflicts.
	w = httptest.NewRecorder()
	testHandler.PushIssueToClickUp(w, withURLParam(newRequest("POST", "/api/issues/"+issueID+"/clickup", nil), "id", issueID))
	if w.Code != http.StatusConflict {
		t.Fatalf("re-push: expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestSetClickUpKeyActivatesIntegration(t *testing.T) {
	t.Setenv("MULTICA_SECRETS_DIR", t.TempDir())
	t.Setenv("MULTICA_CLICKUP_SECRET_KEY", "")
	t.Cleanup(func() { testHandler.SetClickUpService(nil) })

	// Garbage key → 400, stays unconfigured.
	w := httptest.NewRecorder()
	testHandler.SetClickUpKey(w, newRequest("PUT", "/api/clickup/secret-key",
		map[string]string{"secret_key": "not-base64!!"}))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad key: expected 400, got %d: %s", w.Code, w.Body.String())
	}
	if testHandler.ClickUpService() != nil {
		t.Fatal("service must stay nil after invalid key")
	}

	// Valid 32-byte base64 key → 200, service hot-swapped in, file persisted.
	raw := make([]byte, secretbox.KeySize)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	b64 := base64.StdEncoding.EncodeToString(raw)
	w = httptest.NewRecorder()
	testHandler.SetClickUpKey(w, newRequest("PUT", "/api/clickup/secret-key",
		map[string]string{"secret_key": b64}))
	if w.Code != http.StatusOK {
		t.Fatalf("valid key: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	if testHandler.ClickUpService() == nil {
		t.Fatal("service must be live after activation")
	}
	if key, err := clickup.ResolveSecretKey(); err != nil || key == nil {
		t.Fatalf("key not persisted: key=%v err=%v", key, err)
	}

	// Second activation attempt → 409 (already configured).
	w = httptest.NewRecorder()
	testHandler.SetClickUpKey(w, newRequest("PUT", "/api/clickup/secret-key",
		map[string]string{"secret_key": b64}))
	if w.Code != http.StatusConflict {
		t.Fatalf("re-activate: expected 409, got %d", w.Code)
	}
}

func TestSetClickUpKeyRefusedWhenEnvManaged(t *testing.T) {
	t.Setenv("MULTICA_SECRETS_DIR", t.TempDir())
	t.Setenv("MULTICA_CLICKUP_SECRET_KEY", base64.StdEncoding.EncodeToString(make([]byte, secretbox.KeySize)))
	t.Cleanup(func() { testHandler.SetClickUpService(nil) })

	raw := make([]byte, secretbox.KeySize)
	if _, err := rand.Read(raw); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	testHandler.SetClickUpKey(w, newRequest("PUT", "/api/clickup/secret-key",
		map[string]string{"secret_key": base64.StdEncoding.EncodeToString(raw)}))
	if w.Code != http.StatusConflict {
		t.Fatalf("env-managed: expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestClickUpSelectiveImport(t *testing.T) {
	installClickUpForTest(t)
	projectID := createClickUpTestProject(t)

	w := httptest.NewRecorder()
	testHandler.CreateClickUpLink(w, withURLParam(newRequest("POST", "/api/clickup/links",
		map[string]string{"project_id": projectID, "list_id": "list1", "list_name": "Stub List"}), "id", testWorkspaceID))
	if w.Code != http.StatusCreated {
		t.Fatalf("create link: %d: %s", w.Code, w.Body.String())
	}
	var link ClickUpLinkResponse
	_ = json.Unmarshal(w.Body.Bytes(), &link)

	// Import only ct2 — ct1 must not be counted or created.
	w = httptest.NewRecorder()
	testHandler.ImportClickUpList(w, withURLParams(
		newRequest("POST", "/api/clickup/links/"+link.ID+"/import",
			map[string]any{"include_closed": false, "task_ids": []string{"ct2"}}),
		"id", testWorkspaceID, "linkId", link.ID))
	if w.Code != http.StatusOK {
		t.Fatalf("selective import: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var summary clickup.ImportSummary
	_ = json.Unmarshal(w.Body.Bytes(), &summary)
	if summary.Created != 1 || summary.Skipped != 0 {
		t.Fatalf("selective import summary: %+v", summary)
	}

	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM clickup_task_link WHERE task_id = 'ct1'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("unselected task imported: n=%d err=%v", n, err)
	}
}
