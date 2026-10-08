#!/usr/bin/env bash
# Pull, back up the database, restart and verify the stack (SPEC §19.3, §19.4).
# Run by the owner ON THE SERVER, in the application directory (e.g. /opt/bandroom):
#
#   sudo ./deploy.sh              deploy the tag already in .env (BANDROOM_TAG, default latest)
#   sudo ./deploy.sh v1.2.3       set BANDROOM_TAG=v1.2.3 in .env (after checking that the image
#                                 exists; .env is backed up first), then deploy it
#   sudo ./deploy.sh --rollback   undo the last update: restore the database backup taken before
#                                 it and go back to the version that ran before
#   sudo ./deploy.sh --help
#
# Before restarting, the app and worker are stopped and data/bandroom.sqlite is copied to
#   $BANDROOM_BACKUP_DIR (default: ../bandroom-backup next to the application directory)
# as bandroom-before-<new version>-from-<old version>-<UTC time>.sqlite. An existing file is
# never overwritten, and the script stops if the copy cannot be verified.
#
# Self-update: release images carry deploy.sh, status.sh, compose.yml, the ops watcher with its
# systemd units and the Caddyfile templates in /app/deploy/. After pulling, changed copies of
# deploy.sh, status.sh, compose.yml, ops-watcher.sh and bandroom-ops.* are installed here (with a diff and a .bak-<UTC time> copy of the old file), and the script restarts
# itself once when deploy.sh or compose.yml changed. The Caddyfile is never replaced; a difference
# from its template is only shown. Files from an older image than the running one are not installed.
#
# Environment (only with full sudo rights, `sudo VAR=… ./deploy.sh`; sudo drops other variables):
# BANDROOM_BACKUP_DIR=<dir> changes the backup location, BANDROOM_SKIP_BACKUP=1 skips the backup.
set -euo pipefail

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SELF_UPDATED_FILES=(deploy.sh status.sh compose.yml ops-watcher.sh bandroom-ops.path bandroom-ops.service bandroom-ops.timer)

say() { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
}

# A path that does not exist yet: <base>, else <base>-2, <base>-3, …
unique_path() {
  local p="$1" n=2
  while [ -e "$p" ]; do
    p="$1-$n"
    n=$((n + 1))
  done
  printf '%s' "$p"
}

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

running_version() {
  local c
  c="$(docker compose ps -q app 2>/dev/null | head -n 1 || true)"
  if [ -n "$c" ]; then
    version_of_image "$(docker inspect -f '{{.Image}}' "$c")"
  else
    printf 'none'
  fi
}

# True when $1 is a release tag that is older than the release tag $2.
older_release() {
  [[ $1 =~ $TAG_RE ]] && [[ $2 =~ $TAG_RE ]] && [ "$1" != "$2" ] &&
    [ "$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | head -n 1)" = "${1#v}" ]
}

env_tag() {
  if [ -f .env ]; then
    sed -n 's/^BANDROOM_TAG=//p' .env | tail -n 1 | tr -d "\"' \r"
  fi
}

# The app image compose would use with BANDROOM_TAG=$1 (shell variables override .env).
image_for_tag() {
  BANDROOM_TAG="$1" docker compose config --images app | head -n 1
}

# Pull one exact tag without changing anything else; stops the script if it does not exist.
require_tag_image() {
  local tag="$1" image
  image="$(image_for_tag "$tag")"
  say "Checking that $image exists"
  if ! docker pull "$image"; then
    die "Cannot pull $image: the tag $tag does not exist or the registry is unreachable." \
      "Nothing was changed (.env untouched)."
  fi
}

# Set BANDROOM_TAG in .env (backing it up first), keeping the file's owner and mode.
set_env_tag() {
  local tag="$1" bak tmp
  if [ "$(env_tag)" = "$tag" ]; then
    info ".env already has BANDROOM_TAG=$tag"
    return 0
  fi
  if [ ! -f .env ]; then
    (umask 077 && printf 'BANDROOM_TAG=%s\n' "$tag" >.env)
    info "Created .env with BANDROOM_TAG=$tag"
    return 0
  fi
  bak="$(unique_path "$APP_DIR/.env.bak-$STAMP")"
  cp -p .env "$bak"
  chmod 600 "$bak"
  info "Backed up .env to $bak"
  tmp="$(mktemp "$APP_DIR/.env.tmp.XXXXXX")"
  if grep -q '^BANDROOM_TAG=' .env; then
    sed "s/^BANDROOM_TAG=.*/BANDROOM_TAG=$tag/" .env >"$tmp"
  else
    {
      cat .env
      if [ -s .env ] && [ -n "$(tail -c 1 .env)" ]; then echo; fi
      printf 'BANDROOM_TAG=%s\n' "$tag"
    } >"$tmp"
  fi
  cat "$tmp" >.env
  rm -f "$tmp"
  info "Set BANDROOM_TAG=$tag in .env"
}

