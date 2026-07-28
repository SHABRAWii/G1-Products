import type { QuaternionTuple, Vector3Tuple } from "./motion-geometry";

const EPSILON = 1e-8;

export type MotionFrameSample = {
  exactFrame: number;
  frameA: number;
  frameB: number;
  alpha: number;
};

/**
 * Map the authoritative media time to motion frames. The media element, not an
 * accumulated frame counter, is the clock.
 */
export function sampleMotionFrame(
  mediaTime: number,
  motionFps: number,
  frameCount: number,
): MotionFrameSample {
  if (!Number.isFinite(mediaTime) || !Number.isFinite(motionFps) || motionFps <= 0) {
    throw new Error("Media time and motion FPS must be finite; motion FPS must be positive.");
  }
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error("Motion frame count must be a positive integer.");
  }
  const exactFrame = Math.max(0, Math.min(frameCount - 1, mediaTime * motionFps));
  const frameA = Math.floor(exactFrame);
  const frameB = Math.min(frameA + 1, frameCount - 1);
  return { exactFrame, frameA, frameB, alpha: exactFrame - frameA };
}

export function lerpVector(
  first: Vector3Tuple,
  second: Vector3Tuple,
  alpha: number,
  target: Vector3Tuple = [0, 0, 0],
): Vector3Tuple {
  const bounded = Math.max(0, Math.min(1, alpha));
  target[0] = first[0] + (second[0] - first[0]) * bounded;
  target[1] = first[1] + (second[1] - first[1]) * bounded;
  target[2] = first[2] + (second[2] - first[2]) * bounded;
  return target;
}

/** Shortest-path quaternion interpolation for `(x, y, z, w)` values. */
export function slerpQuaternion(
  first: QuaternionTuple,
  second: QuaternionTuple,
  alpha: number,
  target: QuaternionTuple = [0, 0, 0, 1],
): QuaternionTuple {
  const bounded = Math.max(0, Math.min(1, alpha));
  let [bx, by, bz, bw] = second;
  let dot =
    first[0] * bx +
    first[1] * by +
    first[2] * bz +
    first[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  dot = Math.max(-1, Math.min(1, dot));
  let firstWeight: number;
  let secondWeight: number;
  if (1 - dot < 1e-6) {
    firstWeight = 1 - bounded;
    secondWeight = bounded;
  } else {
    const angle = Math.acos(dot);
    const denominator = Math.sin(angle);
    firstWeight = Math.sin((1 - bounded) * angle) / denominator;
    secondWeight = Math.sin(bounded * angle) / denominator;
  }
  target[0] = first[0] * firstWeight + bx * secondWeight;
  target[1] = first[1] * firstWeight + by * secondWeight;
  target[2] = first[2] * firstWeight + bz * secondWeight;
  target[3] = first[3] * firstWeight + bw * secondWeight;
  const norm = Math.hypot(target[0], target[1], target[2], target[3]);
  if (norm < EPSILON) {
    target[0] = 0;
    target[1] = 0;
    target[2] = 0;
    target[3] = 1;
  } else {
    target[0] /= norm;
    target[1] /= norm;
    target[2] /= norm;
    target[3] /= norm;
  }
  return target;
}

export class AnimationLoopGuard {
  private requestId: number | null = null;

  get active() {
    return this.requestId !== null;
  }

  start(request: () => number) {
    if (this.requestId !== null) return false;
    this.requestId = request();
    return true;
  }

  replace(requestId: number) {
    this.requestId = requestId;
  }

  stop(cancel: (requestId: number) => void) {
    if (this.requestId === null) return false;
    cancel(this.requestId);
    this.requestId = null;
    return true;
  }
}
