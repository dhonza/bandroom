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
      "$FAKE_DOCKER_STATE/registry/$t/deploy/"
  done
  cp "$REPO"/deploy/{deploy.sh,status.sh,compose.yml} "$APP/"
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

echo "deploy.test.sh: $passes passed, $failures failed"
[ "$failures" = 0 ]
