#!/usr/bin/env bash
# Shared training-environment resolution. The mjlab environment carries a
# newer C++ runtime than the base image; keep it scoped to training commands so
# PromptHMR and GMR continue using their independently pinned environments.

robomotion_configure_training_runtime() {
  local environment="$1"
  local python_override="${2:-}"
  local prefix

  if [[ -n "$python_override" ]]; then
    [[ -x "$python_override" ]] || return 1
    prefix="$(cd "$(dirname "$python_override")/.." && pwd)"
  else
    prefix="$(
      conda env list --json |
        python -c 'import json, pathlib, sys
name = sys.argv[1]
matches = [path for path in json.load(sys.stdin).get("envs", []) if pathlib.Path(path).name == name]
if len(matches) != 1:
    raise SystemExit(f"expected one Conda environment named {name!r}, found {len(matches)}")
print(matches[0])' "$environment"
    )" || return 1
  fi

  [[ -x "$prefix/bin/python" ]] || return 1
  ROBOMOTION_TRAIN_PREFIX="$prefix"
  ROBOMOTION_TRAIN_PYTHON="$prefix/bin/python"
  ROBOMOTION_TRAIN_LIBRARY_PATH="$prefix/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export ROBOMOTION_TRAIN_PREFIX ROBOMOTION_TRAIN_PYTHON ROBOMOTION_TRAIN_LIBRARY_PATH
}

robomotion_training_exec() {
  [[ -n "${ROBOMOTION_TRAIN_PYTHON:-}" ]] || return 1
  [[ -n "${ROBOMOTION_TRAIN_LIBRARY_PATH:-}" ]] || return 1
  env LD_LIBRARY_PATH="$ROBOMOTION_TRAIN_LIBRARY_PATH" "$ROBOMOTION_TRAIN_PYTHON" "$@"
}

robomotion_training_cpp_runtime_ready() {
  local library="${ROBOMOTION_TRAIN_PREFIX:-}/lib/libstdc++.so.6"
  [[ -f "$library" ]] && strings "$library" | grep -x 'CXXABI_1.3.15' >/dev/null
}
