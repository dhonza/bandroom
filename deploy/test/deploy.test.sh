#!/usr/bin/env bash
# Tests deploy.sh and status.sh against a fake docker (deploy/test/fake-docker): no containers,
# no network, no root. Needs GNU coreutils first in PATH (on macOS: Homebrew's gnubin), node and
# `pnpm install` (status queries run against a migrated SQLite database).
#   bash deploy/test/deploy.test.sh
# Assertions are single-quoted and evaluated later, so variables used there look unused:
# shellcheck disable=SC2016,SC2034,SC2010,SC2317
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bandroom-deploy-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
cp "$REPO/deploy/test/fake-docker" "$BIN/docker"
export PATH="$BIN:$PATH" FAKE_REPO="$REPO"
realpath -m / >/dev/null 2>&1 || {
  echo "GNU coreutils are needed (realpath -m, stat -c, df --output)" >&2
  exit 1
}

# macOS has no flock(1): a stand-in with the same flock(2) semantics (the lock stays with the
# caller's file descriptor).
if ! command -v flock >/dev/null 2>&1; then
  cat >"$BIN/flock" <<'PERL'
#!/usr/bin/env perl
use Fcntl ':flock';
my ($nb, $fd) = (0, undef);
for (@ARGV) { if ($_ eq '-n') { $nb = 1 } elsif (/^\d+$/) { $fd = $_ } }
open(my $f, '>&=', $fd) or die "flock: fd $fd: $!";
flock($f, LOCK_EX | ($nb ? LOCK_NB : 0)) or exit 1;
exit 0;
PERL
  chmod +x "$BIN/flock"
fi

failures=0
passes=0
current=""
pass() { passes=$((passes + 1)); }
fail() {
  failures=$((failures + 1))
  printf 'FAIL [%s]: %s\n' "$current" "$*"
  printf '%s\n' "--- output ---" "$OUT" "--------------"
}
check() { if eval "$1"; then pass; else fail "${2:-$1}"; fi; }
contains() { if grep -qF -- "$1" <<<"$OUT"; then pass; else fail "output lacks: $1"; fi; }
lacks() { if grep -qF -- "$1" <<<"$OUT"; then fail "output has: $1"; else pass; fi; }
count() { grep -cF -- "$1" <<<"$OUT" || true; }

# A fresh case: registry with v0.4.0 (no /app/deploy), v0.4.1 and latest (= v0.4.1, with the
# deploy files of this checkout); an app dir with those files, .env, a database and a Caddyfile.
new_case() {
  current="$1"
  C="$WORK/$1"
  APP="$C/app"
  BK="$C/bandroom-backup"
  export FAKE_DOCKER_STATE="$C/state" FAKE_DATA_DIR="$C/app/data"
  mkdir -p "$APP/data" "$FAKE_DOCKER_STATE/registry"/{v0.4.0,v0.4.1,latest}
  echo v0.4.0 >"$FAKE_DOCKER_STATE/registry/v0.4.0/version"
  for t in v0.4.1 latest; do
    echo v0.4.1 >"$FAKE_DOCKER_STATE/registry/$t/version"
    mkdir -p "$FAKE_DOCKER_STATE/registry/$t/deploy"
    cp "$REPO"/deploy/{deploy.sh,status.sh,compose.yml,Caddyfile,Caddyfile.subpath} \
      "$REPO"/deploy/{ops-watcher.sh,bandroom-ops.path,bandroom-ops.service,bandroom-ops.timer} \
      "$FAKE_DOCKER_STATE/registry/$t/deploy/"
  done
  cp "$REPO"/deploy/{deploy.sh,status.sh,compose.yml} \
    "$REPO"/deploy/{ops-watcher.sh,bandroom-ops.path,bandroom-ops.service,bandroom-ops.timer} "$APP/"
  cp "$REPO/deploy/Caddyfile.subpath" "$APP/Caddyfile"
  printf 'APP_URL=https://example.com/x\nBASE_PATH=/x\nBANDROOM_TAG=v0.4.0\n' >"$APP/.env"
  chmod 600 "$APP/.env"
  echo "NEW DATABASE" >"$APP/data/bandroom.sqlite"
  chmod 640 "$APP/data/bandroom.sqlite"
  echo "ghcr.io/example/bandroom:v0.4.0" >"$FAKE_DOCKER_STATE/running"
  : >"$FAKE_DOCKER_STATE/calls.log"
}
run() {
  set +e
  OUT="$("$@" 2>&1)"
  RC=$?
  set -e
}
running_tag() { sed 's/.*://' "$FAKE_DOCKER_STATE/running"; }
sum() { cksum <"$1"; }
env_tag_v041() {
  sed 's/^BANDROOM_TAG=.*/BANDROOM_TAG=v0.4.1/' "$APP/.env" >"$C/env.tmp"
  cat "$C/env.tmp" >"$APP/.env"
}

