#!/usr/bin/env bash
# Create a private server environment file and interactive SMPL/SMPL-X Docker
# secrets. Existing configuration is never overwritten.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROBOMOTION_SERVER_ENV:-$PROJECT_ROOT/.env.server}"
SECRET_DIR="${ROBOMOTION_SERVER_SECRET_DIR:-$PROJECT_ROOT/.robomotion/server-secrets}"

fail() { printf 'Server preparation failed: %s\n' "$1" >&2; exit 1; }
command -v openssl >/dev/null || fail "openssl is required to generate server passwords."

if [[ ! -s "$SECRET_DIR/smplx_username" || ! -s "$SECRET_DIR/smplx_password" || ! -s "$SECRET_DIR/smpl_username" || ! -s "$SECRET_DIR/smpl_password" ]]; then
  ROBOMOTION_SECRET_DIR="$SECRET_DIR" bash "$PROJECT_ROOT/deploy/configure-model-secrets.sh"
else
  printf 'Reusing restricted model secret files in %s\n' "$SECRET_DIR"
fi

if [[ -e "$ENV_FILE" ]]; then
  printf 'Existing server configuration preserved: %s\n' "$ENV_FILE"
else
  postgres_password="$(openssl rand -hex 32)"
  storage_password="$(openssl rand -hex 32)"
  umask 077
  cat > "$ENV_FILE" <<EOF
POSTGRES_PASSWORD=$postgres_password
OBJECT_STORAGE_BUCKET=robomotion
OBJECT_STORAGE_ACCESS_KEY=robomotion
OBJECT_STORAGE_SECRET_KEY=$storage_password
APP_PORT=3000
APP_BIND_ADDRESS=127.0.0.1

ROBOMOTION_POSE_MAX_HEIGHT=480
ROBOMOTION_POSE_FPS=12
ROBOMOTION_POSE_MAX_FRAMES=180
GPU_SHM_SIZE=8gb
HF_TOKEN=

SMPLX_USERNAME_SECRET_FILE=$SECRET_DIR/smplx_username
SMPLX_PASSWORD_SECRET_FILE=$SECRET_DIR/smplx_password
SMPL_USERNAME_SECRET_FILE=$SECRET_DIR/smpl_username
SMPL_PASSWORD_SECRET_FILE=$SECRET_DIR/smpl_password
EOF
  chmod 600 "$ENV_FILE"
  unset postgres_password storage_password
  printf 'Created private server configuration: %s\n' "$ENV_FILE"
fi

printf '\nPreparation complete. Review %s, then run:\n' "$ENV_FILE"
printf '  bash deploy/deploy-server.sh\n'
