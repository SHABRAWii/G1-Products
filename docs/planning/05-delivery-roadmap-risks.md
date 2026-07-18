# Delivery, deployment, and risk plan

## Deployment topology

Deploy the web/API and workflow workers as stateless services. Use managed PostgreSQL with backups/PITR, managed Redis, an S3-compatible object store, a secrets manager, and a container registry. Run GPU workloads as isolated RunPod templates with network egress allow-lists where practical. Separate development, staging, and production workspaces, buckets, credentials, rate cards, and RunPod accounts/projects.

Infrastructure-as-code must create least-privilege identities, private database networking, bucket encryption/lifecycle policy, observability destinations, and alert routes. CI builds immutable adapter images, scans dependencies, runs unit/integration/contract tests, and promotes image digests rather than mutable tags.

## Phased implementation

| Phase | Deliverable | Exit criteria |
| --- | --- | --- |
| 0. Foundations | ADRs, licensing decision, artifact schemas, one robot/model target, infrastructure and auth skeleton | Commercial pose-extractor path approved; canonical pose and robot-motion contracts signed off. |
| 1. Control plane + ingress | Polished React dashboard shell for Home/New Job/Jobs/Assets, shared design system, RBAC, projects/assets/uploads, object storage, job preflight, immutable plans, basic cost estimates | Video upload and an existing pose/motion asset can create and track a durable job across restart; primary flows meet responsive and accessibility checks. |
| 2. Video/pose/retarget adapters | Containerized video provider, PromptHMR replacement or approved engine, GMR adapter, artifacts, logs, RunPod leases, structured telemetry | Prompt/video to retargeted motion completes with reproducible manifests, cost ledger, and retry/cancel behavior. |
| 3. Review and visualization | Pose-review queue, track selection/annotation, browser viewers, derived approved artifacts, retarget safety checks | Unapproved poses cannot reach retarget/training; approved edits branch lineage correctly. |
| 4. Training and policies | Dataset snapshots, recipe registry, training workers, policy/checkpoint registry, evaluation metrics/comparisons | Training and policy-evaluation jobs operate from frozen inputs and can promote a versioned policy. |
| 5. Simulation verification | Scenario catalog, simulation workers, evidence viewer, threshold gates, signed verification decision | Policy+motion validation runs deterministically and reports pass/fail evidence/cost. |
| 6. Operations hardening | Cost reconciliation, budgets/alerts, retention, load/security testing, runbooks, disaster recovery drills | Spend and resource totals reconcile to provider evidence; recovery objectives and operational acceptance met. |

## Initial acceptance tests

1. Create jobs for every allowed start/end path and reject incompatible source artifacts before dispatch.
2. Complete an upload -> pose -> review -> retarget -> visualization run; approve a selected track and verify new lineage/output versions.
3. Complete a prompt -> video -> pose -> review -> retarget path using a provider operation that survives API and worker restart.
4. Start training from a frozen approved motion dataset, evaluate a named policy version, and run a selected simulation scenario.
5. Reconcile a RunPod lease, a video API request, and storage sample to cost-ledger entries; compare estimated, observed, and reconciled totals.
6. Verify cancel/retry/idempotency behavior, workspace isolation, signed artifact links, audit logs, budget block, and lost-worker cleanup.

## Risk register

| Risk | Impact | Mitigation / decision |
| --- | --- | --- |
| PromptHMR non-commercial license | Blocks commercial delivery | Obtain rights or replace before Phase 2; keep pose adapters pluggable. |
| Pose quality from unconstrained/generated video | Unsafe or unusable retargeting | Ingress guidance, confidence gates, mandatory review, track selection, data-quality metrics, and a curated regression set. |
| GMR / robot / simulator convention mismatch | Invalid motion or misleading simulation | Canonical coordinate/DOF contract, golden fixtures, adapter contract tests, and per-robot compatibility registry. |
| GPU availability, long cold starts, orphan pods | Cost spikes and slow jobs | Lease ownership, quotas, idle TTL, heartbeats, reconciliation, scheduler fallback SKUs, and alerts. |
| Provider price/model/API changes | Incorrect estimates or failed jobs | Versioned rate cards, provider adapters, capability discovery, persisted provider operation IDs, and configurable model catalog. |
| GPU/ML dependency conflicts | Fragile deployments | One pinned OCI image per engine, image digests, no Conda switching in a shared process, and smoke tests on supported GPU types. |
| Pickle/third-party artifact deserialization | Code execution/security exposure | Treat raw pickle as restricted data; never load it in web/API; convert inside isolated workers and validate derived schemas. |
| Missing auditability/reproducibility | Cannot trust results or costs | Immutable manifests, event log, artifact lineage, image/model hashes, input checksums, and rate-card snapshots. |
| Simulation overconfidence | Physical safety risk | Separate simulation evidence from hardware approval; safety thresholds, scenario diversity, and human release control. |
| Large media and visualization egress | Poor UX and unbounded cost | Direct multipart uploads, proxies/derivatives, range requests, CDN/signed URLs, lifecycle policies, and egress ledger entries. |

## Implementation sequence inside Phase 2

Begin with an adapter contract test harness and golden test assets before wiring any UI action to production compute. Implement GMR retargeting first from an uploaded canonical SMPL-X asset, then add video upload to pose, then provider-based video generation. This isolates the legally and operationally riskiest upstream components while validating the artifact, orchestration, cost, and visualization foundations early.
