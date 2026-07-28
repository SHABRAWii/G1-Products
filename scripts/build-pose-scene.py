#!/usr/bin/env python3
"""Build validated SMPL-X scene data for RoboMotion's interactive viewer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import smplx
import torch

from smplx_motion import (
    SMPLX_BODY_EDGES,
    SMPLX_BODY_JOINT_NAMES,
    validate_track,
)


def _track_value(
    data: np.lib.npyio.NpzFile,
    name: str,
    frames: int,
    width: int,
) -> np.ndarray:
    if name not in data:
        return np.zeros((frames, width), dtype=np.float32)
    return np.asarray(data[name], dtype=np.float32)


def load_joints(
    path: Path,
    model_dir: Path,
) -> tuple[np.ndarray, float, dict[str, list[int]]]:
    data = np.load(path, allow_pickle=True)
    frames = int(np.asarray(data["pose_body"]).shape[0])
    betas = np.asarray(data["betas"], dtype=np.float32).reshape(-1)
    root_orient = np.asarray(data["root_orient"], dtype=np.float32)
    body_pose = np.asarray(data["pose_body"], dtype=np.float32)
    transl = np.asarray(data["trans"], dtype=np.float32)
    left_hand_pose = _track_value(data, "left_hand_pose", frames, 45)
    right_hand_pose = _track_value(data, "right_hand_pose", frames, 45)
    jaw_pose = _track_value(data, "jaw_pose", frames, 3)
    leye_pose = _track_value(data, "leye_pose", frames, 3)
    reye_pose = _track_value(data, "reye_pose", frames, 3)
    expression = _track_value(data, "expression", frames, 10)

    validate_track(
        global_orient=root_orient,
        body_pose=body_pose,
        transl=transl,
        betas=betas,
        left_hand_pose=left_hand_pose,
        right_hand_pose=right_hand_pose,
        jaw_pose=jaw_pose,
        leye_pose=leye_pose,
        reye_pose=reye_pose,
        expression=expression,
    )

    model = smplx.create(
        str(model_dir),
        "smplx",
        gender=str(data["gender"]),
        use_pca=False,
        num_betas=len(betas),
        num_expression_coeffs=10,
    )
    output = model(
        betas=torch.from_numpy(betas)[None].repeat(frames, 1),
        global_orient=torch.from_numpy(root_orient),
        body_pose=torch.from_numpy(body_pose),
        transl=torch.from_numpy(transl),
        left_hand_pose=torch.from_numpy(left_hand_pose),
        right_hand_pose=torch.from_numpy(right_hand_pose),
        jaw_pose=torch.from_numpy(jaw_pose),
        leye_pose=torch.from_numpy(leye_pose),
        reye_pose=torch.from_numpy(reye_pose),
        expression=torch.from_numpy(expression),
        return_full_pose=True,
    )
    joints = output.joints.detach().cpu().numpy()[:, :22, :]
    if joints.shape != (frames, 22, 3) or not np.isfinite(joints).all():
        raise RuntimeError(
            f"SMPL-X body reconstruction produced malformed joints with shape {joints.shape}."
        )

    for parent, child in SMPLX_BODY_EDGES:
        lengths = np.linalg.norm(joints[:, child] - joints[:, parent], axis=1)
        if float(np.nanmedian(lengths)) < 1e-5:
            raise RuntimeError(
                f"SMPL-X bone {SMPLX_BODY_JOINT_NAMES[parent]} → "
                f"{SMPLX_BODY_JOINT_NAMES[child]} has zero length."
            )
        if float(np.nanmax(lengths) - np.nanmin(lengths)) > 0.01:
            raise RuntimeError(
                f"SMPL-X bone {SMPLX_BODY_JOINT_NAMES[parent]} → "
                f"{SMPLX_BODY_JOINT_NAMES[child]} changes length across frames."
            )

    fps = float(np.asarray(data.get("mocap_frame_rate", 30.0)).reshape(-1)[0])
    parameter_shapes = {
        "global_orient": list(root_orient.shape),
        "body_pose": list(body_pose.shape),
        "transl": list(transl.shape),
        "betas": list(betas.shape),
        "left_hand_pose": list(left_hand_pose.shape),
        "right_hand_pose": list(right_hand_pose.shape),
        "jaw_pose": list(jaw_pose.shape),
        "leye_pose": list(leye_pose.shape),
        "reye_pose": list(reye_pose.shape),
        "expression": list(expression.shape),
    }
    return joints, fps, parameter_shapes


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build an interactive 3D SMPL-X scene.",
    )
    parser.add_argument("--smplx", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    joints, fps, parameter_shapes = load_joints(
        Path(args.smplx).resolve(),
        Path(args.model_dir).resolve(),
    )
    scene = {
        "schemaVersion": "visualization.pose-3d-scene/v2",
        "kind": "smplx",
        "bodyModel": "smplx",
        "jointConvention": "smplx-body-22",
        "rotationRepresentation": "axis-angle-radians",
        "coordinateSystem": "right-handed-z-up-meters",
        "jointNames": list(SMPLX_BODY_JOINT_NAMES),
        "parameterShapes": parameter_shapes,
        "fps": fps,
        "upAxis": "z",
        "edges": [list(edge) for edge in SMPLX_BODY_EDGES],
        "frames": np.round(joints, 5).tolist(),
    }
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(scene, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"RoboMotion: built {len(joints)} frames of interactive SMPL-X scene data",
        flush=True,
    )


if __name__ == "__main__":
    main()