# ---------------------------------------------------------------------------------------------
new_case deploy-env-tag
env_tag_v041
run "$APP/deploy.sh"
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "Running now: v0.4.0"
contains "Pulled: ghcr.io/example/bandroom:v0.4.1 = v0.4.1"
contains "deploy.sh: up to date"
contains "compose.yml: up to date"
contains "Caddyfile: identical to the Caddyfile.subpath template"
contains "BandRoom v0.4.1 is healthy."
contains "sudo ./deploy.sh --rollback"
check '[ "$(running_tag)" = v0.4.1 ]' "v0.4.1 running"
b="$(ls "$BK"/bandroom-before-v0.4.1-from-v0.4.0-*.sqlite)"
check 'cmp -s "$b" "$APP/data/bandroom.sqlite"' "backup identical"
check '[ "$(stat -c %a "$BK")" = 700 ]' "backup dir 700"

new_case same-version
run "$APP/deploy.sh"
check '[ $RC = 0 ]'
contains "WARNING: the pulled version equals the running one (v0.4.0)"
contains "no /app/deploy"

new_case version-arg
before_env="$(cat "$APP/.env")"
run "$APP/deploy.sh" v0.4.1
check '[ $RC = 0 ]' "exit 0 (got $RC)"
check 'grep -qx BANDROOM_TAG=v0.4.1 "$APP/.env"' ".env updated"
check '[ "$(grep -c BANDROOM_TAG "$APP/.env")" = 1 ]' "one tag line"
check '[ "$(stat -c %a "$APP/.env")" = 600 ]' ".env still 600"
bak="$(ls "$APP"/.env.bak-*)"
check '[ "$(cat "$bak")" = "$before_env" ] && [ "$(stat -c %a "$bak")" = 600 ]' ".env backup 600"
check '[ "$(running_tag)" = v0.4.1 ]' "v0.4.1 running"
check 'ls "$BK"/bandroom-before-v0.4.1-from-v0.4.0-*.sqlite >/dev/null' "db backup"

new_case version-arg-no-line
printf 'APP_URL=https://example.com' >"$APP/.env" # no trailing newline
run "$APP/deploy.sh" v0.4.1
check '[ $RC = 0 ]'
check '[ "$(cat "$APP/.env")" = "$(printf "APP_URL=https://example.com\nBANDROOM_TAG=v0.4.1")" ]' \
  "tag line appended"

for bad in 0.4.1 v0.4 v0.4.1.2 "v0.4.1;id" "v0.4.1 " "-x" latest; do
  new_case "invalid-arg-$bad"
  s="$(sum "$APP/.env")"
  run "$APP/deploy.sh" "$bad"
  check '[ $RC != 0 ]' "rejected '$bad'"
  contains "Invalid argument"
  check '[ "$(sum "$APP/.env")" = "$s" ] && [ ! -s "$FAKE_DOCKER_STATE/calls.log" ]' \
    "nothing touched for '$bad'"
done
new_case too-many-args
run "$APP/deploy.sh" v0.4.1 v0.4.1
check '[ $RC != 0 ] && [ ! -s "$FAKE_DOCKER_STATE/calls.log" ]' "two args rejected"

