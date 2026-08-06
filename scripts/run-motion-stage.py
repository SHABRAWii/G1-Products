#!/usr/bin/env python3
"""RoboMotion-owned GPU stage coordinator.

This program is the only pipeline entry point used by the dashboard worker. It
calls RoboMotion adapters that import PromptHMR and GMR directly; it does not
call or require any third-party orchestration wrapper.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from pathlib import Path


def run(command: list[str], cwd: Path | None = None, extra_env: dict[str, str] | None = None) -> None:
    print("$ " + " ".join(command), flush=True)
    env = {**os.environ, **extra_env} if extra_env else None
    completed = subprocess.run(command, text=True, cwd=cwd, env=env)
    if completed.returncode:
        raise RuntimeError(f"RoboMotion adapter exited with code {completed.returncode}")


def run_tee(command: list[str], log_path: Path, cwd: Path | None = None, extra_env: dict[str, str] | None = None) -> None:
    print("$ " + " ".join(command), flush=True)
    env = {**os.environ, **extra_env} if extra_env else None
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(
            command,
            text=True,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            log.write(line)
        code = process.wait()
    if code:
        raise RuntimeError(f"RoboMotion adapter exited with code {code}")


def require(path: Path, message: str) -> None:
    if not path.exists():
        raise RuntimeError(message)


def output(path: Path, asset_type: str, schema_version: str, role: str, content_type: str) -> dict[str, str]:
    return {"path": str(path), "assetType": asset_type, "schemaVersion": schema_version, "role": role, "contentType": content_type}


def retargeting_outputs(motion: Path, scene: Path) -> list[dict[str, str]]:
    return [
        output(motion, "MOTION_ROBOT", "motion.robot.unitree-g1-29dof-npz/v2", "OUTPUT", "application/x-npz"),
        output(scene, "VISUALIZATION", "visualization.robot-3d-scene/v4", "EVIDENCE", "application/json"),
    ]


def visualization_outputs(motion: Path, scene: Path) -> list[dict[str, str]]:
    return [
        output(motion, "MOTION_ROBOT", "motion.robot.unitree-g1-29dof-npz/v2", "OUTPUT", "application/x-npz"),
        output(scene, "VISUALIZATION", "visualization.robot-3d-scene/v4", "EVIDENCE", "application/json"),
    ]


def conda_python(environment: str, script: Path, arguments: list[str]) -> list[str]:
    return ["conda", "run", "--no-capture-output", "-n", environment, "python", str(script), *arguments]

def training_python(args: argparse.Namespace, script: Path, arguments: list[str]) -> list[str]:
    if args.training_python:
        return [args.training_python, str(script), *arguments]
    return conda_python(args.training_env, script, arguments)


def training_runtime_environment(args: argparse.Namespace) -> dict[str, str]:
    """Use mjlab's Conda-owned C++ ABI without contaminating other stages."""
    library_path = os.environ.get("ROBOMOTION_TRAIN_LIBRARY_PATH", "")
    if not library_path and args.training_python:
        library_path = str(Path(args.training_python).expanduser().resolve().parent.parent / "lib")
    if not library_path:
        raise RuntimeError("ROBOMOTION_TRAIN_LIBRARY_PATH is required for the training stage.")
    inherited = os.environ.get("LD_LIBRARY_PATH", "")
    paths = [path for path in library_path.split(":") if path]
    for path in inherited.split(":"):
        if path and path not in paths:
            paths.append(path)
    return {"LD_LIBRARY_PATH": ":".join(paths)}


# mjlab's own --robot choice and motion-imitation task id per RoboMotion robot identifier.
TRAINING_ROBOTS = {
    "unitree_g1": {"mjlab_robot": "g1", "task": "Unitree-G1-Tracking-No-State-Estimation"},
    "unitree_g1_23dof": {"mjlab_robot": "g1_23dof", "task": "Unitree-G1-23Dof-Tracking-No-State-Estimation"},
}


