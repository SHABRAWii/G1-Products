# Product and UX plan

## Product model

RoboMotion manages reproducible motion-to-policy work as a graph of versioned artifacts. A job is an execution request over a selected contiguous portion of the pipeline. An artifact may be uploaded, generated, approved, or inherited from another job. This supports, for example:

| Start -> end | Required starting artifact | Typical use |
| --- | --- | --- |
| Prompt -> simulation verification | Prompt and generation settings | Full, guided workflow. |
| Video upload -> pose review | Original video | Review pose quality without retargeting. |
| Pose extraction -> visualization | Video | Generate and inspect human motion. |
| Pose review -> policy evaluation | Approved canonical pose/motion | Bypass video and extraction. |
| Robot retargeting -> simulation verification | Approved SMPL-X pose or canonical robot motion | Retarget a chosen robot then validate it. |
| Training -> policy evaluation | Training dataset and recipe | Resume/evaluate model development. |
| Simulation verification -> simulation verification | Policy + simulation evidence | Re-run a verification scenario or compare versions. |

The New Job flow must only expose choices that have valid source artifacts and compatible schemas. It should show the computed stage path, the validation gate, a preflight GPU/cost estimate, and the expected outputs before submission.

## Primary navigation and views

| Area | Primary user outcome | Essential contents |
| --- | --- | --- |
| Home | Understand current work and required action | Active jobs, review queue, failed/retryable runs, recent artifacts, budget burn, GPU availability, and shortcut actions. |
| New Job | Submit a bounded, reproducible pipeline run | Start/end stage selector, asset picker/uploader, robot/provider/recipe settings, validation requirements, cost and runtime estimate, submit confirmation. |
| Jobs | Find, operate, and audit execution | Filters, status/stage/cost columns, job detail timeline, logs, cancellation/retry/clone, inputs/outputs, lineage, and per-stage cost. |
| Assets | Manage reusable inputs and outputs | Searchable asset catalog, previews, metadata, lineage, versions, approval status, downloads, retention, and archive/delete actions. |
| Training & Policies | Train and compare controllers | Dataset selection, recipe cards, training runs, metrics/charts, checkpoints, model registry, evaluation comparisons, and promotion status. |
| Simulation | Validate motion and policies before hardware | Scenario builder, robot/model version selectors, deterministic replay, rendered evidence, safety metrics, comparison view, and verification decision. |
| Compute & Costs | Control infrastructure and spend | RunPod pods/leases, GPU utilization, queues, rate cards, runtime, forecast vs actual spend, storage usage, video API costs, budgets/alerts, invoice export. |
| Settings | Configure secure, versioned system behavior | Organizations/workspaces, users/roles, provider credentials, adapter versions, robot catalogs, simulation defaults, cost-rate cards, retention, webhooks, and audit settings. |

## UI implementation and quality bar

Build the dashboard with **Next.js, React, and TypeScript**. Use Tailwind CSS and a shared accessible component system built on Radix primitives (for example, shadcn/ui components) so every screen uses the same tokens, controls, states, tables, dialogs, and form behavior. This is a product-quality application, not an administrative prototype.

- Use a desktop-first workspace layout optimized for wide data tables, timelines, charts, and 3D/video review, while making job submission, status, and approvals fully usable on tablet and mobile.
- Establish reusable design tokens for color, typography, spacing, elevation, radius, charts, status, and motion; support light and dark themes from the start.
- Make job state, review status, safety gates, errors, queue position, and costs immediately scannable through consistent visual hierarchy and plain-language labels.
- Provide loading skeletons, empty states, actionable error messages, optimistic updates only where safe, keyboard navigation, visible focus, semantic HTML, and WCAG 2.2 AA contrast and interaction support.
- Use server rendering and route-level loading boundaries for fast initial navigation; virtualize large tables and timelines; lazy-load heavy video, chart, and 3D viewer modules.
- Validate the implementation with responsive browser testing, keyboard-only flows, screen-reader checks for key workflows, and visual-regression tests for shared components and the primary pages.

## New Job interaction contract

1. Choose **workspace**, name, optional labels, start stage, and end stage.
2. Pick or create a compatible input asset. Prompt jobs create a `generation_request`; upload jobs use a resumable upload; later-stage jobs choose an approved artifact or a versioned dataset/policy.
3. Configure the stages included in the computed path. Each form is schema-driven from an adapter manifest, rather than being hard-coded into the browser.
4. Run preflight: validate artifact schema/version, permissions, provider credentials, target robot, model availability, quotas, estimated GPU duration, video API estimate, and storage delta.
5. Submit to create an immutable job specification and a draft execution plan. Show the request's estimate and rate-card version.

## Job detail behavior

The timeline shows queued, dispatched, running, waiting-for-review, retrying, completed, cancelled, and failed states. Each stage exposes:

- input and output artifact versions;
- parameters, adapter/image version, GPU allocation, timestamps, logs, metrics, and cost ledger entries;
- retry from stage, clone with edits, and cancel when permitted;
- an artifact provenance graph with upstream job links.

Review stages are first-class: reviewers compare source video with overlay/3D pose, select tracks, mark segments or frames, apply allowed cleanup, and either approve, reject with a reason, or request a rerun. Any material edit produces a new pose artifact version; approvals never mutate an already approved artifact.

## Visualization requirements

Implement browser-native viewers around pre-rendered and streamable artifacts rather than exposing worker-local Viser ports:

- synchronized source/generated video, 2D keypoints, camera path, and 3D human mesh;
- robot motion playback with joint plot, contact/limit overlays, and video export;
- policy/simulation replay with deterministic run controls and downloadable evidence;
- time-coded annotations that create a review decision or derived artifact.

The first release may render thumbnails, MP4s, GLB, and decimated trajectories server-side. Interactive mesh streaming can follow once authorization and egress controls are established.

## Roles and safeguards

Use workspace-scoped RBAC: `viewer`, `operator`, `reviewer`, `trainer`, `workspace_admin`, and `platform_admin`. Require reviewer or admin approval to pass the pose gate; require a simulation pass and a separate hardware-release workflow before any real-robot command integration. The dashboard is not a direct hardware-control surface in the initial phases.
