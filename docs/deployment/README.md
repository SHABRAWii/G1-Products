# RoboMotion server deployment

This is the canonical fresh-machine deployment path. It produces one private dashboard, PostgreSQL, MinIO, an idempotent model bootstrap, and one NVIDIA GPU worker.

## 1. Server requirements

- Linux x86-64 (Ubuntu 22.04 or newer recommended)
- NVIDIA driver and a CUDA-capable GPU
- NVIDIA Container Toolkit
- Docker Engine and Docker Compose v2
- At least 30 GiB free disk space; 50 GiB is safer during the initial image build
- At least 6 GiB VRAM for the currently verified static-camera profile; 16–24 GiB is recommended for higher-detail validation
- Outbound HTTPS access to GitHub, Google Drive, PyTorch package indexes, Hugging Face, and the SMPL/SMPL-X download service

Verify Docker GPU access before cloning RoboMotion:

```bash
nvidia-smi
docker compose version
docker run --rm --gpus all nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04 nvidia-smi
```

## 2. Get the source

After this repository has been pushed to GitHub:

```bash
sudo install -d -o "$USER" -g "$USER" /opt/robomotion
git clone YOUR_PRIVATE_GITHUB_URL /opt/robomotion
cd /opt/robomotion
```

Do not copy `.env.local`, `.env.server`, `.robomotion/`, or model credentials into Git.

## 3. Prepare private configuration

Run the interactive preparation script as the deployment user:

```bash
bash deploy/prepare-server.sh
```

It:

- prompts for SMPL-X/SMPL credentials without echoing passwords;
- stores them with restrictive permissions under `.robomotion/server-secrets/`;
- generates URL-safe PostgreSQL and MinIO passwords;
- creates a mode-0600 `.env.server` without overwriting an existing file;
- binds the dashboard to `127.0.0.1:3000` by default.

Review `.env.server` before starting. The default pose settings are the locally verified profile:

```dotenv
ROBOMOTION_POSE_MAX_HEIGHT=480
ROBOMOTION_POSE_FPS=12
ROBOMOTION_POSE_MAX_FRAMES=180
```

Do not raise these simply because the server has a larger GPU. Validate output quality, VRAM, runtime, and retargeting behavior on representative footage first.

## 4. Deploy

```bash
bash deploy/deploy-server.sh
```

The script runs the NVIDIA/Docker/secret/disk preflight, validates Compose, builds images, applies Prisma migrations, starts PostgreSQL and MinIO, bootstraps PromptHMR/GMR, and starts the worker.

The first model bootstrap downloads and verifies many gigabytes. Follow it with:

```bash
bash deploy/server-status.sh --follow
```

Subsequent deployments reuse four named volumes:

- `postgres-data`
- `minio-data`
- `model-cache`
- `conda-envs`

## 5. Access safely

The MVP has no user authentication. The default loopback binding prevents direct public access.

For temporary access, use an SSH tunnel from your workstation:

```bash
ssh -L 3000:127.0.0.1:3000 USER@SERVER
```

Then open `http://localhost:3000` locally. For longer-term access, use a VPN or an authenticated TLS reverse proxy. Do not set `APP_BIND_ADDRESS=0.0.0.0` on an untrusted network without protection.

## 6. Acceptance check

```bash
bash deploy/server-status.sh
curl http://127.0.0.1:3000/api/health
```

The dashboard must report the worker as `ready`. Upload a short, fixed-camera, single-person MP4 and run:

```text
Pose extraction → Pose review → Robot retargeting → Visualization
```

Confirm that the Job Details page contains the immutable input video, PromptHMR outputs and logs, review decision, GMR motion, the interactive Unitree G1 digital twin, and matching digital-twin MP4 evidence.

## Updating

```bash
cd /opt/robomotion
git pull --ff-only
bash deploy/deploy-server.sh
```

Migrations and model bootstrap are idempotent. Named volumes are not removed by the deployment script.
