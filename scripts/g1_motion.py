"""Unitree G1 qpos validation, MuJoCo FK, and ground-contact diagnostics.

The MuJoCo model is the authority for joint order, free-joint layout, visual
meshes, collision geometry, and floor height.  No browser-only offsets are
introduced here.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any

import mujoco
import numpy as np
from scipy.optimize import Bounds, minimize


G1_29_DOF_JOINTS = (
    "left_hip_pitch_joint",
    "left_hip_roll_joint",
    "left_hip_yaw_joint",
    "left_knee_joint",
    "left_ankle_pitch_joint",
    "left_ankle_roll_joint",
    "right_hip_pitch_joint",
    "right_hip_roll_joint",
    "right_hip_yaw_joint",
    "right_knee_joint",
    "right_ankle_pitch_joint",
    "right_ankle_roll_joint",
    "waist_yaw_joint",
    "waist_roll_joint",
    "waist_pitch_joint",
    "left_shoulder_pitch_joint",
    "left_shoulder_roll_joint",
    "left_shoulder_yaw_joint",
    "left_elbow_joint",
    "left_wrist_roll_joint",
    "left_wrist_pitch_joint",
    "left_wrist_yaw_joint",
    "right_shoulder_pitch_joint",
    "right_shoulder_roll_joint",
    "right_shoulder_yaw_joint",
    "right_elbow_joint",
    "right_wrist_roll_joint",
    "right_wrist_pitch_joint",
    "right_wrist_yaw_joint",
)

ROBOT_MOTION_SCHEMA = "motion.robot.unitree-g1-29dof-npz/v2"


def _json_value(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def save_robot_motion(path: str | Path, motion: dict[str, Any]) -> None:
    """Persist robot motion without Python object deserialization."""

    destination = Path(path)
    if destination.suffix.lower() != ".npz":
        raise ValueError("Robot motion must be stored as a .npz artifact.")
    arrays: dict[str, np.ndarray] = {}
    metadata: dict[str, Any] = {"schema_version": ROBOT_MOTION_SCHEMA}
    for key, value in motion.items():
        if isinstance(value, np.ndarray):
            arrays[key] = value
        else:
            metadata[key] = _json_value(value)
    arrays["metadata_json"] = np.asarray(json.dumps(metadata, separators=(",", ":")))
    destination.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(destination, **arrays)


def load_robot_motion(path: str | Path) -> dict[str, Any]:
    """Load the safe NPZ contract and reject executable pickle artifacts."""

    source = Path(path)
    if source.suffix.lower() != ".npz":
        raise ValueError(
            "Unsafe robot-motion artifact rejected. Use the "
            f"{ROBOT_MOTION_SCHEMA} NPZ contract instead of pickle."
        )
    with np.load(source, allow_pickle=False) as archive:
        if "metadata_json" not in archive:
            raise ValueError("Robot-motion NPZ is missing metadata_json.")
        try:
            metadata = json.loads(str(np.asarray(archive["metadata_json"]).item()))
        except (json.JSONDecodeError, ValueError) as error:
            raise ValueError("Robot-motion NPZ contains invalid metadata JSON.") from error
        if metadata.get("schema_version") != ROBOT_MOTION_SCHEMA:
            raise ValueError(
                "Robot-motion schema mismatch; expected "
                f"{ROBOT_MOTION_SCHEMA}, received {metadata.get('schema_version')!r}."
            )
        motion = {
            key: np.asarray(archive[key])
            for key in archive.files
            if key != "metadata_json"
        }
    motion.update({key: value for key, value in metadata.items() if key != "schema_version"})
    required = ("root_pos", "root_rot", "dof_pos", "fps")
    missing = [key for key in required if key not in motion]
    if missing:
        raise ValueError(f"Robot-motion NPZ is missing required field(s): {missing}.")
    return motion


@dataclass(frozen=True)
class GeometrySets:
    floor_geom: int
    left_foot_collision: tuple[int, ...]
    right_foot_collision: tuple[int, ...]
    left_foot_visual: tuple[int, ...]
    right_foot_visual: tuple[int, ...]
    robot_collision: tuple[int, ...]
    robot_visual: tuple[int, ...]


def joint_names(model: mujoco.MjModel) -> tuple[str, ...]:
    return tuple(
        str(mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, joint_id))
        for joint_id in range(model.njnt)
        if int(model.jnt_type[joint_id]) == int(mujoco.mjtJoint.mjJNT_HINGE)
    )


def validate_qpos(model: mujoco.MjModel, qpos: np.ndarray) -> np.ndarray:
    values = np.asarray(qpos, dtype=np.float64)
    if values.ndim != 2 or values.shape[1] != model.nq:
        raise ValueError(
            f"Unitree G1 qpos must have shape (frames, {model.nq}); received {values.shape}."
        )
    if model.nq != 36 or model.nv != 35:
        raise ValueError(f"Expected the floating-base G1 29-DoF model; nq={model.nq}, nv={model.nv}.")
    names = joint_names(model)
    if names != G1_29_DOF_JOINTS:
        missing = sorted(set(G1_29_DOF_JOINTS) - set(names))
        extra = sorted(set(names) - set(G1_29_DOF_JOINTS))
        raise ValueError(f"G1 joint order mismatch; missing={missing}, extra={extra}, actual={names}.")
    if not np.isfinite(values).all():
        location = np.argwhere(~np.isfinite(values))[0].tolist()
        raise ValueError(f"G1 qpos contains NaN or Infinity at {location}.")
    quaternion_norm = np.linalg.norm(values[:, 3:7], axis=1)
    if np.any(quaternion_norm < 1e-8):
        frame = int(np.where(quaternion_norm < 1e-8)[0][0])
        raise ValueError(f"G1 root quaternion norm is near zero at frame {frame}.")
    values = values.copy()
    values[:, 3:7] /= quaternion_norm[:, None]
    for offset, name in enumerate(names):
        joint_id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        if not bool(model.jnt_limited[joint_id]):
            continue
        lower, upper = model.jnt_range[joint_id]
        invalid = np.where(
            (values[:, 7 + offset] < lower - 1e-5) |
            (values[:, 7 + offset] > upper + 1e-5)
        )[0]
        if len(invalid):
            raise ValueError(
                f"{name} exceeds [{lower:.6f}, {upper:.6f}] radians at frame {int(invalid[0])}."
            )
    root_step = np.linalg.norm(np.diff(values[:, :3], axis=0), axis=1)
    if len(root_step) and float(np.max(root_step)) > 0.5:
        raise ValueError(f"G1 root translation jumps {float(np.max(root_step)):.3f} m in one frame.")
    joint_step = np.abs(np.diff(values[:, 7:], axis=0))
    if joint_step.size and float(np.max(joint_step)) > np.pi:
        frame, joint = np.unravel_index(int(np.argmax(joint_step)), joint_step.shape)
        raise ValueError(
            f"{names[joint]} jumps {joint_step[frame, joint]:.3f} rad between frames {frame} and {frame + 1}."
        )
    return values


def geometry_sets(model: mujoco.MjModel) -> GeometrySets:
    floor_geom = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "floor")
    if floor_geom < 0 or int(model.geom_type[floor_geom]) != int(mujoco.mjtGeom.mjGEOM_PLANE):
        raise ValueError("The Unitree G1 MuJoCo model has no authoritative floor plane.")
    left_bodies = {
        mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "left_ankle_pitch_link"),
        mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "left_ankle_roll_link"),
    }
    right_bodies = {
        mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "right_ankle_pitch_link"),
        mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, "right_ankle_roll_link"),
    }
    if min(*left_bodies, *right_bodies) < 0:
        raise ValueError("The G1 ankle bodies required for sole diagnostics are missing.")
    left_all = tuple(
        geom for geom in range(1, model.ngeom) if int(model.geom_bodyid[geom]) in left_bodies
    )
    right_all = tuple(
        geom for geom in range(1, model.ngeom) if int(model.geom_bodyid[geom]) in right_bodies
    )
    group = lambda geoms, value: tuple(geom for geom in geoms if int(model.geom_group[geom]) == value)
    return GeometrySets(
        floor_geom=floor_geom,
        left_foot_collision=group(left_all, 0),
        right_foot_collision=group(right_all, 0),
        left_foot_visual=group(left_all, 1),
        right_foot_visual=group(right_all, 1),
        robot_collision=tuple(
            geom for geom in range(1, model.ngeom) if int(model.geom_group[geom]) == 0
        ),
        robot_visual=tuple(
            geom for geom in range(1, model.ngeom) if int(model.geom_group[geom]) == 1
        ),
    )


def _geometry_min_z(model: mujoco.MjModel, data: mujoco.MjData, geom: int) -> float:
    geom_type = int(model.geom_type[geom])
    rotation = np.asarray(data.geom_xmat[geom]).reshape(3, 3)
    position = np.asarray(data.geom_xpos[geom])
    size = np.asarray(model.geom_size[geom])
    if geom_type == int(mujoco.mjtGeom.mjGEOM_MESH):
        mesh = int(model.geom_dataid[geom])
        start = int(model.mesh_vertadr[mesh])
        count = int(model.mesh_vertnum[mesh])
        vertices = np.asarray(model.mesh_vert[start : start + count])
        return float(np.min((vertices @ rotation.T + position)[:, 2]))
    if geom_type == int(mujoco.mjtGeom.mjGEOM_SPHERE):
        return float(position[2] - size[0])
    if geom_type == int(mujoco.mjtGeom.mjGEOM_CAPSULE):
        return float(position[2] - size[0] - size[1] * abs(rotation[2, 2]))
    if geom_type == int(mujoco.mjtGeom.mjGEOM_CYLINDER):
        radial = size[0] * np.hypot(rotation[2, 0], rotation[2, 1])
        return float(position[2] - radial - size[1] * abs(rotation[2, 2]))
    if geom_type == int(mujoco.mjtGeom.mjGEOM_BOX):
        return float(position[2] - np.sum(np.abs(rotation[2]) * size[:3]))
    if geom_type == int(mujoco.mjtGeom.mjGEOM_ELLIPSOID):
        return float(position[2] - np.sqrt(np.sum((rotation[2] * size[:3]) ** 2)))
    raise ValueError(f"Unsupported G1 geometry type {geom_type} for geometry {geom}.")


def _minimum(model: mujoco.MjModel, data: mujoco.MjData, geoms: tuple[int, ...]) -> float:
    if not geoms:
        raise ValueError("The Unitree G1 model is missing a required geometry set.")
    return min(_geometry_min_z(model, data, geom) for geom in geoms)


def analyze_qpos(model: mujoco.MjModel, qpos: np.ndarray, fps: float) -> dict[str, Any]:
    values = validate_qpos(model, qpos)
    sets = geometry_sets(model)
    data = mujoco.MjData(model)
    floor_height = float(model.geom_pos[sets.floor_geom, 2])
    frame_rows: list[dict[str, Any]] = []
    left_centers: list[np.ndarray] = []
    right_centers: list[np.ndarray] = []
    for index, frame in enumerate(values):
        data.qpos[:] = frame
        mujoco.mj_forward(model, data)
        left_collision = _minimum(model, data, sets.left_foot_collision)
        right_collision = _minimum(model, data, sets.right_foot_collision)
        left_visual = _minimum(model, data, sets.left_foot_visual)
        right_visual = _minimum(model, data, sets.right_foot_visual)
        robot_collision = _minimum(model, data, sets.robot_collision)
        robot_visual = _minimum(model, data, sets.robot_visual)
        left_centers.append(
            np.mean([np.asarray(data.geom_xpos[geom]) for geom in sets.left_foot_collision], axis=0)
        )
        right_centers.append(
            np.mean([np.asarray(data.geom_xpos[geom]) for geom in sets.right_foot_collision], axis=0)
        )
        left_contact = False
        right_contact = False
        contacts: list[dict[str, Any]] = []
        for contact_index in range(data.ncon):
            contact = data.contact[contact_index]
            pair = {int(contact.geom1), int(contact.geom2)}
            if sets.floor_geom not in pair:
                continue
            is_left = bool(pair.intersection(sets.left_foot_collision))
            is_right = bool(pair.intersection(sets.right_foot_collision))
            left_contact = left_contact or is_left
            right_contact = right_contact or is_right
            if is_left or is_right:
                contacts.append(
                    {
                        "side": "left" if is_left else "right",
                        "position": np.asarray(contact.pos, dtype=float).round(6).tolist(),
                        "distance": float(contact.dist),
                    }
                )
        frame_rows.append(
            {
                "frame": index,
                "qpos": frame.round(7).tolist(),
                "rootPosition": frame[:3].round(7).tolist(),
                "rootQuaternionWxyz": frame[3:7].round(7).tolist(),
                "jointPositions": frame[7:].round(7).tolist(),
                "leftSoleHeight": left_collision,
                "rightSoleHeight": right_collision,
                "leftVisualHeight": left_visual,
                "rightVisualHeight": right_visual,
                "minimumCollisionHeight": robot_collision,
                "minimumVisualHeight": robot_visual,
                "minimumGeometryHeight": min(robot_collision, robot_visual),
                "leftPenetration": max(0.0, floor_height - left_collision),
                "rightPenetration": max(0.0, floor_height - right_collision),
                "leftContact": left_contact,
                "rightContact": right_contact,
                "contacts": contacts,
                "leftCollisionSpheres": [
                    {
                        "position": np.asarray(data.geom_xpos[geom], dtype=float).round(6).tolist(),
                        "radius": float(model.geom_size[geom, 0]),
                    }
                    for geom in sets.left_foot_collision
                    if int(model.geom_type[geom]) == int(mujoco.mjtGeom.mjGEOM_SPHERE)
                ],
                "rightCollisionSpheres": [
                    {
                        "position": np.asarray(data.geom_xpos[geom], dtype=float).round(6).tolist(),
                        "radius": float(model.geom_size[geom, 0]),
                    }
                    for geom in sets.right_foot_collision
                    if int(model.geom_type[geom]) == int(mujoco.mjtGeom.mjGEOM_SPHERE)
                ],
                "bodyPositions": np.asarray(data.xpos, dtype=float).round(6).tolist(),
            }
        )
    left_centers_array = np.asarray(left_centers)
    right_centers_array = np.asarray(right_centers)
    left_velocity = np.vstack(
        (np.zeros((1, 3)), np.diff(left_centers_array, axis=0) * float(fps))
    )
    right_velocity = np.vstack(
        (np.zeros((1, 3)), np.diff(right_centers_array, axis=0) * float(fps))
    )
    for index, row in enumerate(frame_rows):
        row["leftFootVelocity"] = float(np.linalg.norm(left_velocity[index]))
        row["rightFootVelocity"] = float(np.linalg.norm(right_velocity[index]))
    minimum_geometry = np.asarray([row["minimumGeometryHeight"] for row in frame_rows])
    penetration = np.maximum(0.0, floor_height - minimum_geometry)
    root_height = values[:, 2]
    root_acceleration = np.diff(root_height, n=2) * float(fps) ** 2
    contact_velocity = [
        row["leftFootVelocity"] for row in frame_rows if row["leftContact"]
    ] + [
        row["rightFootVelocity"] for row in frame_rows if row["rightContact"]
    ]
    def longest_run(mask: list[bool]) -> int:
        longest = current = 0
        for active in mask:
            current = current + 1 if active else 0
            longest = max(longest, current)
        return longest

    return {
        "qposShape": [int(values.shape[0]), int(values.shape[1])],
        "qposLayout": "xyz-wxyz-joints",
        "jointNames": list(joint_names(model)),
        "quaternionOrder": "wxyz",
        "jointAngleUnit": "radians",
        "worldUpAxis": "z",
        "floorHeight": floor_height,
        "frames": frame_rows,
        "summary": {
            "maximumPenetration": float(np.max(penetration)),
            "averagePenetration": float(np.mean(penetration)),
            "framesOver5mm": np.where(penetration > 0.005)[0].astype(int).tolist(),
            "framesOver20mm": np.where(penetration > 0.020)[0].astype(int).tolist(),
            "maximumContactFootVelocity": float(max(contact_velocity, default=0.0)),
            "leftContactDuration": longest_run(
                [bool(row["leftContact"]) for row in frame_rows]
            ) / float(fps),
            "rightContactDuration": longest_run(
                [bool(row["rightContact"]) for row in frame_rows]
            ) / float(fps),
            "maximumRootHeightAcceleration": float(
                np.max(np.abs(root_acceleration)) if root_acceleration.size else 0.0
            ),
            "rootHeightDiscontinuityFrames": (
                np.where(np.abs(root_acceleration) > 10.0)[0] + 1
            ).astype(int).tolist(),
        },
    }


def contact_aware_grounding(
    model: mujoco.MjModel,
    qpos: np.ndarray,
    fps: float,
) -> tuple[np.ndarray, dict[str, Any], dict[str, Any], np.ndarray]:
    """Optimize one smooth root-height trajectory against exact sole geometry.

    Contact frames anchor the support sole to the MuJoCo floor. Airborne frames
    retain the original root arc through a weak constant-offset prior. Exact
    visual and collision geometry provide hard non-penetration bounds.
    """
    values = validate_qpos(model, qpos)
    before = analyze_qpos(model, values, fps)
    rows = before["frames"]
    left = np.asarray([row["leftSoleHeight"] for row in rows])
    right = np.asarray([row["rightSoleHeight"] for row in rows])
    minimum = np.asarray([row["minimumGeometryHeight"] for row in rows])
    left_speed = np.asarray([row["leftFootVelocity"] for row in rows])
    right_speed = np.asarray([row["rightFootVelocity"] for row in rows])
    floor = float(before["floorHeight"])
    required = floor - minimum
    lower = np.minimum(left, right)
    relative_threshold = np.quantile(lower, 0.45) + 0.045
    left_contact = (left <= right + 0.025) & (left <= relative_threshold) & (left_speed < 0.45)
    right_contact = (right <= left + 0.025) & (right <= relative_threshold) & (right_speed < 0.45)
    # A stance is only physically feasible if grounding that sole would not
    # force another official visual/collision geometry through the floor.
    left_contact &= required <= (floor - left) + 0.005
    right_contact &= required <= (floor - right) + 0.005
    if not np.any(left_contact | right_contact):
        fallback = (lower <= np.quantile(lower, 0.2)) & (
            required <= (floor - lower) + 0.005
        )
        left_contact = fallback & (left <= right)
        right_contact = fallback & (right < left)
    contact_target = np.zeros(len(values), dtype=np.float64)
    contact_weight = np.zeros(len(values), dtype=np.float64)
    for index in range(len(values)):
        targets = []
        if left_contact[index]:
            targets.append(floor - left[index])
        if right_contact[index]:
            targets.append(floor - right[index])
        if targets:
            contact_target[index] = float(np.mean(targets))
            contact_weight[index] = 4000.0
    baseline = float(
        np.median(contact_target[contact_weight > 0])
        if np.any(contact_weight > 0)
        else np.median(required)
    )
    frame_count = len(values)
    second_difference = np.zeros((max(0, frame_count - 2), frame_count), dtype=np.float64)
    for index in range(frame_count - 2):
        second_difference[index, index : index + 3] = (1.0, -2.0, 1.0)
    smoothness = second_difference.T @ second_difference
    prior_weight = 0.35
    smoothness_weight = 240.0
    hessian = (
        np.diag(contact_weight + prior_weight) +
        smoothness_weight * smoothness
    )
    target = contact_weight * contact_target + prior_weight * baseline
    def objective(correction: np.ndarray) -> tuple[float, np.ndarray]:
        value = 0.5 * float(correction @ hessian @ correction) - float(target @ correction)
        gradient = hessian @ correction - target
        return value, gradient

    initial = np.maximum(required, baseline)
    solved = minimize(
        lambda correction: objective(correction)[0],
        initial,
        jac=lambda correction: objective(correction)[1],
        method="L-BFGS-B",
        bounds=Bounds(required, np.full(frame_count, np.inf)),
        options={"ftol": 1e-12, "gtol": 1e-9, "maxiter": 1000},
    )
    if not solved.success:
        raise RuntimeError(f"Unable to solve G1 contact-aware grounding: {solved.message}")
    correction = np.asarray(solved.x)
    corrected = values.copy()
    corrected[:, 2] += correction
    after = analyze_qpos(model, corrected, fps)
    tolerance = 5e-5
    if after["summary"]["maximumPenetration"] > tolerance:
        raise RuntimeError(
            "Contact-aware grounding left "
            f"{after['summary']['maximumPenetration']:.6f} m of geometry penetration."
        )
    after["groundingMethod"] = "mujoco-sole-contact-constrained-smooth-root-height"
    for index, frame in enumerate(after["frames"]):
        frame["leftExpectedContact"] = bool(left_contact[index])
        frame["rightExpectedContact"] = bool(right_contact[index])
    expected_velocity = [
        frame["leftFootVelocity"]
        for index, frame in enumerate(after["frames"])
        if left_contact[index]
    ] + [
        frame["rightFootVelocity"]
        for index, frame in enumerate(after["frames"])
        if right_contact[index]
    ]
    both_airborne_during_stance = [
        index
        for index, frame in enumerate(after["frames"])
        if (left_contact[index] or right_contact[index])
        and frame["leftSoleHeight"] > floor + 0.005
        and frame["rightSoleHeight"] > floor + 0.005
    ]
    after["summary"]["maximumExpectedContactFootVelocity"] = float(
        max(expected_velocity, default=0.0)
    )
    def duration(mask: np.ndarray) -> float:
        longest = current = 0
        for active in mask:
            current = current + 1 if bool(active) else 0
            longest = max(longest, current)
        return longest / float(fps)

    after["summary"]["leftExpectedContactDuration"] = duration(left_contact)
    after["summary"]["rightExpectedContactDuration"] = duration(right_contact)
    after["summary"]["bothFeetAboveFloorDuringExpectedStance"] = (
        both_airborne_during_stance
    )
    after["contactDetection"] = {
        "leftFrames": np.where(left_contact)[0].astype(int).tolist(),
        "rightFrames": np.where(right_contact)[0].astype(int).tolist(),
        "maximumCorrection": float(np.max(correction)),
        "minimumCorrection": float(np.min(correction)),
        "maximumCorrectionStep": float(
            np.max(np.abs(np.diff(correction))) if len(correction) > 1 else 0.0
        ),
    }
    return corrected, before, after, correction


def load_g1_model(xml_path: str | Path) -> mujoco.MjModel:
    return mujoco.MjModel.from_xml_path(str(Path(xml_path).resolve()))
