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
import shutil
import subprocess
from pathlib import Path


def run(command: list[str], cwd: Path | None = None, extra_env: dict[str, str] | None = None) -> None:
    print("$ " + " ".join(command), flush=True)
    env = {**os.environ, **extra_env} if extra_env else None
    completed = subprocess.run(command, text=True, cwd=cwd, env=env)
    if completed.returncode:
        raise RuntimeError(f"RoboMotion adapter exited with code {completed.returncode}")


def require(path: Path, message: str) -> None:
    if not path.exists():
        raise RuntimeError(message)


def output(path: Path, asset_type: str, schema_version: str, role: str, content_type: str) -> dict[str, str]:
    return {"path": str(path), "assetType": asset_type, "schemaVersion": schema_version, "role": role, "contentType": content_type}


def conda_python(environment: str, script: Path, arguments: list[str]) -> list[str]:
    return ["conda", "run", "--no-capture-output", "-n", environment, "python", str(script), *arguments]


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


def run_training_stage(args: argparse.Namespace, source: Path, work_dir: Path, scripts: Path) -> list[dict[str, str]]:
    training_root = Path(args.training_root).expanduser().resolve()
    require(training_root / "scripts" / "train.py", "unitree_rl_mjlab source is incomplete. Set ROBOMOTION_TRAIN_ROOT.")
    robot = TRAINING_ROBOTS.get(args.robot)
    if robot is None:
        raise RuntimeError(f"Training is only supported for {sorted(TRAINING_ROBOTS)}; received --robot {args.robot}.")

    # Step 1: reshape the retargeted robot-motion pickle into mjlab's CSV layout.
    # This runs in the gmr env, which already has mujoco/scipy for g1_motion.py's
    # joint-order validation; the training env only needs mjlab itself.
    csv_path = work_dir / "motion.csv"
    run(conda_python(args.gmr_env, scripts / "robomotion_training_adapter.py", [
        "--motion", str(source), "--output", str(csv_path),
    ]))
    require(csv_path, "The pkl-to-CSV converter completed without a CSV output.")
    conversion = json.loads(csv_path.with_suffix(".json").read_text(encoding="utf-8"))

    # Step 2: replay the CSV through mjlab's own (unmodified) FK pipeline to get
    # the npz format its trainer actually reads.
    npz_name = f"{work_dir.name}.npz"
    run(conda_python(args.training_env, training_root / "scripts" / "csv_to_npz.py", [
        "--input-file", str(csv_path), "--output-name", npz_name,
        "--input-fps", str(conversion["fps"]), "--output-fps", str(args.training_output_fps),
        "--robot", robot["mjlab_robot"],
    ]), cwd=training_root)
    npz_path = training_root / "src" / "assets" / "motions" / robot["mjlab_robot"] / npz_name
    require(npz_path, "csv_to_npz.py completed without an npz motion file.")

    # Step 3: run motion-imitation training itself. The work_dir's own unique
    # name (already unique per stage attempt) doubles as the mjlab experiment
    # name, so concurrent/retried stages never collide on a log directory.
    # WANDB_MODE=offline avoids a hard failure when no wandb API key is configured.
    experiment_name = work_dir.name
    run(conda_python(args.training_env, training_root / "scripts" / "train.py", [
        robot["task"],
        f"--motion_file={npz_path}",
        f"--env.scene.num-envs={args.training_num_envs}",
        f"--agent.max_iterations={args.training_max_iterations}",
        f"--agent.experiment_name={experiment_name}",
    ]), cwd=training_root, extra_env={"WANDB_MODE": "offline"})

    experiment_dir = training_root / "logs" / "rsl_rl" / experiment_name
    require(experiment_dir, f"unitree_rl_mjlab did not create an experiment directory at {experiment_dir}.")
    run_dir = latest_run_dir(experiment_dir)
    checkpoint = latest_checkpoint(run_dir)

    artifacts = [output(checkpoint, "POLICY_CHECKPOINT", "policy.checkpoint.rsl-rl/v1", "OUTPUT", "application/octet-stream")]
    best_checkpoint = run_dir / "model_best.pt"
    if best_checkpoint.exists():
        artifacts.append(output(best_checkpoint, "POLICY_CHECKPOINT", "policy.checkpoint.rsl-rl-best/v1", "EVIDENCE", "application/octet-stream"))
    onnx_policy = next((candidate for candidate in (run_dir / "exported" / "policy.onnx", run_dir / "policy.onnx") if candidate.exists()), None)
    if onnx_policy is not None:
        artifacts.append(output(onnx_policy, "POLICY_CHECKPOINT", "policy.checkpoint.onnx/v1", "EVIDENCE", "application/octet-stream"))
    return artifacts


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
    parser.add_argument("--training-env", default=os.environ.get("ROBOMOTION_TRAIN_ENV", "train"))
    parser.add_argument("--training-num-envs", type=int, default=4096)
    parser.add_argument("--training-max-iterations", type=int, default=3000)
    parser.add_argument("--training-output-fps", type=float, default=50.0)
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
        motion = work_dir / "robot_motion.pkl"
        robot_preview = work_dir / "unitree_g1_digital-twin.mp4"
        robot_scene = work_dir / "unitree_g1_digital-twin-scene.json"
        run(conda_python(args.gmr_env, scripts / "robomotion_gmr_adapter.py", [
            "--gmr-root", str(gmr_root), "--smplx", str(source), "--robot", args.robot, "--output", str(motion),
        ]))
        require(motion, "GMR completed without a robot-motion output.")
        run(conda_python(args.gmr_env, scripts / "render-robot-motion.py", ["--motion", str(motion), "--robot", args.robot, "--output", str(robot_preview), "--scene-output", str(robot_scene)]))
        require(robot_preview, "GMR completed without a robot preview.")
        require(robot_scene, "GMR completed without interactive robot scene data.")
        manifest["outputs"] = [
            output(motion, "MOTION_ROBOT", "motion.robot.unitree-g1-29dof/v1", "OUTPUT", "application/octet-stream"),
            output(robot_preview, "VISUALIZATION", "visualization.robot-digital-twin/v1", "PREVIEW", "video/mp4"),
            output(robot_scene, "VISUALIZATION", "visualization.robot-3d-scene/v4", "EVIDENCE", "application/json"),
        ]
        manifest["summary"] = "RoboMotion retargeted the selected SMPL-X track to Unitree G1 29-DoF motion and rendered matching digital-twin MP4 evidence."

    elif args.stage == "training":
        manifest["outputs"] = run_training_stage(args, source, work_dir, scripts)
        manifest["summary"] = "RoboMotion converted the retargeted motion to mjlab's training format and ran unitree_rl_mjlab motion-imitation training to a policy checkpoint."

    else:
        motion = work_dir / "robot_motion.pkl"
        shutil.copy2(source, motion)
        video = work_dir / "unitree_g1_digital-twin.mp4"
        robot_scene = work_dir / "unitree_g1_digital-twin-scene.json"
        run(conda_python(args.gmr_env, scripts / "render-robot-motion.py", ["--motion", str(motion), "--robot", args.robot, "--output", str(video), "--scene-output", str(robot_scene)]))
        require(video, "The RoboMotion renderer completed without a preview video.")
        require(robot_scene, "The RoboMotion renderer completed without interactive robot scene data.")
        manifest["outputs"] = [output(video, "VISUALIZATION", "visualization.robot-digital-twin/v1", "OUTPUT", "video/mp4"), output(robot_scene, "VISUALIZATION", "visualization.robot-3d-scene/v4", "EVIDENCE", "application/json")]
        manifest["summary"] = "RoboMotion rendered the Unitree G1 digital-twin motion preview."

    Path(args.manifest).write_text(json.dumps(manifest), encoding="utf-8")
    print(json.dumps(manifest), flush=True)


if __name__ == "__main__":
    main()
