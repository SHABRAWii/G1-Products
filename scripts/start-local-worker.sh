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
    # Resolve the direct environment Python and its Conda-owned C++ runtime.
    # Keeping this scoped in ROBOMOTION_TRAIN_LIBRARY_PATH prevents the
    # training ABI from affecting the Node process or motion environments.
    # shellcheck disable=SC1091
    source "$PROJECT_ROOT/deploy/training-runtime-common.sh"
    robomotion_configure_training_runtime "${ROBOMOTION_TRAIN_ENV:-unitree_rl_mjlab}" "${ROBOMOTION_TRAIN_PYTHON:-}" \
      || { printf 'Training environment could not be resolved. Run deploy/install-direct-models.sh first.\n' >&2; exit 1; }
    robomotion_training_cpp_runtime_ready \
      || { printf 'Training C++ runtime is incomplete. Run deploy/install-direct-models.sh to repair it.\n' >&2; exit 1; }
    ;;
  *) printf 'Usage: %s [motion|training]\n' "$0" >&2; exit 2 ;;
esac

exec "$PROJECT_ROOT/node_modules/.bin/tsx" "$PROJECT_ROOT/scripts/pipeline-worker.ts"
