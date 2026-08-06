#!/usr/bin/env bash
# Deterministically verify the installed training source, patch, and CUDA stack.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRAIN_ROOT="${ROBOMOTION_TRAIN_ROOT:-$PROJECT_ROOT/.robomotion/sources/unitree_rl_mjlab}"
TRAIN_ENV="${ROBOMOTION_TRAIN_ENV:-unitree_rl_mjlab}"
TRAIN_PYTHON="${ROBOMOTION_TRAIN_PYTHON:-}"
TRAIN_REF="${ROBOMOTION_TRAIN_REF:-1425b15f73bd4095f0df53709d7c389c3eb9e790}"
PATCH="$PROJECT_ROOT/deploy/patches/unitree_rl_mjlab-robomotion.patch"
source "$PROJECT_ROOT/deploy/training-runtime-common.sh"

fail() { printf 'Training runtime verification failed: %s\n' "$1" >&2; exit 1; }
[[ -f "$TRAIN_ROOT/scripts/train.py" ]] || fail "unitree_rl_mjlab source is missing at $TRAIN_ROOT."
[[ "$(git -C "$TRAIN_ROOT" rev-parse HEAD)" == "$TRAIN_REF" ]] || fail "unitree_rl_mjlab is not at the pinned commit $TRAIN_REF."
git -C "$TRAIN_ROOT" apply --reverse --check "$PATCH" >/dev/null 2>&1 || fail "The RoboMotion training patch is not applied cleanly."
robomotion_configure_training_runtime "$TRAIN_ENV" "$TRAIN_PYTHON" || fail "Unable to resolve the $TRAIN_ENV training environment."
robomotion_training_cpp_runtime_ready || fail "The training environment libstdc++ does not provide CXXABI_1.3.15."
PYTHONPATH="$TRAIN_ROOT${PYTHONPATH:+:$PYTHONPATH}" ROBOMOTION_VERIFY_TRAIN_ROOT="$TRAIN_ROOT" robomotion_training_exec -c '
from pathlib import Path
import os
import torch, mjlab, scipy, mujoco, warp, src
from src.tasks.tracking.rl.runner import MotionTrackingOnPolicyRunner
assert torch.__version__.startswith("2.12."), torch.__version__
assert torch.version.cuda == "13.0", torch.version.cuda
source = Path(src.__file__).resolve()
root = Path(os.environ["ROBOMOTION_VERIFY_TRAIN_ROOT"]).resolve()
assert source.is_relative_to(root), (source, root)
assert hasattr(MotionTrackingOnPolicyRunner, "_save_best_checkpoint")
print(f"training runtime ready: torch={torch.__version__} cuda={torch.version.cuda} mjlab={mjlab.__file__}")
' || fail "Python imports or the pinned torch/CUDA contract failed."
PYTHONPATH="$TRAIN_ROOT${PYTHONPATH:+:$PYTHONPATH}" robomotion_training_exec "$TRAIN_ROOT/scripts/train.py" Unitree-G1-Tracking-No-State-Estimation --help >/dev/null \
  || fail "The patched training CLI cannot be imported."
printf 'Training runtime verification passed.\n'
