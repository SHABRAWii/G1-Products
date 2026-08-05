#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${ROBOMOTION_REPOSITORY:-/opt/robomotion}"
BRANCH="${ROBOMOTION_DEPLOY_BRANCH:-mvp/robot-studio}"
STATE_DIRECTORY="${ROBOMOTION_DEPLOY_STATE_DIRECTORY:-/var/lib/robomotion-control-plane}"
STATE_FILE="$STATE_DIRECTORY/last-successful-sha"
LOCK_FILE="${ROBOMOTION_DEPLOY_LOCK_FILE:-/run/lock/robomotion-control-plane-deploy.lock}"

log() {
  printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

[[ -d "$REPOSITORY/.git" ]] || fail "Repository not found at $REPOSITORY."
[[ -r "$REPOSITORY/control-plane/.env" ]] || fail "Missing $REPOSITORY/control-plane/.env."

exec 9>"$LOCK_FILE"
flock -n 9 || {
  log 'Another control-plane deployment is already running; skipping.'
  exit 0
}

cd "$REPOSITORY"

current_branch="$(git branch --show-current)"
[[ "$current_branch" == "$BRANCH" ]] || \
  fail "Expected branch $BRANCH, found ${current_branch:-detached HEAD}."

if ! git diff --quiet || ! git diff --cached --quiet || \
  [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  fail 'The deployment checkout has uncommitted files; refusing to overwrite them.'
fi

install -d -m 0750 "$STATE_DIRECTORY"
if [[ -s "$STATE_FILE" ]] && git rev-parse --verify "$(<"$STATE_FILE")^{commit}" >/dev/null 2>&1; then
  baseline_sha="$(<"$STATE_FILE")"
else
  baseline_sha="$(git rev-parse HEAD)"
  printf '%s\n' "$baseline_sha" >"$STATE_FILE"
fi

log "Fetching origin/$BRANCH."
git fetch --quiet --prune origin
remote_sha="$(git rev-parse "origin/$BRANCH")"

if [[ "$baseline_sha" == "$remote_sha" ]]; then
  log "Already processed $remote_sha."
  exit 0
fi

git merge-base --is-ancestor "$baseline_sha" "$remote_sha" || \
  fail "origin/$BRANCH is not a fast-forward from $baseline_sha."

changed_files="$(git diff --name-only "$baseline_sha..$remote_sha")"
log "New revision $remote_sha contains $(wc -l <<<"$changed_files") changed file(s)."

current_sha="$(git rev-parse HEAD)"
if [[ "$current_sha" != "$remote_sha" ]]; then
  git merge-base --is-ancestor "$current_sha" "$remote_sha" || \
    fail "The server checkout cannot fast-forward from $current_sha to $remote_sha."
  git merge --ff-only "$remote_sha"
fi

control_plane_pattern='^(control-plane/|app/|components/|lib/|prisma/|public/|Dockerfile$|\.dockerignore$|package\.json$|package-lock\.json$|next\.config\.[^/]+$|postcss\.config\.[^/]+$|tsconfig\.json$|middleware\.[jt]s$|instrumentation\.[jt]s$|scripts/(artifact-export-worker|runpod-controller|capture-digital-twin)\.)'

if ! grep -Eq "$control_plane_pattern" <<<"$changed_files"; then
  log 'No control-plane runtime paths changed; deployment is not required.'
  printf '%s\n' "$remote_sha" >"$STATE_FILE"
  exit 0
fi

log 'Control-plane runtime changes detected; rebuilding and deploying.'
bash control-plane/deploy/up.sh

health_url="${ROBOMOTION_CONTROL_HEALTH_URL:-http://127.0.0.1:3000/api/health}"
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null; then
    log "Deployment $remote_sha is healthy."
    printf '%s\n' "$remote_sha" >"$STATE_FILE"
    exit 0
  fi
  log "Health check attempt $attempt/30 failed; retrying."
  sleep 2
done

fail "Deployment $remote_sha did not become healthy at $health_url."
