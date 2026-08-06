# RoboMotion GPU plane

This directory is the disposable compute half of RoboMotion. It contains:

- model bootstrap for PromptHMR, GMR, and `unitree_rl_mjlab`;
- one serialized RunPod worker for pose extraction, retargeting, interactive
  scene generation, and training.

It does not host the dashboard, PostgreSQL, MinIO, or MP4 export worker.

## RunPod (production GPU target)

Build and push the x86-64 worker image:

```bash
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile.gpu-worker \
  -t ghcr.io/OWNER/robomotion-gpu:VERSION \
  --push .
```

Use its immutable digest in the RunPod template and set that same digest as
`RUNPOD_GPU_IMAGE` on the control plane. The lifecycle controller applies the
new image while the Pod is stopped, before it starts newly queued work.

RunPod Pods do not use Docker Compose. The image starts
`deploy/start-runpod-gpu-plane.sh`, opens a restricted outbound SSH tunnel to
the control VPS, validates/reuses the persistent model runtime, and then starts
one serialized worker advertising all GPU stages. Persist all of `/workspace`,
including models and Conda environments.

Only model and environment caches belong on `/workspace`. The entry point
recreates the tunnel key and known-hosts file under `/run/robomotion-ssh` with
strict permissions on every container start, validates the private key, and
uses public-key authentication exclusively. This runtime path is intentionally
not configurable; any stale `ROBOMOTION_SSH_DIR` template variable is ignored,
and credential files left by older images are removed from `/workspace/.ssh`.

The worker image and the pinned training wheel both use CUDA 13.0. The
`unitree_rl_mjlab` Conda environment also owns its `libstdc++`/`libgcc`
runtime; training commands prepend that environment's library directory only
for the lifetime of the command. This prevents ICU/`CXXABI_1.3.15` failures
without leaking the training ABI into PromptHMR or GMR. Tunnel listeners bind
to `127.0.0.1` explicitly, so Pods with IPv6 disabled do not emit `::1` bind
warnings.

`runpod-template.example.json` records the required shape. Provider, model,
database, object-storage, and tunnel credentials are injected as RunPod
secrets; none belongs in Git. The complete VPS + RunPod procedure is
[`docs/system-structure-and-deployment.md`](../docs/system-structure-and-deployment.md).

## Fixed GPU server (legacy fallback)

`gpu-plane/docker-compose.yml` and `gpu-plane/deploy/up.sh` remain available
for a self-managed GPU machine. They are not used by the production RunPod
deployment.

## Model persistence

Model downloads and Conda environments are expensive and must live on the Pod
volume. The bootstrap scripts are idempotent and validate the pinned sources,
checkpoints, licensed body models, and training runtime before workers advertise
ready capabilities.
