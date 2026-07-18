#!/usr/bin/env bash
# Creates local SMPL/SMPL-X secret files without putting credentials in shell
# history, source control, command arguments, or the RoboMotion configuration.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRET_DIR="${ROBOMOTION_SECRET_DIR:-$PROJECT_ROOT/.robomotion/secrets}"
umask 077
mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

read -r -p "SMPL-X username/email: " smplx_username
read -r -s -p "SMPL-X password: " smplx_password
printf '\n'
read -r -p "Use the same credentials for SMPL? [Y/n] " use_same
if [[ ! "${use_same,,}" =~ ^(n|no)$ ]]; then
  smpl_username="$smplx_username"
  smpl_password="$smplx_password"
else
  read -r -p "SMPL username/email: " smpl_username
  read -r -s -p "SMPL password: " smpl_password
  printf '\n'
fi

[[ -n "$smplx_username" && -n "$smplx_password" && -n "$smpl_username" && -n "$smpl_password" ]] || {
  echo "All values are required; no files were changed." >&2
  exit 1
}

printf '%s' "$smplx_username" > "$SECRET_DIR/smplx_username"
printf '%s' "$smplx_password" > "$SECRET_DIR/smplx_password"
printf '%s' "$smpl_username" > "$SECRET_DIR/smpl_username"
printf '%s' "$smpl_password" > "$SECRET_DIR/smpl_password"
chmod 600 "$SECRET_DIR"/smplx_username "$SECRET_DIR"/smplx_password "$SECRET_DIR"/smpl_username "$SECRET_DIR"/smpl_password

cat > "$SECRET_DIR/install.env" <<EOF
export SMPLX_USERNAME_FILE='$SECRET_DIR/smplx_username'
export SMPLX_PASSWORD_FILE='$SECRET_DIR/smplx_password'
export SMPL_USERNAME_FILE='$SECRET_DIR/smpl_username'
export SMPL_PASSWORD_FILE='$SECRET_DIR/smpl_password'
EOF
chmod 600 "$SECRET_DIR/install.env"
unset smplx_username smplx_password smpl_username smpl_password

printf 'Local secret files created in %s\n' "$SECRET_DIR"
printf 'Next run:\n  source %s/install.env && bash deploy/install-direct-models.sh\n' "$SECRET_DIR"
