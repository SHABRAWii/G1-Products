import assert from "node:assert/strict";
import test from "node:test";

import {
  axisAngleToQuaternion,
  boneTransform,
  mujocoDirectionToThree,
  mujocoFloorToThreeY,
  mujocoQuaternionToThree,
  sourceZUpToThreeYUp,
  type QuaternionTuple,
  type Vector3Tuple,
} from "../lib/motion-geometry";

function rotateVector(vector: Vector3Tuple, [qx, qy, qz, qw]: QuaternionTuple) {
  const [x, y, z] = vector;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ] as Vector3Tuple;
}

function close(actual: number[], expected: number[], tolerance = 1e-7) {
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < tolerance, `${actual} != ${expected}`),
  );
}

test("axis-angle radians convert to a quaternion", () => {
  close(axisAngleToQuaternion([0, 0, Math.PI]), [0, 0, 1, 0]);
});

test("Z-up source coordinates convert once to right-handed Three.js Y-up", () => {
  assert.deepEqual(sourceZUpToThreeYUp([1, 2, 3]), [1, 3, -2]);
  assert.deepEqual(mujocoDirectionToThree([1, 0, 0]), [1, 0, -0]);
  assert.deepEqual(mujocoDirectionToThree([0, 1, 0]), [0, 0, -1]);
  assert.deepEqual(mujocoDirectionToThree([0, 0, 1]), [0, 1, -0]);
  assert.equal(mujocoFloorToThreeY(0.125), 0.125);
});

test("MuJoCo wxyz root rotation is converted through the same basis", () => {
  close(mujocoQuaternionToThree([1, 0, 0, 0]), [0, 0, 0, 1]);
  const half = Math.SQRT1_2;
  const converted = mujocoQuaternionToThree([half, 0, 0, half]);
  // A +90 degree MuJoCo Z rotation becomes a +90 degree Three.js Y rotation.
  close(rotateVector([1, 0, 0], converted), [0, 0, -1]);
});

test("bone orientation rotates local +Y onto the endpoint direction", () => {
  const transform = boneTransform([1, 1, 1], [3, 1, 1]);
  close(transform.midpoint, [2, 1, 1]);
  assert.equal(transform.length, 2);
  close(rotateVector([0, 1, 0], transform.quaternion), [1, 0, 0]);
});

test("zero-length bones are handled without invalid values", () => {
  const transform = boneTransform([2, 3, 4], [2, 3, 4]);
  assert.equal(transform.length, 0);
  assert.ok(transform.quaternion.every(Number.isFinite));
});
