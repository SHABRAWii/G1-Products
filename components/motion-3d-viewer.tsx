"use client";

import {
  Box,
  Bug,
  EyeOff,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Route,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";

import {
  boneTransform,
  finiteVector,
  mujocoFloorToThreeY,
  mujocoPositionToThree,
  type Vector3Tuple,
} from "@/lib/motion-geometry";
import {
  lerpVector,
  sampleMotionFrame,
  type MotionFrameSample,
} from "@/lib/motion-playback";

type RobotMesh = {
  name: string;
  file: string;
  color: [number, number, number, number];
};

type Scene = {
  schemaVersion?: string;
  kind: "smplx" | "robot";
  bodyModel?: "smplx";
  jointConvention?: "smplx-body-22";
  rotationRepresentation?: "axis-angle-radians";
  coordinateSystem?: "right-handed-z-up-meters";
  jointNames?: string[];
  parameterShapes?: Record<string, number[]>;
  fps: number;
  upAxis: "z";
  edges: [number, number][];
  frames: number[][][];
  robotModel?: "unitree_g1";
  robotMeshes?: RobotMesh[];
  robotMeshFrames?: number[][][];
  floorHeight?: number;
  diagnostics?: RobotSceneDiagnostics;
};

type Sync = {
  masterVideo: MutableRefObject<HTMLVideoElement | null>;
};

export type MotionCaptureController = {
  ready: boolean;
  error?: string;
  fps: number;
  frameCount: number;
  duration: number;
  renderTime: (time: number) => Promise<{
    exactFrame: number;
    frameA: number;
    frameB: number;
    alpha: number;
  }>;
};

declare global {
  interface Window {
    __ROBOMOTION_CAPTURE__?: MotionCaptureController;
  }
}

type RobotFrameDiagnostic = {
  qpos: number[];
  rootPosition: [number, number, number];
  rootQuaternionWxyz: [number, number, number, number];
  leftSoleHeight: number;
  rightSoleHeight: number;
  minimumGeometryHeight: number;
  leftPenetration: number;
  rightPenetration: number;
  leftContact: boolean;
  rightContact: boolean;
  leftExpectedContact?: boolean;
  rightExpectedContact?: boolean;
  contacts?: { side: "left" | "right"; position: [number, number, number]; distance: number }[];
  leftCollisionSpheres?: { position: [number, number, number]; radius: number }[];
  rightCollisionSpheres?: { position: [number, number, number]; radius: number }[];
};

type RobotSceneDiagnostics = {
  qposShape: [number, number];
  qposLayout: "xyz-wxyz-joints";
  jointNames: string[];
  floorHeight: number;
  worldUpAxis: "z";
  quaternionOrder: "wxyz";
  jointAngleUnit: "radians";
  groundingMethod: string;
  frames: RobotFrameDiagnostic[];
};

type PlaybackDebug = {
  mediaTime: number;
  exactFrame: number;
  renderedFrame: number;
  videoDuration: number;
  motionDuration: number;
  syncDifferenceMs: number;
  maxSyncDifferenceMs: number;
  rafCallbacks: number;
  averageRenderMs: number;
  droppedVisualFrames: number;
};

type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  bodyScale: number;
};

type LinkVisual = {
  mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshPhysicalMaterial>;
  start: number;
  end: number;
  radius: number;
  sourceSpace: boolean;
};

type HumanAnatomy = {
  head: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  chest: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  abdomen: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  pelvis: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  leftHand: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshPhysicalMaterial>;
  rightHand: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshPhysicalMaterial>;
  leftFoot: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshPhysicalMaterial>;
  rightFoot: THREE.Mesh<THREE.CapsuleGeometry, THREE.MeshPhysicalMaterial>;
};

type ViewerRuntime = {
  renderer: THREE.WebGLRenderer;
  world: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  links: LinkVisual[];
  joints: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>[];
  head?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  chest?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  pelvis?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  humanAnatomy?: HumanAnatomy;
  humanRoot?: THREE.Group;
  debugRoot?: THREE.Group;
  debugLines?: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  debugAxes?: THREE.AxesHelper;
  debugLabels?: THREE.Sprite[];
  robotDebugRoot?: THREE.Group;
  robotDebugPoints?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  robotDebugAxes?: THREE.AxesHelper;
  robotCollisionSpheres?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  robotContactPoints?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  robotParts: THREE.Group[];
  contactGlows: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>[];
  trail: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  reference: THREE.Group;
  video?: HTMLVideoElement;
  videoTexture?: THREE.VideoTexture;
  floorY: number;
  bodyScale: number;
  sampledPoints: number[][];
  lastFrameA: number;
  rafCallbacks: number;
  renderTotalMs: number;
  droppedVisualFrames: number;
  maxSyncDifferenceMs: number;
  lastUiUpdate: number;
  animation: number;
  resizeObserver: ResizeObserver;
};

type WebGLContext = WebGLRenderingContext | WebGL2RenderingContext;

const UP = new THREE.Vector3(0, 1, 0);
const TEMP_A = new THREE.Vector3();
const TEMP_B = new THREE.Vector3();
const TEMP_DIRECTION = new THREE.Vector3();
const TEMP_CENTER = new THREE.Vector3();
const TEMP_UP = new THREE.Vector3();
const TEMP_SIDE = new THREE.Vector3();
const TEMP_FORWARD = new THREE.Vector3();

const SMPLX_BODY_JOINT_NAMES = [
  "pelvis",
  "left_hip",
  "right_hip",
  "spine1",
  "left_knee",
  "right_knee",
  "spine2",
  "left_ankle",
  "right_ankle",
  "spine3",
  "left_foot",
  "right_foot",
  "neck",
  "left_collar",
  "right_collar",
  "head",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
] as const;

const G1_29_DOF_JOINT_NAMES = [
  "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint",
  "left_knee_joint", "left_ankle_pitch_joint", "left_ankle_roll_joint",
  "right_hip_pitch_joint", "right_hip_roll_joint", "right_hip_yaw_joint",
  "right_knee_joint", "right_ankle_pitch_joint", "right_ankle_roll_joint",
  "waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint",
  "left_shoulder_pitch_joint", "left_shoulder_roll_joint", "left_shoulder_yaw_joint",
  "left_elbow_joint", "left_wrist_roll_joint", "left_wrist_pitch_joint", "left_wrist_yaw_joint",
  "right_shoulder_pitch_joint", "right_shoulder_roll_joint", "right_shoulder_yaw_joint",
  "right_elbow_joint", "right_wrist_roll_joint", "right_wrist_pitch_joint", "right_wrist_yaw_joint",
] as const;

const SMPLX = Object.fromEntries(
  SMPLX_BODY_JOINT_NAMES.map((name, index) => [name, index]),
) as Record<(typeof SMPLX_BODY_JOINT_NAMES)[number], number>;

const SMPLX_VISIBLE_BONES = new Set([
  "1-4", "4-7", "7-10",
  "2-5", "5-8", "8-11",
  "12-15",
  "9-13", "13-16", "16-18", "18-20",
  "9-14", "14-17", "17-19", "19-21",
]);

type HumanMetrics = {
  bodyScale: number;
  hipWidth: number;
  shoulderWidth: number;
  headLength: number;
  chestLength: number;
  abdomenLength: number;
  pelvisLength: number;
  handLength: number;
  footLength: number;
};

function sceneValidationError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "Scene payload must be a JSON object.";
  const scene = value as Partial<Scene>;
  if (scene.kind !== "smplx" && scene.kind !== "robot") {
    return `Unsupported scene kind: ${String(scene.kind)}.`;
  }
  if (!Number.isFinite(scene.fps) || Number(scene.fps) <= 0) {
    return `Scene FPS must be a positive finite number; received ${String(scene.fps)}.`;
  }
  if (!Array.isArray(scene.frames) || scene.frames.length === 0) {
    return "Scene contains no motion frames.";
  }
  const expectedJoints = scene.kind === "smplx" ? 22 : undefined;
  for (let frameIndex = 0; frameIndex < scene.frames.length; frameIndex += 1) {
    const frame = scene.frames[frameIndex];
    if (!Array.isArray(frame) || (expectedJoints && frame.length !== expectedJoints)) {
      return `Frame ${frameIndex} must contain ${expectedJoints ?? "a consistent set of"} joints; received ${Array.isArray(frame) ? frame.length : "non-array"}.`;
    }
    for (let jointIndex = 0; jointIndex < frame.length; jointIndex += 1) {
      if (!finiteVector(frame[jointIndex])) {
        return `Frame ${frameIndex}, joint ${jointIndex} is not a finite XYZ position.`;
      }
    }
  }
  if (!Array.isArray(scene.edges)) return "Scene skeleton edges are missing.";
  for (const edge of scene.edges) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 2 ||
      !edge.every(Number.isInteger) ||
      edge.some((index) => index < 0 || index >= scene.frames![0].length)
    ) {
      return `Scene contains an invalid parent-child edge: ${JSON.stringify(edge)}.`;
    }
  }
  if (
    scene.kind === "smplx" &&
    scene.jointNames &&
    (scene.jointNames.length !== 22 ||
      scene.jointNames.some((name, index) => name !== SMPLX_BODY_JOINT_NAMES[index]))
  ) {
    return "SMPL-X scene joint names do not match the explicit body-22 convention.";
  }
  if (
    scene.kind === "robot" &&
    scene.schemaVersion?.endsWith("/v4") &&
    (!scene.diagnostics || !Number.isFinite(scene.floorHeight))
  ) {
    return "Unitree G1 v4 scenes require MuJoCo qpos diagnostics and an explicit floor height.";
  }
  if (scene.kind === "robot" && scene.diagnostics) {
    if (
      !Array.isArray(scene.diagnostics.qposShape) ||
      scene.diagnostics.qposShape[0] !== scene.frames.length ||
      scene.diagnostics.qposShape[1] !== 36
    ) {
      return `Unitree G1 diagnostics require qpos shape (${scene.frames.length}, 36).`;
    }
    if (
      scene.diagnostics.jointNames.length !== G1_29_DOF_JOINT_NAMES.length ||
      scene.diagnostics.jointNames.some(
        (name, index) => name !== G1_29_DOF_JOINT_NAMES[index],
      )
    ) {
      return "Unitree G1 diagnostics do not match the official 29-DoF MJCF joint order.";
    }
    if (
      scene.diagnostics.quaternionOrder !== "wxyz" ||
      scene.diagnostics.worldUpAxis !== "z" ||
      scene.diagnostics.jointAngleUnit !== "radians"
    ) {
      return "Unitree G1 diagnostics use an incompatible quaternion, axis, or angle convention.";
    }
    if (
      !Number.isFinite(scene.floorHeight) ||
      scene.floorHeight !== scene.diagnostics.floorHeight ||
      scene.diagnostics.frames.length !== scene.frames.length
    ) {
      return "Unitree G1 floor or frame diagnostics are inconsistent with the scene.";
    }
    for (const diagnostic of scene.diagnostics.frames) {
      if (
        !Array.isArray(diagnostic.qpos) ||
        diagnostic.qpos.length !== 36 ||
        diagnostic.qpos.some((value) => !Number.isFinite(value)) ||
        !finiteVector(diagnostic.rootPosition) ||
        !diagnostic.rootQuaternionWxyz.every(Number.isFinite)
      ) {
        return "Unitree G1 diagnostics contain malformed or non-finite qpos values.";
      }
    }
  }
  return null;
}

