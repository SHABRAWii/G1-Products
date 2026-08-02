# RoboMotion

RoboMotion is a dashboard and GPU-worker pipeline for turning uploaded human-motion video into reviewed SMPL-X motion, Unitree G1 retargeting, and visual verification.

Implemented pre-training stages:

1. Video upload or generated-video input
2. PromptHMR pose extraction with 2D and interactive 3D evidence
3. Operator pose review
4. GMR retargeting to Unitree G1 (29 DoF)
5. Interactive Unitree G1 digital-twin visualization with asynchronous MP4 evidence
6. `unitree_rl_mjlab` motion-imitation training, checkpoints, learning telemetry, and best-policy replay

Policy evaluation and simulation verification remain later-phase modules.

## Deployment

The target production topology is split between an always-on
[`control-plane/`](control-plane/) and a wake-on-demand
[`gpu-plane/`](gpu-plane/). The control plane hosts the dashboard, durable
state, storage, background MP4 exporter, and RunPod lifecycle controller. The
GPU plane hosts PromptHMR, GMR, and training workers.

Start with [the deployment guide](docs/deployment/README.md). Production means
one website VPS plus one RunPod RTX 4090 Pod. The root
`docker-compose.server.yml` is a legacy single-machine transition file and is
not used in that deployment.

RoboMotion directly installs pinned PromptHMR and GMR upstream revisions. It does not clone, call, or depend on the Video2Robot repository at runtime.

## Local development

```bash
cp .env.example .env.local
docker compose up -d
npm ci
npx prisma migrate dev
npm run dev:stack
```

Install and start the direct GPU engines separately:

```bash
bash deploy/configure-model-secrets.sh
source .robomotion/secrets/install.env
bash deploy/install-direct-models.sh
# `npm run dev:stack` starts web, motion, training, and background export
# processes. Run the individual worker scripts only for isolated debugging.
```

PromptHMR has upstream license restrictions. Confirm that the intended deployment is authorized before enabling it outside the permitted use case.
