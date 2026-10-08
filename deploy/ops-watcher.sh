#!/usr/bin/env bash
# Runs update requests written by the app and records the host status (SPEC §29.8).
# Installed next to deploy.sh (e.g. /opt/bandroom) and run AS ROOT by systemd:
#
#   bandroom-ops.path     starts bandroom-ops.service when data/ops/request.json appears
#   bandroom-ops.service  runs this script (no arguments)
#   bandroom-ops.timer    runs the same service every 15 minutes (status, missed requests)
#
#   ops-watcher.sh                handle a pending request (if any), then write the host status
#   ops-watcher.sh --status-only  only write data/ops/host-status.json
#   ops-watcher.sh --help
#
# data/ops/ belongs to the app, which a compromised app fully controls, so everything in it is
# UNTRUSTED: the request is read size-capped, must consist of a small set of characters, and only
# three fields are taken from it with strict regular expressions (never eval/source/jq). Files
# are only created through mktemp and renamed into place with `mv -T` (a planted symlink is
# replaced, never followed), and the script works inside the directory it checked (cd), so
# swapping the directory for a symlink afterwards changes nothing. A lock outside data/ stops
# concurrent runs.
#
# Files in data/ops/: request.json (app) -> running.json (while deploy.sh runs) ->
# result-<id>.json (exit code, output tail) and last.log (full output, capped); host-status.json.
#
# Environment (tests only; systemd sets none): BANDROOM_OPS_LOCK, BANDROOM_BACKUP_DIR.
set -euo pipefail

TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
REQUEST_MAX_BYTES=4096
# Only what the app writes: JSON punctuation, letters, digits and . _ - (ids, tags, usernames).
REQUEST_CHARS_RE='^[][{}":, a-zA-Z0-9._-]*$'
OUTPUT_TAIL_LINES=60
LAST_LOG_MAX_BYTES=1048576
KEEP_RESULTS=20

say() { printf 'ops-watcher: %s\n' "$*"; }
die() {
  printf 'ops-watcher: ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'
}

now_ms() { printf '%s000' "$(date +%s)"; }

new_uuid() {
  local h
  h="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s-%s-4%s-8%s-%s' "${h:0:8}" "${h:8:4}" "${h:13:3}" "${h:17:3}" "${h:20:12}"
}

# A JSON string literal of $1: printable characters only, escaped.
json_str() {
  local s
  s="$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\010\013-\037\177' |
    sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }')"
  printf '"%s"' "$s"
}

# Write stdin to ./$1 atomically: a fresh mktemp file, renamed over whatever entry is there.
write_file() {
  local name="$1" tmp
  tmp="$(mktemp ".ops-watcher.XXXXXX")"
  cat >"$tmp"
  chmod 644 "$tmp"
  mv -fT -- "$tmp" "$name"
}

# cd into data/ops, creating it (owned like data/, so the app can write it) when missing. Refuses
# a symlink or anything not owned by the data directory's owner.
enter_ops_dir() {
  local data="$APP_DIR/data" ops owner
  if [ ! -d "$data" ] || [ -L "$data" ]; then die "$data is not a directory"; fi
  ops="$data/ops"
  owner="$(stat -c '%u:%g' "$data")"
  if [ ! -e "$ops" ] && [ ! -L "$ops" ]; then
    install -d -o "${owner%:*}" -g "${owner#*:}" -m 755 "$ops"
  fi
  if [ ! -d "$ops" ] || [ -L "$ops" ]; then die "$ops is not a plain directory"; fi
  cd "$ops"
  [ "$(pwd -P)" = "$(cd "$data" && pwd -P)/ops" ] || die "$ops moved while entering it"
  [ "$(stat -c '%u' .)" = "${owner%:*}" ] || die "$ops is not owned by the data directory's owner"
}

