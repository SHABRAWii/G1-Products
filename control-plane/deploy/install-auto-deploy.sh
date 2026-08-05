#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$(id -u)" -eq 0 ]] || {
  printf 'Run this installer as root.\n' >&2
  exit 1
}

PLANE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "$PLANE_ROOT/.." && pwd)"
EXPECTED_ROOT="${ROBOMOTION_REPOSITORY:-/opt/robomotion}"

[[ "$PROJECT_ROOT" == "$EXPECTED_ROOT" ]] || {
  printf 'Repository is %s, but the service expects %s.\n' "$PROJECT_ROOT" "$EXPECTED_ROOT" >&2
  printf 'Set ROBOMOTION_REPOSITORY to the actual absolute path before installing.\n' >&2
  exit 1
}

install -d -m 0750 /var/lib/robomotion-control-plane
if [[ ! -s /var/lib/robomotion-control-plane/last-successful-sha ]]; then
  git -C "$PROJECT_ROOT" rev-parse HEAD \
    >/var/lib/robomotion-control-plane/last-successful-sha
fi

install -m 0644 \
  "$PLANE_ROOT/deploy/systemd/robomotion-control-plane-deploy.service" \
  /etc/systemd/system/robomotion-control-plane-deploy.service
install -m 0644 \
  "$PLANE_ROOT/deploy/systemd/robomotion-control-plane-deploy.timer" \
  /etc/systemd/system/robomotion-control-plane-deploy.timer

systemctl daemon-reload
systemctl enable --now robomotion-control-plane-deploy.timer
systemctl start robomotion-control-plane-deploy.service

systemctl --no-pager status robomotion-control-plane-deploy.timer
systemctl --no-pager status robomotion-control-plane-deploy.service || true
