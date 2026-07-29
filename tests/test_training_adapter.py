from __future__ import annotations

import pickle
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from g1_motion import G1_29_DOF_JOINTS  # noqa: E402
from robomotion_training_adapter import load_motion, motion_to_rows  # noqa: E402


def make_motion(frames=2, joint_names=G1_29_DOF_JOINTS, dof_width=None):
    width = dof_width if dof_width is not None else len(G1_29_DOF_JOINTS)
    motion = {
        "fps": 30.0,
        "robot_type": "unitree_g1",
        "root_pos": np.arange(frames * 3, dtype=np.float32).reshape(frames, 3),
        "root_rot": np.arange(frames * 4, dtype=np.float32).reshape(frames, 4),
        "dof_pos": np.arange(frames * width, dtype=np.float32).reshape(frames, width),
    }
    if joint_names is not None:
        motion["joint_names"] = list(joint_names)
    return motion


class TrainingAdapterTests(unittest.TestCase):
    def test_valid_motion_concatenates_columns_in_order(self):
        motion = make_motion()
        rows = motion_to_rows(motion)
        self.assertEqual(rows.shape, (2, 36))
        np.testing.assert_array_equal(rows[:, :3], motion["root_pos"])
        np.testing.assert_array_equal(rows[:, 3:7], motion["root_rot"])
        np.testing.assert_array_equal(rows[:, 7:], motion["dof_pos"])

    def test_missing_joint_names_warns_but_does_not_raise(self):
        motion = make_motion(joint_names=None)
        rows = motion_to_rows(motion)
        self.assertEqual(rows.shape, (2, 36))

    def test_mismatched_joint_order_raises(self):
        shuffled = list(G1_29_DOF_JOINTS)
        shuffled[0], shuffled[1] = shuffled[1], shuffled[0]
        motion = make_motion(joint_names=shuffled)
        with self.assertRaises(ValueError):
            motion_to_rows(motion)

    def test_wrong_root_pos_width_raises(self):
        motion = make_motion()
        motion["root_pos"] = motion["root_pos"][:, :2]
        with self.assertRaises(ValueError):
            motion_to_rows(motion)

    def test_wrong_dof_pos_width_raises(self):
        motion = make_motion(dof_width=len(G1_29_DOF_JOINTS) - 1)
        with self.assertRaises(ValueError):
            motion_to_rows(motion)

    def test_load_motion_reports_missing_fields(self):
        with tempfile.NamedTemporaryFile(suffix=".pkl") as handle:
            pickle.dump({"fps": 30.0}, handle)
            handle.flush()
            with self.assertRaises(ValueError) as context:
                load_motion(Path(handle.name))
        self.assertIn("root_pos", str(context.exception))


if __name__ == "__main__":
    unittest.main()
