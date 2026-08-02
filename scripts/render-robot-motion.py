#!/usr/bin/env python3
"""Build the Unitree G1 digital-twin scene and its browser-safe MP4 evidence."""

from __future__ import annotations

import argparse
import json
import os
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np

from g1_motion import analyze_qpos, load_robot_motion, validate_qpos

# G1 link indices from the motion artifact written by robomotion_gmr_adapter.
KINEMATIC_CHAINS = (
    ((0, 1, 2, 3, 4, 5, 6, 7), (255, 168, 64)),
    ((0, 9, 10, 11, 12, 13, 14, 15), (86, 142, 255)),
    ((0, 16, 17, 18, 19), (206, 95, 255)),
    ((18, 22, 23, 24, 25, 26, 27, 28, 29), (89, 219, 151)),
    ((18, 30, 31, 32, 33, 34, 35, 36, 37), (80, 210, 245)),
)

# Keep the recorded evidence palette tied to Motion3DViewer's studio instead of
# allowing the off-screen renderer to invent a second visual environment.
STUDIO_BACKGROUND_RGB = np.asarray((0xF7, 0xF9, 0xFC), dtype=np.uint8)
STUDIO_FLOOR_COLOR = (0xF4 / 255.0, 0xF6 / 255.0, 0xF9 / 255.0, 1.0)
# Pyrender has no hemisphere light, so a restrained neutral-cool ambient fill
# complements the two studio directionals without flattening the G1 surfaces.
STUDIO_AMBIENT_LIGHT = np.asarray((0.24, 0.26, 0.30), dtype=np.float32)
STUDIO_GRID_OPACITY = 0.55
STUDIO_FOG_DENSITY = 0.035
# GridHelper uses unlit lines. The off-screen renderer therefore supplies these
# through the material's emissive channel. The narrow rasterized strips receive
# edge antialiasing during the 1440p-to-1080p resolve, reproducing GridHelper's
# translucent visual weight without washing the lines into the light floor.
STUDIO_GRID_SOURCE_MAJOR = (0x9E / 255.0, 0xAC / 255.0, 0xBD / 255.0)
STUDIO_GRID_SOURCE_MINOR = (0xD5 / 255.0, 0xDC / 255.0, 0xE6 / 255.0)
# Three.js blends its one-pixel GridHelper after tone mapping. Pyrender instead
# resolves the emissive grid into its LDR framebuffer before our display pass.
# These recording colors compensate for that ordering difference so the final
# encoded lines retain the browser grid's contrast rather than fading into the
# floor. They are presentation-level equivalents, not a different environment.
STUDIO_GRID_RENDER_MAJOR = (0x7D / 255.0, 0x91 / 255.0, 0xAA / 255.0)
STUDIO_GRID_RENDER_MINOR = (0xB4 / 255.0, 0xBE / 255.0, 0xCD / 255.0)
STUDIO_GRID_MAJOR_COLOR = STUDIO_GRID_RENDER_MAJOR + (1.0,)
STUDIO_GRID_MINOR_COLOR = STUDIO_GRID_RENDER_MINOR + (1.0,)
STUDIO_GRID_MINOR_WIDTH_SCALE = 0.0045
STUDIO_GRID_MAJOR_WIDTH_SCALE = 0.0065

def load_robot_model(xml_path: Path):
    """Load the official G1 kinematic model used for FK and validation."""
    import mujoco

    return mujoco.MjModel.from_xml_path(str(xml_path))


def robot_xml_path(robot: str) -> Path:
    root = Path(os.environ.get("ROBOMOTION_GMR_ROOT", "")).expanduser().resolve()
    xml_by_robot = {
        "unitree_g1": root / "assets" / "unitree_g1" / "g1_mocap_29dof.xml",
        "unitree_g1_with_hands": root / "assets" / "unitree_g1" / "g1_mocap_29dof_with_hands.xml",
    }
    xml_path = xml_by_robot.get(robot)
    if not xml_path or not xml_path.exists():
        raise RuntimeError(f"No official Unitree G1 model is available for {robot} at {xml_path}.")
    return xml_path


def web_mesh_cache() -> Path:
    configured = os.environ.get("ROBOMOTION_MODEL_CACHE")
    if configured:
        return Path(configured).expanduser().resolve() / "unitree-g1-web"
    gmr_root = Path(os.environ.get("ROBOMOTION_GMR_ROOT", "")).expanduser().resolve()
    return gmr_root.parent.parent / "cache" / "unitree-g1-web"


