#!/usr/bin/env python3
"""Render a browser-safe robot-motion preview without requiring a GPU GL context."""

from __future__ import annotations

import argparse
import json
import os
import pickle
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np


# G1 link indices from the motion artifact written by robomotion_gmr_adapter.
# The preview is intentionally a readable kinematic verification view: it is
# headless, deterministic, and works on a server without EGL/desktop access.
KINEMATIC_CHAINS = (
    ((0, 1, 2, 3, 4, 5, 6, 7), (255, 168, 64)),
    ((0, 9, 10, 11, 12, 13, 14, 15), (86, 142, 255)),
    ((0, 16, 17, 18, 19), (206, 95, 255)),
    ((18, 22, 23, 24, 25, 26, 27, 28, 29), (89, 219, 151)),
    ((18, 30, 31, 32, 33, 34, 35, 36, 37), (80, 210, 245)),
)


def stabilized_visual_root_rotation(rotation: np.ndarray) -> np.ndarray:
    """Keep the mesh render world-up while preserving the robot's heading.

    GMR's artifact deliberately carries the source person's global root
    pitch/roll.  That is useful retargeting data, but applying it directly to
    the free base in a review render can make a crouch or camera-estimation
    wobble look as if the physical G1 has fallen over.  This only affects the
    display qpos: stored GMR motion remains unchanged.  We retain yaw (the
    robot's world heading) and let the actual 29 DoF joint motion show the
    pose.
    """
    w, x, y, z = (float(value) for value in rotation)
    yaw = np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    return np.asarray([np.cos(yaw / 2.0), 0.0, 0.0, np.sin(yaw / 2.0)], dtype=np.float32)


