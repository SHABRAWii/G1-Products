#!/usr/bin/env bash
# Reconnect the immutable model source trees to bootstrap's persistent cache,
# verify both Conda environments, then start the real pipeline worker.
set -euo pipefail

PROMPTHMR_ROOT="${ROBOMOTION_PROMPTHMR_ROOT:-/opt/prompt-hmr}"
GMR_ROOT="${ROBOMOTION_GMR_ROOT:-/opt/gmr}"
MODEL_CACHE="${ROBOMOTION_MODEL_CACHE:-/models}"
PROMPTHMR_ENV="${ROBOMOTION_PROMPTHMR_ENV:-phmr_pt2.4}"
GMR_ENV="${ROBOMOTION_GMR_ENV:-gmr}"

fail() { printf 'GPU worker startup failed: %s\n' "$1" >&2; exit 1; }

[[ -d "$MODEL_CACHE/prompthmr-data" ]] || fail "PromptHMR cache is missing. Check model-bootstrap logs."
[[ -d "$MODEL_CACHE/gmr-body-models" ]] || fail "GMR body-model cache is missing. Check model-bootstrap logs."
[[ -f "$MODEL_CACHE/prompthmr-data/.robomotion-checksums-v1.sha256" ]] || fail "PromptHMR integrity manifest is missing."

# These paths live in the disposable worker container. Removing them cannot
# delete the mounted /models cache; it only replaces image-baked placeholders.
rm -rf "$PROMPTHMR_ROOT/data" "$GMR_ROOT/assets/body_models"
ln -s "$MODEL_CACHE/prompthmr-data" "$PROMPTHMR_ROOT/data"
ln -s "$MODEL_CACHE/gmr-body-models" "$GMR_ROOT/assets/body_models"

conda run -n "$PROMPTHMR_ENV" python -c 'from pipeline.pipeline import Pipeline' \
  || fail "PromptHMR environment is unavailable or incomplete."
conda run -n "$GMR_ENV" python -c 'import general_motion_retargeting' \
  || fail "GMR environment is unavailable or incomplete."

printf 'GPU model environments verified; starting RoboMotion worker.\n'
exec npm run worker
