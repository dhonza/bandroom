# BandRoom HTTP API

BandRoom's web app talks to a JSON API, and scripts can use the same API with an **API key**: a
Reaper script that uploads renders, a backup job, or the `brctl` CLI in this repository
(`pnpm remote …`). The endpoints are defined once with Zod in `packages/shared/src/api/`, so
those files are the reference for every request and response shape; this page explains the parts
that matter for a client.

## Base URL

Everything lives below the instance URL, which may include a sub-path:

```text
APP=https://bandroom.example.com            # or https://example.com/some/path
API=$APP/api/v1
```

Paths below are relative to `$API`. Health is outside it: `GET $APP/healthz`.

## Authentication and scopes

Create a key in **Settings → API keys**. It is shown once; store it like a password. Send it on
every request:

```bash
KEY=brk_...   # your key
curl -fsS -H "Authorization: Bearer $KEY" "$API/whoami"
```

A key acts as its user, with that user's rights, narrowed to its **scopes**:

| Scope        | Allows                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `read`       | `GET` requests: projects, songs, tracks, versions, downloads you can see                        |
| `write`      | also `POST`/`PATCH`/`PUT`/`DELETE` and uploads (includes `read`)                                |
| `admin:read` | admins only: `GET /admin/...` (system status, jobs, events, storage, logs)                      |
| `admin:ops`  | admins only: changing `/admin/...` (job retry/cancel, updates, settings); includes `admin:read` |

Admin scopes give no content access; combine them with `read`/`write` if needed. Keys never reach
login/logout, sessions, password changes, API key management, personal secrets, the admin
management of users and invites, or the live event stream (`/stream`). Requests with a key need
no `X-Requested-With` header (browsers send it for cookie sessions).

`GET /whoami` is the "test connection" call: user, key name, scopes and expiry, server version,
`maxUploadBytes`, and storage used / quota.

## Errors

Errors are JSON with a stable code:

```json
{ "code": "API_KEY_SCOPE", "message": "The API key may not call this route" }
```

Common codes: `API_KEY_INVALID` (401: unknown, revoked or expired key, or a disabled user),
`API_KEY_SCOPE` (403: the key's scopes do not cover the route), `FORBIDDEN` (403: the user lacks
the right), `NOT_FOUND` (404, also for things you may not see), `VALIDATION_FAILED` (400, with
`fieldErrors`), `RATE_LIMITED` (429, `params.retryAfterSec`), `QUOTA_EXCEEDED` (413),
`FILE_TOO_LARGE` (413), `DUPLICATE_VERSION` (409, see below). The full list is
`packages/shared/src/errors.ts`.

## Projects, songs and tracks

```bash
H="Authorization: Bearer $KEY"
curl -fsS -H "$H" "$API/projects"                     # {projects: [{id, name, songCount, ...}]}
curl -fsS -H "$H" "$API/projects/$PROJECT/songs"      # {songs: [{id, title, ...}]}
curl -fsS -H "$H" "$API/songs/$SONG/tracks"           # {tracks: [{id, name, current: {id, number, status, ...}}]}
curl -fsS -H "$H" "$API/tracks/$TRACK/versions"       # {versions: [{id, number, status, ...}]}

# Create a song (needs `write` and the song.create right in the project):
curl -fsS -H "$H" -H "Content-Type: application/json" \
  -d '{"title":"New song"}' "$API/projects/$PROJECT/songs"   # {song: {id, ...}}
```

## Uploading audio (tus)

