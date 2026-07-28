#!/usr/bin/env python3
"""Convert a video to a GMR-compatible SMPL-X file using PromptHMR directly."""

from __future__ import annotations

import argparse
import gc
import json
import os
import subprocess
import sys
from pathlib import Path

import joblib
import numpy as np
from scipy.spatial.transform import Rotation

from smplx_motion import split_prompthmr_smplx_pose, validate_track


PROMPTHMR_TO_ROBOT = np.array([[0, 0, -1], [-1, 0, 0], [0, 1, 0]], dtype=np.float32)


def video_fps(video: Path) -> float:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "default=nokey=1:noprint_wrappers=1", str(video)],
        capture_output=True,
        text=True,
        check=False,
    )
    try:
        numerator, denominator = result.stdout.strip().split("/")
        return float(numerator) / float(denominator)
    except (ValueError, ZeroDivisionError):
        return 30.0


def prepare_video(source: Path, destination: Path, max_height: int, fps: float) -> None:
    """Create a bounded inference copy without altering the uploaded artifact."""
    even_height = max_height - (max_height % 2)
    if even_height < 2:
        raise RuntimeError("PromptHMR inference height must be at least two pixels.")
    # -2 tells ffmpeg to calculate an aspect-preserving, even width for H.264.
    filter_graph = f"scale=-2:{even_height},fps={fps}"
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-vf", filter_graph, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-movflags", "+faststart", str(destination),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode:
        raise RuntimeError(f"Unable to prepare the uploaded video for PromptHMR: {completed.stderr.strip()}")


def load_prompthmr_half_precision(checkpoint: str):
    """Load PromptHMR's image model in FP16 so a 6 GB worker can run it."""
    import torch
    from prompt_hmr.core.config import parse_args
    from prompt_hmr.models import build_phmr

    weight = torch.load(checkpoint, map_location="cpu", weights_only=True)
    config = parse_args(["--cfg", str(Path(checkpoint).parent / "config.yaml")])
    model = build_phmr(config).half()
    # PromptHMR's SMPL-X wrapper explicitly mixes some joint values as FP32.
    # Keep that small geometric body model in FP32 while the large image encoder
    # remains FP16 to fit the local 6 GB GPU.
    model.smplx.float()
    # The SMPL projection consumes the FP32 SMPL-X vertices.  Keep its
    # regressors in FP32 as well; the image encoder remains the memory-heavy
    # component and stays FP16.
    model.smpl.float()
    model.smplx2smpl = model.smplx2smpl.float()
    model = model.cuda()
    model.load_state_dict(weight["state_dict"], strict=True)
    model.eval()
    model.is_train = False
    del weight
    torch.cuda.empty_cache()
    return model


def best_track(people: dict) -> tuple[str, dict]:
    if not people:
        raise RuntimeError("PromptHMR did not detect a person in the source video.")

    def score(item: tuple[str, dict]) -> tuple[int, float]:
        _, person = item
        frames = len(person.get("frames", []))
        boxes = np.asarray(person.get("bboxes", []))
        area = 0.0
        if boxes.ndim == 2 and boxes.shape[1] >= 4:
            area = float(np.nanmedian((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])))
        return frames, area

    return max(people.items(), key=score)