# Fields of the request in ./running.json, or a reason in REJECT. Sets REQ_ID, REQ_ACTION, REQ_TAG.
parse_request() {
  local content size m
  REQ_ID=""
  REQ_ACTION=""
  REQ_TAG=""
  REJECT=""
  if [ -L running.json ] || [ ! -f running.json ]; then
    REJECT="not a regular file"
    return 0
  fi
  size="$(stat -c '%s' running.json)"
  if [ "$size" -gt "$REQUEST_MAX_BYTES" ]; then
    REJECT="too large"
    return 0
  fi
  content="$(head -c "$REQUEST_MAX_BYTES" running.json | tr -d '\n\r')"
  if ! [[ $content =~ $REQUEST_CHARS_RE ]]; then
    REJECT="unexpected characters"
    return 0
  fi
  field() { # $1 = key, $2 = value pattern: prints the value if the key occurs exactly once
    local all
    all="$(printf '%s' "$content" | grep -oE "\"$1\"[[:space:]]*:[[:space:]]*$2" || true)"
    if [ -z "$all" ] || [ "$(printf '%s\n' "$all" | wc -l)" != 1 ]; then return 1; fi
    [ "$(printf '%s' "$content" | grep -oE "\"$1\"" | wc -l)" = 1 ] || return 1
    printf '%s' "$all" | sed -E 's/^"[a-z]+"[[:space:]]*:[[:space:]]*//; s/^"//; s/"$//'
  }
  m="$(field id '"[0-9a-f-]{36}"')" || {
    REJECT="missing or invalid id"
    return 0
  }
  [[ $m =~ $UUID_RE ]] || {
    REJECT="missing or invalid id"
    return 0
  }
  REQ_ID="$m"
  m="$(field action '"(deploy|rollback)"')" || {
    REJECT="missing or invalid action"
    return 0
  }
  [[ $m == deploy || $m == rollback ]] || {
    REJECT="missing or invalid action"
    return 0
  }
  REQ_ACTION="$m"
  if [ "$REQ_ACTION" = deploy ]; then
    m="$(field tag '"v[0-9]+\.[0-9]+\.[0-9]+"')" || {
      REJECT="missing or invalid tag"
      return 0
    }
    [[ $m =~ $TAG_RE ]] || {
      REJECT="missing or invalid tag"
      return 0
    }
    REQ_TAG="$m"
  fi
}

write_result() { # $1 id, $2 action, $3 tag, $4 exit code, $5 started, $6 error, $7 output file
  local tag_json=null err_json=null tail_text=""
  [ -n "$3" ] && tag_json="$(json_str "$3")"
  [ -n "$6" ] && err_json="$(json_str "$6")"
  [ -n "$7" ] && [ -f "$7" ] && tail_text="$(tail -n "$OUTPUT_TAIL_LINES" "$7")"
  printf '{"id":%s,"action":%s,"tag":%s,"exitCode":%s,"startedAt":%s,"finishedAt":%s,"error":%s,"outputTail":%s}\n' \
    "$(json_str "$1")" "$(json_str "$2")" "$tag_json" "$4" "${5:-null}" "$(now_ms)" "$err_json" \
    "$(json_str "$tail_text")" | write_file "result-$1.json"
}

prune_results() {
  local f
  # Names are result-<uuid>.json, so `ls` output is safe to read line by line.
  # shellcheck disable=SC2010,SC2012
  ls -1t -- result-*.json 2>/dev/null | grep -E '^result-[0-9a-f-]{36}\.json$' |
    tail -n +"$((KEEP_RESULTS + 1))" | while read -r f; do rm -f -- "$f"; done
}

handle_request() {
  local started out rc=0
  # A run that died (reboot, kill) left running.json behind.
  if [ -e running.json ] || [ -L running.json ]; then
    parse_request
    local id="${REQ_ID:-$(new_uuid)}"
    say "found an interrupted request ($id); recording it as failed"
    write_result "$id" "${REQ_ACTION:-unknown}" "$REQ_TAG" 3 "" "interrupted (the host stopped while it ran)" ""
    rm -f running.json
  fi
  if [ ! -e request.json ] && [ ! -L request.json ]; then
    return 0
  fi
  mv -fT request.json running.json # the claim: the app sees "running" and refuses new requests
  parse_request
  if [ -n "$REJECT" ]; then
    local id
    id="$(new_uuid)"
    say "rejected an invalid request: $REJECT (result $id)"
    mv -fT running.json rejected.json
    write_result "$id" invalid "" 2 "" "invalid request: $REJECT" ""
    return 0
  fi
  started="$(now_ms)"
  out="$(mktemp "${TMPDIR:-/tmp}/bandroom-ops.XXXXXX")"
  say "running $REQ_ACTION ${REQ_TAG:-} (request $REQ_ID)"
  if [ "$REQ_ACTION" = deploy ]; then
    "$APP_DIR/deploy.sh" "$REQ_TAG" >"$out" 2>&1 || rc=$?
  else
    "$APP_DIR/deploy.sh" --rollback >"$out" 2>&1 || rc=$?
  fi
  say "deploy.sh exited with $rc"
  tail -c "$LAST_LOG_MAX_BYTES" "$out" | LC_ALL=C tr -d '\000-\010\013-\037\177' | write_file last.log
  write_result "$REQ_ID" "$REQ_ACTION" "$REQ_TAG" "$rc" "$started" "" "$out"
  rm -f "$out" running.json
  prune_results
}

