#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS=()

stop_all() {
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    kill -TERM "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap stop_all EXIT INT TERM

cd "$PROJECT_ROOT"
setsid npm run dev -- --hostname "${DEV_HOST:-0.0.0.0}" --port "${DEV_PORT:-3000}" &
PIDS+=("$!")
setsid npm run worker:motion &
PIDS+=("$!")
setsid npm run worker:training &
PIDS+=("$!")
setsid npm run worker:export &
PIDS+=("$!")

printf 'RoboMotion development stack started at http://%s:%s\n' "${DEV_HOST:-0.0.0.0}" "${DEV_PORT:-3000}"
printf 'Processes: web=%s motion=%s training=%s export=%s\n' "${PIDS[@]}"
wait -n "${PIDS[@]}"