function validScene(value: unknown): value is Scene {
  return sceneValidationError(value) === null;
}

function hasUnitreeMeshData(scene: Scene) {
  return (
    scene.kind === "robot" &&
    scene.robotModel === "unitree_g1" &&
    Array.isArray(scene.robotMeshes) &&
    scene.robotMeshes.length > 0 &&
    Array.isArray(scene.robotMeshFrames) &&
    scene.robotMeshFrames.length === scene.frames.length
  );
}

function toWorld(point: number[], target = new THREE.Vector3()) {
  const [x, y, z] = mujocoPositionToThree(point as Vector3Tuple);
  return target.set(x, y, z);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const ordered = [...values].sort((first, second) => first - second);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) * 0.5;
}

function stableDistance(scene: Scene, first: number, second: number) {
  return median(
    scene.frames.map((frame) => {
      const start = frame[first];
      const end = frame[second];
      return Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    }),
  );
}

function getHumanMetrics(scene: Scene, bodyScale: number): HumanMetrics {
  const hipWidth = stableDistance(scene, SMPLX.left_hip, SMPLX.right_hip);
  const shoulderWidth = stableDistance(scene, SMPLX.left_shoulder, SMPLX.right_shoulder);
  const headLength = stableDistance(scene, SMPLX.neck, SMPLX.head);
  return {
    bodyScale,
    hipWidth: Math.max(hipWidth, bodyScale * 0.13),
    shoulderWidth: Math.max(shoulderWidth, bodyScale * 0.24),
    headLength: Math.max(headLength, bodyScale * 0.1),
    chestLength: Math.max(
      stableDistance(scene, SMPLX.spine2, SMPLX.neck),
      bodyScale * 0.18,
    ),
    abdomenLength: Math.max(
      stableDistance(scene, SMPLX.spine1, SMPLX.spine3),
      bodyScale * 0.13,
    ),
    pelvisLength: Math.max(
      stableDistance(scene, SMPLX.pelvis, SMPLX.spine1),
      bodyScale * 0.07,
    ),
    handLength: Math.max(
      stableDistance(scene, SMPLX.left_elbow, SMPLX.left_wrist) * 0.28,
      bodyScale * 0.055,
    ),
    footLength: Math.max(
      median([
        stableDistance(scene, SMPLX.left_ankle, SMPLX.left_foot),
        stableDistance(scene, SMPLX.right_ankle, SMPLX.right_foot),
      ]),
      bodyScale * 0.07,
    ),
  };
}

function getBounds(scene: Scene): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const bodyExtents: number[] = [];

  for (const frame of scene.frames) {
    for (const point of frame) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], point[axis] ?? 0);
        max[axis] = Math.max(max[axis], point[axis] ?? 0);
      }
    }
    const root = frame[0];
    if (root) {
      bodyExtents.push(
        Math.max(
          ...frame.map((point) =>
            Math.hypot(
              (point[0] ?? 0) - root[0],
              (point[1] ?? 0) - root[1],
              (point[2] ?? 0) - root[2],
            ),
          ),
        ),
      );
    }
  }

  bodyExtents.sort((first, second) => first - second);
  const bodyScale = Math.max(bodyExtents[Math.floor(bodyExtents.length / 2)] ?? 1, 0.65);
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, min[2]],
    bodyScale,
  };
}

function physicalMaterial(color: number, metalness: number, roughness: number, opacity = 1) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness,
    roughness,
    clearcoat: metalness > 0.4 ? 0.65 : 0.15,
    clearcoatRoughness: 0.25,
    transparent: opacity < 1,
    opacity,
  });
}

function linkColor(scene: Scene, edgeIndex: number) {
  if (scene.kind === "smplx") return edgeIndex % 2 ? 0x7c9bd1 : 0xa9bee2;
  if (edgeIndex < 14) return edgeIndex < 7 ? 0xe8edf3 : 0xcfd7e2;
  if (edgeIndex < 18) return 0xaeb9c7;
  return edgeIndex < 26 ? 0xe7ecf2 : 0xcdd6e1;
}

function linkRadius(scene: Scene, start: number, end: number, scale: number, human?: HumanMetrics) {
  if (scene.kind === "smplx" && human) {
    const key = `${start}-${end}`;
    if (["1-4", "2-5"].includes(key)) return human.hipWidth * 0.18;
    if (["4-7", "5-8"].includes(key)) return human.hipWidth * 0.145;
    if (["7-10", "8-11"].includes(key)) return human.footLength * 0.18;
    if (["16-18", "17-19"].includes(key)) return human.shoulderWidth * 0.07;
    if (["18-20", "19-21"].includes(key)) return human.shoulderWidth * 0.06;
    if (key === "12-15") return human.headLength * 0.19;
    return scale * 0.02;
  }
  if (scene.kind === "smplx") return scale * 0.022;
  const edgeIndex = scene.edges.findIndex(([parent, child]) => parent === start && child === end);
  if (edgeIndex < 14) return scale * 0.045;
  if (edgeIndex < 18) return scale * 0.062;
  return scale * 0.034;
}

function updateCylinder(link: LinkVisual, points: number[][]) {
  const start = points[link.start];
  const end = points[link.end];
  if (!start || !end) {
    link.mesh.visible = false;
    return;
  }

  link.mesh.visible = true;
  const parent = (link.sourceSpace ? start : mujocoPositionToThree(start as Vector3Tuple)) as Vector3Tuple;
  const child = (link.sourceSpace ? end : mujocoPositionToThree(end as Vector3Tuple)) as Vector3Tuple;
  const transform = boneTransform(parent, child);
  if (transform.length < 1e-6) {
    link.mesh.visible = false;
    return;
  }
  link.mesh.position.fromArray(transform.midpoint);
  link.mesh.quaternion.fromArray(transform.quaternion);
  link.mesh.scale.set(link.radius, transform.length, link.radius);
}

function orientShell(
  shell: THREE.Object3D,
  lower: number[] | undefined,
  upper: number[] | undefined,
  left: number[] | undefined,
  right: number[] | undefined,
  sourceSpace = false,
) {
  if (!lower || !upper || !left || !right) {
    shell.visible = false;
    return;
  }
  shell.visible = true;
  const setPoint = (point: number[], target: THREE.Vector3) =>
    sourceSpace ? target.fromArray(point) : toWorld(point, target);
  setPoint(lower, TEMP_A);
  setPoint(upper, TEMP_B);
  TEMP_CENTER.addVectors(TEMP_A, TEMP_B).multiplyScalar(0.5);
  shell.position.copy(TEMP_CENTER);
  TEMP_UP.subVectors(TEMP_B, TEMP_A).normalize();
  setPoint(left, TEMP_A);
  setPoint(right, TEMP_B);
  TEMP_SIDE.subVectors(TEMP_B, TEMP_A).normalize();
  TEMP_FORWARD.crossVectors(TEMP_SIDE, TEMP_UP).normalize();
  TEMP_SIDE.crossVectors(TEMP_UP, TEMP_FORWARD).normalize();
  const basis = new THREE.Matrix4().makeBasis(TEMP_SIDE, TEMP_UP, TEMP_FORWARD);
  shell.quaternion.setFromRotationMatrix(basis);
}

function createHumanAnatomy(root: THREE.Group, metrics: HumanMetrics): HumanAnatomy {
  const skin = physicalMaterial(0xdce9f8, 0.05, 0.5, 0.96);
  const core = physicalMaterial(0xcbdced, 0.05, 0.5, 0.96);
  const sphere = () => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), skin.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  const chest = sphere();
  chest.scale.set(
    metrics.shoulderWidth * 0.43,
    metrics.chestLength * 0.52,
    metrics.shoulderWidth * 0.19,
  );
  const abdomen = sphere();
  abdomen.scale.set(
    (metrics.shoulderWidth + metrics.hipWidth) * 0.16,
    metrics.abdomenLength * 0.47,
    metrics.shoulderWidth * 0.15,
  );
  const pelvis = sphere();
  pelvis.material.dispose();
  pelvis.material = core;
  pelvis.scale.set(
    metrics.hipWidth * 0.64,
    metrics.pelvisLength * 0.62,
    metrics.hipWidth * 0.42,
  );
  const head = sphere();
  head.scale.set(
    metrics.headLength * 0.5,
    metrics.headLength * 0.64,
    metrics.headLength * 0.48,
  );

  const extremity = (length: number, radius: number) => {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, radius), 6, 14),
      skin.clone(),
    );
    mesh.castShadow = true;
    root.add(mesh);
    return mesh;
  };
  const leftHand = extremity(metrics.handLength, metrics.handLength * 0.24);
  const rightHand = extremity(metrics.handLength, metrics.handLength * 0.24);
  const leftFoot = extremity(metrics.footLength, metrics.footLength * 0.22);
  const rightFoot = extremity(metrics.footLength, metrics.footLength * 0.22);
  return { head, chest, abdomen, pelvis, leftHand, rightHand, leftFoot, rightFoot };
}

