#!/usr/bin/env python3
"""Render a colored 2D pose skeleton preview from PromptHMR extraction results."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

import cv2
import joblib
import numpy as np


# OpenPose BODY_25 topology. PromptHMR stores the same 25-joint 2D track in
# ``keypoints_2d``; keeping this mapping here makes the preview independent of
# the upstream visualizer/server.
BODY_25_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 4), (1, 5), (5, 6), (6, 7),
    (1, 8), (8, 9), (9, 10), (10, 11), (8, 12), (12, 13), (13, 14),
    (0, 15), (15, 17), (0, 16), (16, 18), (14, 19), (19, 20),
    (14, 21), (11, 22), (22, 23), (11, 24),
)
PALETTE = (
    (255, 99, 71), (255, 165, 0), (255, 215, 0), (50, 205, 50),
    (0, 191, 255), (65, 105, 225), (138, 43, 226), (255, 20, 147),
)


def choose_track(people: dict) -> dict:
    if not people:
        raise RuntimeError("PromptHMR found no tracked people to visualize.")

    def rank(person: dict) -> tuple[int, float]:
        frames = len(person.get("frames", ()))
        boxes = np.asarray(person.get("bboxes", ()))
        area = 0.0
        if boxes.ndim == 2 and boxes.shape[1] >= 4:
            area = float(np.nanmedian((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])))
        return frames, area

    return max(people.values(), key=rank)


def draw_skeleton(frame: np.ndarray, keypoints: np.ndarray, confidence: float) -> None:
    valid = keypoints[:, 2] >= confidence
    for index, (start, end) in enumerate(BODY_25_EDGES):
        if valid[start] and valid[end]:
            first = tuple(np.rint(keypoints[start, :2]).astype(int))
            second = tuple(np.rint(keypoints[end, :2]).astype(int))
            cv2.line(frame, first, second, PALETTE[index % len(PALETTE)], 3, cv2.LINE_AA)
    for index, point in enumerate(keypoints):
        if valid[index]:
            center = tuple(np.rint(point[:2]).astype(int))
            cv2.circle(frame, center, 5, PALETTE[index % len(PALETTE)], -1, cv2.LINE_AA)
            cv2.circle(frame, center, 7, (255, 255, 255), 1, cv2.LINE_AA)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a colored PromptHMR skeleton preview.")
    parser.add_argument("--video", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--confidence", type=float, default=0.2)
    args = parser.parse_args()

    video_path = Path(args.video).resolve()
    results_path = Path(args.results).resolve()
    output_path = Path(args.output).resolve()
    results = joblib.load(results_path)
    person = choose_track(results.get("people", {}))
    keypoints = np.asarray(person.get("keypoints_2d", ()), dtype=np.float32)
    if keypoints.ndim != 3 or keypoints.shape[1:] != (25, 3):
        raise RuntimeError("PromptHMR did not produce a BODY_25 keypoint track for the selected person.")

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open the prepared video: {video_path}")
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # OpenCV's ``mp4v`` stream is not reliably playable in browser video
    # elements.  Write a temporary stream, then transcode it to H.264/yuv420p
    # with FFmpeg, which is broadly supported by Chrome, Firefox, and Safari.
    intermediate_path = output_path.with_name(f"{output_path.stem}.intermediate.mp4")
    writer = cv2.VideoWriter(str(intermediate_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    if not writer.isOpened():
        raise RuntimeError("Unable to create the MP4 skeleton preview.")

    frame_count = 0
    try:
        while frame_count < len(keypoints):
            ok, frame = capture.read()
            if not ok:
                break
            draw_skeleton(frame, keypoints[frame_count], args.confidence)
            cv2.rectangle(frame, (16, 16), (278, 54), (11, 27, 54), -1)
            cv2.putText(frame, "PromptHMR · 2D pose track", (27, 41), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (245, 248, 255), 1, cv2.LINE_AA)
            writer.write(frame)
            frame_count += 1
    finally:
        capture.release()
        writer.release()

    if frame_count == 0:
        raise RuntimeError("The prepared video contained no frames for the skeleton preview.")
    transcode = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(intermediate_path),
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    intermediate_path.unlink(missing_ok=True)
    if transcode.returncode:
        raise RuntimeError(f"Unable to transcode the skeleton preview to browser-compatible H.264: {transcode.stderr.strip()}")
    print(f"RoboMotion: rendered colored pose skeleton preview; frames={frame_count}", flush=True)


if __name__ == "__main__":
    main()
