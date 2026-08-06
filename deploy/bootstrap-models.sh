#!/usr/bin/env bash
# Prepare the persistent GPU runtime once per installation contract. Warm pod
# starts use cheap file checks plus a versioned marker instead of importing all
# model engines and hashing multi-gigabyte checkpoints again.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROBOMOTION_MODEL_ROOT="${ROBOMOTION_MODEL_ROOT:-/models}"
MODEL_CACHE="${ROBOMOTION_MODEL_CACHE:-$ROBOMOTION_MODEL_ROOT/cache}"
CONDA_ENVS_PATH="${CONDA_ENVS_PATH:-/workspace/conda-envs}"
MARKER="$ROBOMOTION_MODEL_ROOT/.gpu-runtime-contract-v1.sha256"

contract_fingerprint() {
  sha256sum \
    "$PROJECT_ROOT/deploy/install-direct-models.sh" \
    "$PROJECT_ROOT/deploy/verify-training-runtime.sh" \
    "$PROJECT_ROOT/deploy/training-runtime-common.sh" \
    "$PROJECT_ROOT/deploy/patches/unitree_rl_mjlab-robomotion.patch" \
    | sha256sum | awk '{print $1}'
}

runtime_files_present() {
  [[ -r "$ROBOMOTION_MODEL_ROOT/worker-models.env" ]] \
    && [[ -x "$CONDA_ENVS_PATH/phmr_pt2.4/bin/python" ]] \
    && "$CONDA_ENVS_PATH/phmr_pt2.4/bin/python" -c 'import chumpy, smplx' >/dev/null 2>&1 \
    && [[ -x "$CONDA_ENVS_PATH/gmr/bin/python" ]] \
    && [[ -x "$CONDA_ENVS_PATH/unitree_rl_mjlab/bin/python" ]] \
    && [[ -f "$MODEL_CACHE/prompthmr-data/.robomotion-checksums-v1.sha256" ]] \
    && [[ -d "$MODEL_CACHE/gmr-body-models" ]]
}

fingerprint="$(contract_fingerprint)"
if [[ "${ROBOMOTION_FORCE_MODEL_VERIFY:-0}" != "1" ]] \
  && runtime_files_present \
  && [[ -r "$MARKER" ]] \
  && [[ "$(<"$MARKER")" == "$fingerprint" ]]; then
  printf 'Persistent GPU runtime ready (contract %s); skipping full installation verification.\n' "${fingerprint:0:12}"
  exit 0
fi

bash "$PROJECT_ROOT/deploy/install-direct-models.sh"
runtime_files_present || {
  printf 'GPU runtime installation finished without all required persistent files.\n' >&2
  exit 1
}
tmp_marker="$MARKER.tmp.$$"
printf '%s\n' "$fingerprint" > "$tmp_marker"
chmod 600 "$tmp_marker"
mv -f "$tmp_marker" "$MARKER"
printf 'Persistent GPU runtime contract recorded: %s.\n' "${fingerprint:0:12}"