new_case missing-tag
s="$(sum "$APP/.env")"
run "$APP/deploy.sh" v9.9.9
check '[ $RC != 0 ]' "fails"
contains "the tag v9.9.9 does not exist"
check '[ "$(sum "$APP/.env")" = "$s" ] && ! ls "$APP"/.env.bak-* >/dev/null 2>&1' ".env untouched"
check '! grep -q "compose stop" "$FAKE_DOCKER_STATE/calls.log"' "nothing stopped"
check '[ "$(running_tag)" = v0.4.0 ]' "still v0.4.0"

new_case self-update-deploy
echo "# an older deploy.sh" >>"$APP/deploy.sh"
echo "# an older status.sh" >>"$APP/status.sh"
run "$APP/deploy.sh" v0.4.1
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "deploy.sh changed in v0.4.1:"
contains "-# an older deploy.sh"
contains "Restarting deploy.sh with the updated files"
contains "Already updated in this run"
check '[ "$(count "Restarting deploy.sh")" = 1 ] && [ "$(count "BandRoom deploy in")" = 2 ]' \
  "re-executed exactly once"
check 'cmp -s "$APP/deploy.sh" "$REPO/deploy/deploy.sh"' "new deploy.sh installed"
check 'cmp -s "$APP/status.sh" "$REPO/deploy/status.sh"' "new status.sh installed"
check '[ "$(stat -c %a "$APP/deploy.sh")" = 755 ] && [ "$(stat -c %a "$APP/status.sh")" = 755 ]' "modes 755"
check 'grep -q "an older deploy.sh" "$APP"/deploy.sh.bak-* && grep -q "an older status.sh" "$APP"/status.sh.bak-*' \
  "old files kept as .bak"
check '[ "$(ls "$BK" | grep -c "^bandroom-before-v0.4.1-from-v0.4.0-.*\.sqlite$")" = 1 ]' \
  "one database backup"
check '[ "$(running_tag)" = v0.4.1 ]' "v0.4.1 running"

new_case self-update-compose
echo "# local edit" >>"$APP/compose.yml"
run "$APP/deploy.sh" v0.4.1
check '[ $RC = 0 ]'
contains "compose.yml changed in v0.4.1:"
contains "status.sh: up to date"
check 'cmp -s "$APP/compose.yml" "$REPO/deploy/compose.yml" && [ "$(stat -c %a "$APP/compose.yml")" = 644 ]' \
  "compose.yml installed 644"
check 'grep -q "local edit" "$APP"/compose.yml.bak-*' "compose.yml backed up"
contains "Restarting deploy.sh with the updated files"

new_case self-update-status-only
echo "# old" >>"$APP/status.sh"
run "$APP/deploy.sh" v0.4.1
check '[ $RC = 0 ]'
lacks "Restarting deploy.sh"
check 'cmp -s "$APP/status.sh" "$REPO/deploy/status.sh"' "status.sh installed"

new_case caddyfile-differs
echo "# my extra site" >>"$APP/Caddyfile"
cp "$APP/Caddyfile" "$C/caddy.before"
run "$APP/deploy.sh" v0.4.1
check '[ $RC = 0 ]'
contains "NOTE: Caddyfile differs from the Caddyfile.subpath template of v0.4.1 (NOT changed)"
contains "-# my extra site"
check 'cmp -s "$APP/Caddyfile" "$C/caddy.before" && ! ls "$APP"/Caddyfile.bak-* >/dev/null 2>&1' \
  "Caddyfile untouched"

new_case older-image
echo "ghcr.io/example/bandroom:v0.4.1" >"$FAKE_DOCKER_STATE/running"
mkdir -p "$FAKE_DOCKER_STATE/registry/v0.4.0/deploy"
echo "# old" >"$FAKE_DOCKER_STATE/registry/v0.4.0/deploy/deploy.sh"
run "$APP/deploy.sh" v0.4.0
check '[ $RC = 0 ]'
contains "is older than the running version (v0.4.1)"
check 'cmp -s "$APP/deploy.sh" "$REPO/deploy/deploy.sh"' "deploy.sh not downgraded"

new_case health-fails
echo 1 >"$FAKE_DOCKER_STATE/health_rc"
sleep() { :; }
export -f sleep
run "$APP/deploy.sh" v0.4.1
unset -f sleep
check '[ $RC != 0 ]'
contains "Health check failed"
contains "To go back: sudo ./deploy.sh --rollback"

