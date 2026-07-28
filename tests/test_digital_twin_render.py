import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "render_robot_motion",
    SCRIPTS / "render-robot-motion.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class DigitalTwinRenderTests(unittest.TestCase):
    def test_shortest_path_slerp_interpolates_rotation(self):
        identity = np.eye(3, dtype=np.float32)
        quarter_turn = np.asarray(
            ((0.0, -1.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
            dtype=np.float32,
        )
        halfway = MODULE.slerp_quaternion(
            MODULE.rotation_matrix_to_quaternion(identity),
            MODULE.rotation_matrix_to_quaternion(quarter_turn),
            0.5,
        )
        rotation = MODULE.quaternion_to_rotation_matrix(halfway)
        expected = np.sqrt(0.5)
        self.assertTrue(
            np.allclose(
                rotation,
                ((expected, -expected, 0), (expected, expected, 0), (0, 0, 1)),
                atol=1e-5,
            )
        )

    def test_mesh_pose_interpolates_translation_without_distorting_rotation(self):
        identity = np.eye(3, dtype=np.float32).reshape(-1)
        first = np.concatenate((np.asarray((0, 0, 0), dtype=np.float32), identity))
        second = np.concatenate((np.asarray((2, 4, 6), dtype=np.float32), identity))
        pose = MODULE.interpolated_mesh_pose(
            first.tolist(),
            second.tolist(),
            0.25,
            0,
            0,
        )
        self.assertTrue(np.allclose(pose[:3, 3], (0.5, 1.0, 1.5)))
        self.assertTrue(np.allclose(pose[:3, :3], np.eye(3), atol=1e-6))

    def test_aces_tone_mapping_preserves_shape_and_range(self):
        image = np.asarray([[[0, 64, 255], [32, 128, 220]]], dtype=np.uint8)
        mapped = MODULE.aces_filmic_tone_map(image)
        self.assertEqual(mapped.shape, image.shape)
        self.assertEqual(mapped.dtype, np.uint8)
        self.assertGreaterEqual(int(mapped.min()), 0)
        self.assertLessEqual(int(mapped.max()), 255)

    def test_studio_white_balance_removes_warm_cast(self):
        neutral = np.asarray([[[160, 160, 160]]], dtype=np.uint8)
        mapped = MODULE.aces_filmic_tone_map(neutral)
        red, green, blue = mapped[0, 0]
        self.assertLess(red, green)
        self.assertLess(green, blue)


if __name__ == "__main__":
    unittest.main()