show_tag_source() {
  local line
  line="$(grep -E '^BANDROOM_TAG=' .env 2>/dev/null | tail -n 1 || true)"
  if [ -n "$line" ]; then
    info "Image tag from .env: $line"
  else
    info "Image tag: latest (no BANDROOM_TAG in .env)"
  fi
}

# Replace $2 by $1 atomically (a new inode: bash may still be reading the old deploy.sh).
install_file() {
  local src="$1" dst="$2" mode="$3" tmp
  tmp="$(mktemp "$dst.new.XXXXXX")"
  cat "$src" >"$tmp"
  chmod "$mode" "$tmp"
  if [ "$(id -u)" = 0 ]; then chown root:root "$tmp"; fi
  mv -f "$tmp" "$dst"
}

# Install changed deploy files from the pulled image. Sets NEED_REEXEC=1 when deploy.sh or
# compose.yml changed.
NEED_REEXEC=0
self_update() {
  local image="$1" new_version="$2" old_version="$3" tmp cid f cur new mode bak
  say "Checking the deploy files shipped in $image"
  if [ "${BANDROOM_DEPLOY_REEXEC:-0}" = "1" ]; then
    info "Already updated in this run (restarted with the new deploy.sh); skipping."
    return 0
  fi
  if older_release "$new_version" "$old_version"; then
    info "The image ($new_version) is older than the running version ($old_version):"
    info "keeping the current deploy files."
    return 0
  fi
  tmp="$(mktemp -d)"
  if ! cid="$(docker create "$image" 2>/dev/null)"; then
    rm -rf "$tmp"
    info "Could not create a container from $image; deploy files not checked."
    return 0
  fi
  if ! docker cp "$cid:/app/deploy/." "$tmp/" >/dev/null 2>&1; then
    docker rm "$cid" >/dev/null 2>&1 || true
    rm -rf "$tmp"
    info "This image has no /app/deploy (built before v0.4.1); deploy files not checked."
    return 0
  fi
  docker rm "$cid" >/dev/null 2>&1 || true

  for f in "${SELF_UPDATED_FILES[@]}"; do
    new="$tmp/$f"
    cur="$APP_DIR/$f"
    if [ ! -f "$new" ]; then
      info "$f: not in the image, keeping the current one"
      continue
    fi
    if [ -f "$cur" ] && cmp -s "$new" "$cur"; then
      info "$f: up to date"
      continue
    fi
    mode=0644
    if [[ $f == *.sh ]]; then mode=0755; fi
    if [ -f "$cur" ]; then
      say "$f changed in $new_version:"
      diff -u --label "$f (installed)" --label "$f ($new_version)" "$cur" "$new" || true
      bak="$(unique_path "$cur.bak-$STAMP")"
      cp -p "$cur" "$bak"
      info "Old $f saved as $bak"
    else
      say "$f: new in $new_version"
    fi
    install_file "$new" "$cur" "$mode"
    info "Installed the new $f (mode $mode)"
    case "$f" in deploy.sh | compose.yml) NEED_REEXEC=1 ;; esac
  done

  caddyfile_note "$tmp" "$new_version"
  rm -rf "$tmp"
}

# The Caddyfile may be customized: never replace it, only show how it differs from its template.
caddyfile_note() {
  local dir="$1" new_version="$2" template base_path
  [ -f "$APP_DIR/Caddyfile" ] || return 0
  for template in Caddyfile Caddyfile.subpath; do
    if [ -f "$dir/$template" ] && cmp -s "$dir/$template" "$APP_DIR/Caddyfile"; then
      info "Caddyfile: identical to the $template template of $new_version"
      return 0
    fi
  done
  base_path="$(sed -n 's/^BASE_PATH=//p' .env 2>/dev/null | tail -n 1 | tr -d "\"' \r")"
  template=Caddyfile
  if [ -n "$base_path" ]; then template=Caddyfile.subpath; fi
  [ -f "$dir/$template" ] || return 0
  say "NOTE: Caddyfile differs from the $template template of $new_version (NOT changed)."
  info "Review the difference; adopt parts of it by hand if needed, then: sudo docker compose restart caddy"
  diff -u --label "Caddyfile (installed)" --label "$template ($new_version template)" \
    "$APP_DIR/Caddyfile" "$dir/$template" || true
}

