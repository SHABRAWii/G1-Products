#!/usr/bin/env bash
# Docker entry point: use the same direct-installer used for local deployment.
set -euo pipefail
export ROBOMOTION_MODEL_ROOT="${ROBOMOTION_MODEL_ROOT:-/models}"
exec bash deploy/install-direct-models.sh
