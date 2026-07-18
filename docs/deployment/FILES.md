# Deployment file and persistence map

## Files committed to Git

| File | Responsibility |
| --- | --- |
| `Dockerfile` | Builds the non-root production Next.js dashboard image. |
| `deploy/Dockerfile.gpu-worker` | Builds the CUDA 12.1 worker/bootstrap image with Node, Conda, FFmpeg, EGL, build tools, and pinned PromptHMR/GMR source trees. |
| `docker-compose.server.yml` | Connects database, object storage, migrations, dashboard, model bootstrap, GPU worker, secrets, and named volumes. |
| `.env.server.example` | Documents every non-secret server setting and secret-file path. |
| `deploy/prepare-server.sh` | Creates private credentials and `.env.server` without overwriting existing configuration. |
| `deploy/server-preflight.sh` | Verifies Docker, Compose, NVIDIA access, required environment values, secret files, disk space, and exposure mode. |
| `deploy/deploy-server.sh` | Runs preflight and starts or updates the production Compose stack. |
| `deploy/bootstrap-models.sh` | Invokes the direct, idempotent model installer inside `model-bootstrap`. |
| `deploy/install-direct-models.sh` | Installs pinned PromptHMR/GMR environments, downloads licensed/public assets, and verifies PromptHMR files with SHA-256. |
| `deploy/start-gpu-worker.sh` | Reattaches persistent model data, verifies both Conda environments, and starts the pipeline worker. |
| `deploy/server-status.sh` | Shows Compose state, dashboard health, and model/worker logs. |

## Files intentionally not committed

| Path | Why it stays local |
| --- | --- |
| `.env.local` | Local database/storage settings and credentials. |
| `.env.server` | Production passwords, binding, tokens, and secret paths. |
| `.robomotion/` | Licensed body models, checkpoints, Conda/model cache, installer logs, and private secret files. |
| `node_modules/`, `.next/` | Reproducible dependency and build outputs. |
| `graphify-out/`, `.claude/`, `.codex/` | Local development metadata rather than application runtime. |

## Named Docker volumes

| Volume | Contents | Required for recovery? |
| --- | --- | --- |
| `postgres-data` | Jobs, stages, costs, reviews, lineage, and worker state. | Yes, to retain dashboard records. |
| `minio-data` | Uploaded videos and generated pipeline artifacts. | Yes, to retain actual files. |
| `model-cache` | PromptHMR checkpoints, SMPL/SMPL-X models, conversion assets, and GMR body-model link targets. | Rebuildable, but expensive to download. |
| `conda-envs` | Installed PromptHMR and GMR Python environments. | Rebuildable, but expensive to install. |

The model bootstrap and GPU worker are separate containers. `conda-envs` makes the installed Python environments visible to both. `start-gpu-worker.sh` recreates source-tree symlinks into `model-cache` every time a worker container starts.

## Runtime dependency direction

```text
Browser → Next.js dashboard → PostgreSQL
                         └──→ MinIO

Next.js job plan → PostgreSQL queue → GPU worker
GPU worker → PromptHMR/GMR/MuJoCo → MinIO artifacts + PostgreSQL status/cost/logs

model-bootstrap → model-cache + conda-envs → GPU worker
```

Video2Robot is not in this runtime graph. RoboMotion-owned adapters directly import the pinned PromptHMR and GMR installations.
