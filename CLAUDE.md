@AGENTS.md

> **RTK is active in this project.** Always prefix shell commands with `rtk` (e.g. `rtk multica issue list`, `rtk pnpm test`, `rtk gh pr view`, `rtk acli jira workitem view`). Full reference at the bottom of this file.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:
```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (60-99% savings)
```bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)
```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)
```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)
```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)
```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)
```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)
```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Multica CLI (token-optimized)
Always use `rtk multica` — never bare `multica`. Works for all subcommands.

```bash
# Issues
rtk multica issue list                                      # Compact issue list
rtk multica issue list --status in_progress                 # Filter by status
rtk multica issue list --priority urgent --output json      # JSON output, filtered
rtk multica issue get <id>                                  # Issue detail
rtk multica issue get <id> --output json                    # JSON detail
rtk multica issue create --title "..." --priority high      # Create issue
rtk multica issue update <id> --title "..." --priority urgent
rtk multica issue assign <id> --to "AgentName"
rtk multica issue status <id> in_progress

# Comments
rtk multica issue comment list <issue-id>
rtk multica issue comment add <issue-id> --content "..."
rtk multica issue comment add <issue-id> --parent <comment-id> --content "..."
rtk multica issue comment delete <comment-id>

# Agent runs
rtk multica issue runs <issue-id>                           # List runs for issue
rtk multica issue runs <issue-id> --output json
rtk multica issue run-messages <task-id>                    # Stream task messages
rtk multica issue run-messages <task-id> --since 42 --output json

# Workspace
rtk multica workspace list
rtk multica workspace get <workspace-id> --output json
rtk multica workspace members <workspace-id>
rtk multica workspace watch <workspace-id>

# Agents & Daemon
rtk multica agent list
rtk multica daemon status
rtk multica daemon status --output json
rtk multica daemon logs                                     # Last 50 lines
rtk multica daemon logs -n 100

# Auth & Config
rtk multica auth status
rtk multica config local
```

### Atlassian CLI — acli
```bash
rtk acli jira workitem view <KEY>                          # Compact issue view
rtk acli jira workitem view <KEY> --output json
rtk acli jira workitem create --from-json /tmp/issue.json
rtk acli jira workitem edit --from-json /tmp/edit.json --yes
rtk acli jira workitem comment list --key <KEY>
rtk acli confluence page view <PAGE-ID>
```

### PostgreSQL — psql
```bash
rtk psql -U <user> -d <db> -c "SELECT ..."   # Compact query output
rtk psql -U <user> -d <db> -f migration.sql  # Migration output
```

### Meta Commands
```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
