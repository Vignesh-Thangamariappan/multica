package clickup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/service"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// ErrNotConnected signals no ClickUp installation exists for the workspace.
var ErrNotConnected = errors.New("clickup: workspace not connected")

// ErrTokenInvalid signals the personal token failed validation at connect.
var ErrTokenInvalid = errors.New("clickup: token rejected by ClickUp")

// ErrProjectNotLinked signals push-create on an issue whose project has no
// list link.
var ErrProjectNotLinked = errors.New("clickup: issue's project is not linked to a ClickUp list")

// ErrAlreadyLinked signals push-create on an issue that already has a task.
var ErrAlreadyLinked = errors.New("clickup: issue already linked to a ClickUp task")

// Service owns ClickUp Phase 1 operations. Constructed only when
// MULTICA_CLICKUP_SECRET_KEY loads (router); nil Service ⇒ handlers 503.
type Service struct {
	queries  *db.Queries
	box      *secretbox.Box
	issueSvc *service.IssueService
	logger   *slog.Logger
	// baseURL overrides the ClickUp API endpoint in tests.
	baseURL string
}

// NewService wires the Phase 1 service.
func NewService(q *db.Queries, box *secretbox.Box, issueSvc *service.IssueService, logger *slog.Logger) *Service {
	return &Service{queries: q, box: box, issueSvc: issueSvc, logger: logger}
}

// NewServiceForTest is NewService with the ClickUp API base URL pointed
// at a test server. Test-only; production callers use NewService.
func NewServiceForTest(q *db.Queries, box *secretbox.Box, issueSvc *service.IssueService, logger *slog.Logger, baseURL string) *Service {
	return &Service{queries: q, box: box, issueSvc: issueSvc, logger: logger, baseURL: baseURL}
}

// clientFor decrypts the workspace token and builds a client.
func (s *Service) clientFor(ctx context.Context, workspaceID pgtype.UUID) (*Client, db.ClickupInstallation, error) {
	inst, err := s.queries.GetClickUpInstallationByWorkspace(ctx, workspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, db.ClickupInstallation{}, ErrNotConnected
		}
		return nil, db.ClickupInstallation{}, err
	}
	token, err := s.box.Open(inst.ApiTokenEncrypted)
	if err != nil {
		return nil, db.ClickupInstallation{}, fmt.Errorf("clickup: decrypt token: %w", err)
	}
	return NewClient(string(token), s.baseURL), inst, nil
}

// Connect validates the personal token against ClickUp and stores it
// encrypted. One installation per workspace; reconnecting replaces it.
func (s *Service) Connect(ctx context.Context, workspaceID, connectedBy pgtype.UUID, token string) (db.ClickupInstallation, error) {
	teams, err := NewClient(token, s.baseURL).GetAuthorizedTeams(ctx)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && (apiErr.Status == 401 || apiErr.Status == 403) {
			return db.ClickupInstallation{}, ErrTokenInvalid
		}
		return db.ClickupInstallation{}, err
	}
	if len(teams) == 0 {
		return db.ClickupInstallation{}, ErrTokenInvalid
	}
	// Personal tokens are team-scoped in practice; take the first team.
	team := teams[0]

	sealed, err := s.box.Seal([]byte(token))
	if err != nil {
		return db.ClickupInstallation{}, fmt.Errorf("clickup: seal token: %w", err)
	}
	// Replace any existing installation (reconnect flow).
	if _, err := s.queries.DeleteClickUpInstallation(ctx, workspaceID); err != nil {
		return db.ClickupInstallation{}, err
	}
	return s.queries.CreateClickUpInstallation(ctx, db.CreateClickUpInstallationParams{
		WorkspaceID:       workspaceID,
		TeamID:            team.ID,
		TeamName:          team.Name,
		ApiTokenEncrypted: sealed,
		ConnectedBy:       connectedBy,
	})
}

// Disconnect removes the installation; links cascade.
func (s *Service) Disconnect(ctx context.Context, workspaceID pgtype.UUID) (bool, error) {
	n, err := s.queries.DeleteClickUpInstallation(ctx, workspaceID)
	return n > 0, err
}

// Installation returns the workspace's installation (no token material).
func (s *Service) Installation(ctx context.Context, workspaceID pgtype.UUID) (db.ClickupInstallation, error) {
	inst, err := s.queries.GetClickUpInstallationByWorkspace(ctx, workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.ClickupInstallation{}, ErrNotConnected
	}
	return inst, err
}

// SpaceTree is the discovery payload for the link picker.
type SpaceTree struct {
	Space   Space    `json:"space"`
	Folders []Folder `json:"folders"`
	Lists   []List   `json:"lists"` // folderless
}

