package handler

// Fork-owned tables (Knowledge Space, ClickUp integration, Meetings). All of
// them reference workspace(id) ON DELETE CASCADE, so workspace teardown owns
// them through the FK. Registered from a separate file so upstream syncs of
// workspace_delete_manifest_test.go stay conflict-free.
func init() {
	for _, table := range []string{
		"clickup_installation",
		"clickup_list_link",
		"clickup_status_map",
		"clickup_sync_audit",
		"clickup_task_link",
		"meeting",
		"meeting_message",
		"meeting_participant",
		"meeting_turn",
		"workspace_knowledge",
	} {
		workspaceDeletionManifest[table] = workspaceDelete
	}
}