# Copy the database (and a non-empty -wal/-shm) to $1 and verify it; app and worker are stopped.
copy_db_verified() {
  local backup="$1" ext
  if [ -e "$backup" ]; then
    die "Backup file already exists, not overwriting: $backup"
  fi
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  cp -a "$DB" "$backup"
  for ext in wal shm; do
    if [ -s "$DB-$ext" ]; then
      cp -a "$DB-$ext" "$backup-$ext"
      info "Also copied $DB-$ext (the database was not checkpointed)"
    fi
  done
  if ! cmp -s "$DB" "$backup"; then
    die "Backup verification FAILED ($backup differs from $DB). Nothing else was changed;" \
      "start the stack again with: sudo docker compose up -d"
  fi
  info "Database: $DB ($(du -h "$DB" | cut -f1))"
  info "Backup:   $backup ($(du -h "$backup" | cut -f1), verified identical)"
}

backup_summary() {
  info "Backups in $BACKUP_DIR: $(find "$BACKUP_DIR" -maxdepth 1 -name '*.sqlite' | wc -l | tr -d ' ') files," \
    "$(du -sh "$BACKUP_DIR" | cut -f1) in total; free on that disk: $(df -h --output=avail "$BACKUP_DIR" | tail -n 1 | tr -d ' ')"
  info "Old backups are never deleted by this script; remove them by hand when no longer needed."
}

wait_healthy() {
  local version="$1"
  say "Waiting for the health check"
  for _ in $(seq 1 30); do
    if docker compose exec -T app node -e \
      "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
      say "BandRoom $version is healthy."
      return 0
    fi
    sleep 2
  done
  return 1
}

deploy() {
  local tag="$1" old_version new_image new_version backup=""
  shift # the remaining arguments are the original ones, for the restart after a self-update
  old_version="$(running_version)"
  info "Running now: $old_version"

  if [ -n "$tag" ]; then
    require_tag_image "$tag"
    set_env_tag "$tag"
  fi

  say "Pulling images"
  docker compose pull
  new_image="$(docker compose config --images app | head -n 1)"
  new_version="$(version_of_image "$new_image")"
  info "Pulled: $new_image = $new_version"
  show_tag_source

  self_update "$new_image" "$new_version" "$old_version"
  if [ "$NEED_REEXEC" = 1 ]; then
    say "Restarting deploy.sh with the updated files"
    exec env BANDROOM_DEPLOY_REEXEC=1 "$APP_DIR/deploy.sh" "$@"
  fi

  if [ "$new_version" = "$old_version" ]; then
    say "WARNING: the pulled version equals the running one ($new_version); restarting it unchanged."
    info "To update, run: sudo ./deploy.sh vX.Y.Z (the new tag)"
  fi

  if [ "${BANDROOM_SKIP_BACKUP:-0}" = "1" ]; then
    say "Database backup SKIPPED (BANDROOM_SKIP_BACKUP=1)"
  elif [ ! -e "$DB" ]; then
    say "No database at $DB yet (first start): nothing to back up"
  else
    say "Backing up the database before updating $old_version -> $new_version"
    info "Stopping app and worker so the database file is complete"
    docker compose stop app worker
    backup="$BACKUP_DIR/bandroom-before-$new_version-from-$old_version-$STAMP.sqlite"
    copy_db_verified "$backup"
    backup_summary
  fi

  say "Starting $new_version"
  docker compose up -d --remove-orphans

  if wait_healthy "$new_version"; then
    if [ -n "$backup" ] && [ "$new_version" != "$old_version" ]; then
      if [[ $old_version =~ $TAG_RE ]]; then
        info "To undo this update (restores this backup; changes made since are lost):"
        info "  sudo ./deploy.sh --rollback"
      else
        info "The previous version ($old_version) is not a release tag, so --rollback cannot"
        info "restore it; the database before this update is in $backup"
      fi
    fi
    return 0
  fi
  echo "Health check failed; see: sudo docker compose logs app" >&2
  if [ -n "$backup" ]; then
    echo "The database before this update is in: $backup" >&2
    echo "To go back: sudo ./deploy.sh --rollback" >&2
  fi
  exit 1
}

# Newest bandroom-before-<$1>-from-<prev>-<UTC>.sqlite in the backup directory (empty if none).
find_rollback_backup() {
  local cur="$1" f name best="" best_stamp="" stamp
  [ -d "$BACKUP_DIR" ] || return 0
  for f in "$BACKUP_DIR/bandroom-before-$cur-from-"*.sqlite; do
    [ -f "$f" ] || continue
    name="${f##*/}"
    # A redeploy of the same version has nothing to roll back to.
    case "$name" in "bandroom-before-$cur-from-$cur-"*) continue ;; esac
    stamp="$(printf '%s' "$name" | sed -n 's/^.*-\([0-9]\{8\}-[0-9]\{6\}\)\.sqlite$/\1/p')"
    [ -n "$stamp" ] || continue
    if [ -z "$best" ] || [[ $stamp > $best_stamp ]]; then
      best="$f"
      best_stamp="$stamp"
    fi
  done
  printf '%s' "$best"
}

