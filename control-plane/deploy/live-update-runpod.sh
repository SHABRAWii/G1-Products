#!/usr/bin/env bash
# Restart a RunPod worker from an exact Git commit without publishing a new
# container image. The checkout is retained on /workspace and overlaid onto
# /app before the normal GPU entry point runs.
set -euo pipefail

POD_ID="${1:-${RUNPOD_POD_ID:-}}"
REVISION="${2:-$(git rev-parse HEAD)}"
REPOSITORY="${ROBOMOTION_LIVE_REPOSITORY:-https://github.com/SHABRAWii/G1-Products.git}"
BUNDLE_URL="${ROBOMOTION_LIVE_BUNDLE_URL:-}"

[[ -n "$POD_ID" ]] || { printf 'RunPod Pod ID is required.\n' >&2; exit 1; }
[[ -n "${RUNPOD_API_KEY:-}" ]] || { printf 'RUNPOD_API_KEY is required.\n' >&2; exit 1; }
REVISION="$(git rev-parse "${REVISION}^{commit}")"

export ROBOMOTION_LIVE_POD_ID="$POD_ID"
export ROBOMOTION_LIVE_REVISION="$REVISION"
export ROBOMOTION_LIVE_REPOSITORY="$REPOSITORY"
export ROBOMOTION_LIVE_BUNDLE_URL="$BUNDLE_URL"

python3 - <<'PY'
import json
import os
import shlex
import urllib.error
import urllib.request

pod_id = os.environ["ROBOMOTION_LIVE_POD_ID"]
revision = os.environ["ROBOMOTION_LIVE_REVISION"]
repository = os.environ["ROBOMOTION_LIVE_REPOSITORY"]
bundle_url = os.environ.get("ROBOMOTION_LIVE_BUNDLE_URL", "")

if bundle_url:
    update_source = f'''curl --fail --silent --show-error --location {shlex.quote(bundle_url)} \
  | tar -xz -C /app'''
else:
    update_source = f'''LIVE=/workspace/robomotion-live
if [[ ! -d "$LIVE/.git" ]]; then
  [[ ! -e "$LIVE" ]] || {{ echo "$LIVE exists but is not a Git checkout" >&2; exit 1; }}
  git clone --filter=blob:none --no-checkout {repository!r} "$LIVE"
fi
git -C "$LIVE" fetch --depth 1 origin {revision!r}
git -C "$LIVE" checkout --detach --force FETCH_HEAD
tar --exclude=.git --exclude=.next --exclude=node_modules -C "$LIVE" -cf - . | tar -C /app -xf -'''

worker_script = f'''set -euo pipefail
{update_source}

PHMR_ENV=/workspace/conda-envs/phmr_pt2.4
if ! "$PHMR_ENV/bin/python" -c 'import chumpy, smplx' >/dev/null 2>&1; then
  PHMR_SOURCE=''
  for candidate in \
    /opt/prompt-hmr/python_libs/chumpy \
    /workspace/robomotion/sources/PromptHMR/python_libs/chumpy; do
    if [[ -d "$candidate" ]]; then PHMR_SOURCE="$candidate"; break; fi
  done
  [[ -n "$PHMR_SOURCE" ]] || {{ echo "PromptHMR chumpy source is missing from the image and persistent cache." >&2; exit 1; }}
  "$PHMR_ENV/bin/python" -m pip install -e "$PHMR_SOURCE" --no-build-isolation
fi

fingerprint="$(sha256sum \
  /app/deploy/install-direct-models.sh \
  /app/deploy/verify-training-runtime.sh \
  /app/deploy/training-runtime-common.sh \
  /app/deploy/patches/unitree_rl_mjlab-robomotion.patch \
  | sha256sum | awk '{{print $1}}')"
printf '%s\n' "$fingerprint" > /workspace/robomotion/.gpu-runtime-contract-v1.sha256
exec bash /app/deploy/start-runpod-gpu-plane.sh'''

start_script = f'''set -uo pipefail
LOG=/workspace/robomotion/live-start.log
mkdir -p "$(dirname "$LOG")"
set +e
bash -lc {shlex.quote(worker_script)} 2>&1 | tee "$LOG"
status=${{PIPESTATUS[0]}}
set -e
printf 'Live worker startup exited with code %s. Diagnostics remain available on port 8888.\n' "$status" | tee -a "$LOG"
exec python3 -m http.server 8888 --directory /workspace/robomotion'''

request = urllib.request.Request(
    f"https://rest.runpod.io/v1/pods/{pod_id}/update",
    data=json.dumps({
        "dockerStartCmd": ["bash", "-lc", start_script],
        "ports": ["22/tcp", "8888/http"],
    }).encode(),
    headers={
        "Authorization": f"Bearer {os.environ['RUNPOD_API_KEY']}",
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=60) as response:
        pod = json.load(response)
except urllib.error.HTTPError as error:
    print(error.read().decode(), file=__import__("sys").stderr)
    raise SystemExit(f"RunPod update failed with HTTP {error.code}.")

print(
    f"RunPod {pod.get('id', pod_id)} is restarting from Git revision "
    f"{revision[:12]} without a new container image."
)
PY