# ---------------------------------------------------------------------------------------------
new_case rollback
echo "ghcr.io/example/bandroom:v0.4.1" >"$FAKE_DOCKER_STATE/running"
env_tag_v041
mkdir -p "$BK"
echo "BEFORE 0.4.1 (newest)" >"$BK/bandroom-before-v0.4.1-from-v0.4.0-20261001-100000.sqlite"
echo "BEFORE 0.4.1 (older)" >"$BK/bandroom-before-v0.4.1-from-v0.3.9-20260901-100000.sqlite"
echo "BEFORE 0.4.0" >"$BK/bandroom-before-v0.4.0-from-v0.3.9-20261005-100000.sqlite"
echo "REDEPLOY" >"$BK/bandroom-before-v0.4.1-from-v0.4.1-20261007-100000.sqlite"
echo "WAL" >"$APP/data/bandroom.sqlite-wal"
: >"$APP/data/bandroom.sqlite-shm"
run "$APP/deploy.sh" --rollback
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "Rollback plan: v0.4.1 -> v0.4.0"
check '[ "$(cat "$APP/data/bandroom.sqlite")" = "BEFORE 0.4.1 (newest)" ]' "newest matching backup restored"
check '[ ! -e "$APP/data/bandroom.sqlite-wal" ] && [ ! -e "$APP/data/bandroom.sqlite-shm" ]' "stale wal/shm removed"
check '[ "$(stat -c %a "$APP/data/bandroom.sqlite")" = 640 ]' "mode kept"
safety="$(ls "$BK"/bandroom-before-rollback-from-v0.4.1-*.sqlite | grep -v -- '-wal$')"
check '[ "$(cat "$safety")" = "NEW DATABASE" ] && [ "$(cat "$safety-wal")" = WAL ]' "current db saved first"
check 'grep -qx BANDROOM_TAG=v0.4.0 "$APP/.env" && ls "$APP"/.env.bak-* >/dev/null' ".env set, backed up"
check '[ "$(running_tag)" = v0.4.0 ]' "v0.4.0 running"
check 'grep -n "" "$FAKE_DOCKER_STATE/calls.log" | grep -q "compose stop"' "stopped first"

new_case rollback-no-backup
echo "ghcr.io/example/bandroom:v0.4.1" >"$FAKE_DOCKER_STATE/running"
mkdir -p "$BK"
echo x >"$BK/bandroom-before-v0.4.0-from-v0.3.9-20261005-100000.sqlite"
s="$(sum "$APP/.env")$(sum "$APP/data/bandroom.sqlite")"
run "$APP/deploy.sh" --rollback
check '[ $RC != 0 ]'
contains "No backup named bandroom-before-v0.4.1-from-"
check '[ "$(sum "$APP/.env")$(sum "$APP/data/bandroom.sqlite")" = "$s" ]' "nothing changed"
check '! grep -q "compose stop" "$FAKE_DOCKER_STATE/calls.log"' "nothing stopped"

new_case rollback-prev-not-a-tag
echo "ghcr.io/example/bandroom:v0.4.1" >"$FAKE_DOCKER_STATE/running"
mkdir -p "$BK"
echo x >"$BK/bandroom-before-v0.4.1-from-none-20261005-100000.sqlite"
run "$APP/deploy.sh" --rollback
check '[ $RC != 0 ] && ! grep -q "compose stop" "$FAKE_DOCKER_STATE/calls.log"' "aborted"
contains "'none', which is not a release tag"

new_case rollback-prev-image-missing
echo "ghcr.io/example/bandroom:v0.4.1" >"$FAKE_DOCKER_STATE/running"
mkdir -p "$BK"
echo x >"$BK/bandroom-before-v0.4.1-from-v0.3.0-20261005-100000.sqlite"
s="$(sum "$APP/.env")$(sum "$APP/data/bandroom.sqlite")"
run "$APP/deploy.sh" --rollback
check '[ $RC != 0 ] && ! grep -q "compose stop" "$FAKE_DOCKER_STATE/calls.log"' "aborted"
check '[ "$(sum "$APP/.env")$(sum "$APP/data/bandroom.sqlite")" = "$s" ]' "nothing changed"

