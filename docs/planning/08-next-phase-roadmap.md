# Next-phase roadmap: visualization, multi-robot, commercial-use, compute flexibility, prompt-generated training

**Created:** 2026-08-10
**Estimated complexity:** XL (multi-quarter, small team)
**Status:** Draft
**Base branch:** `mvp/robot-studio` (current final-output branch)

## Goal

RoboMotion's MVP pipeline (video → PromptHMR pose extraction → review → GMR
retargeting → visualization → `unitree_rl_mjlab` training) works end-to-end for
one robot (Unitree G1, 29 DoF) on one compute path (RunPod). This plan takes it
from a working single-robot MVP to a defensible, extensible commercial product:
own its post-training analytics instead of depending on wandb, remove the
non-commercial license sitting under the pose-extraction path, let users train
additional curated humanoids, let users choose where processing runs, and let
non-expert users adapt a training environment through a guided, LLM-assisted
config wizard rather than raw code.

Perception and navigation training (the other half of the original "expand the
user base" ask) is intentionally **not** in this plan — see
[Out of scope](#out-of-scope).

## Current state

Confirmed by reading the code, not assumed:

- **Post-training data is already computed, just not shown.** `scripts/run-motion-stage.py`
  runs `unitree_rl_mjlab` training with `WANDB_MODE=offline` (`scripts/run-motion-stage.py:253`),
  zips the offline run directory, and uploads it as an `EVALUATION_REPORT`
  artifact (`scripts/run-motion-stage.py:305-309`). Nobody opens it — there is no
  UI for it. Separately, `lib/training-telemetry.ts` already parses live stdout
  into structured `TrainingMetricPoint`s (reward, termination, episode length,
  steps/sec) and `components/training-run-table.tsx` renders a compact live
  summary card. There is no charting/history view yet — `/training-policies`
  (`app/training-policies/page.tsx`) is just that one table.
- **The commercial blocker is already identified in this repo's own docs, unresolved.**
  `docs/planning/05-delivery-roadmap-risks.md:40` lists "PromptHMR non-commercial
  license → Blocks commercial delivery" as a Phase-0 exit criterion that was
  never closed. It is not only PromptHMR: SMPL/SMPL-X body models (referenced as
  licensed credentials throughout `docs/system-structure-and-deployment.md`) carry
  their own separate non-commercial research license, used by both PromptHMR and
  GMR. GMR's own code and `unitree_rl_mjlab` are permissively licensed
  (`docs/planning/02-reference-assessment.md:31`); the blocker is specifically
  the pose-extraction model and the body-model data it and GMR consume.
- **The multi-robot data model already exists and is unused beyond G1.**
  `prisma/schema.prisma` already defines `RobotModel`, `Policy`, `PolicyVersion`,
  `EvaluationRun`, `SimulationScenario`, and `SimulationRun` (lines 423-555).
  Nothing seeds more than the implicit G1 row today, and nothing populates
  `EvaluationRun`/`SimulationRun` at all — `policy_evaluation` and
  `simulation_verification` are declared pipeline stages
  (`prisma/schema.prisma:36-46`, `lib/stage-registry.ts:22-23`) with zero adapter
  implementation. `scripts/run-motion-stage.py:98-100` already has a small
  precedent for more than one robot variant (`TRAINING_ROBOTS` has both
  `unitree_g1` and `unitree_g1_23dof`), but `Job.robotModel` is a free string
  (`prisma/schema.prisma:184`) validated against nothing, and every output
  contract in `lib/stage-registry.ts:19-21` is hardcoded to
  `motion.robot.unitree-g1-29dof-npz/v2`.
- **Compute is RunPod-shaped in the scripts, but not in the schema.**
  `ComputeResource.provider`/`ComputeLease.provider` are free strings
  (`prisma/schema.prisma:310-351`), and a local worker path already exists
  (`lib/local-pipeline-worker.ts`, `scripts/start-local-worker.sh`,
  `npm run worker:motion` / `worker:training`) alongside the RunPod controller
  (`lib/runpod-controller.ts`, `scripts/runpod-controller.ts`). The
  control-plane/gpu-plane split (`docs/planning/07-control-and-gpu-plane-split.md`)
  is RunPod-lifecycle-specific: Pod start/stop/idle logic, not a general
  provider abstraction. Today exactly one worker runs at a time
  ("one serialized worker" — `docs/system-structure-and-deployment.md:46`),
  so there is no concurrent-job scheduling yet.
- **Training environments are fixed, not editable.** `scripts/run-motion-stage.py`'s
  `TRAINING_ROBOTS` dict hardcodes the `mjlab` task id per robot; there is no
  recipe-selection UI (per-memory: recipe config is "a fixed, unchangeable
  mirror" of that dict) and no path from a user prompt to a validated training
  config.

## Proposed approach

Sequence by risk and dependency, not by the order features were listed, per
your steer. Two tracks can run in parallel from day one given a 2-4 person team.

```
Track A (ML/infra-heavy):  Phase 0 (license) ──▶ Phase 3 (multi-robot) ──▶ Phase 4 (prompt-gen wizard)
Track B (product/app):     Phase 1 (viz) ──▶ Phase 2 (compute flexibility)
```

**Phase 0 (commercial-use blocker) goes first and gates commercial launch,**
not feature delivery — Phases 1 and 2 do not touch PromptHMR/SMPL-X and can
ship to existing users before Phase 0 lands. But do not commercially onboard
new robots (Phase 3) or new paying users on the strength of Phase 3/4 while
Phase 0 is open — every stage built on top of PromptHMR/SMPL-X inherits the
same license restriction.

Phase numbers below are execution order per track, not calendar phases.

---

## Phase 0: Remove the PromptHMR / SMPL-X commercial blocker

### Task 0.1: Survey commercially-licensed replacements (Complexity: M)

**What:** Evaluate alternative video→3D-human-pose models and body models
against: license (must permit commercial use, redistribution of derived
checkpoints if self-hosted), accuracy vs. PromptHMR on your existing review
set, GPU cost/latency, maintenance activity, and whether it outputs
SMPL/SMPL-X-compatible parameters GMR can consume without a rewrite (or
whether GMR's input adapter also needs to change).

**Why:** You confirmed no candidate is picked yet. This is the highest-leverage
decision in the whole roadmap — it determines the shape of Task 0.2 and whether
GMR's retargeting math needs to change at all.

**Dependencies:** None

**Success criteria:**
- [ ] Written comparison of ≥3 candidates against the criteria above
- [ ] One candidate selected with an explicit license citation (link + license
      name), reviewed against your actual commercial terms (not just "looks
      permissive")
- [ ] Confirmed whether the candidate's output can feed GMR directly or needs a
      conversion adapter

**Files affected:** new `docs/planning/09-pose-model-selection.md`

**Testing approach:** N/A (research task); success criteria above are the
deliverable.

---

### Task 0.2: Build the replacement pose-extraction adapter (Complexity: L)

**What:** Implement the selected model as a new adapter behind the existing
`pose_extraction` stage boundary (`lib/stage-registry.ts:17`,
`scripts/run-motion-stage.py`'s `pose_extraction` branch), replacing the
PromptHMR conda environment/install step
(`deploy/install-direct-models.sh`, `deploy/Dockerfile.gpu-worker`) with the
new model's install. Preserve the existing output contract
(`pose.smplx/v1`, `pose.track-manifest/v1`) if the new model emits
SMPL/SMPL-X-compatible parameters; version-bump the contract if it doesn't.

**Why:** `docs/planning/02-reference-assessment.md:37` already established the
adapter boundary specifically so PromptHMR could be swapped without touching
the rest of the pipeline — this task is exercising that boundary as designed,
not inventing a new one.

**Dependencies:** Task 0.1

**Success criteria:**
- [ ] `pose_extraction` stage runs end-to-end on the new model against your
      existing review-set videos with acceptable quality (define the
      acceptance bar from Task 0.1's comparison)
- [ ] Pose-review UI works unmodified against the new model's output
- [ ] PromptHMR conda env/install code fully removed from
      `deploy/install-direct-models.sh` and `deploy/Dockerfile.gpu-worker`
- [ ] `README.md`'s "PromptHMR has upstream license restrictions" line and the
      matching lines in `docs/local-pipeline-worker.md`,
      `docs/server-gpu-deployment.md`, `docs/planning/02-reference-assessment.md`,
      `docs/planning/05-delivery-roadmap-risks.md` updated to reflect the new model

**Files affected:**
- `scripts/run-motion-stage.py` (pose_extraction branch)
- `deploy/install-direct-models.sh`, `deploy/Dockerfile.gpu-worker`
- `lib/stage-registry.ts` (adapter name, contracts if versioned)
- License/doc references listed above

**Testing approach:** Re-run the existing pose-extraction integration tests
against the new adapter; add a golden-output regression test comparing new
vs. old model output on a fixed reference video (documents the accuracy
delta, doesn't require exact match).

---

### Task 0.3: Replace or license the SMPL/SMPL-X body model dependency (Complexity: M-L)

**What:** Depending on what Task 0.1 selected (some replacement pose models
ship their own body model, others still emit SMPL/SMPL-X parameters), either
retire the `robomotion_smplx_*`/`robomotion_smpl_*` credentials entirely, or
confirm and document that GMR's use of SMPL-X remains a licensed dependency
you accept for the MVP. Do not let this get silently forgotten as a
"someone else's problem" — GMR consumes SMPL-X regardless of which pose model
feeds it, so this needs its own explicit decision even after Task 0.2 lands.

**Why:** This is the second half of the license blocker that's easy to miss —
fixing PromptHMR alone does not fix commercial use if GMR's SMPL-X dependency
is still gated by the same non-commercial research license.

**Dependencies:** Task 0.1 (informs whether this is even still a problem)

**Success criteria:**
- [ ] Explicit written decision: SMPL/SMPL-X dependency retired, or
      knowingly retained with a documented license basis for commercial use
- [ ] If retired: `deploy/configure-model-secrets.sh` and the deploy docs no
      longer reference SMPL/SMPL-X credentials

**Files affected:** `deploy/configure-model-secrets.sh`,
`docs/system-structure-and-deployment.md`, GMR adapter install steps

**Testing approach:** Same regression path as Task 0.2.

---

## Phase 1: Native post-training data visualization

### Task 1.1: Design the training-run detail view (Complexity: S)

**What:** Sketch the view that replaces "download the wandb offline zip":
reward-over-iteration chart, episode-length chart, per-termination-cause
breakdown over time, steps/sec, and the existing best-checkpoint marker. Reuse
`TrainingTelemetry`'s already-structured `history: TrainingMetricPoint[]`
(`lib/training-telemetry.ts:14-24`) as the data contract — no new metrics
pipeline needed, just a consumer.

**Why:** The hard part (parsing training stdout into structured points) is
already built and tested. This phase is a rendering problem, not a data
problem.

**Dependencies:** None (parallel to Phase 0)

**Success criteria:**
- [ ] Wireframe/mock reviewed and approved
- [ ] Chart library choice made (check `dataviz` skill guidance before writing
      chart code)

**Files affected:** none (design artifact)

---

### Task 1.2: Build the training-run detail page (Complexity: M)

**What:** New route (e.g. `app/training-policies/[runId]/page.tsx`) rendering
the charts from Task 1.1 against `TrainingRun.metrics` (already populated by
`compactTrainingReport()`, `lib/training-telemetry.ts:119-151`). Link to it
from `components/training-run-table.tsx`.

**Why:** `compactTrainingReport` already samples history down to 240 points and
keeps `best`/`latest`/`evaluation` — the persisted data is already
chart-ready; this is additive UI.

**Dependencies:** Task 1.1

**Success criteria:**
- [ ] Detail page renders live-updating charts for a RUNNING run and a static
      final view for a COMPLETED/FAILED run
- [ ] Works with the existing 3s polling pattern already used in
      `training-run-table.tsx:105`, or upgrade to SSE/websocket if polling
      proves too chatty (measure first, don't assume)

**Files affected:**
- new `app/training-policies/[runId]/page.tsx`
- new chart component(s) under `components/`
- `components/training-run-table.tsx` (add link)

**Testing approach:** Unit test chart data transforms; manual test against a
real RUNNING and COMPLETED run in dev.

---

### Task 1.3: Retire or repurpose the wandb-offline-zip artifact (Complexity: S)

**What:** Decide whether the `wandb-offline-run.zip` artifact
(`scripts/run-motion-stage.py:305-309`) stays as a power-user export option or
gets removed now that the dashboard has native charts. If kept, label it
clearly as "raw wandb export" in the Artifacts panel, not the primary way to
see results.

**Why:** Avoids two competing "sources of truth" for training results once
Task 1.2 ships. Also, `WANDB_MODE=offline` running at all is a soft
dependency on a wandb-shaped local format — worth deciding if it is still
needed once you have first-party visualization.

**Dependencies:** Task 1.2

**Success criteria:**
- [ ] Written decision recorded; either the zip generation is removed or its
      artifact label/description makes its role in the UI unambiguous

**Files affected:** `scripts/run-motion-stage.py`, artifact display naming
(`lib/artifact-display-name.ts`)

---

## Phase 2: Compute flexibility — local execution + multi-job scale-out

Scoped per your input to **local execution** and **parallel job scale-out**,
explicitly **not** single-job multi-GPU distributed training (RSL-RL/mjlab's
current worker model assumes one GPU per job; that's a much larger change to
the training runtime itself and isn't warranted by demand yet).

### Task 2.1: Generalize the compute-provider abstraction (Complexity: M)

**What:** `ComputeResource.provider`/`ComputeLease.provider` are already free
strings — formalize a small provider interface (start/stop/status/heartbeat)
that both the existing `lib/runpod-controller.ts` and a new "local" and
future "generic cloud GPU" provider implement, so dispatch logic
(`lib/local-pipeline-worker.ts`, `lib/orchestration.ts`) stops assuming RunPod
is the only GPU path.

**Why:** The schema already anticipated this (no migration needed for the
data model); the gap is entirely in the controller/dispatch code, which is
currently RunPod-lifecycle-specific per
`docs/planning/07-control-and-gpu-plane-split.md`.

**Dependencies:** None (parallel to Phase 0/1)

**Success criteria:**
- [ ] Provider interface defined and documented
- [ ] Existing RunPod controller refactored to implement it with no behavior
      change (regression: existing acceptance checks in
      `docs/planning/07-control-and-gpu-plane-split.md:97-108` still pass)

**Files affected:** `lib/runpod-controller.ts`, `lib/runpod-control.ts`,
`lib/orchestration.ts`, `lib/worker-status.ts`

**Testing approach:** Existing `tests/test-runpod-controller.test.ts` continues
to pass unmodified against the refactor; add a fake/no-op provider for tests.

---

### Task 2.2: First-class local-GPU provider in the dashboard (Complexity: M)

**What:** A local worker already exists (`lib/local-pipeline-worker.ts`,
`npm run worker:motion`/`worker:training`) but it's a dev-workflow tool, not a
user-facing compute choice. Add a workspace/project-level setting to select
"local" as the compute target, surface local worker heartbeat/capability in
the same UI that shows RunPod status, and make cost estimation
(`lib/costs.ts`) correctly report $0/provider-billed for local runs instead of
RunPod-rate-card pricing.

**Why:** This is the "run wherever you want" ask in its most concrete,
lowest-risk form — the execution path already works, it's unexposed.

**Dependencies:** Task 2.1

**Success criteria:**
- [ ] User can select local compute per project/workspace in Settings
- [ ] A job dispatched to local compute runs correctly end-to-end and shows
      accurate (non-RunPod) cost accounting
- [ ] Local worker connection/capability status is visible in the same place
      RunPod Pod status is shown today

**Files affected:** `app/settings/`, `lib/costs.ts`, `lib/worker-status.ts`,
`lib/local-pipeline-worker.ts`

**Testing approach:** End-to-end job run against local worker in dev, verified
manually per this project's UI-testing convention (start dev server, drive
the flow in a browser).

---

### Task 2.3: Concurrent job scheduling for scale-out (Complexity: L)

**What:** Today the system runs "one serialized worker" total
(`docs/system-structure-and-deployment.md:46`). Scale-out ("rent multiple
GPUs" = many jobs in parallel) requires: multiple worker identities able to
claim work concurrently, per-worker stage-claim locking so two workers never
grab the same `JobStage`, and RunPod controller logic that can start N pods
instead of one based on queue depth.

**Why:** This is the real engineering cost in Feature 4 — everything else is
provider plumbing, this is genuine concurrency-control work against
`JobStage`/`StageAttempt`.

**Dependencies:** Task 2.1

**Success criteria:**
- [ ] Two workers (e.g. one local + one RunPod, or two RunPod pods) can each
      claim and run a different job's stage at the same time with no double-
      claim, verified under an induced race (two workers polling
      simultaneously against the same queued stage)
- [ ] RunPod controller scales pod count within a configured max based on
      queued GPU-stage count, not just start/stop of one pod
- [ ] Idle-timeout and cost-ledger accounting correctly attribute usage
      per-pod when more than one pod is running

**Files affected:** `lib/orchestration.ts`, `lib/local-pipeline-worker.ts`,
`lib/runpod-controller.ts`, `prisma/schema.prisma` (if worker-identity
tracking needs a new field — check `WorkerHeartbeat` first, it may already be
sufficient)

**Testing approach:** Concurrency test with two worker processes racing
against a shared queued stage in the dev database; verify via `JobEvent`/
`StageAttempt` audit trail that exactly one claimed it.

---

## Phase 3: Multi-robot training catalog

Scoped per your input to a **curated set you add** (not user-uploaded
arbitrary URDF/MJCF).

### Task 3.1: Stop hardcoding G1 in stage contracts (Complexity: M)

**What:** `lib/stage-registry.ts:19-21`'s output contracts are literally named
`motion.robot.unitree-g1-29dof-npz/v2` — generalize to
`motion.robot/v2` with robot identity carried as data (already possible:
`Job.robotModel` is a free string today), not encoded in the contract name.
Update `scripts/run-motion-stage.py`'s hardcoded scene/manifest naming
(`unitree_g1_digital-twin-scene.json` etc.) the same way.

**Why:** This is the actual generalization work — everything downstream
(training, viz) currently assumes the contract name itself proves it's a G1.
Without this, every new robot needs its own contract string and every
consumer needs to branch on it.

**Dependencies:** None (can start immediately, parallel to Phase 0-2)

**Success criteria:**
- [ ] G1 continues to work end-to-end after the rename (regression, not
      behavior change)
- [ ] Contract carries robot identity as a field, not string-encoded in the
      contract name

**Files affected:** `lib/stage-registry.ts`, `scripts/run-motion-stage.py`,
consumers of the old contract string (grep before renaming)

---

### Task 3.2: Seed and expose the `RobotModel` catalog (Complexity: M)

**What:** `RobotModel` already exists in the schema (`prisma/schema.prisma:423`)
but is never seeded. Seed it with G1 (retroactively) plus your first
additional target robot (pick one — H1 is the most natural second Unitree
target since GMR/`unitree_rl_mjlab` already have some multi-robot precedent
per `TRAINING_ROBOTS`). Add the URDF/MJCF assets, GMR robot-config mapping,
and an `mjlab` task id the same way `unitree_g1_23dof` was added
(`scripts/run-motion-stage.py:99-100`), i.e. following an existing pattern,
not inventing one.

**Why:** This validates the whole Phase-3 pipeline end-to-end on a second real
robot before investing in a polished picker UI (Task 3.3) — proves the
contract generalization from 3.1 actually holds for something other than G1.

**Dependencies:** Task 3.1

**Success criteria:**
- [ ] Second robot completes retargeting → visualization → training end-to-end
- [ ] `RobotModel` rows exist for both robots with correct `dof`/`config`
- [ ] GMR retargeting quality for the new robot manually reviewed and accepted
      (retargeting correctness is robot-specific and needs a human check, not
      just "it ran without error")

**Files affected:** `prisma/seed.ts`, GMR asset/config directories,
`scripts/run-motion-stage.py` (`TRAINING_ROBOTS`)

**Testing approach:** Full pipeline run against the new robot in dev; extend
`tests/test_training_adapter.py`-style joint-order validation for the new
robot's joint set.

---

### Task 3.3: Robot picker in New Job flow (Complexity: S)

**What:** `app/new-job/` currently has no robot selection (robot is presumably
implicit/hardcoded). Add a picker sourced from the now-seeded `RobotModel`
catalog, gated on `active: true` so you can stage robots before making them
user-selectable.

**Why:** Low complexity once 3.1/3.2 exist — this is the visible payoff of the
harder plumbing work.

**Dependencies:** Task 3.2

**Success criteria:**
- [ ] User can pick either robot when creating a job
- [ ] Job plan/cost estimate correctly reflects the selected robot's stages

**Files affected:** `app/new-job/`, `lib/job-planner.ts`

---

## Phase 4: Prompt-generated, LLM-assisted training config wizard

Scoped per your input to a **constrained, bounded-parameter wizard** — natural-
language intent mapped to validated config fields, not open code generation.

### Task 4.1: Define the editable-parameter schema and safe bounds (Complexity: M)

**What:** Enumerate which `unitree_rl_mjlab`/mjlab task parameters are safe to
expose (reward term weights, termination thresholds, domain-randomization
ranges, episode length, curriculum settings) with explicit min/max bounds per
parameter, separate from parameters that stay fixed (network architecture,
core physics timestep, safety-critical termination conditions). This schema
is the actual safety boundary for the whole feature — get it right before any
LLM integration work.

**Why:** This is the task that prevents Feature 5's real risk (silently unsafe
or GPU-hour-wasting configs). It's a domain-knowledge task, not a coding task
— do this with whoever owns the RL/training side, not as an LLM-prompting
exercise.

**Dependencies:** Phase 3 substantially complete (need >1 robot's worth of
task configs to confirm the schema generalizes, not just fit G1)

**Success criteria:**
- [ ] Written schema: parameter name, type, bounds, default, per-robot
      overrides if any
- [ ] Explicit list of what stays fixed and why (safety-critical vs.
      just-not-built-yet)

**Files affected:** new `docs/planning/10-training-config-schema.md`,
`lib/training-config.ts`

---

### Task 4.2: NL-to-config translation with validation gate (Complexity: L)

**What:** LLM call that maps a user's plain-language description (e.g. "make
it walk more cautiously on stairs") to a structured diff against Task 4.1's
schema — reject or clamp anything out of bounds before it ever reaches a
config file, and always show the user the resulting concrete parameter
changes (never apply invisibly) for confirmation before dispatch.

**Why:** The safety property has to be enforced in code (schema validation),
not by trusting the LLM to stay in bounds — same reasoning as never trusting
client-side validation alone.

**Dependencies:** Task 4.1

**Success criteria:**
- [ ] Out-of-bounds LLM output is rejected/clamped before reaching the config,
      verified with adversarial prompts ("set reward weight to 1000")
- [ ] User sees and confirms the literal parameter diff before any GPU job is
      dispatched
- [ ] A rejected/ambiguous prompt gives the user a clear reason, not a silent
      fallback to defaults

**Files affected:** new API route (e.g. `app/api/training-config/generate`),
`lib/training-config.ts`, new UI in `app/new-job/` or `app/training-policies/`

**Testing approach:** Adversarial-prompt test suite (bounds-violating,
ambiguous, and off-topic prompts) asserting the validation gate holds
regardless of LLM output; manual UX test of the confirm-before-dispatch flow.

---

### Task 4.3: Recipe versioning and reuse (Complexity: S)

**What:** Persist generated configs as new `TrainingRecipe` rows (already a
model, `prisma/schema.prisma:440`) instead of the current fixed single recipe,
so a user-generated config is named, versioned, and re-runnable/shareable.

**Why:** `TrainingRecipe` already exists specifically for this — Task 4.2's
output should land there, not in a one-off untracked config blob.

**Dependencies:** Task 4.2

**Success criteria:**
- [ ] Each generated config produces a distinct `TrainingRecipe` row
- [ ] `/training-policies` lists recipes with their originating prompt for
      traceability

**Files affected:** `lib/local-pipeline-worker.ts` (`recordTrainingRun`),
`app/training-policies/page.tsx`

---

## Suggested addition (not one of the original five): finish `policy_evaluation`/`simulation_verification`

`EvaluationRun`, `SimulationScenario`, and `SimulationRun` already exist in the
schema (`prisma/schema.prisma:506-555`) and `policy_evaluation`/
`simulation_verification` are already declared pipeline stages
(`lib/stage-registry.ts:22-23`), but neither has any adapter implementation —
grepping the worker and training script for these turns up nothing. I'd
suggest pulling this forward rather than treating it as purely later-phase
work, because it directly de-risks two things this plan adds:

- **Phase 3 (multi-robot):** an automated pass/fail simulation check is a much
  better way to validate a newly-onboarded robot's retargeting/training
  quality than eyeballing it once (Task 3.2 currently relies on manual review).
- **Phase 4 (prompt-generated configs):** an automated evidence gate is the
  natural safety backstop for user-edited training configs — "did the
  resulting policy actually complete the reference motion in simulation"
  is a much stronger signal than "training didn't crash."

This doesn't have to block Phase 3/4, but consider sequencing at least a
minimal `simulation_verification` implementation (even just "does the policy
complete the reference motion without falling," which `PolicyEvaluation`'s
`completedReferenceMotion`/`completionRatio` fields in
`components/training-run-table.tsx:43-49` already anticipate) before opening
either feature to real users.

---

## Out of scope

**Perception and navigation training** — deliberately excluded from this plan
per your steer to sequence it separately. Flagging why it's a distinct
initiative rather than an extension: it needs a different simulation/task
stack (vision models, SLAM, semantic mapping, path planning) with almost no
code overlap with the current RL motion-imitation pipeline
(`unitree_rl_mjlab`/RSL-RL/MJX), a different training-data story (perception
needs labeled/synthetic sensor data, not motion-capture video), and a
different evaluation methodology. Recommend scoping it as its own planning
doc once Phases 0-4 above are further along, so it can build on whatever
compute-provider (Phase 2) and multi-robot catalog (Phase 3) foundations exist
by then rather than duplicating them.

**Single-job multi-GPU distributed training** — excluded from Phase 2 per your
scope choice. `unitree_rl_mjlab`/RSL-RL's current training loop assumes one
GPU per job; distributing one run across multiple GPUs is a training-runtime
change (data/model parallelism), not an orchestration change, and isn't
justified without demand for training runs too large for one RTX 4090.

**Open-ended prompt-to-code generation for training environments** — excluded
from Phase 4 per your scope choice, for the safety reasons in Task 4.1's
rationale.

**Bring-your-own-robot (arbitrary user-uploaded URDF/MJCF)** — excluded from
Phase 3 per your scope choice. Validating an arbitrary robot's kinematics,
generating a working GMR retargeting config, and producing a stable
`mjlab` task for it automatically is a much harder, open-ended problem than
onboarding curated robots; worth its own investigation later if the curated
catalog validates demand.

## Risks & considerations

| Risk | Impact | Mitigation |
|---|---|---|
| Replacement pose model (Phase 0) has materially worse accuracy than PromptHMR | Degrades the whole pipeline's output quality | Task 0.1's comparison against your real review set before committing; keep the adapter boundary so a second swap stays cheap |
| GMR's own SMPL-X dependency survives the PromptHMR swap unnoticed | Commercial blocker only half-fixed | Task 0.3 makes this an explicit, separate decision, not an assumed side effect of Task 0.2 |
| Concurrent job scheduling (Task 2.3) introduces a double-claim race under real load | Duplicate GPU spend, corrupted stage state | Explicit induced-race test before shipping, not just happy-path testing |
| LLM-generated training config schema (Task 4.1) omits a parameter that turns out to be safety-critical | Unsafe or wasted-GPU training run reaches production | Written, reviewed schema with explicit fixed-vs-editable rationale before any LLM integration; validation gate enforced server-side regardless of LLM output |
| Second robot (Task 3.2) exposes retargeting assumptions baked in for G1 specifically | New robot produces plausible-looking but wrong motion | Human review gate explicitly required in success criteria, not just "pipeline completed" |
| Phase 0 takes longer than Phases 1-2 | Team blocked waiting on legal/ML decision instead of shipping | Phases 1 and 2 are explicitly parallel tracks that don't depend on Phase 0 completion |

## Success metrics

- Phase 0: zero non-commercial-licensed dependencies in the production pose-
  extraction/retargeting path, documented and verifiable by license audit.
- Phase 1: training results reviewable entirely inside the dashboard; the
  wandb-offline artifact is either removed or clearly secondary.
- Phase 2: a job can be dispatched to local compute or to ≥2 concurrent GPU
  workers with correct cost attribution and no double-claimed stages.
- Phase 3: a second robot trains end-to-end with human-reviewed retargeting
  quality and is selectable in New Job.
- Phase 4: a user can describe training intent in plain language and get a
  named, versioned, bounds-validated `TrainingRecipe` without writing config
  directly.

## References

- `docs/planning/README.md` — existing reading order and locked MVP direction
  this plan extends
- `docs/planning/05-delivery-roadmap-risks.md` — original risk register,
  including the still-open PromptHMR license risk this plan's Phase 0 closes
- `docs/planning/07-control-and-gpu-plane-split.md` — current RunPod-specific
  compute lifecycle that Phase 2 generalizes
- `/home/seller/.claude/projects/-home-seller-Dashboard/memory/training_stage_integration.md`
  — prior session's status on wiring `unitree_rl_mjlab` in as the TRAINING
  stage; background for Phases 1, 3, 4
