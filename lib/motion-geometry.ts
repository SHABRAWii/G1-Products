export type Vector3Tuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

const EPSILON = 1e-8;

export function finiteVector(value: unknown): value is Vector3Tuple {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/** Convert right-handed Z-up source coordinates to right-handed Three.js Y-up. */
export function sourceZUpToThreeYUp([x, y, z]: Vector3Tuple): Vector3Tuple {
  return [x, z, -y];
}

/** One authoritative MuJoCo (Z-up) to Three.js (Y-up) position conversion. */
export const mujocoPositionToThree = sourceZUpToThreeYUp;

/** Directions use the same basis as positions, without any translation. */
export const mujocoDirectionToThree = sourceZUpToThreeYUp;

/**
 * Convert a MuJoCo `(w, x, y, z)` quaternion into a Three.js `(x, y, z, w)`
 * quaternion by conjugating it with the -90° X basis rotation.
 */
export function mujocoQuaternionToThree([
  w,
  x,
  y,
  z,
]: [number, number, number, number]): QuaternionTuple {
  const basis: QuaternionTuple = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const source: QuaternionTuple = [x, y, z, w];
  const inverse: QuaternionTuple = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  return multiplyQuaternion(multiplyQuaternion(basis, source), inverse);
}

export function multiplyQuaternion(
  [ax, ay, az, aw]: QuaternionTuple,
  [bx, by, bz, bw]: QuaternionTuple,
): QuaternionTuple {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** MuJoCo floor `z` is the same numeric height as Three.js floor `y`. */
export function mujocoFloorToThreeY(floorZ: number) {
  if (!Number.isFinite(floorZ)) throw new Error("MuJoCo floor height must be finite.");
  return floorZ;
}

/** Convert an axis-angle rotation in radians to an `(x, y, z, w)` quaternion. */
export function axisAngleToQuaternion([x, y, z]: Vector3Tuple): QuaternionTuple {
  const angle = Math.hypot(x, y, z);
  if (angle < EPSILON) return [0, 0, 0, 1];
  const scale = Math.sin(angle * 0.5) / angle;
  return [x * scale, y * scale, z * scale, Math.cos(angle * 0.5)];
}

/**
 * Compute the stable transform for unit-height geometry whose local long axis
 * is +Y. The quaternion is returned as `(x, y, z, w)`.
 */
export function boneTransform(
  parent: Vector3Tuple,
  child: Vector3Tuple,
): {
  midpoint: Vector3Tuple;
  direction: Vector3Tuple;
  length: number;
  quaternion: QuaternionTuple;
} {
  const dx = child[0] - parent[0];
  const dy = child[1] - parent[1];
  const dz = child[2] - parent[2];
  const length = Math.hypot(dx, dy, dz);
  const midpoint: Vector3Tuple = [
    (parent[0] + child[0]) * 0.5,
    (parent[1] + child[1]) * 0.5,
    (parent[2] + child[2]) * 0.5,
  ];
  if (length < EPSILON) {
    return {
      midpoint,
      direction: [0, 1, 0],
      length: 0,
      quaternion: [0, 0, 0, 1],
    };
  }
  const nx = dx / length;
  const ny = dy / length;
  const nz = dz / length;
  const direction: Vector3Tuple = [nx, ny, nz];
  // Quaternion rotating local +Y to direction. Cross(+Y, direction) is
  // `(dz, 0, -dx)` and dot(+Y, direction) is `dy`.
  if (ny < -1 + EPSILON) {
    return { midpoint, direction, length, quaternion: [1, 0, 0, 0] };
  }
  const qx = nz;
  const qy = 0;
  const qz = -nx;
  const qw = 1 + ny;
  const norm = Math.hypot(qx, qy, qz, qw);
  return {
    midpoint,
    direction,
    length,
    quaternion:
      norm < EPSILON ? [0, 0, 0, 1] : [qx / norm, qy / norm, qz / norm, qw / norm],
  };
}
