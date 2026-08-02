from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "run_motion_stage",
    ROOT / "scripts" / "run-motion-stage.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class StageContractTests(unittest.TestCase):
    def test_training_log_is_parsed_and_best_saved_checkpoint_is_selected(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / "training.log"
            log.write_text(
                "\n".join(
                    [
                        "Learning iteration 0/3",
                        "Mean reward: -2.0",
                        "Episode_Termination/anchor_pos: 5.0",
                        "Learning iteration 1/3",
                        "Mean reward: -0.5",
                        "Learning iteration 2/3",
                        "Mean reward: -1.0",
                    ]
                )
            )
            for iteration in range(3):
                (root / f"model_{iteration}.pt").write_bytes(b"checkpoint")
            metrics = MODULE.parse_training_log(log)
            checkpoint, iteration, reward = MODULE.best_saved_checkpoint(root, metrics)
            self.assertEqual(checkpoint.name, "model_1.pt")
            self.assertEqual(iteration, 1)
            self.assertEqual(reward, -0.5)

    def test_retargeting_builds_scene_without_duplicate_mp4(self):
        outputs = MODULE.retargeting_outputs(
            Path("robot_motion.npz"),
            Path("unitree_g1_scene.json"),
        )
        self.assertEqual([item["role"] for item in outputs], ["OUTPUT", "EVIDENCE"])
        self.assertFalse(any(item["contentType"] == "video/mp4" for item in outputs))

    def test_visualization_passes_motion_to_training_without_blocking_on_mp4(self):
        outputs = MODULE.visualization_outputs(
            Path("robot_motion.npz"),
            Path("unitree_g1_scene.json"),
        )
        pipeline_outputs = [item for item in outputs if item["role"] == "OUTPUT"]
        self.assertEqual(len(pipeline_outputs), 1)
        self.assertEqual(
            pipeline_outputs[0]["schemaVersion"],
            "motion.robot.unitree-g1-29dof-npz/v2",
        )
        self.assertFalse(any(item["contentType"] == "video/mp4" for item in outputs))
        scene = next(item for item in outputs if item["contentType"] == "application/json")
        self.assertEqual(scene["role"], "EVIDENCE")


if __name__ == "__main__":
    unittest.main()
