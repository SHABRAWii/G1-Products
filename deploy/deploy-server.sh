#!/usr/bin/env bash
# Validate, build, migrate, bootstrap models, and start the production stack.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROBOMOTION_SERVER_ENV:-$PROJECT_ROOT/.env.server}"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.server.yml"

[[ -r "$ENV_FILE" ]] || { printf 'Missing %s. Run bash deploy/prepare-server.sh first.\n' "$ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$PROJECT_ROOT"
bash deploy/server-preflight.sh
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile gpu config --quiet
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile gpu up --build -d
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile gpu ps

printf '\nRoboMotion deployment started. Model bootstrap is idempotent and may take a long time on the first run.\n'
printf 'Follow progress:\n  bash deploy/server-status.sh --follow\n'
printf 'Dashboard health:\n  curl http://%s:%s/api/health\n' "${APP_BIND_ADDRESS:-127.0.0.1}" "${APP_PORT:-3000}"