def load_clean_mujoco_model(xml_path: Path):
    """Load GMR's G1 model with a clean review-scene presentation.

    GMR ships the correct Unitree meshes and kinematics, but its demo XML also
    contains a second dark skybox.  RoboMotion owns the presentation layer, so
    it creates a temporary scene-only XML beside the original (preserving
    relative STL paths) and leaves GMR's checked-out source untouched.
    """
    import mujoco

    scene_xml = xml_path.read_text(encoding="utf-8")
    scene_xml = scene_xml.replace(
        '<headlight diffuse="0.6 0.6 0.6" ambient="0.1 0.1 0.1" specular="0.9 0.9 0.9"/>',
        '<headlight diffuse="0.78 0.78 0.78" ambient="0.42 0.42 0.42" specular="0.35 0.35 0.35"/>',
    )
    scene_xml = scene_xml.replace('<rgba haze="0.15 0.25 0.35 1"/>', '<rgba haze="1 1 1 1"/>')
    scene_xml = scene_xml.replace(
        '<texture type="2d" name="groundplane" builtin="checker" mark="edge" rgb1="1 1 1" rgb2="1 1 1" markrgb="0 0 0"',
        '<texture type="2d" name="groundplane" builtin="checker" mark="edge" rgb1="0.98 0.98 0.98" rgb2="0.93 0.94 0.96" markrgb="0.72 0.76 0.82"',
    )
    scene_xml = scene_xml.replace(
        '    <texture type="skybox" builtin="gradient" rgb1=".4 .5 .6" rgb2="0 0 0" width="100" height="100"/>\n',
        "",
    )
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".robomotion.xml", prefix="g1-", dir=xml_path.parent, encoding="utf-8", delete=False
        ) as temporary:
            temporary.write(scene_xml)
            temporary_path = Path(temporary.name)
        return mujoco.MjModel.from_xml_path(str(temporary_path))
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def write_kinematic_preview(motion: dict, output_path: Path) -> int:
    positions = np.asarray(motion.get("local_body_pos"), dtype=np.float32)
    if positions.ndim != 3 or positions.shape[1] < 38 or positions.shape[2] != 3:
        raise RuntimeError("Robot motion lacks the local body positions required for the headless preview.")
    fps = float(motion.get("fps", 30.0))
    height, width = 720, 960
    # Project lateral (Y) vs vertical (Z) robot-link coordinates.  The root is
    # kept centered, making joint motion and contact posture easy to inspect.
    yz = positions[:, :, [1, 2]]
    vertical_min, vertical_max = float(np.min(yz[..., 1])), float(np.max(yz[..., 1]))
    horizontal_extent = max(abs(float(np.min(yz[..., 0]))), abs(float(np.max(yz[..., 0]))), 0.25)
    vertical_extent = max(vertical_max - vertical_min, 0.5)
    scale = min((width * 0.72) / (2 * horizontal_extent), (height * 0.72) / vertical_extent)
    center_x = width // 2
    ground_y = int(height * 0.83)
    intermediate = output_path.with_name(f"{output_path.stem}.intermediate.mp4")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(intermediate), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("Unable to create the temporary robot preview stream.")

    try:
        for frame_index, frame in enumerate(yz):
            image = np.full((height, width, 3), (18, 27, 45), dtype=np.uint8)
            cv2.line(image, (int(width * 0.12), ground_y), (int(width * 0.88), ground_y), (67, 89, 122), 2, cv2.LINE_AA)
            projected = np.column_stack((center_x + frame[:, 0] * scale, ground_y - (frame[:, 1] - vertical_min) * scale)).astype(int)
            for chain, color in KINEMATIC_CHAINS:
                for start, end in zip(chain, chain[1:]):
                    cv2.line(image, tuple(projected[start]), tuple(projected[end]), color, 5, cv2.LINE_AA)
                for joint in chain:
                    cv2.circle(image, tuple(projected[joint]), 7, color, -1, cv2.LINE_AA)
                    cv2.circle(image, tuple(projected[joint]), 9, (240, 247, 255), 1, cv2.LINE_AA)
            cv2.rectangle(image, (24, 22), (420, 76), (10, 19, 34), -1)
            cv2.putText(image, "Unitree G1 · 29 DoF kinematic preview", (40, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (243, 248, 255), 2, cv2.LINE_AA)
            cv2.putText(image, f"Frame {frame_index + 1:04d} / {len(positions):04d}", (width - 255, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (183, 205, 234), 1, cv2.LINE_AA)
            writer.write(image)
    finally:
        writer.release()

    transcode = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(intermediate), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    intermediate.unlink(missing_ok=True)
    if transcode.returncode:
        raise RuntimeError(f"Unable to transcode the robot preview to H.264: {transcode.stderr.strip()}")
    return len(positions)


def render_mujoco_mesh_preview(motion: dict, robot: str, output_path: Path) -> int:
    """Offscreen render the real G1 MuJoCo mesh model, without a desktop GUI."""
    os.environ.setdefault("MUJOCO_GL", "egl")
    import mujoco

    root = Path(os.environ.get("ROBOMOTION_GMR_ROOT", "")).expanduser().resolve()
    xml_by_robot = {
        "unitree_g1": root / "assets" / "unitree_g1" / "g1_mocap_29dof.xml",
        "unitree_g1_with_hands": root / "assets" / "unitree_g1" / "g1_mocap_29dof_with_hands.xml",
    }
    xml_path = xml_by_robot.get(robot)
    if not xml_path or not xml_path.exists():
        raise RuntimeError(f"No MuJoCo mesh model is available for {robot} at {xml_path}.")
    model = load_clean_mujoco_model(xml_path)
    data = mujoco.MjData(model)
    root_positions = np.asarray(motion["root_pos"], dtype=np.float32)
    # GMR stores serialized root quaternions as x, y, z, w; MuJoCo free joints
    # require w, x, y, z.  Its own data_loader performs this same conversion.
    root_rotations = np.asarray(motion["root_rot"], dtype=np.float32)[:, [3, 0, 1, 2]]
    joints = np.asarray(motion["dof_pos"], dtype=np.float32)
    fps = float(motion.get("fps", 30.0))
    if len(root_positions) != len(root_rotations) or len(root_positions) != len(joints):
        raise RuntimeError("Robot motion has inconsistent frame counts.")
    height, width = 720, 960
    intermediate = output_path.with_name(f"{output_path.stem}.intermediate.mp4")
    writer = cv2.VideoWriter(str(intermediate), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("Unable to create the temporary G1 mesh preview.")
    renderer = mujoco.Renderer(model, height=height, width=width)
    camera = mujoco.MjvCamera()
    camera.type = mujoco.mjtCamera.mjCAMERA_FREE
    camera.distance = 2.55
    camera.azimuth = 145
    camera.elevation = -16
    try:
        for index, (root_position, root_rotation, joint_position) in enumerate(zip(root_positions, root_rotations, joints)):
            data.qpos[:] = 0
            data.qpos[:3] = root_position
            data.qpos[3:7] = stabilized_visual_root_rotation(root_rotation)  # MuJoCo free-joint quaternion: w, x, y, z.
            data.qpos[7:7 + min(len(joint_position), model.nq - 7)] = joint_position[: model.nq - 7]
            mujoco.mj_forward(model, data)
            camera.lookat[:] = root_position
            camera.lookat[2] += 0.06
            renderer.update_scene(data, camera=camera)
            rgb = renderer.render()
            image = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            cv2.rectangle(image, (24, 22), (356, 70), (255, 255, 255), -1)
            cv2.rectangle(image, (24, 22), (356, 70), (220, 226, 235), 1)
            cv2.putText(image, "Unitree G1 · MuJoCo", (40, 53), cv2.FONT_HERSHEY_SIMPLEX, .68, (42, 55, 76), 2, cv2.LINE_AA)
            cv2.putText(image, f"Frame {index + 1:04d} / {len(root_positions):04d}", (width - 255, 52), cv2.FONT_HERSHEY_SIMPLEX, .55, (99, 113, 134), 1, cv2.LINE_AA)
            writer.write(image)
    finally:
        writer.release()
        renderer.close()
    transcode = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(intermediate), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path)], capture_output=True, text=True, check=False)
    intermediate.unlink(missing_ok=True)
    if transcode.returncode:
        raise RuntimeError(f"Unable to transcode the G1 mesh preview to H.264: {transcode.stderr.strip()}")
    return len(root_positions)