def write_binary_stl(path: Path, vertices: np.ndarray, faces: np.ndarray) -> None:
    triangles = np.asarray(vertices[faces], dtype="<f4")
    edges_a = triangles[:, 1] - triangles[:, 0]
    edges_b = triangles[:, 2] - triangles[:, 0]
    normals = np.cross(edges_a, edges_b)
    lengths = np.linalg.norm(normals, axis=1, keepdims=True)
    normals = np.divide(normals, lengths, out=np.zeros_like(normals), where=lengths > 1e-12)
    records = np.zeros(
        len(triangles),
        dtype=np.dtype(
            [
                ("normal", "<f4", (3,)),
                ("vertices", "<f4", (3, 3)),
                ("attribute", "<u2"),
            ]
        ),
    )
    records["normal"] = normals
    records["vertices"] = triangles
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as file:
        file.write(b"RoboMotion compiled Unitree G1 mesh".ljust(80, b"\0"))
        file.write(struct.pack("<I", len(triangles)))
        file.write(records.tobytes())


def ensure_web_mesh(model, mesh_id: int, mesh_name: str) -> str:
    filename = f"{mesh_name}.compiled.stl"
    destination = web_mesh_cache() / filename
    if destination.exists() and destination.stat().st_size > 84:
        return filename
    vertex_start = int(model.mesh_vertadr[mesh_id])
    vertex_count = int(model.mesh_vertnum[mesh_id])
    face_start = int(model.mesh_faceadr[mesh_id])
    face_count = int(model.mesh_facenum[mesh_id])
    vertices = np.asarray(
        model.mesh_vert[vertex_start : vertex_start + vertex_count],
        dtype=np.float32,
    )
    faces = np.asarray(
        model.mesh_face[face_start : face_start + face_count],
        dtype=np.int32,
    )
    write_binary_stl(destination, vertices, faces)
    return filename


def normalize(vector: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(vector))
    if not np.isfinite(length) or length < 1e-8:
        raise RuntimeError("The digital-twin camera received an invalid direction.")
    return vector / length


