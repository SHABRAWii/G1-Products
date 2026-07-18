#!/usr/bin/env python3
"""Render a browser-safe 3D SMPL-X joint-track preview from a pose artifact."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
import smplx
import torch


# Body joints from SMPL-X's standard joint order.  Facial and hand joints are
# intentionally omitted: the dashboard view is a readable whole-body motion
# verification, not a dense mesh viewer.
EDGES = (
    (0, 1), (1, 4), (4, 7), (7, 10),
    (0, 2), (2, 5), (5, 8), (8, 11),
    (0, 3), (3, 6), (6, 9), (9, 12),
    (12, 15), (12, 13), (13, 16), (16, 18), (18, 20),
    (12, 14), (14, 17), (17, 19), (19, 21),
)
COLORS = ((255, 165, 74), (97, 181, 255), (210, 108, 255), (90, 224, 154))


def load_joints(path: Path, model_dir: Path) -> tuple[np.ndarray, float]:
    data = np.load(path, allow_pickle=True)
    frames = int(np.asarray(data["pose_body"]).shape[0])
    betas = np.asarray(data["betas"], dtype=np.float32).reshape(-1)
    model = smplx.create(str(model_dir), "smplx", gender=str(data["gender"]), use_pca=False, num_betas=len(betas), num_expression_coeffs=10)
    zeros45 = torch.zeros(frames, 45)
    zeros3 = torch.zeros(frames, 3)
    output = model(
        betas=torch.from_numpy(betas)[None].repeat(frames, 1),
        global_orient=torch.from_numpy(np.asarray(data["root_orient"], dtype=np.float32)),
        body_pose=torch.from_numpy(np.asarray(data["pose_body"], dtype=np.float32)),
        transl=torch.from_numpy(np.asarray(data["trans"], dtype=np.float32)),
        left_hand_pose=zeros45, right_hand_pose=zeros45, jaw_pose=zeros3, leye_pose=zeros3, reye_pose=zeros3,
        expression=torch.zeros(frames, 10), return_full_pose=True,
    )
    joints = output.joints.detach().cpu().numpy()[:, :22, :]
    fps = float(np.asarray(data.get("mocap_frame_rate", 30.0)).reshape(-1)[0])
    return joints, fps


def project(points: np.ndarray, center: np.ndarray, scale: float, width: int, height: int) -> np.ndarray:
    # Fixed yaw/pitch gives the motion genuine depth instead of a camera-plane
    # overlay.  A stable view also makes body orientation easy to compare over
    # time.
    yaw, pitch = np.deg2rad(32), np.deg2rad(-13)
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    yaw_matrix = np.array(((cy, 0, sy), (0, 1, 0), (-sy, 0, cy)), dtype=np.float32)
    pitch_matrix = np.array(((1, 0, 0), (0, cp, -sp), (0, sp, cp)), dtype=np.float32)
    rotated = (points - center) @ yaw_matrix.T @ pitch_matrix.T
    depth = np.clip(rotated[:, 2] + 5.0, 2.0, None)
    x = width * 0.5 + (rotated[:, 0] / depth) * scale
    y = height * 0.78 - (rotated[:, 1] / depth) * scale
    return np.column_stack((x, y)).astype(int)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render a 3D SMPL-X skeleton preview.")
    parser.add_argument("--smplx", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scene-output", help="Optional JSON scene for the interactive dashboard viewer.")
    args = parser.parse_args()
    joints, fps = load_joints(Path(args.smplx).resolve(), Path(args.model_dir).resolve())
    height, width = 720, 960
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    intermediate = output.with_name(f"{output.stem}.intermediate.mp4")
    writer = cv2.VideoWriter(str(intermediate), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("Unable to create the temporary 3D pose preview.")
    center = np.nanmean(joints[:, 0, :], axis=0)
    extent = max(float(np.nanmax(np.linalg.norm(joints - center, axis=-1))), 0.5)
    scale = min(width, height) * 1.9 / extent
    try:
        for index, frame in enumerate(joints):
            image = np.full((height, width, 3), (19, 29, 47), dtype=np.uint8)
            for y in range(int(height * .25), int(height * .86), 52): cv2.line(image, (80, y), (width - 80, y), (39, 55, 80), 1)
            points = project(frame, center, scale, width, height)
            for edge_index, (start, end) in enumerate(EDGES):
                color = COLORS[edge_index % len(COLORS)]
                cv2.line(image, tuple(points[start]), tuple(points[end]), color, 5, cv2.LINE_AA)
            for joint_index, point in enumerate(points):
                color = COLORS[joint_index % len(COLORS)]
                cv2.circle(image, tuple(point), 7, color, -1, cv2.LINE_AA)
                cv2.circle(image, tuple(point), 9, (240, 247, 255), 1, cv2.LINE_AA)
            cv2.rectangle(image, (24, 22), (365, 76), (10, 19, 34), -1)
            cv2.putText(image, "PromptHMR · 3D SMPL-X motion", (40, 55), cv2.FONT_HERSHEY_SIMPLEX, .7, (244, 248, 255), 2, cv2.LINE_AA)
            cv2.putText(image, f"Frame {index + 1:04d} / {len(joints):04d}", (width - 255, 55), cv2.FONT_HERSHEY_SIMPLEX, .55, (183, 205, 234), 1, cv2.LINE_AA)
            writer.write(image)
    finally:
        writer.release()
    result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(intermediate), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)], capture_output=True, text=True, check=False)
    intermediate.unlink(missing_ok=True)
    if result.returncode: raise RuntimeError(f"Unable to transcode the 3D pose preview: {result.stderr.strip()}")
    if args.scene_output:
        scene = {
            "schemaVersion": "visualization.pose-3d-scene/v1",
            "kind": "smplx",
            "fps": fps,
            "upAxis": "z",
            "edges": [list(edge) for edge in EDGES],
            "frames": np.round(joints, 5).tolist(),
        }
        Path(args.scene_output).write_text(json.dumps(scene, separators=(",", ":")), encoding="utf-8")
    print(f"RoboMotion: rendered {len(joints)} frames of 3D SMPL-X motion", flush=True)


if __name__ == "__main__":
    main()
