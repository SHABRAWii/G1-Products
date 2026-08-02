#!/usr/bin/env bash
set -euo pipefail

PLANE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$PLANE_ROOT/.." && pwd)"
ENV_FILE="${ROBOMOTION_GPU_ENV:-$PLANE_ROOT/.env}"

[[ -r "$ENV_FILE" ]] || {
  printf 'Missing %s. Copy gpu-plane/.env.example and fill it first.\n' "$ENV_FILE" >&2
  exit 1
}

cd "$PROJECT_ROOT"
docker compose --env-file "$ENV_FILE" -f gpu-plane/docker-compose.yml up --build -d
docker compose --env-file "$ENV_FILE" -f gpu-plane/docker-compose.yml ps
