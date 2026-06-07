#!/usr/bin/env bash
# Decommission the Colima VM on the OLD machine after migrating.
# DESTRUCTIVE: deletes the entire VM — all containers, volumes (Postgres,
# MinIO, uploads), and images. Run ONLY after restore.sh has been verified
# working on the new machine.
#
#   ./clear-colima.sh            # guarded run (checks for a recent bundle)
#   ./clear-colima.sh --force    # skip the recent-bundle check
set -euo pipefail

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v colima >/dev/null || die "colima not installed — nothing to clear"

# --- Safety gate 1: a migration bundle must exist and be recent --------------
if [ "${1:-}" != "--force" ]; then
  any_bundle="$(find "$HOME/Documents" -maxdepth 1 -name 'multica-migration-*.tar.gz' 2>/dev/null | head -1)"
  [ -n "$any_bundle" ] || die "no migration bundle found in ~/Documents — run backup.sh first (or use --force)"
  bundle="$(find "$HOME/Documents" -maxdepth 1 -name 'multica-migration-*.tar.gz' -mtime -7 2>/dev/null | sort | tail -1)"
  [ -n "$bundle" ] || die "newest bundle is older than 7 days: $any_bundle
Run backup.sh for fresh data before wiping (or use --force)"
  echo "found recent bundle: $bundle"
  warn "make sure this bundle has been transferred AND restore.sh verified on the new machine"
fi

# --- Safety gate 2: show what dies, require typed confirmation ---------------
step "This will permanently delete:"
if colima status >/dev/null 2>&1; then
  docker ps -a --format '  container: {{.Names}} ({{.Status}})' 2>/dev/null || true
  docker volume ls --format '  volume:    {{.Name}}' 2>/dev/null || true
else
  echo "  (colima not running — the whole VM disk, including all volumes above)"
fi
echo "  VM disk:   ~/.colima"
printf '\nType "wipe" to continue: '
read -r answer
[ "$answer" = "wipe" ] || die "aborted"

# --- Wipe ---------------------------------------------------------------------
step "Stopping Colima"
colima stop 2>/dev/null || true

step "Deleting the VM (containers, volumes, images, disk)"
colima delete --force

step "Removing leftover Colima state"
rm -rf "$HOME/.colima"

step "Done"
cat <<'EOF'

Colima VM wiped. Optional final cleanup:
  brew uninstall colima docker docker-compose   # if retiring this machine
  rm -rf ~/.multica                              # daemon config (already in the bundle)
  rm -rf ~/multica-selfhost ~/multica-gemini-pr  # repo checkouts (already on the fork)

Keep ~/Documents/multica-migration-*.tar.gz until the new machine has run
for a few days without issues.
EOF