function orientExtremity(
  mesh: THREE.Object3D,
  parent: number[] | undefined,
  endpoint: number[] | undefined,
  extension: number,
) {
  if (!parent || !endpoint) {
    mesh.visible = false;
    return;
  }
  const direction = TEMP_DIRECTION.fromArray(endpoint).sub(TEMP_A.fromArray(parent));
  const length = direction.length();
  if (length < 1e-6) {
    mesh.visible = false;
    return;
  }
  mesh.visible = true;
  direction.normalize();
  mesh.position.fromArray(endpoint).addScaledVector(direction, extension * 0.3);
  mesh.quaternion.setFromUnitVectors(UP, direction);
}

function makeJointLabel(name: string, scale: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return new THREE.Sprite();
  context.fillStyle = "rgba(12, 22, 38, .88)";
  context.roundRect(0, 0, canvas.width, canvas.height, 10);
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = "600 26px Inter, system-ui, sans-serif";
  context.fillText(name, 14, 41);
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scale * 0.42, scale * 0.084, 1);
  return sprite;
}

function makeLabel(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(12, 22, 38, .92)";
  context.roundRect(0, 0, canvas.width, canvas.height, 18);
  context.fill();
  context.fillStyle = "#80b5ff";
  context.font = "700 25px Inter, system-ui, sans-serif";
  context.fillText("ROBO MOTION  /  REFERENCE", 28, 39);
  context.fillStyle = "#ffffff";
  context.font = "600 20px Inter, system-ui, sans-serif";
  context.fillText(text.toUpperCase(), 28, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.4, 0.3, 1);
  return sprite;
}

function createReferenceWall(
  world: THREE.Scene,
  bounds: Bounds,
  referenceVideoUrl: string | undefined,
) {
  const group = new THREE.Group();
  group.name = "reference-video";
  group.visible = Boolean(referenceVideoUrl);
  const scale = bounds.bodyScale;
  const center = toWorld(bounds.center);
  group.position.set(center.x - scale * 1.45, bounds.min[2] + scale * 0.72, center.z);
  group.rotation.y = Math.PI * 0.1;

  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(scale * 1.28, scale * 0.78, scale * 0.035),
    physicalMaterial(0x17243a, 0.55, 0.28),
  );
  frame.castShadow = true;
  frame.receiveShadow = true;
  group.add(frame);

  let video: HTMLVideoElement | undefined;
  let videoTexture: THREE.VideoTexture | undefined;
  const screenGeometry = new THREE.PlaneGeometry(scale * 1.19, scale * 0.67);
  let screenMaterial: THREE.MeshBasicMaterial;

  if (referenceVideoUrl) {
    video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.src = referenceVideoUrl;
    video.load();
    videoTexture = new THREE.VideoTexture(video);
    videoTexture.colorSpace = THREE.SRGBColorSpace;
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    screenMaterial = new THREE.MeshBasicMaterial({ map: videoTexture, toneMapped: false });
  } else {
    screenMaterial = new THREE.MeshBasicMaterial({ color: 0x23344f });
  }

  const screen = new THREE.Mesh(screenGeometry, screenMaterial);
  screen.position.z = scale * 0.019;
  group.add(screen);

  const label = makeLabel(referenceVideoUrl ? "Synchronized source video" : "Motion reference");
  if (label) {
    label.position.set(0, scale * 0.49, scale * 0.035);
    label.scale.set(scale * 1.18, scale * 0.15, 1);
    group.add(label);
  }

  // An original review-space camera glyph: four rays connect the reference
  // plane to a virtual optical center without claiming calibrated extrinsics.
  const origin = new THREE.Vector3(-scale * 0.92, 0, scale * 0.72);
  const halfWidth = scale * 0.595;
  const halfHeight = scale * 0.335;
  const vertices: number[] = [];
  for (const corner of [
    [-halfWidth, -halfHeight, scale * 0.04],
    [halfWidth, -halfHeight, scale * 0.04],
    [halfWidth, halfHeight, scale * 0.04],
    [-halfWidth, halfHeight, scale * 0.04],
  ]) {
    vertices.push(origin.x, origin.y, origin.z, corner[0], corner[1], corner[2]);
  }
  const rays = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3)),
    new THREE.LineBasicMaterial({ color: 0x4f8ee8, transparent: true, opacity: 0.58 }),
  );
  group.add(rays);
  world.add(group);
  return { group, video, videoTexture };
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Sprite)) return;
    child.geometry?.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      const map = "map" in material ? material.map : undefined;
      if (map instanceof THREE.Texture) map.dispose();
      material.dispose();
    }
  });
}

function applyRobotTransform(part: THREE.Group, transform: number[] | undefined) {
  if (!transform || transform.length !== 12) {
    part.visible = false;
    return;
  }
  part.visible = true;
  const [px, py, pz, r00, r01, r02, r10, r11, r12, r20, r21, r22] = transform;
  part.matrix.set(
    r00, r01, r02, px,
    r10, r11, r12, py,
    r20, r21, r22, pz,
    0, 0, 0, 1,
  );
  part.matrixWorldNeedsUpdate = true;
}

const ROBOT_MATRIX_A = new THREE.Matrix4();
const ROBOT_MATRIX_B = new THREE.Matrix4();
const ROBOT_POSITION_A = new THREE.Vector3();
const ROBOT_POSITION_B = new THREE.Vector3();
const ROBOT_QUATERNION_A = new THREE.Quaternion();
const ROBOT_QUATERNION_B = new THREE.Quaternion();
const ROBOT_SCALE_A = new THREE.Vector3();
const ROBOT_SCALE_B = new THREE.Vector3();
const ROBOT_POSITION_RESULT = new THREE.Vector3();
const ROBOT_QUATERNION_RESULT = new THREE.Quaternion();
const ROBOT_SCALE_RESULT = new THREE.Vector3(1, 1, 1);

function robotMatrix(target: THREE.Matrix4, transform: number[]) {
  const [px, py, pz, r00, r01, r02, r10, r11, r12, r20, r21, r22] = transform;
  return target.set(
    r00, r01, r02, px,
    r10, r11, r12, py,
    r20, r21, r22, pz,
    0, 0, 0, 1,
  );
}

function applyInterpolatedRobotTransform(
  part: THREE.Group,
  first: number[] | undefined,
  second: number[] | undefined,
  alpha: number,
) {
  if (!first || !second || first.length !== 12 || second.length !== 12) {
    part.visible = false;
    return;
  }
  part.visible = true;
  robotMatrix(ROBOT_MATRIX_A, first).decompose(
    ROBOT_POSITION_A,
    ROBOT_QUATERNION_A,
    ROBOT_SCALE_A,
  );
  robotMatrix(ROBOT_MATRIX_B, second).decompose(
    ROBOT_POSITION_B,
    ROBOT_QUATERNION_B,
    ROBOT_SCALE_B,
  );
  ROBOT_POSITION_RESULT.lerpVectors(ROBOT_POSITION_A, ROBOT_POSITION_B, alpha);
  ROBOT_QUATERNION_RESULT.copy(ROBOT_QUATERNION_A).slerp(ROBOT_QUATERNION_B, alpha);
  ROBOT_SCALE_RESULT.lerpVectors(ROBOT_SCALE_A, ROBOT_SCALE_B, alpha);
  part.matrix.compose(ROBOT_POSITION_RESULT, ROBOT_QUATERNION_RESULT, ROBOT_SCALE_RESULT);
  part.matrixWorldNeedsUpdate = true;
}

function interpolateScenePoints(
  scene: Scene,
  sample: MotionFrameSample,
  target: number[][],
) {
  const first = scene.frames[sample.frameA];
  const second = scene.frames[sample.frameB];
  for (let index = 0; index < first.length; index += 1) {
    const destination = target[index] as Vector3Tuple;
    lerpVector(first[index] as Vector3Tuple, second[index] as Vector3Tuple, sample.alpha, destination);
  }
  return target;
}

function createWebGLSurface() {
  const attempts: Array<{
    type: "webgl2" | "webgl";
    attributes: WebGLContextAttributes;
  }> = [
    {
      type: "webgl2",
      attributes: {
        alpha: false,
        antialias: true,
        depth: true,
        failIfMajorPerformanceCaveat: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
        stencil: false,
      },
    },
    {
      type: "webgl2",
      attributes: {
        alpha: false,
        antialias: false,
        depth: true,
        failIfMajorPerformanceCaveat: false,
        powerPreference: "default",
        preserveDrawingBuffer: false,
        stencil: false,
      },
    },
    {
      type: "webgl",
      attributes: {
        alpha: false,
        antialias: false,
        depth: true,
        failIfMajorPerformanceCaveat: false,
        powerPreference: "default",
        preserveDrawingBuffer: false,
        stencil: false,
      },
    },
  ];

  for (const attempt of attempts) {
    const canvas = document.createElement("canvas");
    try {
      const context = canvas.getContext(attempt.type, attempt.attributes);
      if (context) return { canvas, context: context as WebGLContext };
    } catch {
      // Try the next progressively more compatible WebGL profile.
    }
  }
  return null;
}

