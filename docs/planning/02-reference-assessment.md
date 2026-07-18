# `video2robot` reference assessment

## Inspection record

The reference was cloned on 2026-07-15 into a temporary directory at commit `c6a8d74` (shallow clone; not retained in this project). Its pinned third-party revisions were inspected: GMR `069b4fd` and PromptHMR `4f8915c`.

`video2robot` is a Python package plus a small FastAPI application. Its implemented path is:

`prompt -> Veo or Sora -> original.mp4 -> PromptHMR -> results.pkl / world4d.glb -> SMPL-X NPZ -> GMR -> robot_motion.pkl -> Viser or MuJoCo`

It does **not** implement the requested pose-review workflow, policy training/evaluation, simulation verification, durable orchestration, multi-user access, provider accounting, or persistent database.

## Architecture and stage contracts observed

| Reference component | Inputs | Outputs / behavior |
| --- | --- | --- |
| `scripts/generate_video.py`; `video/veo_client.py`; `video/sora_client.py` | action/raw prompt, provider model, duration, dimensions | `original.mp4`, prompt/config metadata; remote long-running operation is polled. |
| `scripts/extract_pose.py`; `pose/extractor.py` | project video and static-camera option | PromptHMR `results.pkl`, mesh export such as `world4d.glb`, derived `smplx.npz`, and `smplx_tracks.json`. Multi-person tracks are ranked and exported independently. |
| `scripts/convert_to_robot.py`; `robot/retargeter.py` | SMPL-X track, robot ID, target FPS | `robot_motion_track_N.pkl`, default `robot_motion.pkl`; optional Unitree G1 TWIST 23-DoF derivative. |
| `scripts/visualize.py`; `visualization/robot_viser.py` | project artifacts | PromptHMR/Viser human or robot view, or a local GMR/MuJoCo viewer. |
| `web/` | local filesystem projects under `data/` | FastAPI routes for upload, projects, three pipeline actions, file download, and launching a Viser subprocess. |

The script runner swaps Conda environments: `phmr` for video/pose work and `gmr` for retargeting. Its web task manager holds tasks and child-process handles in memory, derives progress from stdout, and loses state on restart. Project state is inferred from filenames in a local directory.

## Dependencies and constraints found

- Core wrapper: Python 3.10+, FastAPI, Uvicorn, NumPy, Torch, SciPy, Requests, OpenAI client, Viser, Trimesh, dotenv.
- PromptHMR: separate Python 3.10/3.11 GPU environment, models/checkpoints and SMPL-X data downloads; includes Detectron2, SAM2, DROID-SLAM, Metric3D, ViTPose, OpenCV, and Viser. It emits per-person world-coordinate SMPL-X data and mesh files.
- GMR: separate Python 3.10 environment; uses MuJoCo, Mink, QP solvers, SciPy, SMPL-X, rendering/video libraries, and robot assets. It supports multiple robot/data formats and produces robot base pose, joint positions, FPS, body positions, and link names in a pickle.
- Providers: Veo calls Google long-running video generation endpoints with polling; Sora is similarly wrapped. API credentials are read from environment variables.
- Licensing: core wrapper and GMR are MIT; the repository explicitly states that PromptHMR is non-commercial scientific-research only. Treat this as a blocking legal/product decision for commercial deployment.

## Reuse strategy

| Decision | Components | Implementation treatment |
| --- | --- | --- |
| Rebuild as RoboMotion adapters | PromptHMR invocation/conversion logic, GMR retargeting invocation, track selection, manifests, metrics, and error handling | Implement independently against the direct PromptHMR and GMR package APIs. Do not call the reference package or its helper scripts. |
| Reuse as format/behavior reference | SMPL-X NPZ conversion, GMR robot-motion pickle fields, multi-track naming, Viser/MuJoCo rendering behavior | Define RoboMotion-owned versioned schemas; write import/export adapters. Do not make dashboard APIs depend on pickle names or local folders. |
| Modify substantially | CLI scripts, stdout progress markers, Conda launcher, `web/tasks.py`, `web/routers/*`, Viser process manager | Replace with containerized workers, durable orchestration, structured events, object-store artifacts, authentication, and signed viewer assets. Preserve only narrow transformation logic. |
| Rebuild | Dashboard frontend, tenancy/RBAC, asset catalog, human review, training/evaluation, simulation verification, cost/RunPod management, audit, deployment | Build as RoboMotion services. The reference has no suitable foundation for these concerns. |

## Adapter boundary required

Each reused engine must run in a pinned OCI image (one image per incompatible environment), receive a read-only input manifest and signed object-store URLs, write only to a job-scoped scratch volume, and finish by uploading outputs plus a `stage-result.json`. The wrapper must capture engine revision, container digest, model/checkpoint hashes, GPU type, execution environment, and structured failure classification.

This boundary avoids two known reference limitations: Conda environment switching within a host process and output discovery through mutable `data/video_*` folders.
