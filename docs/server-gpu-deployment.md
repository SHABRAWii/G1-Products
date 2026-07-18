# Server GPU deployment

The server stack has one dashboard, PostgreSQL, MinIO, a migration job, a one-time GPU model bootstrap, and one GPU pipeline worker. It uses the same worker and artifact contract as local development.

The worker directly installs PromptHMR and GMR from their own upstream repositories. RoboMotion-owned adapters run pose extraction, SMPL-X conversion, Unitree G1 retargeting, artifact persistence, and rendering.

## First deployment

1. Install Docker Engine with the NVIDIA Container Toolkit on the server.
2. Run the private configuration helper. It creates `.env.server` plus restricted SMPL-X/SMPL secret files without putting passwords in shell history:

```bash
bash deploy/prepare-server.sh
```

3. Review `.env.server` and validate the server before building anything:

```bash
set -a; source .env.server; set +a
bash deploy/server-preflight.sh
```

4. Run the deployment wrapper:

```bash
bash deploy/deploy-server.sh
```

`model-bootstrap` is idempotent. It installs GMR and PromptHMR once and persists checkpoints/body models in `model-cache` and their Python environments in `conda-envs`. Later deployments reuse both caches. The worker recreates its source-tree links to the model cache before it accepts jobs.

The complete fresh-machine guide is [deployment/README.md](deployment/README.md); [deployment/FILES.md](deployment/FILES.md) explains every file and persistent volume.

The same installer is available for a direct machine installation: [install-direct-models.sh](../deploy/install-direct-models.sh). Supply SMPL/SMPL-X credentials through four environment variables or `*_FILE` variables; the script never writes those values to disk.

The worker container waits for `model-bootstrap` to finish successfully. The dashboard is available while models are being prepared, but it will show the GPU worker as unavailable and will not dispatch any jobs prematurely.

## PromptHMR quality profile — read before server deployment

> **Important:** the currently verified pose worker uses a **laptop-safe PromptHMR profile** so the same upstream PromptHMR model can run on the local RTX 3060 Laptop GPU (6 GB VRAM). It is not a smaller, cheaper, or substituted model. The server deployment should deliberately choose its quality profile before processing production footage.

### What remains the same

- The PromptHMR checkpoint and core detection, tracking, 2D keypoint, mesh, world-coordinate, and SMPL-X conversion pipeline are the direct upstream engine.
- GMR remains the direct Unitree G1 retargeting engine.
- SMPL, SMPL-X, and SMPL-X→SMPL geometry calculations remain FP32.
- The original uploaded video is retained unchanged in artifact storage.

### Current laptop-safe profile

| Setting | Current value | Reason | Quality implication |
| --- | --- | --- | --- |
| Image-model precision | FP16 | Fits PromptHMR's large image encoder in 6 GB VRAM | Usually a small numerical difference from FP32; it is the same model and weights, but output is not bit-identical. |
| Geometry precision | FP32 | Preserves type-correct SMPL/SMPL-X body math | No intentional geometry downgrade. |
| Prepared-video height | 480 px | Bounded local GPU memory/time | Fine spatial detail can be reduced. |
| Prepared-video FPS | 12 FPS | Bounded local GPU memory/time | Fast motion between sampled frames can be missed. |
| Maximum frames | 180 | Avoids unbounded local jobs | Longer inputs are truncated. |
| Person tracks | Best one track | Current MVP is single-person focused | Other people are not output as separate job artifacts yet. |
| Camera profile | Static, identity gravity calibration | Avoids the large optional SPEC calibration model | Appropriate for a level, fixed camera; less accurate for tilted or moving cameras. |

The active defaults are implemented in `scripts/robomotion_pose_adapter.py` and can be overridden for video bounds with environment variables:

```bash
ROBOMOTION_POSE_MAX_HEIGHT=480
ROBOMOTION_POSE_FPS=12
ROBOMOTION_POSE_MAX_FRAMES=180
```

### Recommended larger-server profile

For a server with sufficient VRAM, begin validation with this higher-detail configuration:

```bash
ROBOMOTION_POSE_MAX_HEIGHT=896
ROBOMOTION_POSE_FPS=30
ROBOMOTION_POSE_MAX_FRAMES=1000
```

Use representative customer videos to compare output against the laptop-safe profile before making it the default. Record GPU model, VRAM peak, duration, track confidence, foot-contact quality, and retargeting/simulation outcomes for each comparison.

### Precision and camera-calibration decision

The current adapter intentionally loads the image encoder in FP16. A larger GPU does **not** automatically switch it to full FP32 merely because more VRAM is available. Before production deployment, implement an explicit selectable profile, for example:

- `standard_static` — current mixed-precision, static-camera profile. Use for level, fixed-camera, single-person videos.
- `high_accuracy_world` — higher video resolution/FPS and full camera/gravity estimation for tilted or moving cameras. Decide FP16 versus FP32 only after measuring the target server's VRAM and output quality.

Do not use identity gravity calibration for handheld, moving, or noticeably tilted camera footage. In those cases PromptHMR's full camera/gravity calibration must be installed, enabled, and validated because it determines the world frame used for ground/contact-sensitive robot retargeting.

### Verification already completed locally

The laptop-safe configuration completed a real dashboard job: uploaded video → PromptHMR → 96-frame SMPL-X artifact → evidence file → colored 2D skeleton preview. This confirms the orchestration and direct model integration. It does not establish that the current resource limits are the desired final server-quality settings.

## Operational checks

```bash
docker compose --env-file .env.server -f docker-compose.server.yml ps
docker compose --env-file .env.server -f docker-compose.server.yml logs -f model-bootstrap gpu-worker
```

The dashboard shows the worker heartbeat as **ready** only after the GPU worker has started and all model environments are present. A job cannot be dispatched before that point.

## Licensing

PromptHMR’s upstream license is limited to non-commercial scientific research. Verify authorization for the target deployment before providing model credentials or enabling this worker. GMR is MIT-licensed.
