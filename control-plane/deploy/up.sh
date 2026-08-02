#!/usr/bin/env bash
set -euo pipefail

PLANE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$PLANE_ROOT/.." && pwd)"
ENV_FILE="${ROBOMOTION_CONTROL_ENV:-$PLANE_ROOT/.env}"
PROFILE=()

[[ -r "$ENV_FILE" ]] || {
  printf 'Missing %s. Copy control-plane/.env.example and fill it first.\n' "$ENV_FILE" >&2
  exit 1
}
if grep -Eq '^RUNPOD_API_KEY=.+$' "$ENV_FILE" && grep -Eq '^RUNPOD_POD_ID=.+$' "$ENV_FILE"; then
  PROFILE=(--profile runpod)
fi

cd "$PROJECT_ROOT"
docker compose \
  --env-file "$ENV_FILE" \
  -f control-plane/docker-compose.yml \
  "${PROFILE[@]}" \
  up --build -d
docker compose \
  --env-file "$ENV_FILE" \
  -f control-plane/docker-compose.yml \
  "${PROFILE[@]}" \
  ps