def convert(results: dict, video: Path, destination: Path) -> dict:
    track_id, person = best_track(results.get("people", {}))
    world = person.get("smplx_world") or {}
    poses = np.asarray(world.get("pose", []), dtype=np.float32)
    if poses.size == 0:
        raise RuntimeError("PromptHMR returned no usable world-coordinate SMPL-X pose track.")
    parameters = split_prompthmr_smplx_pose(poses)
    frames = parameters.global_orient.shape[0]
    translation = np.asarray(world.get("trans", np.zeros((frames, 3))), dtype=np.float32).reshape(frames, 3)
    shape = np.asarray(world.get("shape", np.zeros((frames, 10))), dtype=np.float32)
    if shape.ndim == 1:
        shape = shape.reshape(1, -1)
    if shape.shape != (frames, 10):
        raise RuntimeError(
            f"PromptHMR SMPL-X shape must have shape ({frames}, 10); received {shape.shape}."
        )

    root = np.empty((frames, 3), dtype=np.float32)
    for index, axis_angle in enumerate(parameters.global_orient):
        original_rotation = Rotation.from_rotvec(axis_angle).as_matrix()
        root[index] = Rotation.from_matrix(PROMPTHMR_TO_ROBOT @ original_rotation).as_rotvec()

    converted_translation = (translation @ PROMPTHMR_TO_ROBOT.T).astype(np.float32)
    betas = shape.mean(axis=0).astype(np.float32)
    expression = np.zeros((frames, 10), dtype=np.float32)
    validate_track(
        global_orient=root,
        body_pose=parameters.body_pose,
        transl=converted_translation,
        betas=betas,
        left_hand_pose=parameters.left_hand_pose,
        right_hand_pose=parameters.right_hand_pose,
        jaw_pose=parameters.jaw_pose,
        leye_pose=parameters.leye_pose,
        reye_pose=parameters.reye_pose,
        expression=expression,
    )
    np.savez(
        destination,
        root_orient=root,
        pose_body=parameters.body_pose.astype(np.float32),
        betas=betas,
        trans=converted_translation,
        left_hand_pose=parameters.left_hand_pose.astype(np.float32),
        right_hand_pose=parameters.right_hand_pose.astype(np.float32),
        jaw_pose=parameters.jaw_pose.astype(np.float32),
        leye_pose=parameters.leye_pose.astype(np.float32),
        reye_pose=parameters.reye_pose.astype(np.float32),
        expression=expression,
        gender=np.array("neutral"),
        mocap_frame_rate=np.array(video_fps(video), dtype=np.float32),
    )
    return {
        "track": str(track_id),
        "frames": frames,
        "fps": video_fps(video),
        "bodyModel": "smplx",
        "rotationRepresentation": "axis-angle-radians",
        "parameterShapes": {
            "global_orient": [frames, 3],
            "body_pose": [frames, 63],
            "transl": [frames, 3],
            "betas": [10],
            "left_hand_pose": [frames, 45],
            "right_hand_pose": [frames, 45],
            "jaw_pose": [frames, 3],
            "leye_pose": [frames, 3],
            "reye_pose": [frames, 3],
            "expression": [frames, 10],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt-hmr-root", required=True)
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--max-height", type=int, default=int(os.environ.get("ROBOMOTION_POSE_MAX_HEIGHT", "480")))
    parser.add_argument("--fps", type=float, default=float(os.environ.get("ROBOMOTION_POSE_FPS", "12")))
    parser.add_argument("--max-frames", type=int, default=int(os.environ.get("ROBOMOTION_POSE_MAX_FRAMES", "180")))
    args = parser.parse_args()
    root = Path(args.prompt_hmr_root).resolve()
    if not (root / "pipeline" / "pipeline.py").exists():
        raise RuntimeError(f"PromptHMR source is missing at {root}")
    sys.path.insert(0, str(root))
    # PromptHMR resolves its configuration and model files relative to its root.
    os.chdir(root)
    import pipeline.pipeline as prompt_pipeline
    import pipeline.phmr_vid as prompt_video
    import torch

    def static_camera_calibration(*_args: object, **_kwargs: object) -> dict[str, dict[str, float]]:
        # PromptHMR's world-coordinate pass always expects a calibration record.
        # For a static-camera run, zero pitch and roll are the correct identity
        # transform and avoid loading the unrelated SPEC calibration model.
        print("RoboMotion: static-camera profile uses identity gravity calibration.", flush=True)
        return {"first_frame": {"pitch": 0.0, "roll": 0.0}}

    # Avoid PromptHMR's unrelated 2.5 GB SPEC calibration model while retaining
    # its native pose estimation, tracking, SMPL-X inference, and conversion.
    prompt_pipeline.run_cam_calib = static_camera_calibration
    prompt_video.load_phmr = load_prompthmr_half_precision

    video = Path(args.video).resolve()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    prepared_video = output.parent / "prepared-input.mp4"
    prepare_video(video, prepared_video, args.max_height, args.fps)
    work_results = output.parent / "prompthmr-results"
    print(f"PromptHMR: processing {video.name} at <= {args.max_height}px and {args.fps:g} fps", flush=True)
    pipeline = prompt_pipeline.Pipeline(static_cam=True)
    pipeline.cfg.num_max_people = 1
    pipeline.cfg.run_post_opt = False
    original_hps_estimation = pipeline.hps_estimation

    def memory_safe_hps_estimation() -> None:
        gc.collect()
        torch.cuda.empty_cache()
        print(f"RoboMotion: GPU memory before PromptHMR mesh estimation: {torch.cuda.memory_allocated() / 1024**3:.2f} GiB", flush=True)
        original_hps_estimation()

    pipeline.hps_estimation = memory_safe_hps_estimation
    pipeline(input_video=str(prepared_video), output_folder=str(work_results), static_cam=True, max_frame=args.max_frames)
    produced = work_results / "results.pkl"
    if not produced.exists():
        raise RuntimeError("PromptHMR finished without results.pkl")
    Path(args.results).write_bytes(produced.read_bytes())
    evidence = convert(joblib.load(produced), prepared_video, output)
    evidence["profile"] = {"maxHeight": args.max_height, "fps": args.fps, "maxFrames": args.max_frames, "staticCamera": True, "postOptimization": False}
    (output.parent / "pose-evidence.json").write_text(json.dumps(evidence), encoding="utf-8")
    print(f"PromptHMR: saved {output.name}; track={evidence['track']}; frames={evidence['frames']}", flush=True)


if __name__ == "__main__":
    main()
