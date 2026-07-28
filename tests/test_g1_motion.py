import os
import importlib.util
import json
import pickle
import sys
import tempfile
import unittest
from pathlib import Path

import mujoco
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from g1_motion import (  # noqa: E402
    G1_29_DOF_JOINTS,
    analyze_qpos,
    contact_aware_grounding,
    joint_names,
    load_g1_model,
    validate_qpos,
)


class G1MotionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        gmr_root = Path(
            os.environ.get("ROBOMOTION_GMR_ROOT", ROOT / ".robomotion" / "sources" / "GMR")
        )
        cls.model = load_g1_model(
            gmr_root / "assets" / "unitree_g1" / "g1_mocap_29dof.xml"
        )

    def standing(self, frames=1):
        return np.repeat(np.asarray(self.model.qpos0)[None], frames, axis=0)

    def test_qpos_dimension_and_explicit_joint_order(self):
        qpos = validate_qpos(self.model, self.standing())
        self.assertEqual(qpos.shape, (1, 36))
        self.assertEqual(joint_names(self.model), G1_29_DOF_JOINTS)

    def test_mujoco_free_joint_quaternion_is_wxyz(self):
        qpos = self.standing()
        angle = np.pi / 2
        qpos[0, 3:7] = (np.cos(angle / 2), 0, 0, np.sin(angle / 2))
        data = mujoco.MjData(self.model)
        data.qpos[:] = qpos[0]
        mujoco.mj_forward(self.model, data)
        pelvis = mujoco.mj_name2id(
            self.model, mujoco.mjtObj.mjOBJ_BODY, "pelvis"
        )
        np.testing.assert_allclose(
            data.xquat[pelvis],
            qpos[0, 3:7],
            atol=1e-7,
        )

    def test_static_standing_pose_is_on_the_official_floor(self):
        report = analyze_qpos(self.model, self.standing(), 30)
        self.assertEqual(report["floorHeight"], 0.0)
        self.assertLessEqual(report["summary"]["maximumPenetration"], 1e-8)
        frame = report["frames"][0]
        self.assertGreaterEqual(frame["leftSoleHeight"], -1e-8)
        self.assertGreaterEqual(frame["rightSoleHeight"], -1e-8)
        self.assertAlmostEqual(frame["rootPosition"][2], 0.793, places=6)

    def test_one_leg_stance_keeps_support_foot_on_floor(self):
        qpos = self.standing()
        qpos[0, 13] = -0.55  # right hip pitch
        qpos[0, 16] = 1.1  # right knee
        report = analyze_qpos(self.model, qpos, 30)
        frame = report["frames"][0]
        self.assertGreaterEqual(frame["leftSoleHeight"], -1e-8)
        self.assertGreater(frame["rightSoleHeight"], frame["leftSoleHeight"])

    def test_contact_aware_grounding_removes_penetration_smoothly(self):
        qpos = self.standing(24)
        qpos[:, 2] -= 0.03
        corrected, before, after, correction = contact_aware_grounding(
            self.model, qpos, 30
        )
        self.assertGreater(before["summary"]["maximumPenetration"], 0.02)
        self.assertLess(after["summary"]["maximumPenetration"], 5e-5)
        self.assertEqual(after["summary"]["framesOver5mm"], [])
        self.assertLess(np.max(np.abs(np.diff(correction))), 0.005)
        self.assertLess(np.max(np.abs(np.diff(corrected[:, 2], n=2))), 0.005)

    def test_visual_and_collision_soles_use_consistent_model_geometry(self):
        frame = analyze_qpos(self.model, self.standing(), 30)["frames"][0]
        self.assertLess(
            abs(frame["leftVisualHeight"] - frame["leftSoleHeight"]),
            0.02,
        )
        self.assertLess(
            abs(frame["rightVisualHeight"] - frame["rightSoleHeight"]),
            0.02,
        )

    def test_serialized_browser_fk_matches_mujoco_fk_and_floor(self):
        spec = importlib.util.spec_from_file_location(
            "render_robot_motion", ROOT / "scripts" / "render-robot-motion.py"
        )
        renderer = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(renderer)
        qpos = self.standing(2)
        motion = {
            "fps": 30.0,
            "robot_type": "unitree_g1",
            "num_frames": 2,
            "root_pos": qpos[:, :3].astype(np.float32),
            "root_rot": qpos[:, [4, 5, 6, 3]].astype(np.float32),
            "dof_pos": qpos[:, 7:].astype(np.float32),
            "local_body_pos": np.zeros((2, 38, 3), dtype=np.float32),
            "link_body_list": [],
            "ground_diagnostics": {
                "groundingMethod": "test-standing-pose",
            },
            "qpos_layout": "root_xyz-root_quaternion_xyzw-29_hinge_radians",
        }
        data = mujoco.MjData(self.model)
        data.qpos[:] = qpos[0]
        mujoco.mj_forward(self.model, data)
        mesh_geoms = [
            geom
            for geom in range(self.model.ngeom)
            if int(self.model.geom_type[geom]) == int(mujoco.mjtGeom.mjGEOM_MESH)
            and int(self.model.geom_group[geom]) == 1
        ]
        with tempfile.TemporaryDirectory() as directory:
            motion_path = Path(directory) / "motion.pkl"
            scene_path = Path(directory) / "scene.json"
            with motion_path.open("wb") as file:
                pickle.dump(motion, file)
            renderer.write_scene(motion_path, "unitree_g1", str(scene_path))
            scene = json.loads(scene_path.read_text())
        self.assertEqual(scene["floorHeight"], 0.0)
        self.assertEqual(scene["diagnostics"]["qposLayout"], "xyz-wxyz-joints")
        self.assertEqual(scene["diagnostics"]["quaternionOrder"], "wxyz")
        np.testing.assert_allclose(scene["frames"][0], data.xpos[1:], atol=1e-5)
        for serialized, geom in zip(scene["robotMeshFrames"][0], mesh_geoms):
            expected = np.concatenate((data.geom_xpos[geom], data.geom_xmat[geom]))
            np.testing.assert_allclose(serialized, expected, atol=1e-6)

    def test_rejects_joint_limit_violations_and_invalid_values(self):
        invalid = self.standing()
        invalid[0, 7] = 20
        with self.assertRaisesRegex(ValueError, "left_hip_pitch_joint"):
            validate_qpos(self.model, invalid)
        invalid = self.standing()
        invalid[0, 0] = np.nan
        with self.assertRaisesRegex(ValueError, "NaN or Infinity"):
            validate_qpos(self.model, invalid)


if __name__ == "__main__":
    unittest.main()