def latest_run_dir(experiment_dir: Path) -> Path:
    runs = sorted((entry for entry in experiment_dir.iterdir() if entry.is_dir()), key=lambda entry: entry.name)
    if not runs:
        raise RuntimeError(f"unitree_rl_mjlab did not create a run directory under {experiment_dir}.")
    return runs[-1]


def latest_checkpoint(run_dir: Path) -> Path:
    numbered = [(int(stem), candidate) for candidate in run_dir.glob("model_*.pt") if (stem := candidate.stem.removeprefix("model_")).isdigit()]
    if not numbered:
        raise RuntimeError(f"unitree_rl_mjlab did not write a model_<iteration>.pt checkpoint under {run_dir}.")
    return max(numbered, key=lambda pair: pair[0])[1]


def parse_training_log(log_path: Path) -> dict[str, object]:
    ansi = re.compile(r"\x1b\[[0-9;]*m")
    points: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for raw in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = ansi.sub("", raw).strip()
        iteration = re.search(r"Learning iteration\s+(\d+)/(\d+)", line)
        if iteration:
            current = {
                "iteration": int(iteration.group(1)),
                "totalIterations": int(iteration.group(2)),
                "rewards": {},
                "terminations": {},
                "errors": {},
            }
            points.append(current)
            continue
        if current is None or ":" not in line:
            continue
        name, value = (part.strip() for part in line.rsplit(":", 1))
        try:
            number = float(value.rstrip("s"))
        except ValueError:
            continue
        scalars = {
            "Total steps": "totalSteps",
            "Steps per second": "stepsPerSecond",
            "Mean reward": "meanReward",
            "Mean episode length": "meanEpisodeLength",
            "Iteration time": "iterationSeconds",
        }
        if name in scalars:
            current[scalars[name]] = number
        elif name.startswith("Episode_Reward/"):
            current["rewards"][name.removeprefix("Episode_Reward/")] = number  # type: ignore[index]
        elif name.startswith("Episode_Termination/"):
            current["terminations"][name.removeprefix("Episode_Termination/")] = number  # type: ignore[index]
        elif name.startswith("Metrics/motion/"):
            current["errors"][name.removeprefix("Metrics/motion/")] = number  # type: ignore[index]
    reward_points = [point for point in points if "meanReward" in point]
    best = max(reward_points, key=lambda point: float(point["meanReward"])) if reward_points else None
    latest = points[-1] if points else None
    return {
        "schemaVersion": "training.metrics/v1",
        "history": points,
        "latest": latest,
        "best": {"iteration": best["iteration"], "meanReward": best["meanReward"]} if best else None,
        "completedIterations": (int(latest["iteration"]) + 1) if latest else 0,
        "totalIterations": int(latest["totalIterations"]) if latest else 0,
    }


def best_saved_checkpoint(run_dir: Path, training_metrics: dict[str, object]) -> tuple[Path, int | None, float | None]:
    candidates = {
        int(stem): candidate
        for candidate in run_dir.glob("model_*.pt")
        if (stem := candidate.stem.removeprefix("model_")).isdigit()
    }
    history = training_metrics.get("history")
    scored: list[tuple[float, int, Path]] = []
    if isinstance(history, list):
        for point in history:
            if not isinstance(point, dict) or not isinstance(point.get("iteration"), int):
                continue
            checkpoint = candidates.get(point["iteration"])
            reward = point.get("meanReward")
            if checkpoint is not None and isinstance(reward, (int, float)):
                scored.append((float(reward), point["iteration"], checkpoint))
    if scored:
        reward, iteration, checkpoint = max(scored)
        return checkpoint, iteration, reward
    checkpoint = latest_checkpoint(run_dir)
    stem = checkpoint.stem.removeprefix("model_")
    return checkpoint, int(stem) if stem.isdigit() else None, None


