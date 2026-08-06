from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "render-pose-skeleton.py"
SPEC = importlib.util.spec_from_file_location("render_pose_skeleton", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PoseSkeletonTimingTests(unittest.TestCase):
    def test_samples_keypoints_from_media_time(self) -> None:
        keypoints = np.zeros((2, 25, 3), dtype=np.float32)
        keypoints[0, :, :2] = (10.0, 20.0)
        keypoints[1, :, :2] = (30.0, 60.0)
        keypoints[:, :, 2] = 1.0

        sampled = MODULE.sample_keypoints(keypoints, time_seconds=0.25, tracking_fps=2.0)

        np.testing.assert_allclose(sampled[0], (20.0, 40.0, 1.0))

    def test_scales_tracking_coordinates_to_original_video(self) -> None:
        keypoints = np.array([[120.0, 240.0, 0.9]], dtype=np.float32)

        scaled = MODULE.scale_keypoints(keypoints, (270, 480), (1080, 1920))

        np.testing.assert_allclose(scaled[0], (480.0, 960.0, 0.9))
        np.testing.assert_allclose(keypoints[0], (120.0, 240.0, 0.9))


if __name__ == "__main__":
    unittest.main()
