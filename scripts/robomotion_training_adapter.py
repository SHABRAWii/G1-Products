#!/usr/bin/env python3
"""Convert a safe robot-motion NPZ to the CSV layout unitree_rl_mjlab's own
`csv_to_npz.py` expects: one row per frame of
`[root_xyz(3), root_quat_xyzw(4), dof_pos(N)]`.

This performs no physics: it reshapes fields already computed upstream --
either by RoboMotion's own GMR adapter (robomotion_gmr_adapter.py) or by a
third-party G1 retargeter (e.g. the g1-moves repo), which both store the same
`root_pos` / `root_rot` (xyzw) / `dof_pos` arrays. Turning the CSV into the
npz mjlab actually trains on is left to mjlab's unmodified csv_to_npz.py,
which replays the columns through the robot's own kinematic chain to derive
per-link world poses and velocities -- data this script has no way to
fabricate correctly.

RoboMotion's safe NPZ artifacts additionally carry `joint_names`, which lets this
script verify the 29 dof_pos columns are in mjlab's expected order before
writing anything. Artifacts without that metadata are rejected by default;
`--skip-joint-check` exists only for an explicitly reviewed external safe NPZ.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from g1_motion import G1_29_DOF_JOINTS, load_robot_motion

REQUIRED_KEYS = ("root_pos", "root_rot", "dof_pos", "fps")


def load_motion(path: Path) -> dict:
    return load_robot_motion(path)


def motion_to_rows(motion: dict, skip_joint_check: bool = False) -> np.ndarray:
    root_pos = np.asarray(motion["root_pos"], dtype=np.float64)
    root_rot = np.asarray(motion["root_rot"], dtype=np.float64)
    dof_pos = np.asarray(motion["dof_pos"], dtype=np.float64)
    frames = root_pos.shape[0]
    if frames < 2:
        raise ValueError("Robot motion must contain at least two frames.")
    if root_pos.shape != (frames, 3):
        raise ValueError(f"root_pos must have shape ({frames}, 3); received {root_pos.shape}.")
    if root_rot.shape != (frames, 4):
        raise ValueError(f"root_rot must have shape ({frames}, 4); received {root_rot.shape}.")
    if dof_pos.shape != (frames, len(G1_29_DOF_JOINTS)):
        raise ValueError(
            f"dof_pos must have shape ({frames}, {len(G1_29_DOF_JOINTS)}); received {dof_pos.shape}. "
            "Only the Unitree G1 29-DoF layout is currently supported by this converter."
        )
    if not np.isfinite(root_pos).all() or not np.isfinite(root_rot).all() or not np.isfinite(dof_pos).all():
        raise ValueError("Robot motion contains NaN or Infinity.")
    fps = float(motion["fps"])
    if not np.isfinite(fps) or fps <= 0 or fps > 1000:
        raise ValueError(f"fps must be finite and within (0, 1000]; received {fps}.")
    quaternion_norms = np.linalg.norm(root_rot, axis=1)
    if np.any(quaternion_norms < 1e-8):
        frame = int(np.where(quaternion_norms < 1e-8)[0][0])
        raise ValueError(f"root_rot quaternion norm is near zero at frame {frame}.")
    root_rot = root_rot / quaternion_norms[:, None]

    joint_names = motion.get("joint_names")
    if joint_names is not None:
        if tuple(joint_names) != G1_29_DOF_JOINTS:
            raise ValueError(
                "dof_pos has 29 columns but joint_names does not match mjlab's expected "
                f"Unitree G1 29-DoF order; actual={tuple(joint_names)}."
            )
    elif not skip_joint_check:
        raise ValueError(
            "The motion artifact has no joint_names metadata, so its 29 columns cannot be "
            "safely mapped to the Unitree G1. Verify the external source explicitly and pass "
            "--skip-joint-check only for that reviewed import."
        )

    return np.concatenate([root_pos, root_rot, dof_pos], axis=1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a safe RoboMotion robot-motion NPZ to mjlab's training CSV layout")
    parser.add_argument("--motion", required=True, help="Path to a motion.robot.unitree-g1-29dof-npz/v2 artifact")
    parser.add_argument("--output", required=True, help="Path to write the CSV motion file")
    parser.add_argument("--skip-joint-check", action="store_true", help="Silence the joint-order warning for artifacts without a joint_names field")
    args = parser.parse_args()

    source = Path(args.motion).resolve()
    if not source.exists():
        raise RuntimeError(f"Input motion artifact does not exist: {source}")
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)

    motion = load_motion(source)
    rows = motion_to_rows(motion, skip_joint_check=args.skip_joint_check)
    np.savetxt(destination, rows, delimiter=",", fmt="%.8f")

    summary = {
        "csv": str(destination),
        "fps": float(motion["fps"]),
        "num_frames": int(rows.shape[0]),
        "robot_type": str(motion.get("robot_type", "unitree_g1")),
    }
    # Written alongside stdout so a caller that only captures the CSV (e.g. a
    # subprocess wrapper that doesn't parse stdout) can still recover fps/frame
    # count without re-opening the source artifact.
    destination.with_suffix(".json").write_text(json.dumps(summary), encoding="utf-8")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
