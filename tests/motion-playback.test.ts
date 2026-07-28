import assert from "node:assert/strict";
import test from "node:test";

import {
  AnimationLoopGuard,
  lerpVector,
  sampleMotionFrame,
  slerpQuaternion,
} from "../lib/motion-playback";

test("video time maps directly to bounded pose frames", () => {
  assert.deepEqual(sampleMotionFrame(1.25, 12, 96), {
    exactFrame: 15,
    frameA: 15,
    frameB: 16,
    alpha: 0,
  });
  assert.equal(sampleMotionFrame(99, 12, 96).frameA, 95);
});

test("fractional frames interpolate translation without mutating inputs", () => {
  const first = [0, 2, 4] as [number, number, number];
  const second = [10, 6, 0] as [number, number, number];
  assert.deepEqual(lerpVector(first, second, 0.25), [2.5, 3, 3]);
  assert.deepEqual(first, [0, 2, 4]);
  assert.deepEqual(second, [10, 6, 0]);
});

test("quaternion interpolation uses the shortest path", () => {
  const angle = Math.PI / 2;
  const rotation = [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)] as [
    number,
    number,
    number,
    number,
  ];
  const negated = rotation.map((value) => -value) as [
    number,
    number,
    number,
    number,
  ];
  const result = slerpQuaternion(rotation, negated, 0.5);
  result.forEach((value, index) =>
    assert.ok(Math.abs(value - rotation[index]) < 1e-8),
  );
});

test("pause freezes and seek updates immediately because media time is authoritative", () => {
  const pausedTime = 2.375;
  const first = sampleMotionFrame(pausedTime, 12, 96);
  const laterRaf = sampleMotionFrame(pausedTime, 12, 96);
  assert.deepEqual(laterRaf, first);
  const sought = sampleMotionFrame(6.5, 12, 96);
  assert.equal(sought.exactFrame, 78);
});

test("playback speed does not alter time-to-frame mapping", () => {
  const mediaCurrentTimeAfterOneWallSecondAt2x = 2;
  assert.equal(
    sampleMotionFrame(mediaCurrentTimeAfterOneWallSecondAt2x, 12, 96).exactFrame,
    24,
  );
});

test("an eight-second clip has no cumulative source-clock drift", () => {
  const fps = 12;
  const frames = 96;
  let maximumClockErrorMs = 0;
  for (const playbackRate of [0.5, 1, 1.5, 2]) {
    for (let wallFrame = 0; wallFrame <= 8 * 60 / playbackRate; wallFrame += 1) {
      const mediaTime = Math.min(8, wallFrame / 60 * playbackRate);
      const sample = sampleMotionFrame(mediaTime, fps, frames);
      const expectedFrame = Math.min(mediaTime * fps, frames - 1);
      maximumClockErrorMs = Math.max(
        maximumClockErrorMs,
        Math.abs(sample.exactFrame - expectedFrame) / fps * 1000,
      );
    }
  }
  assert.equal(maximumClockErrorMs, 0);
});

test("animation loop guard prevents duplicate loops", () => {
  const guard = new AnimationLoopGuard();
  let requests = 0;
  assert.equal(guard.start(() => ++requests), true);
  assert.equal(guard.start(() => ++requests), false);
  assert.equal(requests, 1);
  let cancelled = 0;
  assert.equal(guard.stop((requestId) => (cancelled = requestId)), true);
  assert.equal(cancelled, 1);
  assert.equal(guard.stop(() => undefined), false);
});
