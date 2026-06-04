# ADR: ClickUp Integration — Issue Import & Sync

> Status: Proposed
> Date: 2026-06-04
> Decision owners: Vignesh
> Companion design: [clickup-integration-rfc.md](./clickup-integration-rfc.md)

## Context

Multica is the system of record for agent-driven work, but planning often happens
in ClickUp (external teams, clients, existing boards). We want to:

1. **Import** ClickUp tasks into Multica as issues (so agents can be assigned to them),
2. **Create** ClickUp tasks from Multica issues (so external stakeholders see progress
   in their tool), and
3. keep linked pairs **in sync** without manual copying.

Two integrations already establish the house pattern:

- **Lark** (`server/internal/integrations/lark/`) — opt-in via a single env key, AES-256-GCM
  (`util/secretbox`) for credentials at rest, dedicated mapping tables with composite FKs,
  per-installation dedup, non-content audit log.
- **GitHub** (`handler/github.go`, migration 079) — signed public webhook ingress
  (`POST /api/webhooks/github`, HMAC-SHA256), mirror table + link table
  (`github_pull_request`, `issue_pull_request`), settings tab with member-visible
  listing and admin-gated management.

Self-host constraint: a Multica instance is **not guaranteed to be publicly reachable**.
Lark solved inbound events with an outbound WebSocket; ClickUp offers no outbound
channel — its webhooks require a public HTTPS endpoint.

## Decision drivers

- **D1** Self-host first: must work on a laptop behind NAT with zero public ingress.
- **D2** Opt-in and inert: zero cost / zero attack surface when not configured (Lark precedent).
- **D3** No echo loops: a change synced *into* ClickUp must not bounce back as an inbound change.
- **D4** Credentials encrypted at rest; never exposed via API responses (Lark precedent).
- **D5** Schema additivity: dedicated tables, no generic "external_ref" column on `issue`
  (house pattern: `issue_pull_request`, `lark_chat_session_binding`).
- **D6** Fork-maintenance cost: we rebase on upstream weekly; surface area inside upstream-owned
  files must stay minimal (new files >> edits to shared files).

## Options considered

### A. Authentication

| Option | Notes | Verdict |
|---|---|---|
| **A1. Personal API token** (`pk_…`) per workspace | One field to paste; works for any ClickUp plan; no app registration; rate limit 100 req/min/token | ✅ **Chosen** (Phase 1) |
| A2. OAuth2 app | Better for multi-user attribution; requires registering a ClickUp app + public redirect URL — clashes with D1 | Deferred (Phase 3+, cloud) |

### B. Inbound change detection

| Option | Notes | Verdict |
|---|---|---|
| B1. Webhooks only | ClickUp signs with HMAC-SHA256 (`X-Signature`); but requires public HTTPS — fails D1 | Rejected as sole mechanism |
| B2. Polling only | `GET /list/{id}/task?date_updated_gt=<cursor>`; works everywhere; worst-case staleness = poll interval | Acceptable, but wasteful when ingress exists |
| **B3. Polling baseline + optional webhooks** | Poll by default; if `MULTICA_PUBLIC_URL` is set, also register a signed webhook for near-real-time; webhook events only *advance* the same cursor pipeline (single code path) | ✅ **Chosen** |

### C. Sync topology

| Option | Notes | Verdict |
|---|---|---|
| C1. Workspace ↔ ClickUp Team (everything) | Too coarse; ClickUp statuses are **per-List**, mapping explodes | Rejected |
| **C2. Multica Project ↔ ClickUp List** | One link per pair; statuses map per-List (matches ClickUp's model); import/create scoped naturally | ✅ **Chosen** |
| C3. Per-issue ad-hoc links only | No import surface; sync rules ambiguous | Rejected (kept as a *capability* within C2: a linked pair is always issue ↔ task) |

### D. Conflict & loop policy

| Option | Notes | Verdict |
|---|---|---|
| **D1. Last-writer-wins by `date_updated`, echo-suppression via origin fence** | Each outbound write records the resulting `task.date_updated` (and our webhook dedup ignores deliveries whose `history_items` actor is our own token); inbound applies only if newer than `last_synced_at` | ✅ **Chosen** |
| D2. Field-level merge | Engineering cost >> value for v1 | Rejected |
| D3. One-way only (import) | Fails the "create in ClickUp" requirement | Rejected |

### E. Status mapping

| Option | Notes | Verdict |
|---|---|---|
| **E1. Per-link mapping table with heuristic defaults** | ClickUp statuses are arbitrary per-List strings with a `type` (`open`/`custom`/`closed`/`done`); default map by type + name heuristics; admin can edit per link | ✅ **Chosen** |
| E2. Hardcoded global map | Breaks on any custom ClickUp board | Rejected |

## Decision

Build a **ClickUp integration gated by `MULTICA_CLICKUP_SECRET_KEY`** (encryption key,
Lark pattern), authenticating with a **per-workspace personal API token** stored
AES-256-GCM-encrypted. Sync is scoped to **Project ↔ List links**. Change detection is
**cursor polling** (default 60s) with **optional signed webhooks** when the instance is
public — both feed one ingest pipeline. Conflicts resolve **last-writer-wins** with an
**origin fence** to prevent echo loops. Statuses map through a **per-link mapping table**
seeded by heuristics.

Phasing (detail in RFC):

- **Phase 1 — Import & push-create.** Connect workspace, link project↔list, bulk import,
  "Create in ClickUp" on an issue. No continuous sync.
- **Phase 2 — Continuous sync.** Poller + cursor pipeline; title/description/status/assignee
  hints; comment mirroring (best-effort, one-way Multica→ClickUp note).
- **Phase 3 — Webhooks + OAuth.** Near-real-time inbound when public; OAuth app for cloud.

## Consequences

**Positive**
- Inert when unconfigured: no goroutines, handlers 503 (D2 ✓).
- Works behind NAT from day one (D1 ✓); webhooks are an optimization, not a dependency.
- One ingest path (poll/webhook both advance the cursor) keeps the dedup/fence logic single-sourced (D3 ✓).
- All new code in `server/internal/integrations/clickup/` + new migrations → minimal rebase friction (D6 ✓).

**Negative / accepted risks**
- Polling: worst-case 60s staleness and rate-limit budget consumed per linked list
  (~2 req/min/list; 100 req/min cap ⇒ practical ceiling ~25 active links, fine for 2-10 person teams).
- LWW can drop a concurrent edit on the losing side (visible in the issue activity log; acceptable for v1).
- Personal token = one identity for all outbound writes; ClickUp-side attribution shows the
  token owner, not the individual member (OAuth fixes this in Phase 3).
- ClickUp custom fields are not synced in any phase of this ADR (explicit non-goal; revisit on demand).

## Compliance checklist (house rules)

- [ ] Token encrypted via `util/secretbox`, never in API responses (mirrors `app_secret_encrypted`)
- [ ] All boundary UUIDs through `parseUUIDOrBadRequest` (post-#1661 convention)
- [ ] Webhook handler verifies HMAC before parsing body; 256 KiB body cap (autopilot precedent)
- [ ] Frontend consumes responses via zod + `parseWithFallback`; status strings stay `z.string()`
- [ ] New routes member-visible for reads, owner/admin for writes (Lark/GitHub precedent)
- [ ] Migrations numbered ≥115, idempotent where possible