function updateSceneVisuals(
  current: ViewerRuntime,
  scene: Scene,
  sample: MotionFrameSample,
  humanMetrics: HumanMetrics | null,
  showDebug: boolean,
  mediaTime: number,
) {
  const points = interpolateScenePoints(scene, sample, current.sampledPoints);
  const robotFirst = scene.robotMeshFrames?.[sample.frameA];
  const robotSecond = scene.robotMeshFrames?.[sample.frameB];
  current.robotParts.forEach((part, index) =>
    applyInterpolatedRobotTransform(
      part,
      robotFirst?.[index],
      robotSecond?.[index],
      sample.alpha,
    ),
  );
  current.links.forEach((link) => updateCylinder(link, points));
  current.joints.forEach((joint, index) => {
    const point = points[index];
    joint.visible = Boolean(
      point &&
        joint.userData.connected &&
        !joint.userData.shellCovered &&
        (scene.kind !== "smplx" || showDebug),
    );
    if (point) {
      if (scene.kind === "smplx") joint.position.fromArray(point);
      else toWorld(point, joint.position);
    }
  });

  if (scene.kind === "robot" && current.head && current.chest && current.pelvis) {
    orientShell(current.chest, points[18], points[19], points[22], points[30]);
    orientShell(current.pelvis, points[0], points[16], points[1], points[9]);
    if (points[18] && points[19]) {
      const chest = toWorld(points[18], new THREE.Vector3());
      const head = toWorld(points[19], new THREE.Vector3());
      current.head.visible = true;
      current.head.position.copy(head).add(
        head.clone().sub(chest).normalize().multiplyScalar(current.bodyScale * 0.045),
      );
      current.head.quaternion.copy(current.chest.quaternion);
    } else current.head.visible = false;
  } else if (scene.kind === "smplx" && current.humanAnatomy && humanMetrics) {
    const anatomy = current.humanAnatomy;
    orientShell(
      anatomy.chest,
      points[SMPLX.spine2],
      points[SMPLX.neck],
      points[SMPLX.left_shoulder],
      points[SMPLX.right_shoulder],
      true,
    );
    orientShell(
      anatomy.abdomen,
      points[SMPLX.spine1],
      points[SMPLX.spine3],
      points[SMPLX.left_hip],
      points[SMPLX.right_hip],
      true,
    );
    orientShell(
      anatomy.pelvis,
      points[SMPLX.pelvis],
      points[SMPLX.spine1],
      points[SMPLX.left_hip],
      points[SMPLX.right_hip],
      true,
    );
    const neck = points[SMPLX.neck];
    const headJoint = points[SMPLX.head];
    if (neck && headJoint) {
      const direction = TEMP_DIRECTION.fromArray(headJoint).sub(TEMP_A.fromArray(neck));
      const length = direction.length();
      anatomy.head.visible = length > 1e-6;
      if (length > 1e-6) {
        direction.normalize();
        anatomy.head.position
          .fromArray(headJoint)
          .addScaledVector(direction, humanMetrics.headLength * 0.28);
        anatomy.head.quaternion.copy(anatomy.chest.quaternion);
      }
    } else anatomy.head.visible = false;
    orientExtremity(
      anatomy.leftHand,
      points[SMPLX.left_elbow],
      points[SMPLX.left_wrist],
      humanMetrics.handLength,
    );
    orientExtremity(
      anatomy.rightHand,
      points[SMPLX.right_elbow],
      points[SMPLX.right_wrist],
      humanMetrics.handLength,
    );
    orientExtremity(
      anatomy.leftFoot,
      points[SMPLX.left_ankle],
      points[SMPLX.left_foot],
      humanMetrics.footLength,
    );
    orientExtremity(
      anatomy.rightFoot,
      points[SMPLX.right_ankle],
      points[SMPLX.right_foot],
      humanMetrics.footLength,
    );
  }

  if (scene.kind === "smplx" && current.debugRoot) {
    current.debugRoot.visible = showDebug;
    if (current.debugAxes && points[SMPLX.pelvis]) {
      current.debugAxes.position.fromArray(points[SMPLX.pelvis]);
    }
    const attribute = current.debugLines?.geometry.getAttribute("position");
    if (attribute instanceof THREE.BufferAttribute) {
      scene.edges.forEach(([parent, child], edgeIndex) => {
        const start = points[parent];
        const end = points[child];
        attribute.setXYZ(edgeIndex * 2, start[0], start[1], start[2]);
        attribute.setXYZ(edgeIndex * 2 + 1, end[0], end[1], end[2]);
      });
      attribute.needsUpdate = true;
    }
    current.debugLabels?.forEach((label, index) => {
      const point = points[index];
      if (!point) return;
      label.position.fromArray(point);
      label.position.z += current.bodyScale * 0.025;
    });
  }

  const frameDiagnostic = scene.diagnostics?.frames[sample.frameA];
  if (scene.kind === "robot" && current.robotDebugRoot) {
    current.robotDebugRoot.visible = showDebug;
    current.robotDebugPoints?.forEach((point, index) => {
      point.visible = Boolean(points[index]);
      if (points[index]) point.position.fromArray(points[index]);
    });
    if (current.robotDebugAxes && points[0]) {
      current.robotDebugAxes.position.fromArray(points[0]);
    }
    const collisionSpheres = [
      ...(frameDiagnostic?.leftCollisionSpheres ?? []),
      ...(frameDiagnostic?.rightCollisionSpheres ?? []),
    ];
    current.robotCollisionSpheres?.forEach((sphere, index) => {
      const collision = collisionSpheres[index];
      sphere.visible = Boolean(collision);
      if (!collision) return;
      sphere.position.fromArray(collision.position);
      sphere.scale.setScalar(collision.radius);
    });
    current.robotContactPoints?.forEach((marker, index) => {
      const contact = frameDiagnostic?.contacts?.[index];
      marker.visible = Boolean(contact);
      if (contact) marker.position.fromArray(contact.position);
    });
  }
  const feet = scene.kind === "robot" ? [points[7], points[15]] : [points[10], points[11]];
  current.contactGlows.forEach((glow, index) => {
    const foot = feet[index];
    glow.visible = Boolean(foot);
    if (!foot) return;
    toWorld(foot, glow.position);
    glow.position.y = current.floorY + 0.006;
    const inContact =
      scene.kind === "robot"
        ? index === 0
          ? frameDiagnostic?.leftExpectedContact ?? frameDiagnostic?.leftContact
          : frameDiagnostic?.rightExpectedContact ?? frameDiagnostic?.rightContact
        : Math.abs((foot[2] ?? current.floorY) - current.floorY) <
          current.bodyScale * 0.09;
    glow.material.opacity = inContact ? 0.36 : 0.07;
  });

  if (current.video && Number.isFinite(mediaTime)) {
    if (Math.abs(current.video.currentTime - mediaTime) > 0.04) {
      current.video.currentTime = Math.min(
        mediaTime,
        Number.isFinite(current.video.duration) ? current.video.duration : mediaTime,
      );
    }
  }
}