def write_scene(motion_path: Path, scene_output: str) -> None:
    with motion_path.open("rb") as file:
        motion = pickle.load(file)
    edges = [[start, end] for chain, _ in KINEMATIC_CHAINS for start, end in zip(chain, chain[1:])]
    # local_body_pos keeps the root pinned at the origin, which reads as a
    # treadmill in the dashboard.  Bake world-space positions so the viewer
    # shows true travel: world = root_pos + R(root_rot) @ local_body_pos.
    local = np.asarray(motion["local_body_pos"], dtype=np.float32)
    root_pos = np.asarray(motion["root_pos"], dtype=np.float32)[:, None, :]
    root_rot = np.asarray(motion["root_rot"], dtype=np.float32)  # serialized x, y, z, w
    axis = root_rot[:, None, :3]
    scalar = root_rot[:, 3][:, None, None]
    crossed = np.cross(axis, local)
    world = local + 2.0 * (scalar * crossed + np.cross(axis, crossed)) + root_pos
    scene = {
        "schemaVersion": "visualization.robot-3d-scene/v2", "kind": "robot", "fps": float(motion.get("fps", 30.0)), "upAxis": "z",
        "edges": edges, "frames": np.round(world, 5).tolist(),
    }
    Path(scene_output).write_text(json.dumps(scene, separators=(",", ":")), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--motion", required=True)
    parser.add_argument("--robot", default="unitree_g1")
    parser.add_argument("--output", required=True)
    parser.add_argument("--scene-output", help="Optional JSON scene for the interactive dashboard viewer.")
    args = parser.parse_args()
    motion_path = Path(args.motion).resolve()
    output_path = Path(args.output).resolve()
    renderer = os.environ.get("ROBOMOTION_ROBOT_RENDERER", "mesh").lower()
    with motion_path.open("rb") as file:
        motion = pickle.load(file)
    if renderer in {"mesh", "mujoco"}:
        try:
            frames = render_mujoco_mesh_preview(motion, args.robot, output_path)
            renderer = "mujoco-mesh"
        except Exception as error:
            if os.environ.get("ROBOMOTION_ALLOW_KINEMATIC_FALLBACK", "1") != "1":
                raise
            print(f"RoboMotion: MuJoCo mesh renderer unavailable ({error}); using kinematic fallback.", flush=True)
            frames = write_kinematic_preview(motion, output_path)
            renderer = "kinematic-fallback"
    elif renderer == "kinematic":
        with motion_path.open("rb") as file:
            motion = pickle.load(file)
            frames = write_kinematic_preview(motion, output_path)
    else:
        raise RuntimeError("ROBOMOTION_ROBOT_RENDERER must be 'mesh', 'mujoco', or 'kinematic'.")
    if args.scene_output:
        write_scene(motion_path, args.scene_output)
    print(f"RoboMotion: rendered {frames} frames to {output_path.name} using {renderer} renderer", flush=True)


if __name__ == "__main__":
    main()
