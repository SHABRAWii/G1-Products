# Training stage implementation

This document describes the implemented motion-imitation training path and its
operational boundaries.

## Runtime path

```text
Unitree G1 robot_motion.npz
  → strict safe-contract validation
  → mjlab CSV conversion
  → unitree_rl_mjlab csv_to_npz.py
  → RSL-RL PPO training
  → checkpoint artifacts
  → TrainingRecipe + TrainingRun
  → candidate Policy + PolicyVersion
```

The stage accepts only
`motion.robot.unitree-g1-29dof-npz/v2`. The artifact contains numeric arrays
and JSON metadata; it is loaded with `allow_pickle=False`. Legacy Python pickle
motion is deliberately rejected because deserialization can execute code.

When Visualization sits between Retargeting and Training, it validates and
publishes the interactive scene plus the unchanged robot-motion NPZ as its
pipeline `OUTPUT`. It then completes immediately. A separate control-plane
artifact-export worker renders the downloadable 60 FPS digital-twin MP4 in the
background, so policy training can start while the MP4 is still queued or
rendering. Retargeting and visualization do not duplicate browser capture.

Before training, the adapter validates frame count, 29-DoF joint order, array
shapes, finite values, FPS, quaternion norms, and canonical Unitree G1 joint
names. An external NPZ with no joint-name metadata requires an explicit
operator override at the converter CLI and cannot enter through the normal
dashboard contract.

## Recipe configuration

The New Job screen exposes and validates:

- parallel environment count;
- maximum RSL-RL iterations;
- converted motion FPS;
- maximum runtime in minutes.

The validated configuration is stored in `JobStage.config` when the job is
created. It is therefore immutable for that job attempt. The training recipe
identity hashes the reusable algorithm/task/robot/resource parameters and does
not include the per-attempt experiment directory.

## Persistence and policy lifecycle

Dispatch creates or resumes the `TrainingRun` as `RUNNING`; failure,
cancellation, and retry update that same job-owned record. Successful
completion publishes the latest checkpoint as the stage output and may publish
the best checkpoint and ONNX export as evidence. Within the same
database transaction that marks the stage successful, RoboMotion:

1. upserts the immutable `TrainingRecipe`;
2. ensures the Unitree G1 `RobotModel`;
3. creates or updates the job-owned candidate `Policy`;
4. creates the next candidate `PolicyVersion` linked to the checkpoint;
5. upserts the `TrainingRun`;
6. records stage completion, cost, and downstream readiness.

If any catalog write fails, the transaction rolls back and the stage is not
reported as successful. The Training & Policies view shows the recipe,
configuration, robot, candidate policy, and latest version.

## Worker isolation and cancellation

Production runs two services built from the same pinned worker image:

| Worker | Capabilities | Required model environment |
| --- | --- | --- |
| `motion-worker` | pose extraction, robot retargeting, visualization | PromptHMR and/or GMR as required |
| `training-worker` | training | unitree_rl_mjlab only |

Each heartbeat advertises an explicit capability set. Dispatch checks the next
stage against fresh ready heartbeats, and each poller claims only its own
stages. A multi-hour training subprocess therefore cannot block motion jobs.

The worker starts each adapter in its own process group. Job cancellation,
worker shutdown, and runtime expiry send `SIGTERM` to the complete process
group, followed by `SIGKILL` after a grace period. This terminates Conda,
Python, simulator, and descendant processes rather than merely changing a
database status.

## Artifacts, logs, and cleanup

Outputs are streamed to object storage instead of being read into one Node.js
buffer. Live logs are serialized through one ordered write queue so a delayed
progress update cannot overwrite the final attempt result. Temporary converted
motion and unitree experiment directories are removed in a `finally` block;
durable checkpoints are copied into the stage work directory before cleanup.

## Reproducible installation

`unitree_rl_mjlab` is pinned to
`1425b15f73bd4095f0df53709d7c389c3eb9e790`. The small RoboMotion patch in
`deploy/patches/unitree_rl_mjlab-robomotion.patch` adds the packaging and
best-checkpoint behavior required by this integration without modifying the
upstream checkout by hand.

The installer uses the locally verified `torch==2.12.0` CUDA 13.0 wheel and
the `unitree_rl_mjlab` Conda environment. Both installation and training-worker
startup run `deploy/verify-training-runtime.sh`, which verifies:

- the exact source commit;
- a clean reverse check of the applied patch;
- torch 2.12 and CUDA 13.0;
- imports for mjlab, SciPy, MuJoCo, and Warp;
- that Python resolves the pinned source tree rather than a stale editable
  install;
- the patched runner's best-checkpoint hook and training CLI.

PromptHMR retains its separate torch 2.4/CUDA 12.1 environment. The two stacks
are not mixed.

## Verification

The repository test suite covers:

- safe NPZ round-trip and pickle rejection;
- joint mapping and malformed motion rejection;
- training configuration bounds;
- worker capability parsing and isolation;
- G1 qpos, joint order, quaternion layout, FK, foot grounding, and viewer
  serialization;
- pose and motion playback synchronization.

The complete stage bridge has also been exercised locally on CUDA with one
environment and one learning iteration. That smoke test consumed a safe robot
motion NPZ, ran mjlab FK conversion and PPO, and produced the latest checkpoint,
`model_best.pt`, ONNX evidence, and a valid stage manifest.

Every target server still requires the same deliberately small GPU training job
after deployment. It validates that server's driver, GPU, and container runtime;
it is not a replacement for the deterministic startup checks.
