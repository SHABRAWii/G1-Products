#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'OK: %s\n' "$1"; }

command -v docker >/dev/null || fail "Docker Engine is not installed."
docker info >/dev/null 2>&1 || fail "Docker is installed but the current user cannot access the daemon."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required."
pass "Docker Engine and Docker Compose are available."

for required in POSTGRES_PASSWORD OBJECT_STORAGE_BUCKET OBJECT_STORAGE_ACCESS_KEY OBJECT_STORAGE_SECRET_KEY; do
  [[ -n "${!required:-}" ]] || fail "$required is missing from the loaded server environment."
done
pass "Database and object-storage configuration is present."

if command -v nvidia-smi >/dev/null; then
  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | sed 's/^/OK: GPU /'
else
  fail "nvidia-smi is unavailable. Install the NVIDIA driver and NVIDIA Container Toolkit."
fi

if docker run --rm --gpus all nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 nvidia-smi >/dev/null 2>&1; then
  pass "Docker can access the NVIDIA GPU."
else
  fail "Docker cannot access the NVIDIA GPU. Configure the NVIDIA Container Toolkit."
fi

for secret in SMPLX_USERNAME_SECRET_FILE SMPLX_PASSWORD_SECRET_FILE SMPL_USERNAME_SECRET_FILE SMPL_PASSWORD_SECRET_FILE; do
  path="${!secret:-}"
  [[ -n "$path" && -r "$path" ]] || fail "$secret must point to a readable secret file."
done
pass "The four model-account secret files are readable."

available_kb="$(df -Pk . | awk 'NR==2 {print $4}')"
required_kb=$((30 * 1024 * 1024))
(( available_kb >= required_kb )) || fail "At least 30 GiB of free disk space is required for images, environments, and model assets."
pass "At least 30 GiB of disk space is available."

case "${APP_BIND_ADDRESS:-127.0.0.1}" in
  127.0.0.1|localhost|::1) pass "Dashboard is bound to the local machine only." ;;
  *) printf 'WARNING: APP_BIND_ADDRESS=%s exposes the unauthenticated MVP interface. Use a firewall or authenticated reverse proxy.\n' "$APP_BIND_ADDRESS" >&2 ;;
esac