// DiscoverLists walks team → spaces → folders/lists for the picker.
func (s *Service) DiscoverLists(ctx context.Context, workspaceID pgtype.UUID) ([]SpaceTree, error) {
	client, inst, err := s.clientFor(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	spaces, err := client.GetSpaces(ctx, inst.TeamID)
	if err != nil {
		return nil, err
	}
	tree := make([]SpaceTree, 0, len(spaces))
	for _, sp := range spaces {
		folders, err := client.GetFolders(ctx, sp.ID)
		if err != nil {
			return nil, err
		}
		lists, err := client.GetFolderlessLists(ctx, sp.ID)
		if err != nil {
			return nil, err
		}
		tree = append(tree, SpaceTree{Space: sp, Folders: folders, Lists: lists})
	}
	return tree, nil
}

// CreateLink links a project to a list and seeds the status map from the
// list's status scheme via the DefaultMulticaStatus heuristics. listName
// comes from the picker payload (the client just displayed it) — saves a
// second GET /list round-trip.
func (s *Service) CreateLink(ctx context.Context, workspaceID, projectID pgtype.UUID, listID, listName string) (db.ClickupListLink, error) {
	client, inst, err := s.clientFor(ctx, workspaceID)
	if err != nil {
		return db.ClickupListLink{}, err
	}
	statuses, err := client.GetListStatuses(ctx, listID)
	if err != nil {
		return db.ClickupListLink{}, err
	}

	link, err := s.queries.CreateClickUpListLink(ctx, db.CreateClickUpListLinkParams{
		InstallationID: inst.ID,
		WorkspaceID:    workspaceID,
		ProjectID:      projectID,
		ListID:         listID,
		ListName:       listName,
	})
	if err != nil {
		return db.ClickupListLink{}, err
	}
	for _, st := range statuses {
		if err := s.queries.UpsertClickUpStatusMap(ctx, db.UpsertClickUpStatusMapParams{
			LinkID:        link.ID,
			ClickupStatus: normalizeStatus(st.Status),
			MulticaStatus: DefaultMulticaStatus(st),
		}); err != nil {
			return db.ClickupListLink{}, err
		}
	}
	return link, nil
}

// ImportSummary reports a bulk import run.
type ImportSummary struct {
	Created int `json:"created"`
	Skipped int `json:"skipped"`
	Failed  int `json:"failed"`
}

// ImportList pulls a linked list's tasks and creates Multica issues.
// Idempotent: tasks already linked (link_id, task_id) are skipped, so
// re-running an import never duplicates issues. Open-only by default
// (RFC open question #2); includeClosed opts into closed tasks.
func (s *Service) ImportList(ctx context.Context, link db.ClickupListLink, actorID pgtype.UUID, includeClosed bool) (ImportSummary, error) {
	client, _, err := s.clientFor(ctx, link.WorkspaceID)
	if err != nil {
		return ImportSummary{}, err
	}
	statusMap, err := s.statusMapFor(ctx, link.ID)
	if err != nil {
		return ImportSummary{}, err
	}

	var summary ImportSummary
	for page := 0; ; page++ {
		tasks, lastPage, err := client.GetTasksPage(ctx, link.ListID, page, includeClosed)
		if err != nil {
			return summary, err
		}
		for _, task := range tasks {
			switch err := s.importTask(ctx, link, task, statusMap, actorID); {
			case err == nil:
				summary.Created++
			case errors.Is(err, errAlreadyImported):
				summary.Skipped++
			default:
				summary.Failed++
				s.logger.Warn("clickup import: task failed", "task_id", task.ID, "error", err)
				s.audit(ctx, link.ID, "inbound", task.ID, pgtype.UUID{}, "error", err.Error())
			}
		}
		if lastPage || len(tasks) == 0 {
			break
		}
	}
	return summary, nil
}

var errAlreadyImported = errors.New("clickup: task already imported")

func (s *Service) importTask(ctx context.Context, link db.ClickupListLink, task Task, statusMap map[string]string, actorID pgtype.UUID) error {
	if _, err := s.queries.GetClickUpTaskLinkByTask(ctx, db.GetClickUpTaskLinkByTaskParams{
		LinkID: link.ID,
		TaskID: task.ID,
	}); err == nil {
		return errAlreadyImported
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	status := statusMap[normalizeStatus(task.Status.Status)]
	if status == "" {
		status = DefaultMulticaStatus(task.Status)
	}

	res, err := s.issueSvc.Create(ctx, service.IssueCreateParams{
		WorkspaceID:    link.WorkspaceID,
		Title:          task.Name,
		Description:    pgtype.Text{String: task.Description, Valid: task.Description != ""},
		Status:         status,
		Priority:       "medium",
		CreatorType:    "member",
		CreatorID:      actorID,
		ProjectID:      link.ProjectID,
		DueDate:        dueDateFromMs(task.DueDate),
		OriginType:     pgtype.Text{String: "clickup_import", Valid: true},
		OriginID:       link.ID,
		AllowDuplicate: true, // re-imported boards may legitimately repeat titles
	}, service.IssueCreateOpts{Platform: "clickup"})
	if err != nil {
		return err
	}

	if _, err := s.queries.CreateClickUpTaskLink(ctx, db.CreateClickUpTaskLinkParams{
		IssueID:       res.Issue.ID,
		LinkID:        link.ID,
		TaskID:        task.ID,
		TaskUrl:       task.URL,
		CreatedByType: "import",
		CreatedByID:   actorID,
	}); err != nil {
		return err
	}
	s.audit(ctx, link.ID, "inbound", task.ID, res.Issue.ID, "created", "")
	return nil
}

// PushCreate creates a ClickUp task from an issue in its project's linked
// list and records the pair. createdByType is "member" or "agent".
func (s *Service) PushCreate(ctx context.Context, workspaceID pgtype.UUID, issue db.Issue, createdByType string, createdByID pgtype.UUID) (db.ClickupTaskLink, error) {
	if _, err := s.queries.GetClickUpTaskLinkByIssue(ctx, issue.ID); err == nil {
		return db.ClickupTaskLink{}, ErrAlreadyLinked
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return db.ClickupTaskLink{}, err
	}
	if !issue.ProjectID.Valid {
		return db.ClickupTaskLink{}, ErrProjectNotLinked
	}
	link, err := s.queries.GetClickUpListLinkByProject(ctx, db.GetClickUpListLinkByProjectParams{
		ProjectID:   issue.ProjectID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return db.ClickupTaskLink{}, ErrProjectNotLinked
		}
		return db.ClickupTaskLink{}, err
	}

	client, _, err := s.clientFor(ctx, workspaceID)
	if err != nil {
		return db.ClickupTaskLink{}, err
	}
	params := CreateTaskParams{Name: issue.Title}
	if issue.Description.Valid {
		params.Description = issue.Description.String
	}
	if issue.DueDate.Valid {
		params.DueDate = issue.DueDate.Time.UnixMilli()
	}
	task, err := client.CreateTask(ctx, link.ListID, params)
	if err != nil {
		return db.ClickupTaskLink{}, err
	}

	taskLink, err := s.queries.CreateClickUpTaskLink(ctx, db.CreateClickUpTaskLinkParams{
		IssueID:       issue.ID,
		LinkID:        link.ID,
		TaskID:        task.ID,
		TaskUrl:       task.URL,
		CreatedByType: createdByType,
		CreatedByID:   createdByID,
	})
	if err != nil {
		return db.ClickupTaskLink{}, err
	}
	s.audit(ctx, link.ID, "outbound", task.ID, issue.ID, "created", "")
	return taskLink, nil
}

func (s *Service) statusMapFor(ctx context.Context, linkID pgtype.UUID) (map[string]string, error) {
	rows, err := s.queries.ListClickUpStatusMap(ctx, linkID)
	if err != nil {
		return nil, err
	}
	m := make(map[string]string, len(rows))
	for _, r := range rows {
		m[r.ClickupStatus] = r.MulticaStatus
	}
	return m, nil
}

func (s *Service) audit(ctx context.Context, linkID pgtype.UUID, direction, taskID string, issueID pgtype.UUID, action, detail string) {
	if err := s.queries.CreateClickUpSyncAudit(ctx, db.CreateClickUpSyncAuditParams{
		LinkID:    linkID,
		Direction: direction,
		TaskID:    taskID,
		IssueID:   issueID,
		Action:    action,
		Detail:    detail,
	}); err != nil {
		s.logger.Warn("clickup: audit write failed", "error", err)
	}
}

func normalizeStatus(s string) string {
	// ClickUp status strings are case-preserved; the map is keyed lowercase.
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		out = append(out, r)
	}
	return string(out)
}

func dueDateFromMs(ms *string) pgtype.Date {
	if ms == nil {
		return pgtype.Date{}
	}
	n, err := strconv.ParseInt(*ms, 10, 64)
	if err != nil || n <= 0 {
		return pgtype.Date{}
	}
	return pgtype.Date{Time: time.UnixMilli(n).UTC(), Valid: true}
}
