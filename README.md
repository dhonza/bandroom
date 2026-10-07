# BandRoom

A self-hosted web app where a band keeps its recordings, rehearses with them and talks about them.
It is built for one band on one small server (1 vCPU, 1 GB RAM).

## Features

- **Projects → songs → tracks**, each track with a stack of versions (upload a new take, compare,
  switch back).
- **Multitrack player in the browser**: sample-accurate playback of all tracks with mute, solo,
  volume and pan, a click from the song's tempo map, loops with count-in, and personal mixer
  snapshots.
- **Markers, sections and time-coded comments** on a zoomable timeline, with notifications.
- **Documents** next to the songs: Markdown, text, PDF, images, MIDI.
- **Public links** to a song or project, optionally with a password and an expiry date.
- **Offline playback** as an installable PWA.
- **Accounts and permissions** per project and per song, per-user storage quotas, a detailed
  activity log, Trash, and an importer for Samply projects.
- English and Czech user interface, dark and light themes, usable on phones.

## Stack

TypeScript everywhere (pnpm workspaces): React, Vite and Mantine on the web; Fastify, Zod, SQLite
(better-sqlite3) and Drizzle on the server; a worker that runs ffmpeg and poppler jobs one at a
time; and a custom audio engine (AudioWorklet mixer with WebAssembly decoders in Web Workers).

```
apps/web  apps/server  apps/worker
packages/shared  packages/server-core  packages/audio-engine
tools/fixtures  deploy  .github/workflows
```

## Development

Requirements: Node 24 (see `.node-version`), pnpm 12, ffmpeg and poppler-utils (for the worker and
the tests).

```bash
pnpm install              # install (better-sqlite3 uses bundled prebuilds; no compiler needed)
pnpm dev                  # web (Vite :5180) + server (:3100) + worker in watch mode; data in ./.data
pnpm --filter server cli create-admin   # create the first admin account
pnpm lint                 # ESLint (incl. i18n literal-string rule)
pnpm typecheck            # tsc --noEmit across workspaces
pnpm test                 # Vitest unit + integration
pnpm test:e2e:install     # one-time: download Playwright browsers into ./.cache
pnpm test:e2e             # build + Playwright (Chromium, WebKit, iPhone/Pixel; root + /bandroom)
pnpm i18n:check           # verify every locale has all English keys
pnpm db:generate          # drizzle-kit: create a migration from schema changes
pnpm fixtures             # generate audio and MIDI test fixtures (needs ffmpeg)
pnpm build                # production build of all apps
```

Copy `.env.example` to `.env` for local settings.

## Deployment

BandRoom runs as Docker Compose (Caddy, app, worker). Images are built by GitHub Actions and
published as `ghcr.io/dhonza/bandroom`. See [`deploy/host-setup.md`](deploy/host-setup.md) for
setting up a VPS, and `deploy/compose.local.yml` for trying the containers locally:

```bash
docker compose -f deploy/compose.yml -f deploy/compose.local.yml up --build
```

## License

[MIT](LICENSE) © 2026 Jan Drchal

Samply is a trademark of its owner; BandRoom is not affiliated with or endorsed by Samply.
