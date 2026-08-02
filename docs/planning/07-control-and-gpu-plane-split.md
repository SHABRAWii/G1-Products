# Control-plane and GPU-plane split

## Decision

RoboMotion is deployed as two independently operated planes:

```text
Public browser
    |
TLS / OIDC reverse proxy
    |
Control plane (always on)
    ├── Next.js dashboard/API
    ├── PostgreSQL
    ├── S3-compatible object storage
    ├── orchestration and audit state
    ├── background digital-twin MP4 exporter
    └── RunPod lifecycle controller
             |
             | RunPod API: start / update / stop
             | private worker data path
             v
GPU plane (wake on demand)
    ├── PromptHMR pose worker
    ├── GMR retarget/scene worker
    └── unitree_rl_mjlab training worker
```

The executable files live under [`control-plane/`](../../control-plane/) and
[`gpu-plane/`](../../gpu-plane/). The legacy root
`docker-compose.server.yml` remains an all-in-one transition deployment and now
also contains the asynchronous artifact exporter.

## Visualization execution

The visualization stage no longer performs a multi-minute screenshot/FFmpeg
capture in the GPU pipeline:

1. The GPU worker validates robot motion and publishes the interactive scene.
2. The visualization stage succeeds and immediately prepares the next selected
   stage, including training.
3. An `ArtifactExport` record is queued transactionally with stage completion.
4. The control-plane export worker claims the record, renders the production
   Three.js viewer, streams progress, and publishes the MP4.
5. Export failure never changes a successful pipeline stage. The operator can
   retry the export from the stage card or Artifacts panel.

The browser keeps using the interactive digital twin throughout. The MP4 is a
downloadable/evidence derivative, not the visualization stage's execution
barrier.

## GPU lifecycle

The RunPod controller watches durable stage and heartbeat state:

- a ready GPU stage and no running Pod triggers Pod start;
- a stopped Pod with an outdated configured image is updated before start;
- a fresh capable worker heartbeat triggers queued-stage dispatch;
- no GPU work for the configured idle window triggers Pod stop;
- the controller never terminates the Pod or deletes its persistent volume.

The configured worker image is an immutable registry digest. Provider pricing
and GPU choices remain configuration and rate-card data.

## Security boundary

- Only the control-plane reverse proxy is public.
- The RunPod API key exists only on the control plane.
- PostgreSQL and object storage bind to a private VPN interface for the current
  worker protocol.
- GPU workers use dedicated scoped credentials, not database-owner or
  object-store-root credentials.
- Licensed SMPL/SMPL-X credentials remain Docker/file secrets on the GPU plane.
- Application, storage, database, model, and provider secrets are ignored by
  Git and represented only by `.env.example` templates.
- Image updates use pinned digests. Bootstrap verifies source revisions and
  model/runtime integrity before advertising worker readiness.

The next hardening step is replacing the current private-network database
worker connection with signed work manifests and presigned object URLs. That
change does not alter the plane layout or artifact contracts.

## Deployment ownership

| Concern | Control plane | GPU plane |
| --- | --- | --- |
| Dashboard/API | Owns | None |
| Pipeline state | Owns | Reads/updates with scoped worker identity |
| Artifact metadata/storage | Owns | Uploads stage results |
| Interactive visualization | Serves | Generates scene data |
| MP4 digital-twin export | Executes asynchronously | None |
| PromptHMR/GMR | None | Executes |
| Training | Tracks/reviews | Executes |
| RunPod API key | Owns | Never receives |
| Pod start/update/stop | Decides | Subject of lifecycle action |

## Acceptance checks

1. Visualization reaches `SUCCEEDED` before the MP4 is complete.
2. Training can be `RUNNING` while the visualization export is `QUEUED` or
   `RUNNING`.
3. Export progress appears in the job page and survives reload.
4. A failed export can be retried without rerunning GMR or training.
5. Restarting an exporter requeues a stale claimed export.
6. A stopped RunPod starts for a ready GPU stage and queued work dispatches
   after its heartbeat.
7. The Pod stops only after the idle timeout and never while a GPU stage is
   ready or running.