# One line per service: "service state health", tokens limited to [a-z0-9_-].
container_states() {
  local svc c state health
  for svc in caddy app worker; do
    c="$(if cd "$APP_DIR"; then docker compose ps -a -q "$svc" 2>/dev/null | head -n 1; fi)" || c=""
    if [ -z "$c" ]; then
      printf '%s missing none\n' "$svc"
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null | head -n 1 || echo unknown)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$c" 2>/dev/null | head -n 1 || echo unknown)"
    state="${state%% *}"
    [[ $state =~ ^[a-z0-9_-]{1,32}$ ]] || state=unknown
    [[ $health =~ ^[a-z0-9_-]{1,32}$ ]] || health=unknown
    printf '%s %s %s\n' "$svc" "$state" "$health"
  done
}

write_status() {
  local tag containers="" svc state health avail size backups count=0 bytes=0 latest=""
  tag="$(sed -n 's/^BANDROOM_TAG=//p' "$APP_DIR/.env" 2>/dev/null | tail -n 1 | tr -d "\"' \r" || true)"
  [[ $tag =~ $TAG_RE || $tag == latest ]] || tag="${tag:+invalid}"
  while read -r svc state health; do
    containers="$containers${containers:+,}{\"service\":\"$svc\",\"state\":\"$state\",\"health\":\"$health\"}"
  done < <(container_states)
  read -r avail size < <(df -B1 --output=avail,size "$APP_DIR/data" 2>/dev/null | tail -n 1 || echo "0 0")
  [[ $avail =~ ^[0-9]+$ ]] || avail=0
  [[ $size =~ ^[0-9]+$ ]] || size=0
  backups="$(realpath -m "${BANDROOM_BACKUP_DIR:-$APP_DIR/../bandroom-backup}")"
  if [ -d "$backups" ]; then
    count="$(find "$backups" -maxdepth 1 -name '*.sqlite' -type f | wc -l | tr -d ' ')"
    bytes="$(du -sb "$backups" 2>/dev/null | cut -f1 || echo 0)"
    # shellcheck disable=SC2010,SC2012
    latest="$(ls -1t "$backups" 2>/dev/null | grep -E '^[A-Za-z0-9._-]+\.sqlite$' | head -n 1 || true)"
  fi
  [[ $bytes =~ ^[0-9]+$ ]] || bytes=0
  printf '{"ts":%s,"tag":%s,"containers":[%s],"disk":{"availBytes":%s,"sizeBytes":%s},"backups":{"count":%s,"bytes":%s,"latest":%s}}\n' \
    "$(now_ms)" "$(json_str "$tag")" "$containers" "$avail" "$size" "$count" "$bytes" \
    "$(if [ -n "$latest" ]; then json_str "$latest"; else echo null; fi)" | write_file host-status.json
}

main() {
  local mode=run
  if [ "$#" -gt 1 ]; then
    usage >&2
    die "Too many arguments."
  fi
  case "${1:-}" in
    "") ;;
    --status-only) mode=status ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "Invalid argument '$1'."
      ;;
  esac
  [ "$(id -u)" = 0 ] || [ "${BANDROOM_OPS_ALLOW_NONROOT:-0}" = 1 ] || die "run as root (systemd)"

  cd "$(dirname "$0")"
  APP_DIR="$(pwd -P)"
  [ -x "$APP_DIR/deploy.sh" ] || die "deploy.sh not found next to this script"

  command -v flock >/dev/null || die "flock (util-linux) is required"
  exec 9>"${BANDROOM_OPS_LOCK:-$APP_DIR/.ops-watcher.lock}"
  if ! flock -n 9; then
    say "another run is in progress; leaving it to that run"
    exit 0
  fi

  enter_ops_dir
  if [ "$mode" = run ]; then handle_request; fi
  write_status
}

main "$@"
