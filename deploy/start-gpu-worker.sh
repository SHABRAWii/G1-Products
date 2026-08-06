#!/usr/bin/env bash
# Reconnect only the model caches required by this worker's advertised stages,
# verify those environments, then start the real pipeline worker.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/deploy/training-runtime-common.sh"

PROMPTHMR_ROOT="${ROBOMOTION_PROMPTHMR_ROOT:-/opt/prompt-hmr}"
GMR_ROOT="${ROBOMOTION_GMR_ROOT:-/opt/gmr}"
TRAIN_ROOT="${ROBOMOTION_TRAIN_ROOT:-/opt/unitree-rl-mjlab}"
MODEL_CACHE="${ROBOMOTION_MODEL_CACHE:-/models}"
PROMPTHMR_ENV="${ROBOMOTION_PROMPTHMR_ENV:-phmr_pt2.4}"
GMR_ENV="${ROBOMOTION_GMR_ENV:-gmr}"
TRAIN_ENV="${ROBOMOTION_TRAIN_ENV:-unitree_rl_mjlab}"
WORKER_STAGES="${ROBOMOTION_WORKER_STAGES:-pose_extraction,robot_retargeting,visualization,training}"

fail() { printf 'GPU worker startup failed: %s\n' "$1" >&2; exit 1; }
has_stage() { [[ ",$WORKER_STAGES," == *",$1,"* ]]; }

NEEDS_PROMPTHMR=false
NEEDS_GMR=false
NEEDS_TRAINING=false
has_stage pose_extraction && NEEDS_PROMPTHMR=true
(has_stage robot_retargeting || has_stage visualization) && NEEDS_GMR=true
has_stage training && NEEDS_TRAINING=true

if $NEEDS_PROMPTHMR; then
  [[ -d "$MODEL_CACHE/prompthmr-data" ]] || fail "PromptHMR cache is missing. Check model-bootstrap logs."
  [[ -f "$MODEL_CACHE/prompthmr-data/.robomotion-checksums-v1.sha256" ]] || fail "PromptHMR integrity manifest is missing."
  rm -rf "$PROMPTHMR_ROOT/data"
  ln -s "$MODEL_CACHE/prompthmr-data" "$PROMPTHMR_ROOT/data"
  (
    cd "$PROMPTHMR_ROOT"
    conda run -n "$PROMPTHMR_ENV" python -c 'from pipeline.pipeline import Pipeline'
  ) || fail "PromptHMR environment is unavailable or incomplete."
fi

if $NEEDS_GMR; then
  [[ -d "$MODEL_CACHE/gmr-body-models" ]] || fail "GMR body-model cache is missing. Check model-bootstrap logs."
  rm -rf "$GMR_ROOT/assets/body_models"
  ln -s "$MODEL_CACHE/gmr-body-models" "$GMR_ROOT/assets/body_models"
  conda run -n "$GMR_ENV" python -c 'import general_motion_retargeting, mujoco, numpy, scipy' \
    || fail "GMR environment is unavailable or incomplete."
fi

if $NEEDS_TRAINING; then
  [[ -f "$TRAIN_ROOT/scripts/train.py" ]] || fail "unitree_rl_mjlab source is incomplete. Set ROBOMOTION_TRAIN_ROOT."
  robomotion_configure_training_runtime "$TRAIN_ENV" "${ROBOMOTION_TRAIN_PYTHON:-}" \
    || fail "The $TRAIN_ENV training environment cannot be resolved."
  robomotion_training_cpp_runtime_ready \
    || fail "The training environment libstdc++ does not provide CXXABI_1.3.15."
  robomotion_training_exec -c 'import mjlab, torch; assert torch.__version__.startswith("2.12."); assert torch.version.cuda == "12.6"' \
    || fail "Training environment is unavailable or does not match the verified torch 2.12/CUDA 12.6 contract."
  bash /app/deploy/verify-training-runtime.sh \
    || fail "The deterministic training runtime verification failed."
fi

printf 'GPU environments verified for stages: %s\n' "$WORKER_STAGES"
exec npm run worker
