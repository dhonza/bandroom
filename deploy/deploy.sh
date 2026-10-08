#!/usr/bin/env bash
# Pull, back up the database, restart and verify the stack (SPEC §19.3, §19.4).
# Run by the owner ON THE SERVER, in the application directory (e.g. sudo /opt/bandroom/deploy.sh).
#
# Before restarting, the app and worker are stopped and data/bandroom.sqlite is copied to
#   $BANDROOM_BACKUP_DIR (default: ../bandroom-backup next to the application directory)
# as bandroom-before-<new version>-from-<old version>-<UTC time>.sqlite. An existing file is
# never overwritten, and the script stops if the copy cannot be verified.
# Environment: BANDROOM_BACKUP_DIR=<dir> to change the location, BANDROOM_SKIP_BACKUP=1 to skip it.
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd -P)"
DB="$APP_DIR/data/bandroom.sqlite"
BACKUP_DIR="$(realpath -m "${BANDROOM_BACKUP_DIR:-$APP_DIR/../bandroom-backup}")"

say() { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# APP_VERSION baked into an image (release builds set it to the tag, e.g. v0.4.0).
version_of_image() {
  local v
  v="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null |
    sed -n 's/^APP_VERSION=//p' | head -n 1)"
  if [ -z "$v" ]; then
    v="$(docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | sed 's/^sha256://' | cut -c1-12)"
  fi
  printf '%s' "${v:-unknown}"
}

say "BandRoom deploy in $APP_DIR"

old_container="$(docker compose ps -q app 2>/dev/null || true)"
if [ -n "$old_container" ]; then
  old_version="$(version_of_image "$(docker inspect -f '{{.Image}}' "$old_container")")"
else
  old_version="none"
fi
info "Running now: $old_version"

say "Pulling images"
docker compose pull
new_image="$(docker compose config --images app | head -n 1)"
new_version="$(version_of_image "$new_image")"
info "Pulled: $new_image = $new_version"
tag_line="$(grep -E '^BANDROOM_TAG=' .env 2>/dev/null | tail -n 1 || true)"
if [ -n "$tag_line" ]; then
  info "Image tag from .env: $tag_line (edit .env to deploy another version)"
else
  info "Image tag: latest (no BANDROOM_TAG in .env)"
fi
if [ "$new_version" = "$old_version" ]; then
  say "WARNING: the pulled version equals the running one ($new_version); restarting it unchanged."
  info "To update, set BANDROOM_TAG in .env to the new tag (e.g. v1.2.3) or remove the line for latest."
fi

backup=""
if [ "${BANDROOM_SKIP_BACKUP:-0}" = "1" ]; then
  say "Database backup SKIPPED (BANDROOM_SKIP_BACKUP=1)"
elif [ ! -e "$DB" ]; then
  say "No database at $DB yet (first start): nothing to back up"
else
  if [ ! -r "$DB" ]; then
    echo "Cannot read $DB: run this script with sudo." >&2
    exit 1
  fi
  say "Backing up the database before updating $old_version -> $new_version"
  info "Stopping app and worker so the database file is complete"
  docker compose stop app worker
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  backup="$BACKUP_DIR/bandroom-before-$new_version-from-$old_version-$(date -u +%Y%m%d-%H%M%S).sqlite"
  if [ -e "$backup" ]; then
    echo "Backup file already exists, not overwriting: $backup" >&2
    exit 1
  fi
  cp -a "$DB" "$backup"
  for ext in wal shm; do
    if [ -s "$DB-$ext" ]; then
      cp -a "$DB-$ext" "$backup-$ext"
      info "Also copied $DB-$ext (the database was not checkpointed)"
    fi
  done
  if ! cmp -s "$DB" "$backup"; then
    echo "Backup verification FAILED ($backup differs from $DB). Not updating;" \
      "start the old version again with: docker compose up -d" >&2
    exit 1
  fi
  info "Database: $DB ($(du -h "$DB" | cut -f1))"
  info "Backup:   $backup ($(du -h "$backup" | cut -f1), verified identical)"
  info "Backups in $BACKUP_DIR: $(find "$BACKUP_DIR" -maxdepth 1 -name '*.sqlite' | wc -l) files," \
    "$(du -sh "$BACKUP_DIR" | cut -f1) in total; free on that disk: $(df -h --output=avail "$BACKUP_DIR" | tail -n 1 | tr -d ' ')"
  info "Old backups are never deleted by this script; remove them by hand when no longer needed."
fi

say "Starting $new_version"
docker compose up -d --remove-orphans

say "Waiting for the health check"
for _ in $(seq 1 30); do
  if docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    say "BandRoom $new_version is healthy."
    if [ -n "$backup" ]; then
      info "To roll back to $old_version with this backup:"
      info "  cd $APP_DIR"
      info "  sudo docker compose stop app worker"
      info "  sudo rm -f $DB-wal $DB-shm"
      info "  sudo cp -a $backup $DB"
      info "  (set BANDROOM_TAG=$old_version in .env, then) sudo docker compose up -d"
    fi
    exit 0
  fi
  sleep 2
done
echo "Health check failed; see: docker compose logs app" >&2
if [ -n "$backup" ]; then
  echo "The database before this update is in: $backup" >&2
fi
exit 1