export function Motion3DViewer({
  sceneUrl,
  title,
  downloadUrl,
  sync,
  referenceVideoUrl,
  controls = "full",
  captureMode = false,
  modelBaseUrl,
}: {
  sceneUrl: string;
  title: string;
  downloadUrl?: string;
  sync?: Sync;
  referenceVideoUrl?: string;
  controls?: "compact" | "full";
  captureMode?: boolean;
  modelBaseUrl?: string;
}) {
  const container = useRef<HTMLElement>(null);
  const mount = useRef<HTMLDivElement>(null);
  const runtime = useRef<ViewerRuntime | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const [webglAttempt, setWebglAttempt] = useState(0);
  const [viewerActive, setViewerActive] = useState(captureMode);
  const [robotMeshesLoaded, setRobotMeshesLoaded] = useState(0);
  const [displayFrame, setDisplayFrame] = useState(0);
  const [localPlaying, setLocalPlaying] = useState(!captureMode);
  const [syncPlaying, setSyncPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showReference, setShowReference] = useState(false);
  const [showTrail, setShowTrail] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [view, setView] = useState<"studio" | "front" | "side" | "top">("studio");
  const [playbackDebug, setPlaybackDebug] = useState<PlaybackDebug | null>(null);
  const syncRef = useRef(sync);
  const optionsRef = useRef({
    showDebug,
    showReference,
    humanMetrics: null as HumanMetrics | null,
    localPlaying,
    speed,
  });
  const localClock = useRef({ time: 0, lastTimestamp: 0 });
  const bounds = useMemo(() => (scene ? getBounds(scene) : null), [scene]);
  const humanMetrics = useMemo(
    () => (scene?.kind === "smplx" && bounds ? getHumanMetrics(scene, bounds.bodyScale) : null),
    [bounds, scene],
  );

  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  useEffect(() => {
    optionsRef.current = { showDebug, showReference, humanMetrics, localPlaying, speed };
  }, [humanMetrics, localPlaying, showDebug, showReference, speed]);

  useEffect(() => {
    if (!sync) {
      setSyncPlaying(false);
      return;
    }
    let master: HTMLVideoElement | null = null;
    const update = () => {
      if (!master) return;
      setSyncPlaying(
        !master.paused &&
          !master.ended &&
          master.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
      );
      setSpeed(master.playbackRate);
    };
    const events = [
      "play",
      "playing",
      "pause",
      "waiting",
      "stalled",
      "ended",
      "ratechange",
      "seeking",
      "seeked",
    ];
    const attach = () => {
      const next = sync.masterVideo.current;
      if (next === master) return;
      if (master) {
        for (const event of events) master.removeEventListener(event, update);
      }
      master = next;
      if (master) {
        for (const event of events) master.addEventListener(event, update);
        update();
      }
    };
    attach();
    const attachmentPoll = window.setInterval(attach, 250);
    return () => {
      window.clearInterval(attachmentPoll);
      if (master) {
        for (const event of events) master.removeEventListener(event, update);
      }
    };
  }, [scene, sync]);

  const frame = displayFrame;
  const playing = sync ? syncPlaying : localPlaying;
  const setPlaying = (value: boolean) => {
    if (sync) {
      const master = sync.masterVideo.current;
      if (!master) return;
      if (value) void master.play().catch(() => undefined);
      else master.pause();
    } else setLocalPlaying(value);
  };
  const setFrame = (value: number) => {
    const bounded = Math.max(0, Math.min((scene?.frames.length ?? 1) - 1, value));
    const time = scene ? bounded / scene.fps : 0;
    if (sync && scene && sync.masterVideo.current) {
      sync.masterVideo.current.currentTime = time;
    } else if (showReference && runtime.current?.video) {
      runtime.current.video.currentTime = time;
      localClock.current.time = time;
      setDisplayFrame(bounded);
    } else {
      localClock.current.time = time;
      setDisplayFrame(bounded);
    }
  };
  const toggleReference = () => {
    const nextVisible = !showReference;
    setShowReference(nextVisible);
    const video = runtime.current?.video;
    if (!video) return;
    if (!nextVisible) {
      if (Number.isFinite(video.currentTime)) localClock.current.time = video.currentTime;
      video.pause();
      return;
    }

    const master = syncRef.current?.masterVideo.current;
    const targetTime = master?.currentTime ?? localClock.current.time;
    const shouldPlay = master
      ? !master.paused &&
        !master.ended &&
        master.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      : optionsRef.current.localPlaying;

    const activate = () => {
      if (Number.isFinite(targetTime)) {
        video.currentTime = Math.max(
          0,
          Math.min(
            targetTime,
            Number.isFinite(video.duration) ? video.duration : targetTime,
          ),
        );
      }
      video.playbackRate = master?.playbackRate ?? optionsRef.current.speed;
      if (shouldPlay) {
        void video.play().catch((cause: unknown) => {
          console.warn("[RoboMotion reference] Unable to start the synchronized video.", cause);
        });
      }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      activate();
    } else {
      video.addEventListener("loadedmetadata", activate, { once: true });
      video.load();
      // The reference is muted, so initiating playback from the user's click
      // is safe and preserves the browser's playback permission context.
      if (shouldPlay) void video.play().catch(() => undefined);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setScene(null);
    setError(null);
    setWebglUnavailable(false);
    setRobotMeshesLoaded(0);
    fetch(sceneUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load scene (${response.status}).`);
        return response.json();
      })
      .then((value: unknown) => {
        const validationError = sceneValidationError(value);
        if (validationError || !validScene(value)) {
          console.error("[RoboMotion 3D] Malformed scene artifact:", validationError, value);
          throw new Error(validationError ?? "The scene artifact is not valid.");
        }
        if (!cancelled) {
          setScene(value);
          setDisplayFrame(0);
          localClock.current = { time: 0, lastTimestamp: 0 };
        }
      })
      .catch(
        (cause: unknown) =>
          !cancelled &&
          setError(cause instanceof Error ? cause.message : "Unable to load the digital twin."),
      );
    return () => {
      cancelled = true;
    };
  }, [sceneUrl]);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    if (captureMode) {
      setViewerActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setViewerActive(entry.isIntersecting),
      { rootMargin: "240px 0px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [captureMode]);

  useEffect(() => {
    const host = mount.current;
    if (!host || !scene || !bounds || !viewerActive) return;
    const actualUnitree = hasUnitreeMeshData(scene);

    const surface = createWebGLSurface();
    if (!surface) {
      host.replaceChildren();
      setWebglUnavailable(true);
      const retry = window.setTimeout(
        () => setWebglAttempt((attempt) => attempt + 1),
        Math.min(3000, 500 + webglAttempt * 350),
      );
      return () => window.clearTimeout(retry);
    }

    const world = new THREE.Scene();
    world.background = new THREE.Color(0xf7f9fc);
    world.fog = new THREE.FogExp2(0xf7f9fc, 0.035 / bounds.bodyScale);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 500);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: surface.canvas,
        context: surface.context,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      host.replaceChildren();
      setWebglUnavailable(true);
      const retry = window.setTimeout(
        () => setWebglAttempt((attempt) => attempt + 1),
        Math.min(3000, 500 + webglAttempt * 350),
      );
      return () => window.clearTimeout(retry);
    }
    setWebglUnavailable(false);
    const recoverContext = (event: Event) => {
      event.preventDefault();
      setWebglUnavailable(true);
      setWebglAttempt((attempt) => attempt + 1);
    };
    surface.canvas.addEventListener("webglcontextlost", recoverContext);
    renderer.setPixelRatio(
      captureMode ? 1 : Math.min(window.devicePixelRatio || 1, actualUnitree ? 1.5 : 2),
    );
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = !actualUnitree;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.replaceChildren(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.screenSpacePanning = true;
    controls.minDistance = bounds.bodyScale * 0.75;
    controls.maxDistance = bounds.bodyScale * 12;
    controls.zoomToCursor = true;

    const center = toWorld(bounds.center);
    center.y = bounds.min[2] + bounds.bodyScale * 0.65;
    controls.target.copy(center);
    camera.position.copy(center).add(
      new THREE.Vector3(bounds.bodyScale * 2.4, bounds.bodyScale * 1.5, bounds.bodyScale * 2.8),
    );
    controls.update();

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x9aa7b8, 2.35);
    world.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffffff, 4.2);
    key.position.copy(center).add(
      new THREE.Vector3(bounds.bodyScale * 2.2, bounds.bodyScale * 4.5, bounds.bodyScale * 2.5),
    );
    key.castShadow = !actualUnitree;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = bounds.bodyScale * 14;
    const shadowExtent = bounds.bodyScale * 3.5;
    key.shadow.camera.left = -shadowExtent;
    key.shadow.camera.right = shadowExtent;
    key.shadow.camera.top = shadowExtent;
    key.shadow.camera.bottom = -shadowExtent;
    world.add(key);
    const rim = new THREE.DirectionalLight(0x6fa7ff, 1.4);
    rim.position.copy(center).add(new THREE.Vector3(-2, 2.5, -2).multiplyScalar(bounds.bodyScale));
    world.add(rim);

    // Robot scenes use the exact MuJoCo floor. Human-only scenes do not carry
    // a physics floor, so their review plane remains derived from the track.
    const floorY =
      scene.kind === "robot"
        ? mujocoFloorToThreeY(scene.floorHeight ?? scene.diagnostics?.floorHeight ?? 0)
        : bounds.min[2] - bounds.bodyScale * 0.015;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(bounds.bodyScale * 16, bounds.bodyScale * 16),
      new THREE.MeshPhysicalMaterial({
        color: 0xf4f6f9,
        roughness: 0.88,
        metalness: 0.03,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = floorY;
    floor.receiveShadow = true;
    world.add(floor);
    const grid = new THREE.GridHelper(bounds.bodyScale * 12, 36, 0x9eacbd, 0xd5dce6);
    grid.position.y = floorY + 0.002;
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const material of gridMaterials) {
      material.transparent = true;
      material.opacity = 0.55;
    }
    world.add(grid);

    // SMPL-X joints stay in their native right-handed Z-up coordinates. The
    // complete human rig is converted once at this root to Three.js Y-up,
    // preventing per-joint mirroring or mixed translation/rotation bases.
    const humanRoot = scene.kind === "smplx" ? new THREE.Group() : undefined;
    if (humanRoot) {
      humanRoot.name = "smplx-z-up-to-three-y-up";
      humanRoot.rotation.x = -Math.PI / 2;
      world.add(humanRoot);
    }
    const bodyParent = humanRoot ?? world;
    const visibleEdges =
      scene.kind === "smplx"
        ? scene.edges.filter(([start, end]) => SMPLX_VISIBLE_BONES.has(`${start}-${end}`))
        : scene.edges;
    const links: LinkVisual[] = (actualUnitree ? [] : visibleEdges).map(([start, end]) => {
      const edgeIndex = scene.edges.findIndex(
        ([candidateStart, candidateEnd]) =>
          candidateStart === start && candidateEnd === end,
      );
      const material = physicalMaterial(
        linkColor(scene, edgeIndex),
        scene.kind === "robot" ? 0.66 : 0.08,
        scene.kind === "robot" ? 0.27 : 0.5,
        scene.kind === "robot" ? 1 : 0.94,
      );
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16, 1, false), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      bodyParent.add(mesh);
      return {
        mesh,
        start,
        end,
        radius: linkRadius(scene, start, end, bounds.bodyScale, humanMetrics ?? undefined),
        sourceSpace: scene.kind === "smplx",
      };
    });

    const pointCount = actualUnitree ? 0 : Math.max(...scene.frames.map((item) => item.length));
    const connectedJoints = new Set(scene.edges.flat());
    const joints = Array.from({ length: pointCount }, (_, index) => {
      const material = physicalMaterial(
        scene.kind === "robot" ? (index === 18 ? 0x2588f4 : 0x313a47) : 0x8facd7,
        scene.kind === "robot" ? 0.72 : 0.05,
        0.25,
        scene.kind === "robot" ? 1 : 0.82,
      );
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), material);
      const radius = bounds.bodyScale * (scene.kind === "robot" ? 0.038 : 0.038);
      mesh.scale.setScalar(radius);
      mesh.castShadow = true;
      mesh.userData.connected = connectedJoints.has(index);
      mesh.userData.shellCovered = scene.kind === "robot" && [0, 16, 17, 18, 19].includes(index);
      mesh.visible = scene.kind !== "smplx";
      bodyParent.add(mesh);
      return mesh;
    });

    let head: ViewerRuntime["head"];
    let chest: ViewerRuntime["chest"];
    let pelvis: ViewerRuntime["pelvis"];
    if (scene.kind === "robot" && !actualUnitree) {
      const shell = physicalMaterial(0xe9edf2, 0.7, 0.22);
      head = new THREE.Mesh(
        new THREE.CapsuleGeometry(bounds.bodyScale * 0.105, bounds.bodyScale * 0.105, 7, 20),
        shell.clone(),
      );
      head.castShadow = true;
      const visor = new THREE.Mesh(
        new THREE.BoxGeometry(
          bounds.bodyScale * 0.15,
          bounds.bodyScale * 0.065,
          bounds.bodyScale * 0.018,
        ),
        physicalMaterial(0x101722, 0.82, 0.16),
      );
      visor.position.set(0, bounds.bodyScale * 0.012, bounds.bodyScale * 0.095);
      head.add(visor);
      world.add(head);
      chest = new THREE.Mesh(
        new THREE.BoxGeometry(
          bounds.bodyScale * 0.37,
          bounds.bodyScale * 0.33,
          bounds.bodyScale * 0.215,
          3,
          3,
          3,
        ),
        shell.clone(),
      );
      chest.castShadow = true;
      world.add(chest);
      pelvis = new THREE.Mesh(
        new THREE.BoxGeometry(
          bounds.bodyScale * 0.28,
          bounds.bodyScale * 0.16,
          bounds.bodyScale * 0.19,
          2,
          2,
          2,
        ),
        physicalMaterial(0xc7d0dc, 0.62, 0.28),
      );
      pelvis.castShadow = true;
      world.add(pelvis);
    }

    const humanAnatomy =
      scene.kind === "smplx" && humanRoot && humanMetrics
        ? createHumanAnatomy(humanRoot, humanMetrics)
        : undefined;

    let debugRoot: THREE.Group | undefined;
    let debugLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | undefined;
    let debugAxes: THREE.AxesHelper | undefined;
    let debugLabels: THREE.Sprite[] | undefined;
    if (scene.kind === "smplx" && humanRoot) {
      debugRoot = new THREE.Group();
      debugRoot.name = "smplx-debug";
      debugRoot.visible = showDebug;
      humanRoot.add(debugRoot);
      for (const joint of joints) {
        humanRoot.remove(joint);
        joint.scale.setScalar(bounds.bodyScale * 0.016);
        joint.material.color.setHex(0xff4f91);
        joint.material.opacity = 1;
        joint.visible = true;
        debugRoot.add(joint);
      }
      debugLines = new THREE.LineSegments(
        new THREE.BufferGeometry().setAttribute(
          "position",
          new THREE.Float32BufferAttribute(new Float32Array(scene.edges.length * 6), 3),
        ),
        new THREE.LineBasicMaterial({ color: 0x225ed8, depthTest: false }),
      );
      debugRoot.add(debugLines);
      debugAxes = new THREE.AxesHelper(bounds.bodyScale * 0.32);
      debugRoot.add(debugAxes);
      debugLabels = (scene.jointNames ?? SMPLX_BODY_JOINT_NAMES).map((name) => {
        const label = makeJointLabel(name, bounds.bodyScale);
        debugRoot!.add(label);
        return label;
      });
    }

    const robotParts: THREE.Group[] = [];
    let robotDebugRoot: THREE.Group | undefined;
    let robotDebugAxes: THREE.AxesHelper | undefined;
    const robotDebugPoints: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
    const robotCollisionSpheres: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
    const robotContactPoints: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
    let disposed = false;
    if (actualUnitree) {
      THREE.Cache.enabled = true;
      const robotRoot = new THREE.Group();
      robotRoot.name = "unitree-g1-digital-twin";
      robotRoot.rotation.x = -Math.PI / 2;
      world.add(robotRoot);
      robotDebugRoot = new THREE.Group();
      robotDebugRoot.name = "unitree-g1-mujoco-debug";
      robotDebugRoot.visible = showDebug;
      robotRoot.add(robotDebugRoot);
      robotDebugAxes = new THREE.AxesHelper(bounds.bodyScale * 0.28);
      robotDebugRoot.add(robotDebugAxes);
      for (let index = 0; index < scene.frames[0].length; index += 1) {
        const point = new THREE.Mesh(
          new THREE.SphereGeometry(1, 10, 8),
          new THREE.MeshBasicMaterial({ color: 0xff3d8d, depthTest: false }),
        );
        point.scale.setScalar(bounds.bodyScale * 0.012);
        robotDebugRoot.add(point);
        robotDebugPoints.push(point);
      }
      for (let index = 0; index < 8; index += 1) {
        const sphere = new THREE.Mesh(
          new THREE.SphereGeometry(1, 14, 10),
          new THREE.MeshBasicMaterial({
            color: index < 4 ? 0x2979ff : 0xff9f1c,
            wireframe: true,
            depthTest: false,
          }),
        );
        robotDebugRoot.add(sphere);
        robotCollisionSpheres.push(sphere);
      }
      for (let index = 0; index < 8; index += 1) {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(bounds.bodyScale * 0.018, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0x14b86e, depthTest: false }),
        );
        robotDebugRoot.add(marker);
        robotContactPoints.push(marker);
      }
      const loader = new STLLoader();
      scene.robotMeshes!.forEach((metadata, index) => {
        const part = new THREE.Group();
        part.name = metadata.name;
        part.matrixAutoUpdate = false;
        applyRobotTransform(part, scene.robotMeshFrames?.[frame]?.[index]);
        robotRoot.add(part);
        robotParts.push(part);
        const meshUrl = modelBaseUrl
          ? `${modelBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(metadata.file)}`
          : `/api/models/unitree-g1/meshes/${encodeURIComponent(metadata.file)}`;
        loader.load(
          meshUrl,
          (geometry) => {
            if (disposed) {
              geometry.dispose();
              return;
            }
            geometry.computeVertexNormals();
            const [red, green, blue, alpha = 1] = metadata.color;
            const material = new THREE.MeshStandardMaterial({
              color: new THREE.Color(red, green, blue),
              metalness: 0.48,
              roughness: 0.34,
              transparent: alpha < 1,
              opacity: alpha,
            });
            const mesh = new THREE.Mesh(geometry, material);
            part.add(mesh);
            setRobotMeshesLoaded((value) => value + 1);
          },
          undefined,
          () => setError(`Unable to load the Unitree G1 mesh ${metadata.file}.`),
        );
      });
    }

    const trailPoints = scene.frames
      .filter((_, index) => index % Math.max(1, Math.floor(scene.frames.length / 240)) === 0)
      .map((item) => toWorld(item[0] ?? bounds.center, new THREE.Vector3()).setY(floorY + 0.012));
    const trail = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(trailPoints),
      new THREE.LineBasicMaterial({ color: 0x2476ef, transparent: true, opacity: 0.82 }),
    );
    trail.visible = showTrail;
    world.add(trail);

    const contactGlows = [0, 1].map(() => {
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(bounds.bodyScale * 0.11, 32),
        new THREE.MeshBasicMaterial({
          color: 0x21bd75,
          transparent: true,
          opacity: 0.26,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = floorY + 0.006;
      world.add(mesh);
      return mesh;
    });

    const reference = createReferenceWall(world, bounds, referenceVideoUrl);
    reference.group.visible = showReference;
    if (reference.video) {
      reference.video.playbackRate = speed;
      if (showReference && playing) void reference.video.play().catch(() => undefined);
    }
    const resizeObserver = new ResizeObserver(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(host);

    const currentRuntime: ViewerRuntime = {
      renderer,
      world,
      camera,
      controls,
      links,
      joints,
      head,
      chest,
      pelvis,
      humanAnatomy,
      humanRoot,
      debugRoot,
      debugLines,
      debugAxes,
      debugLabels,
      robotDebugRoot,
      robotDebugPoints,
      robotDebugAxes,
      robotCollisionSpheres,
      robotContactPoints,
      robotParts,
      contactGlows,
      trail,
      reference: reference.group,
      video: reference.video,
      videoTexture: reference.videoTexture,
      floorY,
      bodyScale: bounds.bodyScale,
      sampledPoints: scene.frames[0].map((point) => [...point]),
      lastFrameA: -1,
      rafCallbacks: 0,
      renderTotalMs: 0,
      droppedVisualFrames: 0,
      maxSyncDifferenceMs: 0,
      lastUiUpdate: 0,
      animation: 0,
      resizeObserver,
    };
    runtime.current = currentRuntime;
    const render = (timestamp: number) => {
      const renderStarted = performance.now();
      currentRuntime.rafCallbacks += 1;
      const master = syncRef.current?.masterVideo.current;
      let mediaTime: number;
      if (master) {
        mediaTime = Number.isFinite(master.currentTime) ? master.currentTime : 0;
      } else if (
        optionsRef.current.showReference &&
        currentRuntime.video &&
        Number.isFinite(currentRuntime.video.currentTime)
      ) {
        // The visible reference video is the local playback clock. The robot
        // is sampled from its media time, so the browser can decode the MP4
        // sequentially instead of being forced through continuous seeks.
        mediaTime = currentRuntime.video.currentTime;
        localClock.current.time = mediaTime;
        localClock.current.lastTimestamp = timestamp;
      } else {
        if (!localClock.current.lastTimestamp) localClock.current.lastTimestamp = timestamp;
        if (optionsRef.current.localPlaying) {
          localClock.current.time +=
            ((timestamp - localClock.current.lastTimestamp) / 1000) *
            optionsRef.current.speed;
          const duration = scene.frames.length / scene.fps;
          if (localClock.current.time >= duration) localClock.current.time %= duration;
        }
        localClock.current.lastTimestamp = timestamp;
        mediaTime = localClock.current.time;
      }
      const sample = sampleMotionFrame(mediaTime, scene.fps, scene.frames.length);
      if (
        currentRuntime.lastFrameA >= 0 &&
        sample.frameA > currentRuntime.lastFrameA + 1 &&
        !master?.seeking
      ) {
        const skipped = sample.frameA - currentRuntime.lastFrameA - 1;
        currentRuntime.droppedVisualFrames += skipped;
        console.debug(
          `[RoboMotion sync] ${skipped} visual frame(s) skipped; motion data remains time-sampled.`,
        );
      }
      currentRuntime.lastFrameA = sample.frameA;
      updateSceneVisuals(
        currentRuntime,
        scene,
        sample,
        optionsRef.current.humanMetrics,
        optionsRef.current.showDebug,
        mediaTime,
      );
      controls.update();
      renderer.render(world, camera);
      currentRuntime.renderTotalMs += performance.now() - renderStarted;
      const latestMediaTime =
        master && Number.isFinite(master.currentTime) ? master.currentTime : mediaTime;
      const syncDifferenceMs = (mediaTime - latestMediaTime) * 1000;
      currentRuntime.maxSyncDifferenceMs = Math.max(
        currentRuntime.maxSyncDifferenceMs,
        Math.abs(syncDifferenceMs),
      );
      if (timestamp - currentRuntime.lastUiUpdate >= 200) {
        currentRuntime.lastUiUpdate = timestamp;
        setDisplayFrame(Math.round(sample.exactFrame));
        setPlaybackDebug({
          mediaTime,
          exactFrame: sample.exactFrame,
          renderedFrame: sample.exactFrame,
          videoDuration: Number.isFinite(master?.duration) ? master!.duration : 0,
          motionDuration: scene.frames.length / scene.fps,
          syncDifferenceMs,
          maxSyncDifferenceMs: currentRuntime.maxSyncDifferenceMs,
          rafCallbacks: currentRuntime.rafCallbacks,
          averageRenderMs:
            currentRuntime.renderTotalMs / Math.max(1, currentRuntime.rafCallbacks),
          droppedVisualFrames: currentRuntime.droppedVisualFrames,
        });
      }
      currentRuntime.animation = requestAnimationFrame(render);
    };
    if (!captureMode) currentRuntime.animation = requestAnimationFrame(render);

    return () => {
      disposed = true;
      cancelAnimationFrame(currentRuntime.animation);
      console.info(
        `[RoboMotion sync] stopped after ${currentRuntime.rafCallbacks} RAF callbacks; ` +
          `${currentRuntime.droppedVisualFrames} visual frame(s) skipped; motion-data frames were not dropped.`,
      );
      resizeObserver.disconnect();
      controls.dispose();
      surface.canvas.removeEventListener("webglcontextlost", recoverContext);
      reference.video?.pause();
      reference.video?.removeAttribute("src");
      reference.video?.load();
      disposeObject(world);
      renderer.dispose();
      renderer.forceContextLoss();
      host.replaceChildren();
      runtime.current = null;
    };
  }, [
    bounds,
    captureMode,
    humanMetrics,
    modelBaseUrl,
    referenceVideoUrl,
    scene,
    viewerActive,
    webglAttempt,
  ]);

  useEffect(() => {
    if (!captureMode) return;
    const current = runtime.current;
    if (!scene || !current) return;
    const expectedMeshes = scene.robotMeshes?.length ?? 0;
    const ready = !error && !webglUnavailable && robotMeshesLoaded >= expectedMeshes;
    const controller: MotionCaptureController = {
      ready,
      error: error ?? (webglUnavailable ? "WebGL is unavailable." : undefined),
      fps: scene.fps,
      frameCount: scene.frames.length,
      duration: scene.frames.length / scene.fps,
      renderTime: async (time: number) => {
        if (!ready) throw new Error("The digital twin is not ready for capture.");
        const boundedTime = Math.max(
          0,
          Math.min(
            Number.isFinite(time) ? time : 0,
            Math.max(0, (scene.frames.length - 1) / scene.fps),
          ),
        );
        const sample = sampleMotionFrame(boundedTime, scene.fps, scene.frames.length);
        updateSceneVisuals(
          current,
          scene,
          sample,
          humanMetrics,
          false,
          boundedTime,
        );
        current.controls.update();
        current.renderer.render(current.world, current.camera);
        setDisplayFrame(Math.round(sample.exactFrame));
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return sample;
      },
    };
    window.__ROBOMOTION_CAPTURE__ = controller;
    return () => {
      if (window.__ROBOMOTION_CAPTURE__ === controller) {
        delete window.__ROBOMOTION_CAPTURE__;
      }
    };
  }, [
    captureMode,
    error,
    humanMetrics,
    robotMeshesLoaded,
    scene,
    webglAttempt,
    webglUnavailable,
  ]);

  useEffect(() => {
    const current = runtime.current;
    // Motion is applied directly inside the single WebGL RAF loop from the
    // authoritative media time. React state only refreshes the HUD.
    if (typeof window !== "undefined") return;
    if (!current || !scene) return;
    const points = scene.frames[frame] ?? scene.frames[0];
    const robotTransforms = scene.robotMeshFrames?.[frame];
    current.robotParts.forEach((part, index) =>
      applyRobotTransform(part, robotTransforms?.[index]),
    );
    current.links.forEach((link) => updateCylinder(link, points));
    current.joints.forEach((joint, index) => {
      const point = points[index];
      joint.visible = Boolean(
        point &&
          joint.userData.connected &&
          !joint.userData.shellCovered &&
          (scene.kind !== "smplx" || showDebug),
      );
      if (point) {
        if (scene.kind === "smplx") joint.position.fromArray(point);
        else toWorld(point, joint.position);
      }
    });

    if (scene.kind === "robot" && current.head && current.chest && current.pelvis) {
      orientShell(current.chest!, points[18], points[19], points[22], points[30]);
      orientShell(current.pelvis!, points[0], points[16], points[1], points[9]);
      if (points[18] && points[19]) {
        const chest = toWorld(points[18], new THREE.Vector3());
        const head = toWorld(points[19], new THREE.Vector3());
        current.head!.visible = true;
        current.head!.position.copy(head).add(
          head.clone().sub(chest).normalize().multiplyScalar(current.bodyScale * 0.045),
        );
        current.head!.quaternion.copy(current.chest!.quaternion);
      } else current.head!.visible = false;
    } else if (scene.kind === "smplx" && current.humanAnatomy && humanMetrics) {
      const anatomy = current.humanAnatomy;
      orientShell(
        anatomy.chest,
        points[SMPLX.spine2],
        points[SMPLX.neck],
        points[SMPLX.left_shoulder],
        points[SMPLX.right_shoulder],
        true,
      );
      orientShell(
        anatomy.abdomen,
        points[SMPLX.spine1],
        points[SMPLX.spine3],
        points[SMPLX.left_hip],
        points[SMPLX.right_hip],
        true,
      );
      orientShell(
        anatomy.pelvis,
        points[SMPLX.pelvis],
        points[SMPLX.spine1],
        points[SMPLX.left_hip],
        points[SMPLX.right_hip],
        true,
      );
      const neck = points[SMPLX.neck];
      const headJoint = points[SMPLX.head];
      if (neck && headJoint) {
        const direction = TEMP_DIRECTION.fromArray(headJoint).sub(TEMP_A.fromArray(neck));
        const length = direction.length();
        anatomy.head.visible = length > 1e-6;
        if (length > 1e-6) {
          direction.normalize();
          anatomy.head.position
            .fromArray(headJoint)
            .addScaledVector(direction, humanMetrics.headLength * 0.28);
          anatomy.head.quaternion.copy(anatomy.chest.quaternion);
        }
      } else anatomy.head.visible = false;
      orientExtremity(
        anatomy.leftHand,
        points[SMPLX.left_elbow],
        points[SMPLX.left_wrist],
        humanMetrics.handLength,
      );
      orientExtremity(
        anatomy.rightHand,
        points[SMPLX.right_elbow],
        points[SMPLX.right_wrist],
        humanMetrics.handLength,
      );
      orientExtremity(
        anatomy.leftFoot,
        points[SMPLX.left_ankle],
        points[SMPLX.left_foot],
        humanMetrics.footLength,
      );
      orientExtremity(
        anatomy.rightFoot,
        points[SMPLX.right_ankle],
        points[SMPLX.right_foot],
        humanMetrics.footLength,
      );
    }

    if (scene.kind === "smplx" && current.debugRoot) {
      current.debugRoot.visible = showDebug;
      if (current.debugAxes && points[SMPLX.pelvis]) {
        current.debugAxes.position.fromArray(points[SMPLX.pelvis]);
      }
      const attribute = current.debugLines?.geometry.getAttribute("position");
      if (attribute instanceof THREE.BufferAttribute) {
        scene.edges.forEach(([parent, child], edgeIndex) => {
          const start = points[parent];
          const end = points[child];
          attribute.setXYZ(edgeIndex * 2, start[0], start[1], start[2]);
          attribute.setXYZ(edgeIndex * 2 + 1, end[0], end[1], end[2]);
        });
        attribute.needsUpdate = true;
      }
      current.debugLabels?.forEach((label, index) => {
        const point = points[index];
        if (!point) return;
        label.position.fromArray(point);
        label.position.z += current.bodyScale * 0.025;
      });
    }

    const feet = scene.kind === "robot" ? [points[7], points[15]] : [points[10], points[11]];
    current.contactGlows.forEach((glow, index) => {
      const foot = feet[index];
      glow.visible = Boolean(foot);
      if (!foot) return;
      toWorld(foot, glow.position);
      glow.position.y = current.floorY + 0.006;
      const distance = Math.abs((foot[2] ?? current.floorY) - current.floorY);
      glow.material.opacity = distance < current.bodyScale * 0.09 ? 0.36 : 0.09;
    });

    if (current.video) {
      const time = frame / scene.fps;
      if (Number.isFinite(time) && Math.abs(current.video.currentTime - time) > 0.12) {
        current.video.currentTime = Math.min(
          time,
          Number.isFinite(current.video.duration) ? current.video.duration : time,
        );
      }
    }
  }, [frame, humanMetrics, scene, showDebug]);

  useEffect(() => {
    const video = runtime.current?.video;
    if (!video) return;
    video.playbackRate = sync?.masterVideo.current?.playbackRate ?? speed;
    if (playing && showReference) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, showReference, speed, sync]);

  useEffect(() => {
    if (runtime.current) {
      runtime.current.reference.visible = showReference;
      if (!showReference) runtime.current.video?.pause();
    }
  }, [showReference]);

  useEffect(() => {
    if (runtime.current) runtime.current.trail.visible = showTrail;
  }, [showTrail]);

  useEffect(() => {
    if (runtime.current?.debugRoot) runtime.current.debugRoot.visible = showDebug;
  }, [showDebug]);

  const applyView = (next: typeof view) => {
    setView(next);
    const current = runtime.current;
    if (!current || !bounds) return;
    const target = toWorld(bounds.center);
    target.y = bounds.min[2] + bounds.bodyScale * 0.62;
    current.controls.target.copy(target);
    const distance = bounds.bodyScale * 3.5;
    const offset =
      next === "front"
        ? new THREE.Vector3(0, bounds.bodyScale * 0.45, distance)
        : next === "side"
          ? new THREE.Vector3(distance, bounds.bodyScale * 0.45, 0)
          : next === "top"
            ? new THREE.Vector3(0, distance, 0.01)
            : new THREE.Vector3(distance * 0.68, distance * 0.44, distance * 0.8);
    current.camera.position.copy(target).add(offset);
    current.camera.up.set(0, 1, 0);
    current.controls.update();
  };

  const reset = () => applyView("studio");
  const fullscreen = () => {
    if (container.current?.requestFullscreen) {
      void container.current.requestFullscreen();
    }
  };

  const progress = scene ? Math.round(((frame + 1) / scene.frames.length) * 100) : 0;
  const debugPoints =
    scene?.kind === "smplx"
      ? [
          SMPLX.pelvis,
          SMPLX.left_shoulder,
          SMPLX.right_shoulder,
          SMPLX.left_knee,
          SMPLX.right_knee,
          SMPLX.left_ankle,
          SMPLX.right_ankle,
        ].map((index) => ({
          name: (scene.jointNames ?? SMPLX_BODY_JOINT_NAMES)[index],
          value: scene.frames[frame]?.[index],
        }))
      : [];
  const robotDiagnostic =
    scene?.kind === "robot" ? scene.diagnostics?.frames[frame] : undefined;
  const browserRoot = robotDiagnostic
    ? mujocoPositionToThree(robotDiagnostic.rootPosition)
    : undefined;
  return (
    <section
      ref={container}
      className={`motion-3d motion-3d--professional motion-3d--${controls}${captureMode ? " motion-3d--capture" : ""}`}
    >
      <div className="motion-3d__heading">
        <div>
          <small>DIGITAL TWIN REVIEW</small>
          <b>{title}</b>
          <span>
            {webglUnavailable
              ? "Reconnecting the interactive WebGL digital twin…"
              : scene
              ? `${scene.kind === "robot" ? "Unitree G1 · 29 DoF" : "SMPL-X human"} · ${hasUnitreeMeshData(scene) ? "official robot mesh" : "world-space WebGL"}`
              : "Loading scene geometry…"}
          </span>
        </div>
        <div className="motion-3d__heading-actions">
          <span className="motion-3d__live"><i /> synchronized</span>
          {downloadUrl ? (
            <a href={downloadUrl} target="_blank">
              MP4 evidence
            </a>
          ) : null}
          <button type="button" aria-label="Open fullscreen" onClick={fullscreen}>
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      <div className="motion-3d__viewport">
        <div ref={mount} className="motion-3d__webgl" aria-label={`${title} interactive 3D viewer`} />
        {webglUnavailable ? (
          <div className="motion-3d__reconnect">
            <RotateCcw size={22} />
            <b>Restoring the interactive digital twin</b>
            <p>The GPU context was interrupted. RoboMotion is reconnecting it automatically.</p>
            <button type="button" onClick={() => setWebglAttempt((attempt) => attempt + 1)}>
              Retry now
            </button>
          </div>
        ) : null}
        {scene && hasUnitreeMeshData(scene) && robotMeshesLoaded < (scene.robotMeshes?.length ?? 0) ? (
          <p className="motion-3d__model-status">
            Loading Unitree G1 digital twin · {robotMeshesLoaded}/{scene.robotMeshes?.length}
          </p>
        ) : null}
        {error ? <p className="motion-3d__message">{error}</p> : null}
        {!scene && !error ? <p className="motion-3d__message">Preparing the digital twin…</p> : null}
        <div className="motion-3d__hud motion-3d__hud--top" hidden={webglUnavailable}>
          <span>
            <Box size={12} /> {scene?.kind === "robot" ? "G1 DIGITAL TWIN" : "SMPL-X MOTION"}
          </span>
          <span>FRAME {scene ? String(frame + 1).padStart(4, "0") : "—"}</span>
        </div>
        <div className="motion-3d__hud motion-3d__hud--bottom" hidden={webglUnavailable}>
          <span>Drag to orbit</span>
          <span>Wheel to dolly</span>
          <span>Right-drag to pan</span>
        </div>
        {showDebug && scene ? (
          <aside className="motion-3d__debug">
            <strong>
              {scene.kind === "smplx" ? "SMPL-X BODY-22" : "UNITREE G1 · MUJOCO FK"} ·
              Z-UP METERS · FRAME {frame + 1}
            </strong>
            {playbackDebug ? (
              <>
                <span>video: {playbackDebug.mediaTime.toFixed(3)} s</span>
                <span>expected/rendered: {playbackDebug.exactFrame.toFixed(2)} / {playbackDebug.renderedFrame.toFixed(2)}</span>
                <span>motion FPS: {scene.fps.toFixed(3)}</span>
                <span>video/motion duration: {playbackDebug.videoDuration.toFixed(3)} / {playbackDebug.motionDuration.toFixed(3)} s</span>
                <span>sync difference: {playbackDebug.syncDifferenceMs.toFixed(2)} ms</span>
                <span>maximum sync difference: {playbackDebug.maxSyncDifferenceMs.toFixed(2)} ms</span>
                <span>RAF callbacks: {playbackDebug.rafCallbacks}</span>
                <span>average render: {playbackDebug.averageRenderMs.toFixed(2)} ms</span>
                <span>dropped visual / motion-data frames: {playbackDebug.droppedVisualFrames} / 0</span>
              </>
            ) : null}
            {debugPoints.map(({ name, value }) => (
              <span key={name}>
                {name}:{" "}
                {value?.map((component) => Number(component).toFixed(3)).join(", ") ?? "missing"}
              </span>
            ))}
            {robotDiagnostic ? (
              <>
                <span>root: {robotDiagnostic.rootPosition.map((value) => value.toFixed(3)).join(", ")}</span>
                <span>browser XYZ: {browserRoot?.map((value) => value.toFixed(3)).join(", ")}</span>
                <span>root wxyz: {robotDiagnostic.rootQuaternionWxyz.map((value) => value.toFixed(3)).join(", ")}</span>
                <span>qpos: frame {frame} · {robotDiagnostic.qpos.length} values</span>
                <span>left/right sole: {robotDiagnostic.leftSoleHeight.toFixed(4)} / {robotDiagnostic.rightSoleHeight.toFixed(4)} m</span>
                <span>left/right penetration: {(robotDiagnostic.leftPenetration * 1000).toFixed(1)} / {(robotDiagnostic.rightPenetration * 1000).toFixed(1)} mm</span>
                <span>MuJoCo contacts: L={String(robotDiagnostic.leftContact)} R={String(robotDiagnostic.rightContact)}</span>
                <span>expected stance: L={String(robotDiagnostic.leftExpectedContact)} R={String(robotDiagnostic.rightExpectedContact)}</span>
                <span>floor: {(scene.diagnostics?.floorHeight ?? scene.floorHeight ?? 0).toFixed(4)} m</span>
              </>
            ) : null}
          </aside>
        ) : null}
        <div className="motion-3d__progress" hidden={webglUnavailable} style={{ width: `${progress}%` }} />
      </div>
      <div className="motion-3d__toolbar">
        <div className="motion-3d__playback">
          <button
            type="button"
            className="motion-3d__primary-control"
            aria-label={playing ? "Pause" : "Play"}
            disabled={webglUnavailable}
            onClick={() => setPlaying(!playing)}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <input
            aria-label="Frame"
            type="range"
            min="0"
            max={Math.max(0, (scene?.frames.length ?? 1) - 1)}
            value={frame}
            disabled={webglUnavailable}
            onChange={(event) => {
              setPlaying(false);
              setFrame(Number(event.target.value));
            }}
          />
          <span className="motion-3d__counter">
            {scene ? `${frame + 1} / ${scene.frames.length}` : "—"}
          </span>
          <select
            aria-label="Playback speed"
            value={speed}
            disabled={webglUnavailable}
            onChange={(event) => {
              const nextSpeed = Number(event.target.value);
              setSpeed(nextSpeed);
              if (sync?.masterVideo.current) sync.masterVideo.current.playbackRate = nextSpeed;
            }}
          >
            <option value="0.5">0.5×</option>
            <option value="1">1×</option>
            <option value="2">2×</option>
          </select>
        </div>
        {controls === "full" ? (
          <div className="motion-3d__tools">
            <button
              type="button"
              className={showReference ? "is-active" : ""}
              disabled={!referenceVideoUrl || webglUnavailable}
              onClick={toggleReference}
            >
              {showReference ? <Video size={14} /> : <EyeOff size={14} />} Reference
            </button>
            <button
              type="button"
              className={showTrail ? "is-active" : ""}
              disabled={webglUnavailable}
              onClick={() => setShowTrail((value) => !value)}
            >
              <Route size={14} /> Trajectory
            </button>
            {scene ? (
              <button
                type="button"
                className={showDebug ? "is-active" : ""}
                disabled={webglUnavailable}
                onClick={() => setShowDebug((value) => !value)}
              >
                <Bug size={14} /> Debug
              </button>
            ) : null}
            <select
              aria-label="Camera view"
              value={view}
              disabled={webglUnavailable}
              onChange={(event) => applyView(event.target.value as typeof view)}
            >
              <option value="studio">Studio view</option>
              <option value="front">Front view</option>
              <option value="side">Side view</option>
              <option value="top">Top view</option>
            </select>
            <button type="button" aria-label="Reset camera" disabled={webglUnavailable} onClick={reset}>
              <RotateCcw size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
