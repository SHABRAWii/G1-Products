#!/usr/bin/env python3
"""Convert a RoboMotion robot-motion pickle to the CSV layout unitree_rl_mjlab's
own `csv_to_npz.py` expects: one row per frame of
`[root_xyz(3), root_quat_xyzw(4), dof_pos(N)]`.

This performs no physics: it reshapes fields RoboMotion's GMR adapter already
computed (see robomotion_gmr_adapter.py). Turning that CSV into the npz mjlab
actually trains on is left to mjlab's unmodified csv_to_npz.py, which replays
the columns through the robot's own kinematic chain to derive per-link world
poses and velocities -- data this script has no way to fabricate correctly.
"""

from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import numpy as np

from g1_motion import G1_29_DOF_JOINTS

REQUIRED_KEYS = ("root_pos", "root_rot", "dof_pos", "joint_names", "fps", "robot_type", "num_frames")


def load_motion(path: Path) -> dict:
    with path.open("rb") as file:
        motion = pickle.load(file)
    missing = [key for key in REQUIRED_KEYS if key not in motion]
    if missing:
        raise ValueError(f"Robot-motion pickle is missing required field(s): {missing}.")
    return motion


def motion_to_rows(motion: dict) -> np.ndarray:
    root_pos = np.asarray(motion["root_pos"], dtype=np.float64)
    root_rot = np.asarray(motion["root_rot"], dtype=np.float64)
    dof_pos = np.asarray(motion["dof_pos"], dtype=np.float64)
    frames = int(motion["num_frames"])
    if root_pos.shape != (frames, 3):
        raise ValueError(f"root_pos must have shape ({frames}, 3); received {root_pos.shape}.")
    if root_rot.shape != (frames, 4):
        raise ValueError(f"root_rot must have shape ({frames}, 4); received {root_rot.shape}.")
    if dof_pos.ndim != 2 or dof_pos.shape[0] != frames:
        raise ValueError(f"dof_pos must have shape ({frames}, N); received {dof_pos.shape}.")

    joint_names = tuple(motion["joint_names"])
    if dof_pos.shape[1] == len(G1_29_DOF_JOINTS):
        if joint_names != G1_29_DOF_JOINTS:
            raise ValueError(
                "dof_pos has 29 columns but joint_names does not match mjlab's expected "
                f"Unitree G1 29-DoF order; actual={joint_names}."
            )
    else:
        raise ValueError(
            f"Unsupported joint count {dof_pos.shape[1]}; only the Unitree G1 29-DoF "
            "layout is currently supported by this converter."
        )

    return np.concatenate([root_pos, root_rot, dof_pos], axis=1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a RoboMotion robot-motion pickle to mjlab's training CSV layout")
    parser.add_argument("--motion", required=True, help="Path to a GMR robot_motion.pkl artifact")
    parser.add_argument("--output", required=True, help="Path to write the CSV motion file")
    args = parser.parse_args()

    source = Path(args.motion).resolve()
    if not source.exists():
        raise RuntimeError(f"Input motion artifact does not exist: {source}")
    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)

    motion = load_motion(source)
    rows = motion_to_rows(motion)
    np.savetxt(destination, rows, delimiter=",", fmt="%.8f")

    summary = {
        "csv": str(destination),
        "fps": float(motion["fps"]),
        "num_frames": int(motion["num_frames"]),
        "robot_type": str(motion["robot_type"]),
    }
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
