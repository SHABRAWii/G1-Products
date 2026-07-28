from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from smplx_motion import (  # noqa: E402
    SMPLX_BODY_EDGES,
    SMPLX_BODY_JOINT_NAMES,
    SMPLX_BODY_PARENTS,
    axis_angle_to_quaternion,
    bone_geometry,
    source_to_three,
    split_prompthmr_smplx_pose,
)


class SMPLXMotionTests(unittest.TestCase):
    def test_explicit_joint_mapping_and_hierarchy(self) -> None:
        self.assertEqual(len(SMPLX_BODY_JOINT_NAMES), 22)
        self.assertEqual(SMPLX_BODY_JOINT_NAMES[0], "pelvis")
        self.assertEqual(SMPLX_BODY_JOINT_NAMES[1:3], ("left_hip", "right_hip"))
        self.assertEqual(SMPLX_BODY_PARENTS[18], 16)
        self.assertEqual(SMPLX_BODY_PARENTS[19], 17)
        self.assertIn((16, 18), SMPLX_BODY_EDGES)
        self.assertIn((17, 19), SMPLX_BODY_EDGES)

    def test_full_smplx_pose_is_split_without_joint_shift(self) -> None:
        pose = np.arange(2 * 55 * 3, dtype=np.float32).reshape(2, 55, 3)
        result = split_prompthmr_smplx_pose(pose)
        np.testing.assert_array_equal(result.global_orient, pose[:, 0])
        np.testing.assert_array_equal(result.body_pose.reshape(2, 21, 3), pose[:, 1:22])
        np.testing.assert_array_equal(result.jaw_pose, pose[:, 22])
        np.testing.assert_array_equal(result.left_hand_pose.reshape(2, 15, 3), pose[:, 25:40])
        np.testing.assert_array_equal(result.right_hand_pose.reshape(2, 15, 3), pose[:, 40:55])

    def test_axis_angle_is_converted_to_quaternion_in_radians(self) -> None:
        quaternion = axis_angle_to_quaternion(np.asarray((0.0, 0.0, np.pi), dtype=np.float32))
        np.testing.assert_allclose(quaternion, (0.0, 0.0, 1.0, 0.0), atol=1e-6)

    def test_coordinate_conversion_is_right_handed_and_not_mirrored(self) -> None:
        basis = source_to_three(np.eye(3, dtype=np.float32))
        np.testing.assert_allclose(basis, ((1, 0, 0), (0, 0, -1), (0, 1, 0)))
        self.assertAlmostEqual(float(np.linalg.det(basis)), 1.0, places=6)

    def test_bone_geometry_uses_midpoint_direction_and_length(self) -> None:
        midpoint, direction, length = bone_geometry(
            np.asarray((1.0, 2.0, 3.0)),
            np.asarray((1.0, 4.0, 3.0)),
        )
        np.testing.assert_allclose(midpoint, (1.0, 3.0, 3.0))
        np.testing.assert_allclose(direction, (0.0, 1.0, 0.0))
        self.assertAlmostEqual(length, 2.0)


if __name__ == "__main__":
    unittest.main()