def run_training_stage(args: argparse.Namespace, source: Path, work_dir: Path, scripts: Path) -> tuple[list[dict[str, str]], dict[str, object]]:
    training_root = Path(args.training_root).expanduser().resolve()
    require(training_root / "scripts" / "train.py", "unitree_rl_mjlab source is incomplete. Set ROBOMOTION_TRAIN_ROOT.")
    robot = TRAINING_ROBOTS.get(args.robot)
    if robot is None:
        raise RuntimeError(f"Training is only supported for {sorted(TRAINING_ROBOTS)}; received --robot {args.robot}.")
    runtime_env = training_runtime_environment(args)

    # Step 1: reshape the safe retargeted robot-motion NPZ into mjlab's CSV layout.
    # This runs in the training env, which already contains NumPy, MuJoCo, and
    # SciPy through mjlab. A training-only worker therefore does not depend on
    # the GMR source tree or GMR environment.
    csv_path = work_dir / "motion.csv"
    run(training_python(args, scripts / "robomotion_training_adapter.py", [
        "--motion", str(source), "--output", str(csv_path),
    ]), extra_env=runtime_env)
    require(csv_path, "The NPZ-to-CSV converter completed without a CSV output.")
    conversion = json.loads(csv_path.with_suffix(".json").read_text(encoding="utf-8"))

    # Step 2: replay the CSV through mjlab's own (unmodified) FK pipeline to get
    # the npz format its trainer actually reads.
    npz_name = f"{work_dir.name}.npz"
    run(training_python(args, training_root / "scripts" / "csv_to_npz.py", [
        "--input-file", str(csv_path), "--output-name", npz_name,
        "--input-fps", str(conversion["fps"]), "--output-fps", str(args.training_output_fps),
        "--robot", robot["mjlab_robot"],
    ]), cwd=training_root, extra_env=runtime_env)
    npz_path = training_root / "src" / "assets" / "motions" / robot["mjlab_robot"] / npz_name
    require(npz_path, "csv_to_npz.py completed without an npz motion file.")

    # Step 3: run motion-imitation training itself. The work_dir's own unique
    # name (already unique per stage attempt) doubles as the mjlab experiment
    # name, so concurrent/retried stages never collide on a log directory.
    # WANDB_MODE=offline avoids a hard failure when no wandb API key is configured.
    experiment_name = work_dir.name
    experiment_dir = training_root / "logs" / "rsl_rl" / experiment_name
    training_log = work_dir / "training.log"
    wandb_dir = work_dir / "wandb"
    checkpoint_interval = max(1, args.training_max_iterations // 20)
    try:
        train_arguments = [
            robot["task"],
            f"--motion_file={npz_path}",
            f"--env.scene.num-envs={args.training_num_envs}",
            f"--agent.max_iterations={args.training_max_iterations}",
            f"--agent.save_interval={checkpoint_interval}",
            f"--agent.experiment_name={experiment_name}",
        ]
        if args.training_capture_videos:
            train_arguments.extend([
                "--video=true",
                f"--video-interval={args.training_video_interval_steps}",
                f"--video-length={args.training_video_length_steps}",
                f"--env.viewer.width={args.training_video_width}",
                f"--env.viewer.height={args.training_video_height}",
                "--env.viewer.max-extra-envs=0",
            ])
        run_tee(training_python(args, training_root / "scripts" / "train.py", train_arguments), training_log, cwd=training_root, extra_env={
            **runtime_env,
            "WANDB_MODE": "offline",
            "WANDB_DIR": str(wandb_dir),
            "WANDB_NAME": experiment_name,
        })

        require(experiment_dir, f"unitree_rl_mjlab did not create an experiment directory at {experiment_dir}.")
        run_dir = latest_run_dir(experiment_dir)
        checkpoint = latest_checkpoint(run_dir)
        training_metrics = parse_training_log(training_log)
        durable_checkpoint = work_dir / "policy-checkpoint.pt"
        shutil.copy2(checkpoint, durable_checkpoint)
        artifacts = [output(durable_checkpoint, "POLICY_CHECKPOINT", "policy.checkpoint.rsl-rl-latest/v1", "EVIDENCE", "application/octet-stream")]
        best_checkpoint, best_iteration, best_reward = best_saved_checkpoint(run_dir, training_metrics)
        durable_best = work_dir / "policy-best.pt"
        shutil.copy2(best_checkpoint, durable_best)
        # The candidate PolicyVersion must point at the best reward-bearing
        # checkpoint, not merely the final optimizer iteration.
        artifacts.append(output(durable_best, "POLICY_CHECKPOINT", "policy.checkpoint.rsl-rl-best/v1", "OUTPUT", "application/octet-stream"))
        onnx_policy = next((candidate for candidate in (run_dir / "exported" / "policy.onnx", run_dir / "policy.onnx") if candidate.exists()), None)
        if onnx_policy is not None:
            durable_onnx = work_dir / "policy.onnx"
            shutil.copy2(onnx_policy, durable_onnx)
            artifacts.append(output(durable_onnx, "POLICY_CHECKPOINT", "policy.checkpoint.onnx/v1", "EVIDENCE", "application/octet-stream"))

        # MjLab's own train.py recorder captures the policy during learning.
        # Preserve every completed clip so the operator can compare early,
        # middle, and later policy behavior without treating any one of them as
        # the independently scored best-checkpoint replay.
        learning_videos = sorted((run_dir / "videos" / "train").glob("*.mp4"))
        for index, learning_video in enumerate(learning_videos, start=1):
            durable_video = work_dir / f"policy-learning-{index:03d}.mp4"
            shutil.copy2(learning_video, durable_video)
            artifacts.append(output(
                durable_video,
                "VISUALIZATION",
                "visualization.policy-learning-progress/v1",
                "EVIDENCE",
                "video/mp4",
            ))

        metrics_path = work_dir / "training-metrics.json"
        training_metrics.update({
            "checkpointInterval": checkpoint_interval,
            "bestSavedCheckpoint": best_checkpoint.name,
            "bestSavedIteration": best_iteration,
            "bestSavedMeanReward": best_reward,
            "executionCompleted": True,
            "qualityStatus": "EVALUATION_PENDING",
        })
        metrics_path.write_text(json.dumps(training_metrics, indent=2), encoding="utf-8")
        artifacts.append(output(metrics_path, "EVALUATION_REPORT", "training.metrics/v1", "EVIDENCE", "application/json"))

        wandb_runs = [path for path in wandb_dir.rglob("*") if path.is_dir() and ("offline-run-" in path.name or path.name.startswith("run-"))]
        if wandb_runs:
            archive_base = work_dir / "wandb-offline-run"
            archive = Path(shutil.make_archive(str(archive_base), "zip", root_dir=wandb_runs[-1]))
            artifacts.append(output(archive, "EVALUATION_REPORT", "training.wandb-offline/v1", "EVIDENCE", "application/zip"))

        rollout_video = work_dir / "best-policy-rollout.mp4"
        rollout_report = work_dir / "best-policy-evaluation.json"
        try:
            run(training_python(args, scripts / "robomotion_policy_rollout.py", [
                "--training-root", str(training_root),
                "--task", robot["task"],
                "--checkpoint", str(best_checkpoint),
                "--motion", str(npz_path),
                "--video", str(rollout_video),
                "--report", str(rollout_report),
                "--width", str(args.training_video_width),
                "--height", str(args.training_video_height),
            ]), cwd=training_root, extra_env=runtime_env)
            require(rollout_video, "Best-policy evaluation completed without a video.")
            require(rollout_report, "Best-policy evaluation completed without a report.")
            artifacts.append(output(rollout_video, "VISUALIZATION", "visualization.policy-best-rollout/v1", "PREVIEW", "video/mp4"))
            artifacts.append(output(rollout_report, "EVALUATION_REPORT", "training.policy-evaluation/v1", "EVIDENCE", "application/json"))
            evaluation = json.loads(rollout_report.read_text(encoding="utf-8"))
            training_metrics["evaluation"] = evaluation
            training_metrics["qualityStatus"] = evaluation["qualityStatus"]
            metrics_path.write_text(json.dumps(training_metrics, indent=2), encoding="utf-8")
        except Exception as error:
            training_metrics["evaluation"] = {"qualityStatus": "EVALUATION_FAILED", "error": str(error)}
            training_metrics["qualityStatus"] = "EVALUATION_FAILED"
            metrics_path.write_text(json.dumps(training_metrics, indent=2), encoding="utf-8")
            print(f"RoboMotion warning: best-policy rollout could not be generated: {error}", flush=True)

        training_config = {
            "algorithm": "rsl-rl-ppo",
            "task": robot["task"],
            "robot": robot["mjlab_robot"],
            "numEnvs": args.training_num_envs,
            "maxIterations": args.training_max_iterations,
            "outputFps": args.training_output_fps,
            "experimentName": experiment_name,
            "captureTrainingVideos": args.training_capture_videos,
            "videoIntervalSteps": args.training_video_interval_steps,
            "videoLengthSteps": args.training_video_length_steps,
            "videoWidth": args.training_video_width,
            "videoHeight": args.training_video_height,
            "learningVideoCount": len(learning_videos),
            "report": training_metrics,
        }
        return artifacts, training_config
    finally:
        npz_path.unlink(missing_ok=True)
        shutil.rmtree(experiment_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a RoboMotion GPU pipeline stage")
    parser.add_argument("--stage", choices=["pose_extraction", "robot_retargeting", "visualization", "training"], required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--robot", default="unitree_g1")
    parser.add_argument("--prompthmr-root", default=os.environ.get("ROBOMOTION_PROMPTHMR_ROOT", ""))
    parser.add_argument("--gmr-root", default=os.environ.get("ROBOMOTION_GMR_ROOT", ""))
    parser.add_argument("--prompthmr-env", default=os.environ.get("ROBOMOTION_PROMPTHMR_ENV", "phmr"))
    parser.add_argument("--gmr-env", default=os.environ.get("ROBOMOTION_GMR_ENV", "gmr"))
    parser.add_argument("--training-root", default=os.environ.get("ROBOMOTION_TRAIN_ROOT", ""))
    parser.add_argument("--training-env", default=os.environ.get("ROBOMOTION_TRAIN_ENV", "unitree_rl_mjlab"))
    parser.add_argument("--training-python", default=os.environ.get("ROBOMOTION_TRAIN_PYTHON", ""))
    parser.add_argument("--training-num-envs", type=int, default=4096)
    parser.add_argument("--training-max-iterations", type=int, default=3000)
    parser.add_argument("--training-output-fps", type=float, default=50.0)
    parser.add_argument("--training-capture-videos", action="store_true")
    parser.add_argument("--training-video-interval-steps", type=int, default=2000)
    parser.add_argument("--training-video-length-steps", type=int, default=200)
    parser.add_argument("--training-video-width", type=int, default=1280)
    parser.add_argument("--training-video-height", type=int, default=720)
    args = parser.parse_args()

    source = Path(args.input).resolve()
    require(source, f"Input artifact does not exist: {source}")
    work_dir = Path(args.work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    scripts = Path(__file__).resolve().parent
    manifest: dict[str, object] = {"stage": args.stage, "outputs": []}

    if args.stage == "pose_extraction":
        prompt_root = Path(args.prompthmr_root).expanduser().resolve()
        require(prompt_root / "pipeline" / "pipeline.py", "PromptHMR source is incomplete. Set ROBOMOTION_PROMPTHMR_ROOT.")
        video = work_dir / f"source{source.suffix or '.mp4'}"
        shutil.copy2(source, video)
        smplx = work_dir / "smplx.npz"
        results = work_dir / "results.pkl"
        skeleton_preview = work_dir / "pose-skeleton-preview.mp4"
        pose_3d_scene = work_dir / "pose-3d-scene.json"
        run(conda_python(args.prompthmr_env, scripts / "robomotion_pose_adapter.py", [
            "--prompt-hmr-root", str(prompt_root), "--video", str(video), "--output", str(smplx), "--results", str(results),
        ]))
        require(smplx, "PromptHMR completed without a SMPL-X output.")
        artifacts = [output(smplx, "POSE_SMPLX", "pose.smplx/v1", "OUTPUT", "application/octet-stream")]
        if results.exists():
            artifacts.append(output(results, "POSE_SMPLX", "pose.prompthmr-results/v1", "EVIDENCE", "application/octet-stream"))
            prepared_video = work_dir / "prepared-input.mp4"
            require(prepared_video, "PromptHMR completed without its prepared video needed for the pose preview.")
            run(conda_python(args.prompthmr_env, scripts / "render-pose-skeleton.py", [
                "--video", str(prepared_video), "--results", str(results), "--output", str(skeleton_preview),
            ]))
            require(skeleton_preview, "The pose skeleton renderer completed without an MP4 preview.")
            artifacts.append(output(skeleton_preview, "VISUALIZATION", "visualization.pose-skeleton/v1", "PREVIEW", "video/mp4"))
        run(conda_python(args.gmr_env, scripts / "build-pose-scene.py", [
            "--smplx", str(smplx), "--model-dir", str(Path(args.gmr_root).expanduser().resolve() / "assets" / "body_models"), "--output", str(pose_3d_scene),
        ]))
        require(pose_3d_scene, "The SMPL-X scene builder completed without interactive scene data.")
        artifacts.append(output(pose_3d_scene, "VISUALIZATION", "visualization.pose-3d-scene/v2", "EVIDENCE", "application/json"))
        manifest["outputs"] = artifacts
        manifest["summary"] = "RoboMotion converted the PromptHMR track to SMPL-X pose data, retained 2D tracking evidence, and built the interactive 3D motion scene."

    elif args.stage == "robot_retargeting":
        gmr_root = Path(args.gmr_root).expanduser().resolve()
        require(gmr_root / "general_motion_retargeting", "GMR source is incomplete. Set ROBOMOTION_GMR_ROOT.")
        motion = work_dir / "robot_motion.npz"
        robot_scene = work_dir / "unitree_g1_digital-twin-scene.json"
        run(conda_python(args.gmr_env, scripts / "robomotion_gmr_adapter.py", [
            "--gmr-root", str(gmr_root), "--smplx", str(source), "--robot", args.robot, "--output", str(motion),
        ]))
        require(motion, "GMR completed without a robot-motion output.")
        # Retargeting needs scene data for its interactive side-by-side review,
        # but it must not pay the multi-minute browser-capture cost. The
        # dedicated visualization stage produces the reusable MP4 once.
        run(conda_python(args.gmr_env, scripts / "render-robot-motion.py", [
            "--motion", str(motion), "--robot", args.robot,
            "--scene-output", str(robot_scene), "--scene-only",
        ]))
        require(robot_scene, "GMR completed without interactive robot scene data.")
        manifest["outputs"] = retargeting_outputs(motion, robot_scene)
        manifest["summary"] = "RoboMotion retargeted the selected SMPL-X track to Unitree G1 29-DoF motion and built its interactive digital-twin scene."

    elif args.stage == "training":
        manifest["outputs"], manifest["training"] = run_training_stage(args, source, work_dir, scripts)
        manifest["summary"] = "RoboMotion converted the retargeted motion to mjlab's training format and ran unitree_rl_mjlab motion-imitation training to a policy checkpoint."

    else:
        motion = work_dir / "robot_motion.npz"
        shutil.copy2(source, motion)
        robot_scene = work_dir / "unitree_g1_digital-twin-scene.json"
        run(conda_python(args.gmr_env, scripts / "render-robot-motion.py", [
            "--motion", str(motion), "--robot", args.robot,
            "--scene-output", str(robot_scene), "--scene-only",
        ]))
        require(robot_scene, "The RoboMotion renderer completed without interactive robot scene data.")
        # Visualization completes as soon as the interactive scene is ready.
        # The control-plane artifact export worker captures the downloadable
        # MP4 independently, so training never waits for browser screenshots.
        manifest["outputs"] = visualization_outputs(motion, robot_scene)
        manifest["summary"] = "RoboMotion validated the Unitree G1 digital-twin scene and queued its downloadable MP4 export."

    Path(args.manifest).write_text(json.dumps(manifest), encoding="utf-8")
    print(json.dumps(manifest), flush=True)


if __name__ == "__main__":
    main()
