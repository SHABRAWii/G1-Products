# Orchestration and API plan

## Pipeline definition

Define each stage in a registry with: accepted artifact types/schema versions, output types, parameter schema/defaults, compatibility rules, required compute profile, cache key policy, validation gate, worker adapter image, and retry policy.

The ordered stage registry is:

1. `video_generation`
2. `pose_extraction`
3. `pose_review`
4. `robot_retargeting`
5. `visualization`
6. `training`
7. `policy_evaluation`
8. `simulation_verification`

Prompt and video upload are **ingress modes**, not executable GPU stages. A prompt creates a generation request; an upload creates `video.source`. This keeps a job starting at `pose_extraction` valid while still supporting prompt-to-video work.

## Job state machine

```text
draft -> preflighted -> queued -> dispatching -> running
                                      |             |
                                      |             +-> waiting_review -> queued
                                      |             +-> succeeded
                                      |             +-> failed -> retrying -> queued
                                      |             +-> cancelled
                                      +-> blocked (budget, quota, dependency, compatibility)
```

Stage states are `pending`, `ready`, `leased`, `running`, `awaiting_review`, `succeeded`, `failed_retryable`, `failed_terminal`, `cancelled`, and `skipped`. A job succeeds only when all selected stages succeed or are explicitly skipped by the computed plan. All transitions require an idempotency key and append an audit event.

### Start/end validation

- The end stage must not precede the start stage in the registry, except an explicit single-stage rerun of simulation/evaluation.
- The selected source artifact must satisfy the start-stage contract; adapters may offer an import/conversion stage only when explicitly selected.
- Each stage receives the exact output version from its predecessor. Re-run or review edits create a new downstream branch rather than overwrite artifacts.
- `pose_review` is a signal-driven durable workflow wait. A rejection routes to a configured remediation stage or ends the job as rejected; approval unlocks the next stage.
- Training must reference a frozen dataset manifest; policy evaluation must reference a concrete policy version; simulation must reference a concrete scenario and robot/simulator version.

## Worker execution protocol

1. Scheduler claims a ready `job_stage`, rechecks budget/quota and input checksums, reserves a compute lease, and issues a signed work manifest.
2. A RunPod adapter provisions/reuses a worker, records resource ID and rate card, and dispatches a container with no database credentials.
3. The worker downloads inputs to scratch storage, executes the pinned stage image, emits structured heartbeat/progress events, uploads artifacts/logs/metrics, and writes an output manifest.
4. The control plane validates schemas/checksums, publishes artifact versions and cost usage, releases the lease, and makes dependents ready.
5. Lost heartbeats trigger lease reconciliation, cancellation cleanup, and a retry only when the adapter's error classification marks the operation safe to retry.

Adapters must distinguish provider-polling work from GPU work. Video generation should persist provider operation IDs and poll from a durable activity; it must not occupy an expensive GPU while waiting for an external API.

Visualization also distinguishes pipeline work from derivative export work.
The GPU stage completes after publishing the validated interactive scene and
unchanged robot-motion output. A durable `ArtifactExport` record drives MP4
capture on the always-on control plane, including progress, stale-claim
recovery, failure isolation, and retry. Downstream training is prepared in the
same transaction that queues this export.

## Validation and safety gates

| Gate | Automatic checks | Human/decision requirement |
| --- | --- | --- |
| Ingress | MIME/probe, duration, checksum, malware policy, schema and quota | Upload owner acknowledges rights to use media. |
| Pose | Track count, missing-frame ratio, confidence/trajectory discontinuity, coordinate/FPS manifest | Mandatory reviewer selects/approves track and annotations. |
| Retarget | Joint position/velocity/acceleration limits, self-collision proxy, foot contact/slip, root stability, adapter compatibility | Reviewer/admin accepts exception if thresholds are exceeded. |
| Training | Dataset frozen, recipe compatibility, regression baseline comparison | Trainer promotes candidate policy. |
| Evaluation | Success/reward, falls, tracking error, latency and regression thresholds | Policy is promoted only on explicit approval. |
| Simulation | Deterministic replay, termination reason, collision/torque/contact limits, scenario pass rate | Simulation verification record is signed/approved. |

Metrics thresholds are versioned by robot model, training recipe, and simulation scenario. A passing visualization is not proof of simulated safety.

## API surface (v1)

All endpoints are workspace-scoped, authenticated, auditable, paginated where listing, and use request IDs/idempotency keys for mutations.

| Area | Representative endpoints |
| --- | --- |
| Jobs | `POST /v1/jobs/preflight`, `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/{id}`, `POST /v1/jobs/{id}:cancel`, `POST /v1/jobs/{id}:retry`, `POST /v1/jobs/{id}:clone`, `GET /v1/jobs/{id}/events` (SSE). |
| Assets | `POST /v1/uploads`, `POST /v1/uploads/{id}:complete`, `GET /v1/assets`, `GET /v1/assets/{id}`, `GET /v1/assets/{id}/versions/{version}`, `POST /v1/assets/{id}:archive`. |
| Review | `GET /v1/review-tasks`, `POST /v1/review-tasks/{id}/annotations`, `POST /v1/review-tasks/{id}:approve`, `POST /v1/review-tasks/{id}:reject`. |
| Catalogs | `GET /v1/stages`, `GET /v1/robots`, `GET /v1/recipes`, `GET /v1/scenarios`, `GET /v1/adapters`. |
| Training/simulation | `GET /v1/training-runs`, `GET /v1/policies`, `POST /v1/policies/{id}:promote`, `GET /v1/simulation-runs`, `POST /v1/simulation-runs/{id}:verify`. |
| Compute/cost | `GET /v1/compute/resources`, `GET /v1/compute/leases`, `GET /v1/costs/summary`, `GET /v1/costs/ledger`, `GET /v1/rate-cards`, `POST /v1/budgets`. |
| Integrations | `POST /v1/webhooks`, `GET /v1/audit-events`, provider callback endpoints protected by signature verification. |

Use a generated OpenAPI client in the frontend. Internal worker communication is event/manifest based; do not expose worker endpoints to the browser.

## Caching and reproducibility

Cache only deterministic, approved stage outputs using a key over adapter/container digest, input artifact checksums, normalized parameters, robot/model versions, and model checkpoint hashes. Video generation is non-deterministic by default and should not be silently cache-hit. Every final asset and report links to a reproducibility manifest containing the full resolved dependency graph.
