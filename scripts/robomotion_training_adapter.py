#!/usr/bin/env python3
"""Convert a robot-motion pickle to the CSV layout unitree_rl_mjlab's own
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

RoboMotion's own pkls additionally carry `joint_names`, which lets this
script verify the 29 dof_pos columns are in mjlab's expected order before
writing anything. Third-party pkls (like g1-moves') don't carry that field;
for those, only the column count is checked, and the joint order is trusted
to follow the same canonical Unitree G1 29-DoF convention (the ecosystem's
only real joint ordering for this robot). Pass --skip-joint-check to
silence the resulting warning once you've verified a given source by hand.
"""

from __future__ import annotations

import argparse
import json
import pickle
import sys
from pathlib import Path

import numpy as np

from g1_motion import G1_29_DOF_JOINTS

REQUIRED_KEYS = ("root_pos", "root_rot", "dof_pos", "fps")


def load_motion(path: Path) -> dict:
    with path.open("rb") as file:
        motion = pickle.load(file)
    missing = [key for key in REQUIRED_KEYS if key not in motion]
    if missing:
        raise ValueError(f"Robot-motion pickle is missing required field(s): {missing}.")
    return motion


def motion_to_rows(motion: dict, skip_joint_check: bool = False) -> np.ndarray:
    root_pos = np.asarray(motion["root_pos"], dtype=np.float64)
    root_rot = np.asarray(motion["root_rot"], dtype=np.float64)
    dof_pos = np.asarray(motion["dof_pos"], dtype=np.float64)
    frames = root_pos.shape[0]
    if root_pos.shape != (frames, 3):
        raise ValueError(f"root_pos must have shape ({frames}, 3); received {root_pos.shape}.")
    if root_rot.shape != (frames, 4):
        raise ValueError(f"root_rot must have shape ({frames}, 4); received {root_rot.shape}.")
    if dof_pos.shape != (frames, len(G1_29_DOF_JOINTS)):
        raise ValueError(
            f"dof_pos must have shape ({frames}, {len(G1_29_DOF_JOINTS)}); received {dof_pos.shape}. "
            "Only the Unitree G1 29-DoF layout is currently supported by this converter."
        )

    joint_names = motion.get("joint_names")
    if joint_names is not None:
        if tuple(joint_names) != G1_29_DOF_JOINTS:
            raise ValueError(
                "dof_pos has 29 columns but joint_names does not match mjlab's expected "
                f"Unitree G1 29-DoF order; actual={tuple(joint_names)}."
            )
    elif not skip_joint_check:
        print(
            "WARNING: this pickle has no joint_names field, so the dof_pos column order "
            "could not be verified against mjlab's expected Unitree G1 29-DoF order. "
            "Assuming the standard canonical ordering. Pass --skip-joint-check once you've "
            "confirmed this source by hand to silence this warning.",
            file=sys.stderr,
        )

    return np.concatenate([root_pos, root_rot, dof_pos], axis=1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a RoboMotion robot-motion pickle to mjlab's training CSV layout")
    parser.add_argument("--motion", required=True, help="Path to a robot-motion pickle (RoboMotion GMR output or a compatible third-party G1 retargeter)")
    parser.add_argument("--output", required=True, help="Path to write the CSV motion file")
    parser.add_argument("--skip-joint-check", action="store_true", help="Silence the joint-order warning for pickles without a joint_names field")
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
    # count without re-opening the source pickle.
    destination.with_suffix(".json").write_text(json.dumps(summary), encoding="utf-8")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    main()
