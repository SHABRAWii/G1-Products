#!/usr/bin/env bash
# Show service health and optionally follow model/worker logs.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROBOMOTION_SERVER_ENV:-$PROJECT_ROOT/.env.server}"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.server.yml"
FOLLOW="${1:-}"

[[ -r "$ENV_FILE" ]] || { printf 'Missing %s.\n' "$ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$PROJECT_ROOT"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile gpu ps
printf '\nDashboard health:\n'
curl --fail --silent --show-error "http://${APP_BIND_ADDRESS:-127.0.0.1}:${APP_PORT:-3000}/api/health" || true
printf '\n\nRecent bootstrap and worker logs:\n'
if [[ "$FOLLOW" == "--follow" || "$FOLLOW" == "-f" ]]; then
  exec docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile gpu logs --tail=80 -f model-bootstrap motion-worker training-worker
fi
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile gpu logs --tail=40 model-bootstrap motion-worker training-worker
