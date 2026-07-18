# RoboMotion

RoboMotion is a dashboard and GPU-worker pipeline for turning uploaded human-motion video into reviewed SMPL-X motion, Unitree G1 retargeting, and visual verification.

Implemented pre-training stages:

1. Video upload or generated-video input
2. PromptHMR pose extraction with 2D and interactive 3D evidence
3. Operator pose review
4. GMR retargeting to Unitree G1 (29 DoF)
5. Headless MuJoCo G1 mesh visualization

Training, policy evaluation, and simulation verification remain separate later-phase modules.

## Deployment

The production topology is Docker Compose with PostgreSQL, MinIO, a Next.js dashboard, a migration job, one idempotent model bootstrap, and one NVIDIA GPU worker.

Start with [the deployment guide](docs/deployment/README.md). The complete file and volume map is in [deployment files](docs/deployment/FILES.md), and update/backup guidance is in [operations](docs/deployment/OPERATIONS.md).

RoboMotion directly installs pinned PromptHMR and GMR upstream revisions. It does not clone, call, or depend on the Video2Robot repository at runtime.

## Local development

```bash
cp .env.example .env.local
docker compose up -d
npm ci
npx prisma migrate dev
npm run dev
```

Install and start the direct GPU engines separately:

```bash
bash deploy/configure-model-secrets.sh
source .robomotion/secrets/install.env
bash deploy/install-direct-models.sh
npm run worker
```

PromptHMR has upstream license restrictions. Confirm that the intended deployment is authorized before enabling it outside the permitted use case.
