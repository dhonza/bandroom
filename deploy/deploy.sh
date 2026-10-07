#!/usr/bin/env bash
# Pull and restart the stack on the VPS, then verify health (SPEC §19.3).
# Run by the owner ON THE SERVER, in the application directory (e.g. sudo /opt/bandroom/deploy.sh).
set -euo pipefail

cd "$(dirname "$0")"
docker compose pull
docker compose up -d --remove-orphans

for _ in $(seq 1 30); do
  if docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    echo "BandRoom is healthy."
    exit 0
  fi
  sleep 2
done
echo "Health check failed; see: docker compose logs app" >&2
exit 1
