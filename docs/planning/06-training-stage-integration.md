# Training stage integration

Status report for wiring `unitree_rl_mjlab` in as the real `TRAINING` pipeline stage, on branch `mvp/trainning-pipe`. Written as a snapshot of what's done, what's verified, and what's explicitly deferred — not a forward-looking design doc.

## What's achieved

1. **Environment wiring.** `ROBOMOTION_TRAIN_ROOT`/`ROBOMOTION_TRAIN_ENV` added alongside the existing PromptHMR/GMR model-root env vars, with an independent preflight check in `deploy/start-gpu-worker.sh` and `lib/worker-status.ts` (each model root is now validated only when it's actually configured, so a worker doesn't need every model installed to report itself ready).

2. **pkl → CSV converter** (`scripts/robomotion_training_adapter.py`). Converts a robot-motion pickle — either RoboMotion's own GMR output or a compatible third-party schema (verified against the `g1-moves` repo's) — into the CSV layout `unitree_rl_mjlab`'s own `csv_to_npz.py` expects. Validates the 29-column joint order against `G1_29_DOF_JOINTS` when `joint_names` is present; warns rather than fails when it's absent (trusting the canonical Unitree G1 ordering). Covered by `tests/test_training_adapter.py` (6 cases: valid conversion, missing joint names, mismatched joint order, wrong array widths, missing required fields).

3. **Full stage chain** (`scripts/run-motion-stage.py`'s `training` branch). Chains CSV → npz (`csv_to_npz.py`) → `train.py` → locates the resulting checkpoint (`model_<iteration>.pt`, `model_best.pt` if present, `policy.onnx` if present). Forces `WANDB_MODE=offline` so a missing/invalid wandb API key never blocks a run. **Validated end-to-end on real GPU hardware**, not just unit-tested.

4. **Dashboard wiring** (`lib/local-pipeline-worker.ts`). `TRAINING` added to the worker's executable-stage set, so jobs dispatch and run automatically instead of requiring a manual CLI invocation. On a successful run, `recordTrainingRun()` upserts a `TrainingRecipe`/`TrainingRun` row (recipe config is a fixed mirror of the actual CLI invocation — not user-editable, by explicit choice, since there's no recipe-selection UI yet); failures are not mirrored into `TrainingRun` and remain fully visible through the existing `JobStage`/`StageAttempt`/`JobEvent` trail. Validated live through the real dashboard API: upload → create job → dispatch → worker executes → checkpoint recorded.
   - Two latent bugs found and fixed while testing this: `app/api/jobs/route.ts`'s `acceptedTypes` map had no entry for `training` at all (a job could never validly start there); `lib/worker-status.ts` unconditionally required PromptHMR *and* GMR even for a training-only worker.

5. **Cost tracking.** Needed no new code — `lib/costs.ts` already bills every GPU stage, training included, against one shared `runpod-gpu-minute` SKU. The only real gap was that this dev database's rate card had never been seeded (`prisma db push` doesn't run seeds); fixed by running `npm run db:seed`.

6. **Tests.** `tests/test_training_adapter.py`, wired into `npm run test:motion`'s existing stage. Fixed a regression introduced earlier in this work (a stale, unrelated `.robomotion/worker-models.env` file had been moved aside for local testing, which broke that script's unconditional `source` of it — made the source conditional with a default).