# ---------------------------------------------------------------------------------------------
new_case status
rm "$APP/data/bandroom.sqlite"
# A migrated database with two songs (modules resolve from apps/server, hence stdin).
(cd "$REPO/apps/server" && DB_FILE="$APP/data/bandroom.sqlite" node --input-type=commonjs -) <<'JS'
const Database = require("better-sqlite3");
const { drizzle } = require("drizzle-orm/better-sqlite3");
const { migrate } = require("drizzle-orm/better-sqlite3/migrator");

const sqlite = new Database(process.env.DB_FILE);
migrate(drizzle(sqlite), { migrationsFolder: "drizzle" });
const now = Date.now();
const run = (sql, ...args) => sqlite.prepare(sql).run(...args);
run(
  "INSERT INTO users (id, username, display_name, password_hash, global_role, created_at) VALUES ('u1', 'tester', 'Tester', 'x', 'admin', ?)",
  now,
);
run(
  "INSERT INTO projects (id, name, owner_id, created_at, updated_at) VALUES ('p1', 'Demo project', 'u1', ?, ?)",
  now,
  now,
);
run(
  "INSERT INTO songs (id, project_id, title, created_at, updated_at) VALUES ('s1', 'p1', ?, ?, ?)",
  `Tom's "Song"; DROP TABLE songs; --`,
  now,
  now,
);
run(
  "INSERT INTO songs (id, project_id, title, created_at, updated_at, deleted_at) VALUES ('s2', 'p1', 'Old song', ?, ?, ?)",
  now,
  now,
  now,
);
run(
  "INSERT INTO assets (id, kind, original_filename, size_bytes, original_hash, status, probe, ingest_options, uploaded_by, created_at) VALUES ('a1', 'audio', 'bass.wav', 1048576, 'h1', 'ready', ?, ?, 'u1', ?)",
  JSON.stringify({ codec: "pcm_s24le", lossless: true }),
  JSON.stringify({ lossyOnly: false, opusPreset: "high" }),
  now,
);
for (const h of ["b1", "b2", "b3"])
  run(
    "INSERT INTO blobs (hash, size_bytes, storage_key, created_at) VALUES (?, 1, ?, ?)",
    h,
    h,
    now,
  );
run(
  "INSERT INTO asset_variants (asset_id, variant, blob_hash, meta, created_at) VALUES ('a1', 'opus', 'b1', ?, ?)",
  JSON.stringify({ codec: "opus", bitrate: 160, channels: 2 }),
  now,
);
run(
  "INSERT INTO asset_variants (asset_id, variant, blob_hash, created_at) VALUES ('a1', 'flac', 'b2', ?), ('a1', 'seekindex_opus', 'b3', ?)",
  now,
  now,
);
run(
  "INSERT INTO tracks (id, song_id, name, current_version_id, created_at) VALUES ('t1', 's1', 'Bass', 'v1', ?)",
  now,
);
run(
  "INSERT INTO track_versions (id, track_id, number, asset_id, source, created_at) VALUES ('v1', 't1', 1, 'a1', 'upload', ?)",
  now,
);
sqlite.close();
JS
mkdir -p "$BK"
echo x >"$BK/bandroom-before-v0.4.0-from-v0.3.9-20261005-100000.sqlite"
db_sum="$(sum "$APP/data/bandroom.sqlite")"
run "$APP/status.sh"
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "app: v0.4.0, running since"
contains "healthy"
contains ".env: BANDROOM_TAG=v0.4.0"
contains "bandroom-before-v0.4.0-from-v0.3.9-20261005-100000.sqlite"
contains '"level":40,"msg":"slow request"'
lacks '"msg":"listening"'