def camera_basis(
    eye: np.ndarray,
    target: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    forward = normalize(target - eye)
    right = normalize(np.cross(forward, np.asarray((0.0, 0.0, 1.0), dtype=np.float32)))
    up = normalize(np.cross(right, forward))
    return eye, right, up, forward


def camera_pose(eye: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Return the OpenGL camera transform matching the browser studio view."""
    eye, right, up, forward = camera_basis(eye, target)
    pose = np.eye(4, dtype=np.float32)
    pose[:3, 0] = right
    pose[:3, 1] = up
    pose[:3, 2] = -forward
    pose[:3, 3] = eye
    return pose


def browser_studio_bounds(
    body_frames: list[list[list[float]]],
) -> tuple[np.ndarray, np.ndarray, float]:
    """Reproduce Motion3DViewer's bounds-based camera in MuJoCo Z-up space."""
    minimum = np.full(3, np.inf, dtype=np.float32)
    maximum = np.full(3, -np.inf, dtype=np.float32)
    body_extents = []
    for frame_index, frame_values in enumerate(body_frames):
        frame = np.asarray(frame_values, dtype=np.float32)
        if frame.ndim != 2 or frame.shape[1] != 3 or not np.all(np.isfinite(frame)):
            raise RuntimeError(f"Malformed robot body positions at frame {frame_index}.")
        minimum = np.minimum(minimum, np.min(frame, axis=0))
        maximum = np.maximum(maximum, np.max(frame, axis=0))
        body_extents.append(float(np.max(np.linalg.norm(frame - frame[0], axis=1))))
    body_scale = max(float(np.median(body_extents)), 0.65)
    center = np.asarray(
        (
            (minimum[0] + maximum[0]) * 0.5,
            (minimum[1] + maximum[1]) * 0.5,
            minimum[2],
        ),
        dtype=np.float32,
    )
    target = center.copy()
    target[2] = minimum[2] + body_scale * 0.65
    # Three.js studio offset is (+2.4, +1.5, +2.8) in Y-up space.
    # Its inverse basis in MuJoCo Z-up is (+2.4, -2.8, +1.5).
    eye = target + np.asarray(
        (body_scale * 2.4, body_scale * -2.8, body_scale * 1.5),
        dtype=np.float32,
    )
    return eye, target, body_scale


def mesh_pose(values: list[float] | np.ndarray, frame_index: int, part_index: int) -> np.ndarray:
    """Convert the serialized MuJoCo mesh transform into a renderer pose."""
    transform = np.asarray(values, dtype=np.float32)
    if transform.shape != (12,) or not np.all(np.isfinite(transform)):
        raise RuntimeError(
            f"Malformed robot mesh transform at frame {frame_index}, part {part_index}."
        )
    pose = np.eye(4, dtype=np.float32)
    pose[:3, 3] = transform[:3]
    pose[:3, :3] = transform[3:].reshape(3, 3)
    return pose


def rotation_matrix_to_quaternion(matrix: np.ndarray) -> np.ndarray:
    """Convert a proper 3×3 rotation matrix to normalized `(x, y, z, w)`."""
    rotation = np.asarray(matrix, dtype=np.float64)
    if rotation.shape != (3, 3) or not np.all(np.isfinite(rotation)):
        raise RuntimeError("Cannot interpolate a malformed robot rotation matrix.")
    trace = float(np.trace(rotation))
    if trace > 0:
        scale = np.sqrt(trace + 1.0) * 2.0
        quaternion = np.asarray(
            (
                (rotation[2, 1] - rotation[1, 2]) / scale,
                (rotation[0, 2] - rotation[2, 0]) / scale,
                (rotation[1, 0] - rotation[0, 1]) / scale,
                0.25 * scale,
            )
        )
    else:
        diagonal = int(np.argmax(np.diag(rotation)))
        if diagonal == 0:
            scale = np.sqrt(1.0 + rotation[0, 0] - rotation[1, 1] - rotation[2, 2]) * 2.0
            quaternion = np.asarray(
                (
                    0.25 * scale,
                    (rotation[0, 1] + rotation[1, 0]) / scale,
                    (rotation[0, 2] + rotation[2, 0]) / scale,
                    (rotation[2, 1] - rotation[1, 2]) / scale,
                )
            )
        elif diagonal == 1:
            scale = np.sqrt(1.0 + rotation[1, 1] - rotation[0, 0] - rotation[2, 2]) * 2.0
            quaternion = np.asarray(
                (
                    (rotation[0, 1] + rotation[1, 0]) / scale,
                    0.25 * scale,
                    (rotation[1, 2] + rotation[2, 1]) / scale,
                    (rotation[0, 2] - rotation[2, 0]) / scale,
                )
            )
        else:
            scale = np.sqrt(1.0 + rotation[2, 2] - rotation[0, 0] - rotation[1, 1]) * 2.0
            quaternion = np.asarray(
                (
                    (rotation[0, 2] + rotation[2, 0]) / scale,
                    (rotation[1, 2] + rotation[2, 1]) / scale,
                    0.25 * scale,
                    (rotation[1, 0] - rotation[0, 1]) / scale,
                )
            )
    length = float(np.linalg.norm(quaternion))
    if not np.isfinite(length) or length < 1e-8:
        raise RuntimeError("Cannot interpolate a zero-length robot quaternion.")
    return np.asarray(quaternion / length, dtype=np.float32)


def quaternion_to_rotation_matrix(quaternion: np.ndarray) -> np.ndarray:
    x, y, z, w = normalize(np.asarray(quaternion, dtype=np.float64))
    return np.asarray(
        (
            (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
            (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
            (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
        ),
        dtype=np.float32,
    )


def slerp_quaternion(first: np.ndarray, second: np.ndarray, alpha: float) -> np.ndarray:
    """Shortest-path quaternion interpolation matching Three.js Quaternion.slerp."""
    start = normalize(np.asarray(first, dtype=np.float64))
    end = normalize(np.asarray(second, dtype=np.float64))
    dot = float(np.dot(start, end))
    if dot < 0:
        end = -end
        dot = -dot
    dot = float(np.clip(dot, -1.0, 1.0))
    if dot > 0.9995:
        return np.asarray(normalize(start + (end - start) * alpha), dtype=np.float32)
    angle = np.arccos(dot)
    sine = np.sin(angle)
    return np.asarray(
        start * (np.sin((1.0 - alpha) * angle) / sine)
        + end * (np.sin(alpha * angle) / sine),
        dtype=np.float32,
    )


def interpolated_mesh_pose(
    first_values: list[float],
    second_values: list[float],
    alpha: float,
    frame_index: int,
    part_index: int,
) -> np.ndarray:
    first = mesh_pose(first_values, frame_index, part_index)
    second = mesh_pose(second_values, frame_index + 1, part_index)
    pose = np.eye(4, dtype=np.float32)
    pose[:3, 3] = first[:3, 3] + (second[:3, 3] - first[:3, 3]) * alpha
    first_rotation = rotation_matrix_to_quaternion(first[:3, :3])
    second_rotation = rotation_matrix_to_quaternion(second[:3, :3])
    pose[:3, :3] = quaternion_to_rotation_matrix(
        slerp_quaternion(first_rotation, second_rotation, alpha)
    )
    return pose


def aces_filmic_tone_map(
    rgb: np.ndarray,
    exposure: float = 1.08,
    display_gamma: float = 0.64,
    white_balance: tuple[float, float, float] = (1.0, 1.0, 1.025),
) -> np.ndarray:
    """Map pyrender's clamped LDR output into the browser's ACES display range.

    Unlike Three.js, pyrender resolves its framebuffer to 8-bit sRGB before this
    function receives it, so the original HDR lighting values are unavailable.
    The display gamma restores the highlight range that Three.js retains until
    its final output pass.
    """
    encoded = np.asarray(rgb, dtype=np.float32) / 255.0
    linear = np.where(
        encoded <= 0.04045,
        encoded / 12.92,
        np.power((encoded + 0.055) / 1.055, 2.4),
    )
    linear *= exposure
    mapped = np.clip(
        (linear * (2.51 * linear + 0.03))
        / (linear * (2.43 * linear + 0.59) + 0.14),
        0.0,
        1.0,
    )
    srgb = np.where(
        mapped <= 0.0031308,
        mapped * 12.92,
        1.055 * np.power(mapped, 1.0 / 2.4) - 0.055,
    )
    srgb *= np.asarray(white_balance, dtype=np.float32)
    srgb = np.power(np.clip(srgb, 0.0, 1.0), float(display_gamma))
    return np.asarray(np.clip(srgb * 255.0, 0, 255), dtype=np.uint8)


def apply_studio_fog(
    rgb: np.ndarray,
    depth: np.ndarray,
    body_scale: float,
) -> np.ndarray:
    """Apply the browser's FogExp2 falloff to rendered scene pixels."""
    image = np.asarray(rgb, dtype=np.float32)
    distances = np.asarray(depth, dtype=np.float32)
    if image.ndim != 3 or image.shape[2] != 3 or distances.shape != image.shape[:2]:
        raise RuntimeError("The digital-twin fog pass received incompatible image buffers.")
    density = STUDIO_FOG_DENSITY / max(float(body_scale), 1e-6)
    fog = np.zeros_like(distances, dtype=np.float32)
    rendered = distances > 0
    fog[rendered] = 1.0 - np.exp(-np.square(density * distances[rendered]))
    fog = np.clip(fog, 0.0, 1.0)[..., None]
    background = STUDIO_BACKGROUND_RGB.astype(np.float32)
    mixed = image * (1.0 - fog) + background * fog
    return np.asarray(np.clip(mixed, 0, 255), dtype=np.uint8)


def dynamic_geometry_mask(
    depth: np.ndarray,
    studio_depth: np.ndarray,
    body_scale: float,
) -> np.ndarray:
    """Identify geometry in front of the static studio using camera-space depth."""
    current = np.asarray(depth, dtype=np.float32)
    studio = np.asarray(studio_depth, dtype=np.float32)
    if current.shape != studio.shape or current.ndim != 2:
        raise RuntimeError("The digital-twin depth buffers have incompatible dimensions.")
    tolerance = max(float(body_scale) * 1e-4, 1e-5)
    rendered = current > 0
    no_studio_surface = studio <= 0
    closer_than_studio = current < studio - tolerance
    return rendered & (no_studio_surface | closer_than_studio)


def studio_grid_meshes(floor_height: float, body_scale: float):
    """Build Three.js GridHelper-equivalent center and minor line meshes."""
    import trimesh

    extent = body_scale * 6.0
    # GridHelper lines retain a one-pixel screen width regardless of distance.
    # Physical strip geometry does not, so a slightly wider world-space strip
    # is required to survive the high-resolution antialias/downsample pass.
    minor_thickness = max(body_scale * STUDIO_GRID_MINOR_WIDTH_SCALE, 0.0028)
    major_thickness = max(body_scale * STUDIO_GRID_MAJOR_WIDTH_SCALE, 0.0042)
    height = max(body_scale * 0.0006, 0.0004)
    line_center_z = floor_height + 0.002 + height * 0.5
    major_strips = []
    minor_strips = []
    for index, offset in enumerate(np.linspace(-extent, extent, 37)):
        is_center = index == 18
        thickness = major_thickness if is_center else minor_thickness
        destination = major_strips if is_center else minor_strips
        horizontal = trimesh.creation.box((extent * 2, thickness, height))
        horizontal.apply_translation(
            (0.0, float(offset), line_center_z)
        )
        destination.append(horizontal)
        vertical = trimesh.creation.box((thickness, extent * 2, height))
        vertical.apply_translation(
            (float(offset), 0.0, line_center_z)
        )
        destination.append(vertical)
    return (
        trimesh.util.concatenate(major_strips),
        trimesh.util.concatenate(minor_strips),
    )


def render_digital_twin_preview(scene: dict, output_path: Path) -> int:
    """Render exact official G1 STL surfaces from the browser scene transforms."""
    os.environ.setdefault("PYOPENGL_PLATFORM", "egl")
    # pyrender 0.1.45 still references NumPy's removed `infty` alias.
    # Keep the compatibility local to this renderer without downgrading GMR's NumPy.
    if not hasattr(np, "infty"):
        setattr(np, "infty", np.inf)
    try:
        import pyrender
        import trimesh
    except ImportError as error:
        raise RuntimeError(
            "The exact digital-twin renderer is unavailable. Run "
            "deploy/install-direct-models.sh to install pyrender and trimesh."
        ) from error

    mesh_metadata = scene.get("robotMeshes")
    mesh_frames = scene.get("robotMeshFrames")
    body_frames = scene.get("frames")
    if not isinstance(mesh_metadata, list) or not mesh_metadata:
        raise RuntimeError("The digital-twin scene does not contain Unitree G1 meshes.")
    if not isinstance(mesh_frames, list) or not mesh_frames:
        raise RuntimeError("The digital-twin scene does not contain robot mesh transforms.")
    if len(mesh_frames) != len(body_frames):
        raise RuntimeError("Robot mesh frames and motion frames have different lengths.")

    motion_fps = float(scene.get("fps", 30.0))
    output_fps = float(os.environ.get("ROBOMOTION_DIGITAL_TWIN_FPS", "60"))
    if not np.isfinite(motion_fps) or motion_fps <= 0:
        raise RuntimeError("The digital-twin motion FPS must be positive.")
    if not np.isfinite(output_fps) or output_fps < motion_fps or output_fps > 120:
        raise RuntimeError(
            "ROBOMOTION_DIGITAL_TWIN_FPS must be between the motion FPS and 120."
        )
    duration = len(mesh_frames) / motion_fps
    output_frame_count = max(1, int(round(duration * output_fps)))
    floor_height = float(scene.get("floorHeight", 0.0))
    render_height, render_width = 1440, 2560
    output_height, output_width = 1080, 1920
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoder = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgr24",
            "-s",
            f"{output_width}x{output_height}",
            "-r",
            f"{output_fps:.8g}",
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "16",
            "-pix_fmt",
            "yuv420p",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-movflags",
            "+faststart",
            str(output_path),
        ],
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if encoder.stdin is None:
        raise RuntimeError("Unable to open the high-quality digital-twin encoder.")

    trajectory = np.asarray([frame[0] for frame in body_frames], dtype=np.float32)
    if trajectory.ndim != 2 or trajectory.shape[1] != 3 or not np.all(np.isfinite(trajectory)):
        raise RuntimeError("The robot trajectory is malformed.")
    camera_eye, camera_target, body_scale = browser_studio_bounds(body_frames)

    digital_scene = pyrender.Scene(
        bg_color=np.append(STUDIO_BACKGROUND_RGB, 255),
        ambient_light=STUDIO_AMBIENT_LIGHT,
    )
    robot_nodes = []
    for part_index, part in enumerate(mesh_metadata):
        mesh_path = web_mesh_cache() / part["file"]
        if not mesh_path.exists():
            raise RuntimeError(f"Unitree G1 mesh is missing: {mesh_path}.")
        source_mesh = trimesh.load_mesh(mesh_path, process=False)
        if not isinstance(source_mesh, trimesh.Trimesh):
            raise RuntimeError(f"Unitree G1 mesh did not load as one triangle mesh: {mesh_path}.")
        red, green, blue, alpha = part.get("color", (0.82, 0.85, 0.9, 1))
        material = pyrender.MetallicRoughnessMaterial(
            baseColorFactor=(float(red), float(green), float(blue), float(alpha)),
            metallicFactor=0.48,
            roughnessFactor=0.34,
            alphaMode="BLEND" if float(alpha) < 1 else "OPAQUE",
        )
        rendered_mesh = pyrender.Mesh.from_trimesh(
            source_mesh,
            material=material,
            smooth=True,
        )
        node = digital_scene.add(
            rendered_mesh,
            pose=mesh_pose(mesh_frames[0][part_index], 0, part_index),
        )
        robot_nodes.append(node)

    floor_extent = body_scale * 16.0
    floor_thickness = 0.02
    floor_mesh = trimesh.creation.box((floor_extent, floor_extent, floor_thickness))
    # Motion3DViewer's floor is fixed at the MuJoCo world origin. The box top,
    # rather than its center, is the physical floor height.
    floor_mesh.apply_translation((0.0, 0.0, floor_height - floor_thickness * 0.5))
    floor_material = pyrender.MetallicRoughnessMaterial(
        baseColorFactor=STUDIO_FLOOR_COLOR,
        metallicFactor=0.03,
        roughnessFactor=0.88,
    )
    digital_scene.add(
        pyrender.Mesh.from_trimesh(floor_mesh, material=floor_material, smooth=False)
    )

    major_grid, minor_grid = studio_grid_meshes(floor_height, body_scale)
    for grid_mesh, color in (
        (minor_grid, STUDIO_GRID_MINOR_COLOR),
        (major_grid, STUDIO_GRID_MAJOR_COLOR),
    ):
        grid_material = pyrender.MetallicRoughnessMaterial(
            baseColorFactor=(0.0, 0.0, 0.0, 1.0),
            emissiveFactor=color[:3],
            metallicFactor=0.0,
            roughnessFactor=1.0,
        )
        digital_scene.add(
            pyrender.Mesh.from_trimesh(
                grid_mesh,
                material=grid_material,
                smooth=False,
            )
        )

    diagnostic_frames = scene.get("diagnostics", {}).get("frames", [])
    contact_nodes: dict[str, object] = {}
    if isinstance(diagnostic_frames, list) and len(diagnostic_frames) == len(mesh_frames):
        contact_material = pyrender.MetallicRoughnessMaterial(
            baseColorFactor=(0.13, 0.82, 0.53, 0.22),
            metallicFactor=0.0,
            roughnessFactor=1.0,
            alphaMode="BLEND",
        )
        for side in ("left", "right"):
            disc = trimesh.creation.cylinder(
                radius=body_scale * 0.11,
                height=max(body_scale * 0.003, 0.002),
                sections=48,
            )
            contact_nodes[side] = digital_scene.add(
                pyrender.Mesh.from_trimesh(
                    disc,
                    material=contact_material,
                    smooth=False,
                )
            )

    camera = pyrender.PerspectiveCamera(
        yfov=np.deg2rad(42.0),
        aspectRatio=output_width / output_height,
        znear=0.01,
        zfar=500.0,
    )
    camera_transform = camera_pose(camera_eye, camera_target)
    digital_scene.add(camera, pose=camera_transform)

    key_eye = camera_target + np.asarray(
        (body_scale * 2.2, body_scale * -2.5, body_scale * 4.5),
        dtype=np.float32,
    )
    key_light = pyrender.DirectionalLight(
        color=np.ones(3, dtype=np.float32),
        intensity=4.2,
    )
    digital_scene.add(key_light, pose=camera_pose(key_eye, camera_target))
    rim_eye = camera_target + np.asarray(
        (body_scale * -2.0, body_scale * 2.0, body_scale * 2.5),
        dtype=np.float32,
    )
    rim_light = pyrender.DirectionalLight(
        color=np.asarray((0.435, 0.655, 1.0), dtype=np.float32),
        intensity=1.4,
    )
    digital_scene.add(rim_light, pose=camera_pose(rim_eye, camera_target))
    renderer = pyrender.OffscreenRenderer(render_width, render_height)

    try:
        # Three.js performs tone mapping while its frame is still HDR. Pyrender
        # exposes an already-clamped LDR framebuffer, so one global correction
        # cannot simultaneously preserve the studio floor and the G1's shaded
        # surface detail. Render the motion-independent studio once, then use
        # depth to composite the sharper dynamic geometry over it.
        dynamic_nodes = [*robot_nodes, *contact_nodes.values()]
        for node in dynamic_nodes:
            digital_scene.remove_node(node)
        studio_rgb, studio_depth = renderer.render(digital_scene)
        studio_rgb = aces_filmic_tone_map(studio_rgb)
        studio_rgb = apply_studio_fog(studio_rgb, studio_depth, body_scale)
        studio_rgb[studio_depth <= 0] = STUDIO_BACKGROUND_RGB
        for node in dynamic_nodes:
            digital_scene.add_node(node)

        for output_frame_index in range(output_frame_count):
            exact_frame = min(
                output_frame_index * motion_fps / output_fps,
                len(mesh_frames) - 1,
            )
            frame_index = int(np.floor(exact_frame))
            next_frame_index = min(frame_index + 1, len(mesh_frames) - 1)
            alpha = float(exact_frame - frame_index)
            first_transforms = mesh_frames[frame_index]
            second_transforms = mesh_frames[next_frame_index]
            for part_index, (first_values, second_values) in enumerate(
                zip(first_transforms, second_transforms)
            ):
                digital_scene.set_pose(
                    robot_nodes[part_index],
                    interpolated_mesh_pose(
                        first_values,
                        second_values,
                        alpha,
                        frame_index,
                        part_index,
                    ),
                )
            for side, node in contact_nodes.items():
                key = f"{side}CollisionSpheres"
                first_spheres = diagnostic_frames[frame_index].get(key, [])
                second_spheres = diagnostic_frames[next_frame_index].get(key, [])
                if not first_spheres or not second_spheres:
                    continue
                first_center = np.mean(
                    np.asarray([sphere["position"] for sphere in first_spheres], dtype=np.float32),
                    axis=0,
                )
                second_center = np.mean(
                    np.asarray([sphere["position"] for sphere in second_spheres], dtype=np.float32),
                    axis=0,
                )
                contact_center = first_center + (second_center - first_center) * alpha
                contact_center[2] = floor_height + 0.004
                contact_pose = np.eye(4, dtype=np.float32)
                contact_pose[:3, 3] = contact_center
                digital_scene.set_pose(node, contact_pose)
            rgb, depth = renderer.render(
                digital_scene,
            )
            rgb = aces_filmic_tone_map(
                rgb,
                display_gamma=1.0,
                white_balance=(1.0, 1.0, 1.015),
            )
            rgb = apply_studio_fog(rgb, depth, body_scale)
            foreground = dynamic_geometry_mask(depth, studio_depth, body_scale)
            rgb = np.where(foreground[..., None], rgb, studio_rgb)
            image = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
            image = cv2.resize(
                image,
                (output_width, output_height),
                interpolation=cv2.INTER_LANCZOS4,
            )

            cv2.rectangle(image, (48, 42), (340, 100), (62, 37, 19), -1)
            cv2.putText(
                image,
                "G1 DIGITAL TWIN",
                (72, 80),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.82,
                (247, 250, 255),
                2,
                cv2.LINE_AA,
            )
            cv2.rectangle(
                image,
                (output_width - 270, 42),
                (output_width - 48, 100),
                (62, 37, 19),
                -1,
            )
            cv2.putText(
                image,
                f"FRAME {frame_index + 1:04d}",
                (output_width - 240, 80),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.82,
                (247, 250, 255),
                2,
                cv2.LINE_AA,
            )
            encoder.stdin.write(image.tobytes())
    finally:
        renderer.delete()
        encoder.stdin.close()
    error_output = encoder.stderr.read().decode("utf-8", errors="replace") if encoder.stderr else ""
    return_code = encoder.wait()
    if return_code:
        raise RuntimeError(
            f"Unable to encode the digital-twin preview to H.264: {error_output.strip()}"
        )
    return output_frame_count


def write_scene(motion_path: Path, robot: str, scene_output: str | None = None) -> dict:
    import mujoco

    motion = load_robot_motion(motion_path)
    edges = [[start, end] for chain, _ in KINEMATIC_CHAINS for start, end in zip(chain, chain[1:])]
    xml_path = robot_xml_path(robot)
    model = load_robot_model(xml_path)
    data = mujoco.MjData(model)
    asset_meshes = {
        mesh.attrib["name"]: mesh.attrib["file"]
        for mesh in ET.parse(xml_path).getroot().findall("./asset/mesh")
        if "name" in mesh.attrib and "file" in mesh.attrib
    }
    mesh_geom_ids = [
        geom_id
        for geom_id in range(model.ngeom)
        if model.geom_type[geom_id] == mujoco.mjtGeom.mjGEOM_MESH
        and int(model.geom_group[geom_id]) == 1
    ]
    mesh_parts = []
    for geom_id in mesh_geom_ids:
        mesh_id = int(model.geom_dataid[geom_id])
        mesh_name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_MESH, mesh_id)
        if not mesh_name or mesh_name not in asset_meshes:
            continue
        mesh_file = ensure_web_mesh(model, mesh_id, mesh_name)
        mesh_parts.append(
            {
                "name": f"g1-geom-{geom_id}",
                "file": mesh_file,
                "color": np.round(model.geom_rgba[geom_id], 4).tolist(),
                "geomId": geom_id,
            }
        )

    root_rotations = np.asarray(motion["root_rot"], dtype=np.float32)[:, [3, 0, 1, 2]]
    joints = np.asarray(motion["dof_pos"], dtype=np.float32)
    qpos = validate_qpos(
        model,
        np.concatenate(
            (
                np.asarray(motion["root_pos"], dtype=np.float32),
                root_rotations,
                joints,
            ),
            axis=1,
        ),
    )
    diagnostics = analyze_qpos(model, qpos, float(motion.get("fps", 30.0)))
    contact_detection = motion.get("ground_diagnostics", {}).get("contactDetection", {})
    expected_left = set(contact_detection.get("leftFrames", []))
    expected_right = set(contact_detection.get("rightFrames", []))
    for frame_index, frame_diagnostic in enumerate(diagnostics["frames"]):
        frame_diagnostic["leftExpectedContact"] = frame_index in expected_left
        frame_diagnostic["rightExpectedContact"] = frame_index in expected_right
    diagnostics["summary"].update(
        motion.get("ground_diagnostics", {}).get("after", {})
    )
    mesh_frames: list[list[list[float]]] = []
    for frame_qpos in qpos:
        data.qpos[:] = frame_qpos
        mujoco.mj_forward(model, data)
        frame_transforms = []
        for part in mesh_parts:
            geom_id = int(part["geomId"])
            position = data.geom_xpos[geom_id]
            rotation = data.geom_xmat[geom_id].reshape(3, 3)
            frame_transforms.append(
                np.round(
                    np.concatenate((position, rotation.reshape(-1))),
                    6,
                ).tolist()
            )
        mesh_frames.append(frame_transforms)

    for part in mesh_parts:
        part.pop("geomId", None)

    world = np.asarray(
        [frame["bodyPositions"][1:] for frame in diagnostics["frames"]],
        dtype=np.float32,
    )
    body_names = [
        mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY, body_id)
        for body_id in range(1, model.nbody)
    ]
    scene = {
        "schemaVersion": "visualization.robot-3d-scene/v4",
        "kind": "robot",
        "fps": float(motion.get("fps", 30.0)),
        "upAxis": "z",
        "coordinateSystem": "right-handed-z-up-meters",
        "floorHeight": diagnostics["floorHeight"],
        "edges": edges,
        "frames": np.round(world, 5).tolist(),
        "bodyNames": body_names,
        "robotModel": "unitree_g1",
        "robotMeshes": mesh_parts,
        "robotMeshFrames": mesh_frames,
        "diagnostics": {
            "qposShape": diagnostics["qposShape"],
            "qposLayout": diagnostics["qposLayout"],
            "jointNames": diagnostics["jointNames"],
            "quaternionOrder": diagnostics["quaternionOrder"],
            "jointAngleUnit": diagnostics["jointAngleUnit"],
            "worldUpAxis": diagnostics["worldUpAxis"],
            "floorHeight": diagnostics["floorHeight"],
            "groundingMethod": motion.get("ground_diagnostics", {}).get(
                "groundingMethod",
                "unverified-existing-trajectory",
            ),
            "summary": diagnostics["summary"],
            "frames": [
                {
                    key: value
                    for key, value in frame.items()
                    if key not in {"bodyPositions"}
                }
                for frame in diagnostics["frames"]
            ],
        },
    }
    if scene_output:
        Path(scene_output).write_text(
            json.dumps(scene, separators=(",", ":")),
            encoding="utf-8",
        )
    return scene


def render_three_digital_twin(
    scene_path: Path,
    output_path: Path,
) -> int:
    """Capture the production Three.js viewer and encode its exact frames."""
    capture_script = Path(__file__).with_name("capture-digital-twin.mjs")
    if not capture_script.exists():
        raise RuntimeError(f"The Three.js capture script is missing at {capture_script}.")
    command = [
        os.environ.get("ROBOMOTION_NODE_BIN", "node"),
        str(capture_script),
        "--scene",
        str(scene_path),
        "--model-root",
        str(web_mesh_cache()),
        "--output",
        str(output_path),
        "--fps",
        os.environ.get("ROBOMOTION_DIGITAL_TWIN_FPS", "60"),
        "--width",
        os.environ.get("ROBOMOTION_DIGITAL_TWIN_WIDTH", "1920"),
        "--height",
        os.environ.get("ROBOMOTION_DIGITAL_TWIN_HEIGHT", "1080"),
        "--dashboard-url",
        os.environ.get("ROBOMOTION_DASHBOARD_URL", "http://127.0.0.1:3000"),
    ]
    completed = subprocess.run(command, check=False)
    if completed.returncode:
        raise RuntimeError(
            "The production Three.js digital-twin capture failed. "
            "Confirm that the dashboard is reachable through ROBOMOTION_DASHBOARD_URL "
            "and Google Chrome is installed."
        )
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise RuntimeError("The Three.js capture completed without an MP4 output.")
    scene = json.loads(scene_path.read_text(encoding="utf-8"))
    return max(
        1,
        int(
            round(
                len(scene["frames"])
                / float(scene["fps"])
                * float(os.environ.get("ROBOMOTION_DIGITAL_TWIN_FPS", "60"))
            )
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--motion", required=True)
    parser.add_argument("--robot", default="unitree_g1")
    parser.add_argument("--output", help="MP4 output path. Required unless --scene-only is used.")
    parser.add_argument("--scene-output", help="Optional JSON scene for the interactive dashboard viewer.")
    parser.add_argument(
        "--scene-only",
        action="store_true",
        help="Build interactive scene JSON without launching the browser MP4 capture.",
    )
    args = parser.parse_args()
    motion_path = Path(args.motion).resolve()
    if args.scene_only and not args.scene_output:
        parser.error("--scene-only requires --scene-output")
    if not args.scene_only and not args.output:
        parser.error("--output is required unless --scene-only is used")
    output_path = Path(args.output).resolve() if args.output else None
    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_scene: tempfile.NamedTemporaryFile | None = None
    if args.scene_output:
        scene_path = Path(args.scene_output).resolve()
    else:
        temporary_scene = tempfile.NamedTemporaryFile(
            prefix="robomotion-digital-twin-",
            suffix=".json",
            delete=False,
        )
        temporary_scene.close()
        scene_path = Path(temporary_scene.name)
    scene_path.parent.mkdir(parents=True, exist_ok=True)
    scene = write_scene(motion_path, args.robot, str(scene_path))
    if args.scene_only:
        print(
            f"RoboMotion: built {len(scene['frames'])} frames of interactive "
            f"Unitree G1 scene data without MP4 capture",
            flush=True,
        )
        return
    assert output_path is not None
    try:
        frames = render_three_digital_twin(scene_path, output_path)
        renderer_name = "the production Three.js digital twin"
    except Exception:
        if os.environ.get("ROBOMOTION_ALLOW_LEGACY_PYRENDER_FALLBACK") != "1":
            raise
        print(
            "RoboMotion: Three.js capture failed; using the explicitly enabled "
            "legacy Pyrender fallback.",
            flush=True,
        )
        frames = render_digital_twin_preview(scene, output_path)
        renderer_name = "the legacy Pyrender fallback"
    finally:
        if temporary_scene:
            scene_path.unlink(missing_ok=True)
    print(
        f"RoboMotion: rendered {frames} frames to {output_path.name} "
        f"using {renderer_name}",
        flush=True,
    )


if __name__ == "__main__":
    main()
