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

    def test_studio_tone_map_keeps_neutral_input_nearly_neutral(self):
        neutral = np.asarray([[[160, 160, 160]]], dtype=np.uint8)
        mapped = MODULE.aces_filmic_tone_map(neutral)
        red, green, blue = mapped[0, 0]
        self.assertLessEqual(red, green)
        self.assertLess(green, blue)
        self.assertLessEqual(int(max(red, green, blue) - min(red, green, blue)), 5)

    def test_studio_grid_is_fixed_at_world_origin_and_above_floor(self):
        floor_height = 0.125
        major, minor = MODULE.studio_grid_meshes(floor_height, 1.0)
        for mesh in (major, minor):
            center = mesh.bounds.mean(axis=0)
            self.assertAlmostEqual(float(center[0]), 0.0, places=6)
            self.assertAlmostEqual(float(center[1]), 0.0, places=6)
            self.assertGreater(float(mesh.bounds[0, 2]), floor_height)
        self.assertLess(len(major.faces), len(minor.faces))

    def test_recorded_studio_uses_browser_grid_palette_and_opacity(self):
        self.assertEqual(
            MODULE.STUDIO_GRID_SOURCE_MINOR,
            (0xD5 / 255.0, 0xDC / 255.0, 0xE6 / 255.0),
        )
        self.assertEqual(MODULE.STUDIO_GRID_OPACITY, 0.55)
        self.assertEqual(
            MODULE.STUDIO_GRID_MAJOR_COLOR[:3],
            MODULE.STUDIO_GRID_RENDER_MAJOR,
        )
        self.assertTrue(
            all(
                recorded < browser
                for recorded, browser in zip(
                    MODULE.STUDIO_GRID_RENDER_MINOR,
                    MODULE.STUDIO_GRID_SOURCE_MINOR,
                )
            )
        )

    def test_recorded_grid_has_stable_raster_width(self):
        self.assertGreaterEqual(MODULE.STUDIO_GRID_MAJOR_WIDTH_SCALE, 0.0065)
        self.assertGreaterEqual(MODULE.STUDIO_GRID_MINOR_WIDTH_SCALE, 0.0045)

    def test_studio_fog_preserves_background_and_fades_distant_geometry(self):
        image = np.asarray([[[20, 40, 60], [20, 40, 60], [20, 40, 60]]], dtype=np.uint8)
        depth = np.asarray([[0.0, 1.0, 100.0]], dtype=np.float32)
        fogged = MODULE.apply_studio_fog(image, depth, 1.0)
        self.assertTrue(np.array_equal(fogged[0, 0], image[0, 0]))
        near_distance = np.linalg.norm(
            fogged[0, 1].astype(np.float32) - MODULE.STUDIO_BACKGROUND_RGB
        )
        far_distance = np.linalg.norm(
            fogged[0, 2].astype(np.float32) - MODULE.STUDIO_BACKGROUND_RGB
        )
        self.assertLess(far_distance, near_distance)

    def test_dynamic_geometry_mask_uses_depth_instead_of_color(self):
        studio = np.asarray([[0.0, 4.0, 4.0, 4.0]], dtype=np.float32)
        current = np.asarray([[0.0, 2.0, 4.0, 4.0002]], dtype=np.float32)
        mask = MODULE.dynamic_geometry_mask(current, studio, 1.0)
        self.assertTrue(np.array_equal(mask, [[False, True, False, False]]))

    def test_dynamic_geometry_mask_rejects_mismatched_buffers(self):
        with self.assertRaisesRegex(RuntimeError, "incompatible"):
            MODULE.dynamic_geometry_mask(
                np.zeros((2, 2), dtype=np.float32),
                np.zeros((2, 3), dtype=np.float32),
                1.0,
            )

    def test_recorded_studio_uses_neutral_cool_ambient_fill(self):
        red, green, blue = MODULE.STUDIO_AMBIENT_LIGHT
        self.assertGreater(float(green), float(red))
        self.assertGreater(float(blue), float(green))


if __name__ == "__main__":
    unittest.main()