run "$APP/status.sh" song "'s \"Song\"; DROP"
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "Demo project / Tom's \"Song\"; DROP TABLE songs; -- (song s1)"
contains 'track "Bass"'
contains "v1 bass.wav [current]"
contains "codec pcm_s24le lossless"
contains "variants: flac, opus(160 kbps, 2 ch)"
lacks "seekindex"
contains '"opusPreset":"high"'
run "$APP/status.sh" song 'old'
contains "Old song [deleted"
cd "$C"
run "$APP/status.sh" song '$(touch pwned)`touch pwned2`'
cd "$REPO"
check '[ $RC = 0 ] && [ -z "$(find "$C" -name "pwned*")" ]' "no shell expansion"
contains "No song title contains that text."
run "$APP/status.sh" song ""
check '[ $RC != 0 ]' "empty fragment rejected"
run "$APP/status.sh" song "$(printf 'a\nb')"
check '[ $RC != 0 ]' "newline rejected"
run "$APP/status.sh" song a b
check '[ $RC != 0 ]' "extra argument rejected"

run "$APP/status.sh" uploads
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "1 audio upload(s) since"
contains "tester bass.wav (1.0 MB) -> Demo project / Tom's \"Song\"; DROP TABLE songs; -- / Bass v1"
run "$APP/status.sh" uploads 48
check '[ $RC = 0 ]'
for bad in abc 0 -1 1.5 "1;id" 123456 ""; do
  run "$APP/status.sh" uploads "$bad"
  check '[ $RC != 0 ]' "uploads '$bad' rejected"
done
run "$APP/status.sh" nonsense
check '[ $RC != 0 ]' "unknown command rejected"
check '[ "$(sum "$APP/data/bandroom.sqlite")" = "$db_sum" ]' "database unchanged"
check '! grep -qE "compose (stop|up|pull)|docker (pull|create|cp|rm)" "$FAKE_DOCKER_STATE/calls.log"' \
  "status made no changing docker calls"