Uploads use the [tus 1.0](https://tus.io/protocols/resumable-upload) protocol at `$API/uploads`;
plain `curl` is enough. The `Upload-Metadata` header carries base64 values of `filename` and
`target` (JSON):

- a new track in a song: `{"type":"newTrack","songId":"…","name":"Bass"}`
- a new version of a track: `{"type":"newVersion","trackId":"…","sha256":"<hex>"}`

`sha256` is optional: when it equals the SHA-256 of the track's current version, the upload is
refused at once with `409 DUPLICATE_VERSION`, so rendering again without changes uploads nothing.

```bash
FILE=render.wav
SIZE=$(wc -c <"$FILE" | tr -d ' ')
SHA=$(shasum -a 256 "$FILE" | cut -d' ' -f1)          # sha256sum on Linux
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
TARGET="{\"type\":\"newVersion\",\"trackId\":\"$TRACK\",\"sha256\":\"$SHA\"}"

# 1. Create the upload; the answer's Location header is the upload URL.
LOCATION=$(curl -fsS -o /dev/null -D - -X POST "$API/uploads" -H "$H" \
  -H "Tus-Resumable: 1.0.0" -H "Upload-Length: $SIZE" \
  -H "Upload-Metadata: filename $(b64 "$(basename "$FILE")"),target $(b64 "$TARGET")" |
  tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
case "$LOCATION" in /*) LOCATION="$(printf '%s' "$APP" | sed -E 's#^(https?://[^/]+).*#\1#')$LOCATION" ;; esac

# 2. Send the bytes (one PATCH here; large files can be sent in several, each with its offset).
curl -fsS -X PATCH "$LOCATION" -H "$H" -H "Tus-Resumable: 1.0.0" \
  -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" \
  --data-binary @"$FILE"
# -> {"assetId":"…","trackId":"…","trackVersionId":"…"}
```

The last `PATCH` answers with the created track and version. An interrupted upload can continue:
`HEAD $LOCATION` returns `Upload-Offset`, then `PATCH` from there. Quota, the maximum size and free
disk are checked when the upload is created.

## Waiting for processing

A new version is processed in the background (`queued` → `processing` → `ready`, or `failed`).
Poll the track's versions every few seconds:

```bash
curl -fsS -H "$H" "$API/tracks/$TRACK/versions"   # versions[].id == trackVersionId, .status
```

## Create a song and upload stems

The whole flow with curl: create a project (or use an existing one), create a song, then one
`newTrack` upload per stem. `options` in the target is optional: `quality` is the Opus preset
(`veryHigh`, `high`, `standard`, `low`) and `lossyOnly: true` keeps only Opus.

```bash
JSON="Content-Type: application/json"
PROJECT=$(curl -fsS -H "$H" -H "$JSON" -d '{"name":"Demos"}' "$API/projects" |
  grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
SONG=$(curl -fsS -H "$H" -H "$JSON" -d '{"title":"New song"}' "$API/projects/$PROJECT/songs" |
  grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

for FILE in stems/*.wav; do
  NAME=$(basename "$FILE" .wav)
  SIZE=$(wc -c <"$FILE" | tr -d ' ')
  TARGET="{\"type\":\"newTrack\",\"songId\":\"$SONG\",\"name\":\"$NAME\",\"options\":{\"quality\":\"high\",\"lossyOnly\":false}}"
  LOCATION=$(curl -fsS -o /dev/null -D - -X POST "$API/uploads" -H "$H" \
    -H "Tus-Resumable: 1.0.0" -H "Upload-Length: $SIZE" \
    -H "Upload-Metadata: filename $(b64 "$(basename "$FILE")"),target $(b64 "$TARGET")" |
    tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
  case "$LOCATION" in /*) LOCATION="$(printf '%s' "$APP" | sed -E 's#^(https?://[^/]+).*#\1#')$LOCATION" ;; esac
  curl -fsS -X PATCH "$LOCATION" -H "$H" -H "Tus-Resumable: 1.0.0" \
    -H "Upload-Offset: 0" -H "Content-Type: application/offset+octet-stream" \
    --data-binary @"$FILE"
  echo
done
```

Upload one file at a time: the server processes them in order anyway. `pnpm remote upload-song`
does the same, and names the tracks like the web folder upload (the files' common prefix removed).

## brctl

`pnpm remote <command>` (in a checkout of this repository) wraps the API: `whoami`, `status`,
`projects`, `songs`, `tracks`, `find-song`, `upload <file> --song <id> (--track <id> | --name <n>)`,
`create-project <name>`, `create-song <projectId> <title>`,
`upload-song <folder> --project <id> [--title T]` (a new song, one track per audio file in the
folder), `upload-project <folder> [--project <id> | --name N]` (each subfolder with audio a song,
loose files one more song named after the folder), the admin commands (`jobs`, `events`, `logs`, `storage`, `uploads`, `users`, `keys`) and
`update check | status | request | rollback | cancel`. It reads `BANDROOM_URL` (the instance URL,
with its sub-path) and `BANDROOM_API_KEY` from the environment or from a gitignored `.env.remote`
in the repository root. Uploads take `--quality veryHigh|high|standard|low`, `--lossy-only` and
`--wait`; the folder uploads also take `--dry-run` (print the plan, write nothing). They skip
non-audio files and zips (unzip them first), refuse a song title the project already has, continue
after a failed file and exit non-zero with the list of failures. Add `--json` for machine-readable
output; `pnpm remote help` lists every option.
