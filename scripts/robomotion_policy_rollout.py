#!/usr/bin/env python3
"""Evaluate and record a local motion-tracking policy without W&B cloud access."""

from __future__ import annotations

import argparse
import json
import math
import shutil
from dataclasses import asdict
from pathlib import Path

import numpy as np
import torch

from mjlab.envs import ManagerBasedRlEnv
from mjlab.rl import MjlabOnPolicyRunner, RslRlVecEnvWrapper
from mjlab.tasks.registry import load_env_cfg, load_rl_cfg, load_runner_cls
from mjlab.tasks.tracking.mdp import MotionCommandCfg
from mjlab.utils.torch import configure_torch_backends
from mjlab.utils.wrappers import VideoRecorder


def main() -> None:
    parser = argparse.ArgumentParser(description="Record and score one local trained policy rollout")
    parser.add_argument("--training-root", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--motion", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    args = parser.parse_args()

    training_root = Path(args.training_root).resolve()
    checkpoint = Path(args.checkpoint).resolve()
    motion_path = Path(args.motion).resolve()
    video_path = Path(args.video).resolve()
    report_path = Path(args.report).resolve()
    video_dir = video_path.parent / "policy-rollout-frames"
    video_dir.mkdir(parents=True, exist_ok=True)

    configure_torch_backends()
    device = "cuda:0" if torch.cuda.is_available() else "cpu"

    # Import the checkout's task registration after resolving its local root.
    import sys
    sys.path.insert(0, str(training_root))
    import mjlab.tasks  # noqa: F401
    import src.tasks  # noqa: F401

    env_cfg = load_env_cfg(args.task, play=True)
    agent_cfg = load_rl_cfg(args.task)
    motion_cmd = env_cfg.commands.get("motion")
    if not isinstance(motion_cmd, MotionCommandCfg):
        raise RuntimeError(f"{args.task} is not a motion-tracking task.")
    motion_cmd.motion_file = str(motion_path)
    motion_cmd.sampling_mode = "start"
    env_cfg.scene.num_envs = 1
    env_cfg.viewer.width = args.width
    env_cfg.viewer.height = args.height
    env_cfg.observations["actor"].enable_corruption = False
    env_cfg.events.pop("push_robot", None)

    with np.load(motion_path, allow_pickle=False) as motion:
        frame_count = int(motion["joint_pos"].shape[0])
        motion_fps = float(np.asarray(motion["fps"]).reshape(-1)[0])
    duration_seconds = frame_count / motion_fps

    raw_env = ManagerBasedRlEnv(cfg=env_cfg, device=device, render_mode="rgb_array")
    # Step count is derived from the environment clock, not assumed to equal the
    # motion-file FPS. This preserves the complete reference duration.
    expected_steps = max(1, math.ceil(duration_seconds / raw_env.step_dt))
    recorded_env = VideoRecorder(
        raw_env,
        video_folder=video_dir,
        step_trigger=lambda step: step == 0,
        video_length=expected_steps,
        name_prefix="best-policy",
        disable_logger=True,
    )
    env = RslRlVecEnvWrapper(recorded_env, clip_actions=agent_cfg.clip_actions)
    runner_cls = load_runner_cls(args.task) or MjlabOnPolicyRunner
    runner = runner_cls(env, asdict(agent_cfg), device=device)
    runner.load(str(checkpoint), load_cfg={"actor": True}, strict=True, map_location=device)
    policy = runner.get_inference_policy(device=device)

    termination_counts = {
        name: 0 for name in env.unwrapped.termination_manager.active_terms
    }
    total_reward = 0.0
    first_failure_step: int | None = None
    first_failure_reasons: list[str] = []
    obs = env.get_observations()
    try:
        for step in range(expected_steps):
            with torch.no_grad():
                actions = policy(obs)
            obs, reward, _, _ = env.step(actions)
            total_reward += float(reward[0].detach().cpu())
            manager = env.unwrapped.termination_manager
            for name in manager.active_terms:
                active = bool(manager.get_term(name)[0].detach().cpu())
                if active:
                    termination_counts[name] += 1
                    cfg = manager.get_term_cfg(name)
                    if not cfg.time_out and first_failure_step is None:
                        first_failure_step = step
                        first_failure_reasons.append(name)
                    elif not cfg.time_out and first_failure_step == step:
                        first_failure_reasons.append(name)
    finally:
        env.close()

    rendered = sorted(video_dir.glob("best-policy-*.mp4"))
    if not rendered:
        raise RuntimeError("Policy rollout completed without an MP4 recording.")
    video_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(rendered[-1], video_path)
    shutil.rmtree(video_dir, ignore_errors=True)

    completed_reference = first_failure_step is None
    completed_steps = first_failure_step if first_failure_step is not None else expected_steps
    report = {
        "schemaVersion": "training.policy-evaluation/v1",
        "checkpoint": checkpoint.name,
        "task": args.task,
        "device": device,
        "motionFrames": frame_count,
        "motionFps": motion_fps,
        "motionDurationSeconds": duration_seconds,
        "expectedSteps": expected_steps,
        "completedStepsBeforeFailure": completed_steps,
        "completionRatio": completed_steps / expected_steps,
        "completedReferenceMotion": completed_reference,
        "terminatedEarly": not completed_reference,
        "firstFailureStep": first_failure_step,
        "firstFailureReasons": first_failure_reasons,
        "terminationCounts": termination_counts,
        "meanStepReward": total_reward / expected_steps,
        "qualityStatus": "PASSED_REFERENCE_ROLLOUT" if completed_reference else "FAILED_REFERENCE_ROLLOUT",
    }
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("RoboMotion policy evaluation: " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