# --- ops-watcher.sh (SPEC §29.8) -------------------------------------------------------------
export BANDROOM_OPS_ALLOW_NONROOT=1
UUID1=0192a7e4-1111-7000-8000-000000000001
OPS=""
watcher_case() {
  new_case "$1"
  OPS="$APP/data/ops"
  mkdir -p "$OPS"
  export BANDROOM_OPS_LOCK="$C/ops.lock"
}
request() { printf '%s' "$1" >"$OPS/request.json"; }
valid_json() { node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1"; }
result_of() { cat "$OPS/result-$1.json"; }
only_result() { find "$OPS" -maxdepth 1 -name 'result-*.json' | head -n 1; }
nothing_deployed() { ! grep -qE "compose (stop|up|pull)|docker pull" "$FAKE_DOCKER_STATE/calls.log"; }

watcher_case watcher-deploy
request "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"requestedBy\":\"boss\",\"ts\":1}"
run "$APP/ops-watcher.sh"
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "running deploy v0.4.1 (request $UUID1)"
contains "deploy.sh exited with 0"
check '[ "$(running_tag)" = v0.4.1 ]' "v0.4.1 running"
check '[ ! -e "$OPS/request.json" ] && [ ! -e "$OPS/running.json" ]' "request consumed"
check 'valid_json "$OPS/result-$UUID1.json"' "result is JSON"
check 'grep -q "\"exitCode\":0" "$OPS/result-$UUID1.json"' "exit code 0 recorded"
check 'grep -q "is healthy" "$OPS/result-$UUID1.json"' "output tail recorded"
check 'grep -q "is healthy" "$OPS/last.log"' "last.log written"
check '[ "$(stat -c %a "$OPS/result-$UUID1.json")" = 644 ]' "result readable by the app"
check 'valid_json "$OPS/host-status.json"' "host status is JSON"
check 'grep -q "\"tag\":\"v0.4.1\"" "$OPS/host-status.json"' "host status has the new tag"
check 'grep -q "\"service\":\"app\",\"state\":\"running\",\"health\":\"healthy\"" "$OPS/host-status.json"' \
  "container states"
check 'grep -q "\"backups\":{\"count\":1" "$OPS/host-status.json"' "backup count"
check '[ -z "$(find "$OPS" -name ".ops-watcher.*")" ]' "no temp files left"

watcher_case watcher-rollback
run "$APP/deploy.sh" v0.4.1
request "{\"id\":\"$UUID1\",\"action\":\"rollback\",\"tag\":null,\"requestedBy\":\"boss\",\"ts\":1}"
run "$APP/ops-watcher.sh"
check '[ $RC = 0 ]' "exit 0 (got $RC)"
contains "running rollback"
check '[ "$(running_tag)" = v0.4.0 ]' "rolled back to v0.4.0"
check 'grep -q "\"action\":\"rollback\",\"tag\":null,\"exitCode\":0" "$OPS/result-$UUID1.json"' \
  "rollback result"

watcher_case watcher-deploy-fails
request "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v9.9.9\",\"requestedBy\":\"boss\",\"ts\":1}"
run "$APP/ops-watcher.sh"
check '[ $RC = 0 ]' "the watcher itself succeeds"
check 'grep -q "\"exitCode\":1" "$OPS/result-$UUID1.json"' "deploy.sh failure recorded"
check 'grep -q "does not exist" "$OPS/result-$UUID1.json"' "with its message"
check '[ "$(running_tag)" = v0.4.0 ]' "still v0.4.0"

i=0
for bad in \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"latest\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1;id\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"\$(touch pwned)\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"\`touch pwned\`\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"tag\":\"v0.4.0\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"action\":\"rollback\",\"tag\":\"v0.4.1\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"shell\",\"tag\":\"v0.4.1\"}" \
  "{\"id\":\"../../etc/x\",\"action\":\"deploy\",\"tag\":\"v0.4.1\"}" \
  "{\"action\":\"deploy\",\"tag\":\"v0.4.1\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"x\":\"a\\\\nb\"}" \
  "$(printf '{"id":"%s",\n"action":"deploy","tag":"v0.4.1"}\n{"tag":"v0.4.0"}' "$UUID1")" \
  "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"pad\":\"$(head -c 5000 /dev/zero | tr '\0' a)\"}" \
  "{\"id\":\"$UUID1\",\"action\":\"déploy\",\"tag\":\"v0.4.1\"}" \
  ""; do
  i=$((i + 1))
  watcher_case "watcher-reject-$i"
  request "$bad"
  cd "$C"
  run "$APP/ops-watcher.sh"
  cd "$REPO"
  check '[ $RC = 0 ]' "watcher exit 0 for bad request $i"
  contains "rejected an invalid request"
  r="$(only_result)"
  check '[ -n "$r" ] && valid_json "$r"' "result written for bad request $i"
  check 'grep -q "\"exitCode\":2" "$r" && grep -q "invalid request" "$r"' "rejection recorded ($i)"
  check '[ -f "$OPS/rejected.json" ] && [ ! -e "$OPS/running.json" ]' "moved aside ($i)"
  check 'nothing_deployed' "nothing deployed for bad request $i"
  check '[ -z "$(find "$C" -name "pwned*")" ]' "no command ran ($i)"
done

watcher_case watcher-symlink-request
echo "secret" >"$C/secret"
ln -s "$C/secret" "$OPS/request.json"
run "$APP/ops-watcher.sh"
check '[ $RC = 0 ]'
contains "rejected an invalid request: not a regular file"
check '[ "$(cat "$C/secret")" = secret ] && nothing_deployed' "symlinked request refused"

watcher_case watcher-symlink-result
echo "keep" >"$C/target"
ln -s "$C/target" "$OPS/result-$UUID1.json"
ln -s "$C/target" "$OPS/host-status.json"
ln -s "$C/target" "$OPS/last.log"
request "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"requestedBy\":\"boss\",\"ts\":1}"
run "$APP/ops-watcher.sh"
check '[ $RC = 0 ]'
check '[ "$(cat "$C/target")" = keep ]' "planted symlinks are not followed"
check '[ ! -L "$OPS/result-$UUID1.json" ] && [ ! -L "$OPS/host-status.json" ] && [ ! -L "$OPS/last.log" ]' \
  "symlinks replaced by files"

watcher_case watcher-symlink-dir
rmdir "$OPS"
mkdir -p "$C/elsewhere"
ln -s "$C/elsewhere" "$OPS"
run "$APP/ops-watcher.sh"
check '[ $RC != 0 ]' "symlinked ops dir refused"
contains "is not a plain directory"
check '[ -z "$(ls -A "$C/elsewhere")" ]' "nothing written through the symlink"

watcher_case watcher-creates-dir
rmdir "$OPS"
run "$APP/ops-watcher.sh" --status-only
check '[ $RC = 0 ] && [ -d "$OPS" ] && valid_json "$OPS/host-status.json"' "ops dir created"

watcher_case watcher-interrupted
printf '{"id":"%s","action":"deploy","tag":"v0.4.1"}' "$UUID1" >"$OPS/running.json"
run "$APP/ops-watcher.sh"
check '[ $RC = 0 ]'
contains "found an interrupted request ($UUID1)"
check 'grep -q "\"exitCode\":3" "$OPS/result-$UUID1.json" && grep -q interrupted "$OPS/result-$UUID1.json"' \
  "interrupted run recorded"
check '[ ! -e "$OPS/running.json" ] && nothing_deployed' "cleaned up, nothing deployed"

watcher_case watcher-concurrent
request "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"requestedBy\":\"boss\",\"ts\":1}"
perl -MFcntl=:flock -e 'open(my $f, ">", $ARGV[0]) or die; flock($f, LOCK_EX) or die;
  open(my $r, ">", $ARGV[1]); close $r; sleep 5' "$BANDROOM_OPS_LOCK" "$C/locked" &
holder=$!
for _ in $(seq 1 50); do [ -e "$C/locked" ] && break; sleep 0.1; done
run "$APP/ops-watcher.sh"
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
check '[ $RC = 0 ]'
contains "another run is in progress"
check '[ -f "$OPS/request.json" ] && nothing_deployed' "request left for the running watcher"
run "$APP/ops-watcher.sh"
check '[ "$(running_tag)" = v0.4.1 ]' "handled once the lock is free"

watcher_case watcher-status-only
request "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"requestedBy\":\"boss\",\"ts\":1}"
mkdir -p "$BK" && echo db >"$BK/bandroom-before-v0.4.0-from-v0.3.0-20261001-000000.sqlite"
printf 'BANDROOM_TAG="$(id)"\n' >>"$APP/.env"
run "$APP/ops-watcher.sh" --status-only
check '[ $RC = 0 ]'
check 'valid_json "$OPS/host-status.json"' "host status is JSON"
check 'grep -q "\"tag\":\"invalid\"" "$OPS/host-status.json"' "odd .env tag not copied"
check 'grep -q "\"latest\":\"bandroom-before-v0.4.0-from-v0.3.0-20261001-000000.sqlite\"" "$OPS/host-status.json"' \
  "newest backup"
check '[ -f "$OPS/request.json" ] && nothing_deployed' "status-only leaves requests alone"

watcher_case watcher-args
run "$APP/ops-watcher.sh" --nope
check '[ $RC != 0 ]'
contains "Invalid argument"
run "$APP/ops-watcher.sh" a b
check '[ $RC != 0 ]'
run "$APP/ops-watcher.sh" --help
check '[ $RC = 0 ]'
contains "--status-only"
unset BANDROOM_OPS_ALLOW_NONROOT
run "$APP/ops-watcher.sh"
if [ "$(id -u)" != 0 ]; then check '[ $RC != 0 ]' "needs root"; fi

watcher_case watcher-prune
for n in $(seq 1 25); do
  id="$(printf '0192a7e4-1111-7000-8000-%012d' "$n")"
  echo '{}' >"$OPS/result-$id.json"
  touch -d "@$((1700000000 + n))" "$OPS/result-$id.json"
done
request "{\"id\":\"$UUID1\",\"action\":\"deploy\",\"tag\":\"v0.4.1\",\"requestedBy\":\"boss\",\"ts\":1}"
BANDROOM_OPS_ALLOW_NONROOT=1 run "$APP/ops-watcher.sh"
check '[ "$(find "$OPS" -name "result-*.json" | wc -l)" = 20 ] && [ -f "$OPS/result-$UUID1.json" ]' \
  "keeps the newest 20 results"

echo "deploy.test.sh: $passes passed, $failures failed"
[ "$failures" = 0 ]
