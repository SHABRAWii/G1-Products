# Architecture, data, and cost plan

## Target architecture

```text
Browser -> Web app / API -> PostgreSQL
                         -> Object storage (raw, derived, evidence artifacts)
                         -> Orchestrator -> queue -> adapter workers on RunPod
                                           -> video-generation provider APIs
                                           -> training / evaluation workers
                                           -> simulation workers
                         -> cost collector <- RunPod + providers + storage inventory
```

Use a modular monolith for the control plane initially: TypeScript web application and API, PostgreSQL, Redis, S3-compatible object storage, and a durable workflow engine. Keep compute as separate Python container images. This provides a small deployment footprint while preserving service boundaries for future extraction.

### Recommended implementation choices

- Frontend/API: Next.js (App Router), React, and TypeScript with a server-side TypeScript API layer. Use Tailwind CSS plus a Radix-based shared component system, generated OpenAPI clients, and Playwright for end-to-end and visual-regression coverage.
- Metadata: PostgreSQL with row-level workspace scope; Redis only for cache, rate limiting, pub/sub, and ephemeral viewer coordination.
- Workflows: Temporal is preferred for long-running, retriable, human-gated jobs. A durable queue with a persisted state machine is acceptable only if it provides idempotency, timers, signals, and recovery after API restarts.
- Artifacts: S3-compatible bucket (Cloudflare R2/S3/MinIO) with multipart direct upload, versioned immutable object keys, checksums, lifecycle tiers, and server-side encryption.
- Compute: RunPod Pods or Serverless workers selected through a provider adapter. The scheduler owns leases; stage workers never create untracked GPU resources.
- Observability: OpenTelemetry traces, structured JSON logs, metrics, error reporting, and immutable audit events.

## Versioned artifact contracts

Artifact type, schema version, media type, checksum, object key, producing run, logical parent, and provenance are mandatory. Avoid exposing Python pickles as the only interchange format.

| Type | Canonical payload | Interoperability/export |
| --- | --- | --- |
| `video.source` / `video.generated` | MP4/WebM plus probe metadata, frame timestamps, prompt/provider request metadata | Original media, thumbnails, low-res review proxy. |
| `pose.prompthmr.raw` | Restricted raw `results.pkl` plus manifest | Never deserialized in the web/API process. |
| `pose.smplx` | NPZ and a JSON schema manifest: FPS, axes, coordinate units, tracks, pose/translation/shape shapes | GLB/MCS previews and decimated JSON trajectory for the viewer. |
| `pose.reviewed` | Immutable derived pose or patch + review decision/annotations | Same SMPL-X export contract. |
| `motion.robot` | Canonical NPZ/Parquet arrays and manifest: robot model/version, DOF names/order, root position/rotation convention, FPS, units | GMR-compatible pickle only as adapter import/export. |
| `visualization` | MP4, GLB, thumbnails, metrics/plot series | Browser-safe signed URLs. |
| `dataset.training` | Manifest referencing approved motion versions, splits, recipe compatibility, frozen checksums | Dataset snapshot manifest. |
| `policy.checkpoint` | Framework checkpoint, model card, ONNX/exported policy if applicable | Signed, registry-controlled download. |
| `evaluation.report` / `simulation.evidence` | JSON metric schema plus rendered evidence | Comparison-ready normalized metrics. |

## Database model

All tables include `id`, `workspace_id`, timestamps, and actor/audit fields unless clearly global.

| Entity | Key fields and relationships |
| --- | --- |
| `workspace`, `user`, `membership`, `role_binding` | Tenant boundary and authorization. |
| `project` | Logical work container; owns jobs, assets, budgets, labels. |
| `asset` and `asset_version` | Logical asset and immutable physical/version record; type/schema/checksum/storage/lineage/approval status. |
| `artifact_link` | Typed parent/child lineage between asset versions and stage runs. |
| `job` | Immutable requested start/end, source asset, normalized stage plan, requested settings, priority, state, estimate snapshot. |
| `job_stage` | One planned stage with dependencies, adapter/version/config, lifecycle state, attempts, gate status, selected input/output artifacts. |
| `stage_attempt` | Dispatch, worker/RunPod allocation, container digest, logs, timings, retry reason, structured result. |
| `review_task`, `review_annotation`, `review_decision` | Assigned reviewer, versioned annotations/edits, approval/rejection, rationale, decision gate. |
| `robot_model`, `robot_model_version`, `adapter_version`, `training_recipe`, `simulation_scenario` | Versioned configuration catalogs and compatibility declarations. |
| `training_run`, `policy`, `policy_version`, `evaluation_run`, `simulation_run` | Domain records linked to jobs/artifacts and normalized metric summaries. |
| `compute_resource`, `compute_lease`, `usage_sample` | RunPod resource ID/type/region, allocation timestamps, sampled runtime, state, owner stage attempt. |
| `rate_card`, `rate_card_item`, `cost_estimate`, `cost_ledger_entry`, `budget`, `budget_alert` | Currency, unit price, provider SKU, effective period, estimated/actual/finalized cost, source evidence. |
| `audit_event`, `webhook_delivery` | Security and integration traceability. |

## Cost and resource accounting

Store money as integer minor units plus ISO currency, never floats. Each quote and ledger entry pins the active rate-card item/version.

| Cost class | Estimate source | Actual source | Required dimensions |
| --- | --- | --- |
| RunPod compute | Stage duration heuristic by adapter/model/video length and selected GPU rate | Pod/endpoint lifecycle plus sampled runtime; reconcile with provider usage/invoice | provider resource ID, GPU SKU, region, seconds, rate card, lease/stage. |
| Video API | Provider/model/duration/resolution/request settings rate card | Provider response/usage record, or reconciled invoice allocation | provider, model, request ID, duration, resolution, units. |
| Object storage | Predicted source/derived outputs and retention class | Daily object inventory/usage sampling and egress events | bucket/class, GiB-days, requests, egress, asset version. |
| Platform/other | Optional fixed/worker overhead allocation | Internal billing/export policy | workspace/project/job attribution. |

The cost service creates a non-billable `estimated` ledger on job submission, records immutable `observed` entries during execution, and later writes `reconciled` adjustments. UI displays estimated, observed, and reconciled totals separately. Budget enforcement supports warn, require approval, and block policies before dispatch.

## Storage layout and lifecycle

Use opaque, workspace-isolated keys such as `workspaces/{workspace}/assets/{asset}/{version}/{role}/{content-hash}`. Store manifests separate from bulk data, assign lifecycle classes (`hot`, `review`, `archive`, `delete-pending`), generate review proxies, and retain provenance manifests after raw objects age out. Upload directly to object storage via short-lived multipart URLs; the API validates size/type/checksum on completion.

No cloud credential, provider key, raw model license file, or client-owned artifact URL is stored in browser state or job parameters. Secrets are referenced by a workspace/provider credential ID and resolved only in the worker at runtime.
