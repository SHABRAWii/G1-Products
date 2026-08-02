#!/usr/bin/env bash
set -euo pipefail

PLANE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$PLANE_ROOT/.." && pwd)"
ENV_FILE="${ROBOMOTION_CONTROL_ENV:-$PLANE_ROOT/.env}"

cd "$PROJECT_ROOT"
docker compose --env-file "$ENV_FILE" -f control-plane/docker-compose.yml ps
docker compose --env-file "$ENV_FILE" -f control-plane/docker-compose.yml logs \
  --tail 30 app artifact-export-worker runpod-controller 2>/dev/null || true
