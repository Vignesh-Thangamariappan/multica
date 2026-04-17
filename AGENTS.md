# Repository Guidelines

This file provides guidance to AI agents when working with code in this repository.

<!-- rtk-instructions v2 -->
## RTK (Token Efficiency) — Golden Rule

**Always prefix shell commands with `rtk`** (e.g. `rtk multica issue list`, `rtk pnpm test`, `rtk gh pr view`, `rtk go test ./...`). RTK filters verbose output to only what matters, saving 50–99% of tokens. If RTK has no filter for a command it passes it through unchanged — so `rtk` is always safe.

**Even in `&&` chains, every command gets `rtk`:**
```bash
# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
# ❌ Wrong
git add . && git commit -m "msg" && git push
```

Key savings by category:

| Category | Commands | Savings |
| --- | --- | --- |
| Multica CLI | `rtk multica ...` | 60-80% |
| Tests | `rtk vitest`, `rtk go test`, `rtk playwright test` | 90-99% |
| Build | `rtk tsc`, `rtk pnpm build`, `rtk next build` | 70-87% |
| Git | `rtk git status/log/diff/add/commit/push` | 59-80% |
| GitHub | `rtk gh pr view`, `rtk gh run list` | 26-87% |
| Files | `rtk ls`, `rtk grep`, `rtk find`, `rtk cat` | 60-75% |
<!-- /rtk-instructions -->

> **Single source of truth:** This file is a concise pointer document.
> All authoritative architecture, coding rules, commands, and conventions
> live in **CLAUDE.md** at the project root. Read that file first.

## Project Context

## Quick Reference

### Architecture

Go backend + monorepo frontend (pnpm workspaces + Turborepo) with shared packages.

- `server/` — Go backend (Chi router, sqlc, gorilla/websocket)
- `apps/web/` — Next.js frontend (App Router)
- `apps/desktop/` — Electron desktop app
- `packages/core/` — Headless business logic (Zustand stores, React Query hooks, API client)
- `packages/ui/` — Atomic UI components (shadcn/Base UI, zero business logic)
- `packages/views/` — Shared business pages/components
- `packages/tsconfig/` — Shared TypeScript config

### State Management (critical)

- **React Query** owns all server state (issues, members, agents, inbox, workspace list)
- **Zustand** owns all client state (current workspace selection, view filters, drafts, modals)
- All Zustand stores live in `packages/core/` — never in `packages/views/` or app directories
- WS events invalidate React Query — never write directly to stores

### Package Boundaries (hard rules)

- `packages/core/` — zero react-dom, zero localStorage, zero process.env
- `packages/ui/` — zero `@multica/core` imports
- `packages/views/` — zero `next/*`, zero `react-router-dom`, use `NavigationAdapter` for routing
- `apps/web/platform/` — only place for Next.js APIs

### Commands

```bash
make dev              # Auto-setup + start everything
pnpm typecheck        # TypeScript check
pnpm test             # TS unit tests (Vitest)
make test             # Go tests
make check            # Full verification pipeline
```

See CLAUDE.md for the complete command reference.
