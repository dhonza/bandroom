# syntax=docker/dockerfile:1.7
# BandRoom image: API server and worker share it (SPEC §19.2). Built in CI for linux/amd64;
# `compose.local.yml` builds it locally for development testing only.

ARG NODE_VERSION=24.21.0
ARG DEBIAN=bookworm
# Static ffmpeg/ffprobe (libopus, libsoxr, …); keeps GPU/speech libs out of the image
# (decision log, "Static ffmpeg"). Same major version as the dev machines.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:8.1.2

# ---------------------------------------------------------------------------------------------
FROM ${FFMPEG_IMAGE} AS ffmpeg

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN}-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.6.0
WORKDIR /repo

# Fetch dependencies from the lockfile alone, so this layer is cached across source changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm --filter web --filter server --filter worker build

# Self-contained production installs of the two Node apps (workspace packages are bundled).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter server deploy --prod --legacy /out/apps/server \
 && pnpm --filter worker deploy --prod --legacy /out/apps/worker \
 && rm -rf /out/apps/server/src /out/apps/worker/src \
 && mkdir -p /out/apps/web && cp -r apps/web/dist /out/apps/web/dist

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN}-slim AS runtime
ARG APP_VERSION=0.0.0-local

# Media tools (SPEC §5.3, §5.7): static ffmpeg/ffprobe (with libopus + libsoxr) and pdftoppm.
# Waveform peaks are computed in Node (decision log), so audiowaveform is not needed.
COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && ffmpeg -hide_banner -version | head -1 && pdftoppm -v

WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
RUN printf '#!/bin/sh\nexec node /app/apps/server/dist/cli.js "$@"\n' > /usr/local/bin/bandroom \
 && chmod +x /usr/local/bin/bandroom \
 && mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/apps/web/dist \
    PORT=3000 \
    APP_VERSION=${APP_VERSION}

USER node
VOLUME ["/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--max-old-space-size=256", "apps/server/dist/main.js"]