rollback() {
  local cur backup name prev safety="" owner mode tmp ext
  cur="$(running_version)"
  info "Running now: $cur"
  if ! [[ $cur =~ $TAG_RE ]]; then
    die "The running version '$cur' is not a release tag (vX.Y.Z); cannot find its backup." \
      "Nothing was changed."
  fi
  backup="$(find_rollback_backup "$cur")"
  if [ -z "$backup" ]; then
    die "No backup named bandroom-before-$cur-from-<previous>-<time>.sqlite in $BACKUP_DIR." \
      "Nothing was changed."
  fi
  name="${backup##*/}"
  prev="${name#bandroom-before-"$cur"-from-}"
  prev="$(printf '%s' "$prev" | sed 's/-[0-9]\{8\}-[0-9]\{6\}\.sqlite$//')"
  if ! [[ $prev =~ $TAG_RE ]]; then
    die "The backup $name was taken before updating from '$prev', which is not a release tag" \
      "(vX.Y.Z), so it cannot be deployed again. Nothing was changed."
  fi

  say "Rollback plan: $cur -> $prev"
  info "1. check that the $prev image exists"
  info "2. stop app and worker"
  info "3. back up the current database to $BACKUP_DIR/bandroom-before-rollback-from-$cur-$STAMP.sqlite"
  info "4. restore $backup"
  info "   (everything changed since that backup was taken is lost; the copy in step 3 keeps it)"
  info "5. set BANDROOM_TAG=$prev in .env, start and wait for the health check"

  require_tag_image "$prev"

  say "Stopping app and worker"
  docker compose stop app worker

  if [ -e "$DB" ]; then
    say "Backing up the current database"
    safety="$BACKUP_DIR/bandroom-before-rollback-from-$cur-$STAMP.sqlite"
    copy_db_verified "$safety"
    owner="$(stat -c '%u:%g' "$DB")"
    mode="$(stat -c '%a' "$DB")"
  else
    info "No current database at $DB"
    owner="$(stat -c '%u:%g' "$(dirname "$DB")")"
    mode=644
  fi

  say "Restoring $backup"
  tmp="$(mktemp "$DB.rollback.XXXXXX")"
  cp "$backup" "$tmp"
  chown "$owner" "$tmp"
  chmod "$mode" "$tmp"
  rm -f "$DB-wal" "$DB-shm"
  mv -f "$tmp" "$DB"
  for ext in wal shm; do
    if [ -s "$backup-$ext" ]; then
      cp "$backup-$ext" "$DB-$ext"
      chown "$owner" "$DB-$ext"
      chmod "$mode" "$DB-$ext"
      info "Also restored $backup-$ext"
    fi
  done
  if ! cmp -s "$backup" "$DB"; then
    die "Restore verification FAILED ($DB differs from $backup). The stack is stopped;" \
      "the database before the rollback is in ${safety:-(none)}."
  fi
  info "Restored (owner $owner, mode $mode, verified identical)"

  set_env_tag "$prev"

  say "Starting $prev"
  docker compose up -d --remove-orphans
  if wait_healthy "$prev"; then
    if [ -n "${safety:-}" ]; then
      info "The database as it was before the rollback is in $safety"
    fi
    return 0
  fi
  echo "Health check failed; see: sudo docker compose logs app" >&2
  exit 1
}

main() {
  local mode=deploy tag=""
  if [ "$#" -gt 1 ]; then
    usage >&2
    die "Too many arguments."
  fi
  case "${1:-}" in
    "") ;;
    -h | --help)
      usage
      exit 0
      ;;
    --rollback) mode=rollback ;;
    *)
      if ! [[ $1 =~ $TAG_RE ]]; then
        usage >&2
        die "Invalid argument '$1': expected a version tag like v1.2.3, --rollback or --help."
      fi
      tag="$1"
      ;;
  esac

  cd "$(dirname "$0")"
  APP_DIR="$(pwd -P)"
  DB="$APP_DIR/data/bandroom.sqlite"
  BACKUP_DIR="$(realpath -m "${BANDROOM_BACKUP_DIR:-$APP_DIR/../bandroom-backup}")"
  if [ -e "$DB" ] && [ ! -r "$DB" ]; then
    die "Cannot read $DB: run this script with sudo."
  fi

  say "BandRoom $mode in $APP_DIR"
  if [ "$mode" = rollback ]; then
    rollback
  else
    deploy "$tag" "$@"
  fi
}

# Everything above only defines functions, so bash has read the whole file before running it.
main "$@"
