"""SMPL-X conventions and validation shared by RoboMotion pose adapters.

PromptHMR emits the full 55-joint SMPL-X pose as axis-angle rotations:
global, 21 body joints, jaw, two eyes, and 15 joints for each hand.  RoboMotion
keeps those groups explicit so no consumer has to infer offsets from a flat
array.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


SMPLX_BODY_JOINT_NAMES = (
    "pelvis",
    "left_hip",
    "right_hip",
    "spine1",
    "left_knee",
    "right_knee",
    "spine2",
    "left_ankle",
    "right_ankle",
    "spine3",
    "left_foot",
    "right_foot",
    "neck",
    "left_collar",
    "right_collar",
    "head",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
)

# Explicit SMPL-X body hierarchy. The tuple index is the child joint and the
# value is its parent. Pelvis is the only root.
SMPLX_BODY_PARENTS = (
    -1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19
)
SMPLX_BODY_EDGES = tuple(
    (parent, child)
    for child, parent in enumerate(SMPLX_BODY_PARENTS)
    if parent >= 0
)

# A single right-handed basis conversion: PromptHMR/RoboMotion Z-up source
# coordinates become Three.js Y-up coordinates as (x, z, -y).
Z_UP_TO_THREE_Y_UP = np.asarray(
    ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0)),
    dtype=np.float32,
)


@dataclass(frozen=True)
class SMPLXParameters:
    global_orient: np.ndarray
    body_pose: np.ndarray
    jaw_pose: np.ndarray
    leye_pose: np.ndarray
    reye_pose: np.ndarray
    left_hand_pose: np.ndarray
    right_hand_pose: np.ndarray


def _finite(name: str, value: np.ndarray) -> np.ndarray:
    array = np.asarray(value, dtype=np.float32)
    if not np.isfinite(array).all():
        bad = np.argwhere(~np.isfinite(array))
        raise ValueError(f"{name} contains NaN or Infinity at {bad[0].tolist()}.")
    return array


def split_prompthmr_smplx_pose(value: np.ndarray) -> SMPLXParameters:
    """Validate and split PromptHMR's `(frames, 165)` SMPL-X axis-angle pose."""
    pose = _finite("smplx_world.pose", value)
    if pose.ndim == 3 and pose.shape[1:] == (55, 3):
        pose = pose.reshape(pose.shape[0], 165)
    if pose.ndim != 2 or pose.shape[1] != 165:
        raise ValueError(
            "PromptHMR SMPL-X pose must have shape (frames, 165) or "
            f"(frames, 55, 3); received {pose.shape}."
        )
    grouped = pose.reshape(-1, 55, 3)
    return SMPLXParameters(
        global_orient=grouped[:, 0],
        body_pose=grouped[:, 1:22].reshape(-1, 63),
        jaw_pose=grouped[:, 22],
        leye_pose=grouped[:, 23],
        reye_pose=grouped[:, 24],
        left_hand_pose=grouped[:, 25:40].reshape(-1, 45),
        right_hand_pose=grouped[:, 40:55].reshape(-1, 45),
    )


def validate_track(
    *,
    global_orient: np.ndarray,
    body_pose: np.ndarray,
    transl: np.ndarray,
    betas: np.ndarray,
    left_hand_pose: np.ndarray | None = None,
    right_hand_pose: np.ndarray | None = None,
    jaw_pose: np.ndarray | None = None,
    leye_pose: np.ndarray | None = None,
    reye_pose: np.ndarray | None = None,
    expression: np.ndarray | None = None,
) -> int:
    """Validate a serialized SMPL-X track and return its frame count."""
    root = _finite("global_orient", global_orient)
    if root.ndim != 2 or root.shape[1] != 3:
        raise ValueError(f"global_orient must have shape (frames, 3); received {root.shape}.")
    frames = root.shape[0]
    expected = {
        "body_pose": (frames, 63),
        "transl": (frames, 3),
    }
    optional = {
        "left_hand_pose": (left_hand_pose, (frames, 45)),
        "right_hand_pose": (right_hand_pose, (frames, 45)),
        "jaw_pose": (jaw_pose, (frames, 3)),
        "leye_pose": (leye_pose, (frames, 3)),
        "reye_pose": (reye_pose, (frames, 3)),
        "expression": (expression, (frames, 10)),
    }
    values = {"body_pose": body_pose, "transl": transl}
    for name, shape in expected.items():
        array = _finite(name, values[name])
        if array.shape != shape:
            raise ValueError(f"{name} must have shape {shape}; received {array.shape}.")
    shape = _finite("betas", betas).reshape(-1)
    if shape.size not in (10, 16):
        raise ValueError(f"betas must contain 10 or 16 coefficients; received {shape.size}.")
    for name, (value, expected_shape) in optional.items():
        if value is None:
            continue
        array = _finite(name, value)
        if array.shape != expected_shape:
            raise ValueError(f"{name} must have shape {expected_shape}; received {array.shape}.")
    return frames


def axis_angle_to_quaternion(axis_angle: np.ndarray) -> np.ndarray:
    """Convert an axis-angle rotation in radians to an `(x, y, z, w)` quaternion."""
    rotation = _finite("axis_angle", axis_angle).reshape(3)
    angle = float(np.linalg.norm(rotation))
    if angle < 1e-8:
        return np.asarray((0.0, 0.0, 0.0, 1.0), dtype=np.float32)
    half = angle * 0.5
    xyz = rotation / angle * np.sin(half)
    return np.asarray((*xyz, np.cos(half)), dtype=np.float32)


def source_to_three(points: np.ndarray) -> np.ndarray:
    """Convert source points once with the shared right-handed root basis."""
    array = _finite("points", points)
    if array.shape[-1] != 3:
        raise ValueError(f"points must end in XYZ coordinates; received {array.shape}.")
    return array @ Z_UP_TO_THREE_Y_UP.T


def bone_geometry(parent: np.ndarray, child: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Return midpoint, unit direction, and length for a procedural bone."""
    start = _finite("parent", parent).reshape(3)
    end = _finite("child", child).reshape(3)
    delta = end - start
    length = float(np.linalg.norm(delta))
    midpoint = (start + end) * 0.5
    if length < 1e-8:
        return midpoint, np.asarray((0.0, 1.0, 0.0), dtype=np.float32), 0.0
    return midpoint, delta / length, length
