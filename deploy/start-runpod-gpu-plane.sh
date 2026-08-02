#!/usr/bin/env bash
# RunPod entry point: establish restricted control-plane tunnels, reuse the
# persistent model/Conda cache, validate model engines, then advertise one GPU
# worker. One worker intentionally serializes GPU stages on the single GPU.
set -euo pipefail

fail() { printf 'RunPod GPU startup failed: %s\n' "$1" >&2; exit 1; }
required() { [[ -n "${!1:-}" ]] || fail "$1 is required."; }

WORKSPACE="${ROBOMOTION_RUNPOD_WORKSPACE:-/workspace}"
SSH_DIR="$WORKSPACE/.ssh"
SSH_KEY="$SSH_DIR/control-plane"
SSH_KNOWN_HOSTS="$SSH_DIR/known_hosts"

required ROBOMOTION_CONTROL_SSH_HOST
required ROBOMOTION_CONTROL_SSH_USER
required ROBOMOTION_CONTROL_SSH_KEY
required ROBOMOTION_CONTROL_SSH_KNOWN_HOSTS
required ROBOMOTION_DB_PASSWORD
required OBJECT_STORAGE_ACCESS_KEY
required OBJECT_STORAGE_SECRET_KEY

export ROBOMOTION_MODEL_ROOT="${ROBOMOTION_MODEL_ROOT:-$WORKSPACE/robomotion}"
export ROBOMOTION_MODEL_CACHE="${ROBOMOTION_MODEL_CACHE:-$WORKSPACE/models}"
export CONDA_ENVS_PATH="${CONDA_ENVS_PATH:-$WORKSPACE/conda-envs}"
export CONDA_PKGS_DIRS="${CONDA_PKGS_DIRS:-$WORKSPACE/conda-pkgs}"
export ROBOMOTION_WORKER_ID="${ROBOMOTION_WORKER_ID:-runpod-rtx4090-worker}"
export ROBOMOTION_WORKER_STAGES="${ROBOMOTION_WORKER_STAGES:-pose_extraction,robot_retargeting,visualization,training}"

mkdir -p "$SSH_DIR" "$ROBOMOTION_MODEL_ROOT" "$ROBOMOTION_MODEL_CACHE" \
  "$CONDA_ENVS_PATH" "$CONDA_PKGS_DIRS"
chmod 700 "$SSH_DIR"
printf '%s\n' "$ROBOMOTION_CONTROL_SSH_KEY" > "$SSH_KEY"
printf '%s\n' "$ROBOMOTION_CONTROL_SSH_KNOWN_HOSTS" > "$SSH_KNOWN_HOSTS"
chmod 600 "$SSH_KEY" "$SSH_KNOWN_HOSTS"

ssh -NT \
  -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o IdentitiesOnly=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS" \
  -L 15432:127.0.0.1:5432 \
  -L 19000:127.0.0.1:9000 \
  -L 13000:127.0.0.1:3000 \
  "${ROBOMOTION_CONTROL_SSH_USER}@${ROBOMOTION_CONTROL_SSH_HOST}" &
SSH_PID=$!
trap 'kill "$SSH_PID" 2>/dev/null || true' EXIT INT TERM

for port in 15432 19000 13000; do
  ready=false
  for _ in $(seq 1 60); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      exec 3>&-
      ready=true
      break
    fi
    kill -0 "$SSH_PID" 2>/dev/null || fail "The control-plane SSH tunnel exited before becoming ready."
    sleep 1
  done
  $ready || fail "Timed out waiting for local tunnel port $port."
done

export DATABASE_URL="postgresql://robomotion:${ROBOMOTION_DB_PASSWORD}@127.0.0.1:15432/robomotion?schema=public"
export OBJECT_STORAGE_ENDPOINT="http://127.0.0.1:19000"
export ROBOMOTION_DASHBOARD_URL="http://127.0.0.1:13000"

printf 'Control-plane tunnel ready; validating persistent GPU runtime.\n'
bash /app/deploy/bootstrap-models.sh
printf 'GPU runtime ready; starting worker capabilities: %s\n' "$ROBOMOTION_WORKER_STAGES"
exec bash /app/deploy/start-gpu-worker.sh
