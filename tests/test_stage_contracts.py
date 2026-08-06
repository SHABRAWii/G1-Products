from __future__ import annotations

import importlib.util
import os
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "run_motion_stage",
    ROOT / "scripts" / "run-motion-stage.py",
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class StageContractTests(unittest.TestCase):
    def test_training_commands_receive_the_conda_cpp_runtime_only(self):
        args = Namespace(training_python="/workspace/conda-envs/unitree_rl_mjlab/bin/python")
        with patch.dict(os.environ, {"LD_LIBRARY_PATH": "/usr/local/cuda/lib64"}, clear=False):
            environment = MODULE.training_runtime_environment(args)
        self.assertEqual(
            environment["LD_LIBRARY_PATH"],
            "/workspace/conda-envs/unitree_rl_mjlab/lib:/usr/local/cuda/lib64",
        )

    def test_runpod_runtime_contract_uses_cuda_12_6_and_ipv4_tunnels(self):
        dockerfile = (ROOT / "deploy" / "Dockerfile.gpu-worker").read_text()
        startup = (ROOT / "deploy" / "start-runpod-gpu-plane.sh").read_text()
        installer = (ROOT / "deploy" / "install-direct-models.sh").read_text()
        local_worker = (ROOT / "scripts" / "start-local-worker.sh").read_text()
        self.assertIn("nvidia/cuda:12.6.3-runtime-ubuntu22.04", dockerfile)
        self.assertIn("https://download.pytorch.org/whl/cu126", installer)
        self.assertNotIn("https://download.pytorch.org/whl/cu130", installer)
        for port in (15432, 19000, 13000):
            self.assertIn(f"-L 127.0.0.1:{port}:127.0.0.1:", startup)
        self.assertIn("libstdcxx-ng>=14", installer)
        self.assertIn("robomotion_training_cpp_runtime_ready", installer)
        self.assertIn("robomotion_configure_training_runtime", local_worker)

    def test_runpod_warm_start_uses_a_versioned_runtime_marker(self):
        bootstrap = (ROOT / "deploy" / "bootstrap-models.sh").read_text()
        startup = (ROOT / "deploy" / "start-runpod-gpu-plane.sh").read_text()
        worker = (ROOT / "deploy" / "start-gpu-worker.sh").read_text()
        self.assertIn(".gpu-runtime-contract-v1.sha256", bootstrap)
        self.assertIn("ROBOMOTION_FORCE_MODEL_VERIFY", bootstrap)
        self.assertIn("runtime_files_present", bootstrap)
        self.assertIn("ROBOMOTION_RUNTIME_VERIFIED=1", startup)
        self.assertIn("ROBOMOTION_RUNTIME_VERIFIED", worker)

    def test_training_cli_uses_unbuffered_python_and_tyro_boolean_spelling(self):
        args = Namespace(training_python="/workspace/conda-envs/unitree_rl_mjlab/bin/python")
        command = MODULE.training_python(args, Path("train.py"), ["--video=True"])
        self.assertEqual(command[:2], [args.training_python, "-u"])
        self.assertIn("--video=True", command)
        source = (ROOT / "scripts" / "run-motion-stage.py").read_text()
        self.assertNotIn('"--video=true"', source)

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
