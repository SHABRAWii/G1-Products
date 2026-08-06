#!/usr/bin/env bash
# RunPod entry point: establish restricted control-plane tunnels, reuse the
# persistent model/Conda cache, validate model engines, then advertise one GPU
# worker. One worker intentionally serializes GPU stages on the single GPU.
set -euo pipefail

fail() { printf 'RunPod GPU startup failed: %s\n' "$1" >&2; exit 1; }
required() { [[ -n "${!1:-}" ]] || fail "$1 is required."; }

WORKSPACE="${ROBOMOTION_RUNPOD_WORKSPACE:-/workspace}"
# Tunnel credentials are deliberately kept off the persistent RunPod volume.
# Some provider-backed volume mounts retain or normalize file modes, which can
# leave a private key as 0666 even after chmod. OpenSSH correctly refuses such
# a key. /run is container-local, ephemeral, and supports strict Unix modes.
# This path is intentionally not configurable: a stale RunPod template must not
# be able to redirect private credentials back onto /workspace.
SSH_DIR="/run/robomotion-ssh"
SSH_KEY="$SSH_DIR/control-plane"
SSH_KNOWN_HOSTS="$SSH_DIR/known_hosts"

if [[ -n "${ROBOMOTION_SSH_DIR:-}" && "$ROBOMOTION_SSH_DIR" != "$SSH_DIR" ]]; then
  printf 'Ignoring insecure ROBOMOTION_SSH_DIR override (%s); using %s.\n' \
    "$ROBOMOTION_SSH_DIR" "$SSH_DIR" >&2
fi

# Delete only the two credential files written by pre-fix images. Leaving them
# on a persistent volume would retain secrets even though they are no longer
# used by the worker.
rm -f "$WORKSPACE/.ssh/control-plane" "$WORKSPACE/.ssh/known_hosts" || \
  printf 'Warning: unable to remove legacy tunnel credentials from %s/.ssh.\n' \
    "$WORKSPACE" >&2

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

mkdir -p "$ROBOMOTION_MODEL_ROOT" "$ROBOMOTION_MODEL_CACHE" \
  "$CONDA_ENVS_PATH" "$CONDA_PKGS_DIRS"

umask 077
install -d -m 700 "$SSH_DIR"
install -m 600 /dev/null "$SSH_KEY"
install -m 600 /dev/null "$SSH_KNOWN_HOSTS"
printf '%s\n' "$ROBOMOTION_CONTROL_SSH_KEY" > "$SSH_KEY"
printf '%s\n' "$ROBOMOTION_CONTROL_SSH_KNOWN_HOSTS" > "$SSH_KNOWN_HOSTS"
chmod 600 "$SSH_KEY" "$SSH_KNOWN_HOSTS"

[[ "$(stat -c '%a' "$SSH_KEY")" == "600" ]] || \
  fail "The control-plane SSH private key does not have mode 0600."
[[ "$(stat -c '%a' "$SSH_KNOWN_HOSTS")" == "600" ]] || \
  fail "The control-plane known-hosts file does not have mode 0600."
ssh-keygen -y -f "$SSH_KEY" >/dev/null 2>&1 || \
  fail "ROBOMOTION_CONTROL_SSH_KEY is not a valid unencrypted OpenSSH private key."

ssh -NT \
  -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o IdentitiesOnly=yes \
  -o PubkeyAuthentication=yes \
  -o PreferredAuthentications=publickey \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$SSH_KNOWN_HOSTS" \
  -L 127.0.0.1:15432:127.0.0.1:5432 \
  -L 127.0.0.1:19000:127.0.0.1:9000 \
  -L 127.0.0.1:13000:127.0.0.1:3000 \
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
