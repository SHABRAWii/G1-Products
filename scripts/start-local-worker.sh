#!/usr/bin/env bash
# Start the dashboard worker with the same local configuration used by Next.js.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -r "$PROJECT_ROOT/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

MODEL_ENV="${ROBOMOTION_WORKER_MODELS_ENV:-$PROJECT_ROOT/.robomotion/worker-models.env}"
if [[ -r "$MODEL_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$MODEL_ENV"
fi

case "${1:-motion}" in
  motion)
    export ROBOMOTION_WORKER_ID="${ROBOMOTION_WORKER_ID:-local-pipeline-worker-motion}"
    export ROBOMOTION_WORKER_STAGES="${ROBOMOTION_WORKER_STAGES:-pose_extraction,robot_retargeting,visualization}"
    ;;
  training)
    export ROBOMOTION_WORKER_ID="${ROBOMOTION_WORKER_ID:-local-pipeline-worker-training}"
    export ROBOMOTION_WORKER_STAGES="${ROBOMOTION_WORKER_STAGES:-training}"
    ;;
  *) printf 'Usage: %s [motion|training]\n' "$0" >&2; exit 2 ;;
esac

exec "$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/scripts/pipeline-worker.ts"
