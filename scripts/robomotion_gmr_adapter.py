#!/usr/bin/env python3
"""Retarget RoboMotion SMPL-X artifacts to robot motion with GMR directly."""

from __future__ import annotations

import argparse
import pickle
import sys
from pathlib import Path

import numpy as np
import torch


def load_smplx_for_gmr(smplx_file: Path, model_dir: Path):
    """Load the RoboMotion SMPL-X artifact against the installed body model.

    The official SMPL-X v1.1 files can expose 16 body shape directions, while
    PromptHMR exports the standard 10 shape coefficients.  GMR's convenience
    loader relies on SMPL-X defaults, which selects 16 + 10 expression values
    and therefore mismatches our 10 + 10 input.  Select the body-shape count
    explicitly from the artifact; this preserves every coefficient supplied by
    PromptHMR and pads none for the normal 10-coefficient case.
    """
    import smplx

    data = np.load(smplx_file, allow_pickle=True)
    betas = np.asarray(data["betas"], dtype=np.float32).reshape(-1)
    if not len(betas):
        raise RuntimeError("The SMPL-X input contains no body-shape coefficients.")
    frames = int(np.asarray(data["pose_body"]).shape[0])
    body_model = smplx.create(
        str(model_dir),
        "smplx",
        gender=str(data["gender"]),
        use_pca=False,
        num_betas=len(betas),
        num_expression_coeffs=10,
    )
    expression = np.asarray(data["expression"], dtype=np.float32) if "expression" in data else np.zeros((frames, 10), dtype=np.float32)
    if expression.ndim == 1:
        expression = np.broadcast_to(expression, (frames, len(expression))).copy()
    if expression.shape != (frames, 10):
        raise RuntimeError(f"Expected SMPL-X expression shape ({frames}, 10), received {expression.shape}.")
    output = body_model(
        betas=torch.from_numpy(betas)[None].repeat(frames, 1),
        global_orient=torch.from_numpy(np.asarray(data["root_orient"], dtype=np.float32)),
        body_pose=torch.from_numpy(np.asarray(data["pose_body"], dtype=np.float32)),
        transl=torch.from_numpy(np.asarray(data["trans"], dtype=np.float32)),
        left_hand_pose=torch.zeros(frames, 45), right_hand_pose=torch.zeros(frames, 45),
        jaw_pose=torch.zeros(frames, 3), leye_pose=torch.zeros(frames, 3), reye_pose=torch.zeros(frames, 3),
        expression=torch.from_numpy(expression), return_full_pose=True,
    )
    human_height = float(1.66 + 0.1 * betas[0])
    return data, body_model, output, human_height


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gmr-root", required=True)
    parser.add_argument("--smplx", required=True)
    parser.add_argument("--robot", default="unitree_g1")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    root = Path(args.gmr_root).resolve()
    if not (root / "general_motion_retargeting").is_dir():
        raise RuntimeError(f"GMR source is missing at {root}")
    sys.path.insert(0, str(root))
    from general_motion_retargeting import GeneralMotionRetargeting
    from general_motion_retargeting.kinematics_model import KinematicsModel
    from general_motion_retargeting.utils.smpl import get_smplx_data_offline_fast

    smplx_file = Path(args.smplx).resolve()
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    model_dir = root / "assets" / "body_models"
    data, body_model, body_output, human_height = load_smplx_for_gmr(smplx_file, model_dir)
    # GMR's loader cannot upsample: asking for 30 fps from a 12 fps capture
    # keeps every frame but labels them 30 fps, which makes all downstream
    # renders play 2.5x too fast.  Clamp the target to the capture rate and
    # trust the capture rate whenever no resampling actually occurred.
    source_fps = float(np.asarray(data["mocap_frame_rate"]).reshape(-1)[0]) if "mocap_frame_rate" in data else 30.0
    source_frames = int(np.asarray(data["pose_body"]).shape[0])
    frames, fps = get_smplx_data_offline_fast(data, body_model, body_output, tgt_fps=min(30.0, source_fps))
    if not frames:
        raise RuntimeError("The SMPL-X input contains no frames to retarget.")
    if len(frames) == source_frames:
        fps = source_fps

    retargeter = GeneralMotionRetargeting(actual_human_height=human_height, src_human="smplx", tgt_robot=args.robot, verbose=False)
    configuration = []
    for index, frame in enumerate(frames, start=1):
        configuration.append(retargeter.retarget(frame))
        if index % 10 == 0 or index == len(frames):
            print(f"GMR: retargeted {index}/{len(frames)} frames", flush=True)

    qpos = np.asarray(configuration)
    root_position = qpos[:, :3].astype(np.float32)
    root_rotation = qpos[:, [4, 5, 6, 3]].astype(np.float32)
    joints = qpos[:, 7:].astype(np.float32)
    kinematics = KinematicsModel(retargeter.xml_file, device=torch.device("cpu"))
    zeros = torch.zeros((len(qpos), 3))
    identity = torch.zeros((len(qpos), 4))
    identity[:, -1] = 1.0
    local_body_position, _ = kinematics.forward_kinematics(zeros, identity, torch.from_numpy(joints))
    world_bodies, _ = kinematics.forward_kinematics(torch.from_numpy(root_position), torch.from_numpy(root_rotation), torch.from_numpy(joints))
    root_position[:, 2] -= float(torch.min(world_bodies[..., 2]))
    motion = {
        "fps": float(fps), "robot_type": args.robot, "num_frames": int(len(qpos)), "human_height": float(human_height),
        "root_pos": root_position, "root_rot": root_rotation, "dof_pos": joints,
        "local_body_pos": local_body_position.numpy().astype(np.float32), "link_body_list": kinematics.body_names,
    }
    with destination.open("wb") as file:
        pickle.dump(motion, file, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"GMR: saved {destination.name}; {joints.shape[1]} DoF; {len(qpos)} frames", flush=True)


if __name__ == "__main__":
    main()