7. **UI.** Two parts, done last as planned:
   - `components/new-job-form.tsx` was structurally blocking training from ever being created through the real dashboard: `entryPoints` (the Start Stage options) didn't list `training` at all, and `availableEndStages` computed `pipelineStages.slice(startIndex, indexOf("training"))` — an *exclusive* end bound that capped the End Stage dropdown at `visualization`. Fixed both: added a `training` entry to `entryPoints`, and changed the slice bound to `indexOf("training") + 1`.
   - `app/training-policies/page.tsx` was a 5-line placeholder stating training was "intentionally disabled" — no longer true. Replaced with a real `TrainingRunTable` component (new file, mirrors `JobTable`'s exact pattern: client component, fetch `/api/training-runs` on mount, `StatusBadge`, link out to the underlying job) rendering real data.
   - **Verified in a real running instance**, not just typechecked: started the dev server, confirmed via the actual rendered HTML that both the Start Stage and End Stage `<select>` elements now list all 6 stages through `training` with correct slice math for every start-stage combination (not just the training-specific case), confirmed the training-policies page renders the correct empty state (no `TrainingRun` rows exist yet, expected), and confirmed a clean dev-server log with no compile or runtime errors across all requests.
   - Deliberately not built here (not scope creep — matches earlier decisions): no recipe-selection UI (recipes are fixed/hardcoded by choice), no `Policy`/`PolicyVersion` promotion UI, no metrics charts/dataset selection/evaluation comparisons from the original product-and-UX plan's larger vision — the backend doesn't support any of that yet.

## Best-checkpoint tracking — investigated, fixed, externalized

Separately, the user had hand-committed a custom "save the best checkpoint" feature directly into their local `unitree_rl_mjlab` git checkout.

- **Investigated for bugs** by reading the actual installed `rsl_rl`/`mjlab` source rather than guessing. No crash risk found (the suspected `kwargs["it"]` `KeyError` didn't pan out — confirmed the real caller passes it as a keyword). The real issue: every reward improvement (frequent, especially early in training) triggered a full checkpoint **plus two ONNX export passes**, far more often than the existing periodic-save schedule — the change's own notes admitted no full training run had ever validated this at scale.
- **Fixed**: best-checkpoint saves now write only the lightweight `.pt` checkpoint; ONNX export stays on its normal periodic/final schedule.
- **Externalized as a patch**, after ruling out a runtime-registry-override approach (`mjlab.tasks.registry.register_mjlab_task()` refuses re-registration; reaching into its private internals was judged more fragile than the alternative). Stored at `deploy/patches/unitree_rl_mjlab-robomotion.patch`, re-diffed against the actual latest upstream commit (not the user's personal fork history) after that was identified as the correct base. Bundles two independent fixes since both are required: the best-checkpoint feature itself, and a `setup.py` dependency fix (see below).
- **Verified for real**: applied via `git apply --check`/`git apply` against a throwaway `git worktree` checked out at the exact pinned base commit, then diffed byte-for-byte against the working fixed files. Also re-verified the idempotency logic (`train_patch_applied`/`apply_train_patch` in the installer script) through all three states — not-yet-applied, already-applied, and a repeat-apply attempt correctly refusing to double-apply.

## Dependency closure — fully verified, not assumed

Walked `mjlab==1.2.0`'s complete transitive `Requires:` graph (119 packages) and diffed it against every package actually installed in a working environment (131 packages). Result: 100% accounted for — the only 12 unreached are `pip`/`wheel`/the package itself and 9 CUDA runtime wheels bundled automatically with whichever `torch` build gets installed.

- Upstream's real `setup.py` only declares `mjlab==1.2.0` + `mujoco-warp==3.5.0`. `mujoco`/`warp-lang` are already covered transitively via mjlab (the user's explicit pins for those are redundant but harmless).
- `scipy` was the one genuine gap: `mjlab`'s own code (`mjlab/terrains/heightfield_terrains.py`, `mjlab/terrains/utils.py`) imports it directly at runtime, but it's only ever declared as an *optional extra* of mjlab's other dependencies — never a plain dependency of anything in the chain — so a bare install never gets it. This is a real upstream packaging gap, and the fix is now part of the patch above.
- `moviepy`, present in a much older version of `unitree_rl_mjlab`'s `setup.py`, is confirmed dead: zero references anywhere in the current codebase, not installed in the working environment, training runs fine without it.

## Dockerizing

- Pinned to the latest genuine upstream commit (`1425b15f73bd4095f0df53709d7c389c3eb9e790`, confirmed current via `git fetch origin` against `unitreerobotics/unitree_rl_mjlab`), with the patch above applied on top — not the user's personal fork/commit history.
- `deploy/Dockerfile.gpu-worker` clones and patches `unitree_rl_mjlab` at build time (cheap; mirrors the existing PromptHMR/GMR pattern). `deploy/install-direct-models.sh` does the heavy lifting at container-start time (conda env creation, pinned `torch==2.13.0`/CUDA 13.0 install, `pip install -e .`), matching the existing staged-progress installer flow, with idempotent patch application.
- **Architecture decision**: training runs in the *same* single `gpu-worker` service/image as the rest of the pipeline for now. A genuinely separate, independently-scaled training worker was recommended (the real problem: one shared poll loop means a multi-hour training job blocks every other pipeline stage — pose extraction, retargeting, visualization — for its entire duration) but explicitly deferred as the next planned feature, not part of this pass.

## Explicitly flagged and deferred (not oversights)

- **`lib/stage-registry.ts`'s stale `inputContracts`.** Still declares a made-up `dataset.training/v1` contract instead of the real `motion.robot/v1`. Confirmed this field is only read by `/api/stages`, which nothing currently calls — zero runtime effect today. Left as-is by explicit instruction; revisit only if something starts actually consuming it.
- **`Policy`/`PolicyVersion`/`RobotModel` catalog support.** Not built. Creating a `Policy` requires a `RobotModel` foreign key, and nothing in the app seeds `RobotModel` rows anywhere today — a separate gap from training itself.
- **Dual-worker architecture.** Recommended, not built. Next planned feature: a genuinely separate training worker (own image, own service, stage-partitioned polling, separate heartbeat identity) so training no longer blocks the rest of the pipeline.
- **The torch/CUDA install line is unverified.** `torch==2.13.0 --index-url .../cu130` in the installer script is a best-effort reconstruction of what's proven to work in the development environment (confirmed via `pip show`/`torch.version.cuda`), not something re-verified by an actual fresh install.
- **No real `docker build` has been run.** Everything checkable without one has been checked for real (patch application and idempotency via actual `git apply` calls in throwaway worktrees, bash syntax via `bash -n`, the full dependency closure walked against a real working environment) — but the Dockerfile and install script have never executed end-to-end. This is the concrete next step before trusting this in production.
