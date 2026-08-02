# RoboMotion control plane

This directory is the persistent server half of RoboMotion. It runs without a
GPU and remains online while the GPU plane is stopped.

It owns:

- the Next.js dashboard and API;
- PostgreSQL and the durable pipeline state machine;
- MinIO/S3-compatible artifact storage;
- the background Three.js MP4 export worker;
- the optional RunPod lifecycle controller.

It does **not** install PromptHMR, GMR, or `unitree_rl_mjlab`.

## Start

```bash
cp control-plane/.env.example control-plane/.env
# Fill secrets and the private network bind address.
bash control-plane/deploy/up.sh
```

If `RUNPOD_API_KEY` and `RUNPOD_POD_ID` are set, `up.sh` enables the RunPod
controller. It starts the configured stopped Pod when a GPU stage becomes
ready, dispatches queued work after a worker heartbeat appears, and stops the
Pod after `RUNPOD_IDLE_AFTER_SECONDS` with no GPU work.

## Digital-twin MP4 exports

Visualization succeeds when its interactive scene JSON is published. The
control-plane export worker then captures the production Three.js viewer at
1920×1080/60 FPS and publishes the MP4 independently. The job detail page
shows queued/running progress and offers retry on failure. Training is not
blocked by this capture.

The exporter needs the official Unitree G1 compiled web meshes. Set
`ROBOMOTION_WEB_MODEL_SOURCE` to a directory containing at least 30
`*.compiled.stl` files. The existing local verified cache is:

```text
.robomotion/cache/unitree-g1-web/
```

The Compose bootstrap copies this immutable set into the control-plane model
volume. It fails instead of producing incomplete robot videos when the bundle
is missing.

## Network boundary

Only SSH and the authenticated dashboard reverse proxy are internet-facing.
PostgreSQL, MinIO, and Next.js bind to `127.0.0.1`. The RunPod worker reaches
them through the restricted outbound SSH tunnel created by
`deploy/start-runpod-gpu-plane.sh`. Do not set the bind address to `0.0.0.0`.

The RunPod API key exists only here; GPU workers cannot start, stop, or update
Pods. The current MVP Compose stack creates one database user and one MinIO
identity, so the RunPod worker receives those credentials as provider secrets.
Dedicated scoped worker credentials remain hardening work.
