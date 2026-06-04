// ClickUp integration (Phase 1) — docs/clickup-integration-rfc.md.
// All server-driven strings stay `string` so enum drift degrades
// instead of crashing (API Response Compatibility, CLAUDE.md).

export interface ClickUpInstallation {
  configured: boolean;
  connected: boolean;
  team_id?: string;
  team_name?: string;
  connected_by?: string | null;
  created_at?: string;
}

export interface ClickUpLink {
  id: string;
  project_id: string;
  list_id: string;
  list_name: string;
  sync_enabled: boolean;
  last_error: string;
  created_at: string;
}

export interface ClickUpList {
  id: string;
  name: string;
}

export interface ClickUpFolder {
  id: string;
  name: string;
  lists?: ClickUpList[];
}

export interface ClickUpSpaceTree {
  space: { id: string; name: string };
  folders?: ClickUpFolder[];
  lists?: ClickUpList[];
}

export interface ClickUpImportSummary {
  created: number;
  skipped: number;
  failed: number;
}

export interface ClickUpTaskLink {
  task_id: string;
  task_url: string;
}

export interface CreateClickUpLinkRequest {
  project_id: string;
  list_id: string;
  list_name: string;
}
