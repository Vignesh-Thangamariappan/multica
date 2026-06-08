#!/usr/bin/env bash
# Ensure the local MinIO object-storage container is running.
#
# Avatar/attachment URLs created under the MinIO storage backend are stored
# as absolute http://localhost:9000/... links. If MinIO isn't running those
# images 404 even though the bytes are sitting in the multica_miniodata volume.
# `make dev` / dev-desktop only start Postgres, so without this the desktop app
# shows broken avatars on any setup that has MinIO-era objects.
#
# This is best-effort: object storage is not required for the app to boot, so a
# failure here warns but does not abort the caller (set -e is intentionally not
# inherited via a hard exit).
set -uo pipefail

# No-op when the compose project doesn't define a minio service (e.g. a setup
# that only ever used local-disk or remote S3 storage).
if ! docker compose config --services 2>/dev/null | grep -qx minio; then
  exit 0
fi

if curl -fsS "http://localhost:9000/minio/health/live" >/dev/null 2>&1; then
  echo "✓ MinIO already running on localhost:9000."
  exit 0
fi

echo "==> Ensuring MinIO object storage is running on localhost:9000..."
if ! docker compose up -d minio; then
  echo "  ! Warning: failed to start MinIO. Avatars/attachments served from"
  echo "    MinIO may not load. Start it manually with: docker compose up -d minio"
  exit 0
fi

echo "==> Waiting for MinIO to be ready..."
for _ in {1..30}; do
  if curl -fsS "http://localhost:9000/minio/health/live" >/dev/null 2>&1; then
    echo "✓ MinIO ready (local Docker) on localhost:9000."
    exit 0
  fi
  sleep 1
done

echo "  ! Warning: MinIO did not become ready in time; continuing anyway."
exit 0
