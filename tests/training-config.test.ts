import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultTrainingStageConfig,
  normalizeTrainingStageConfig,
} from "../lib/training-config";

test("training configuration defaults are stable and immutable per job", () => {
  assert.deepEqual(normalizeTrainingStageConfig(undefined), defaultTrainingStageConfig);
});

test("training configuration accepts bounded operator values", () => {
  assert.deepEqual(normalizeTrainingStageConfig({
    numEnvs: 1024,
    maxIterations: 5000,
    outputFps: 60,
    maxRuntimeMinutes: 720,
  }), {
    ...defaultTrainingStageConfig,
    numEnvs: 1024,
    maxIterations: 5000,
    outputFps: 60,
    maxRuntimeMinutes: 720,
  });
});

test("training configuration rejects invalid resource and runtime values", () => {
  assert.throws(() => normalizeTrainingStageConfig({ numEnvs: 0 }), /numEnvs/);
  assert.throws(() => normalizeTrainingStageConfig({ maxIterations: 1.5 }), /maxIterations/);
  assert.throws(() => normalizeTrainingStageConfig({ outputFps: Number.NaN }), /outputFps/);
  assert.throws(() => normalizeTrainingStageConfig({ maxRuntimeMinutes: 20_000 }), /maxRuntimeMinutes/);
  assert.throws(() => normalizeTrainingStageConfig({ videoIntervalSteps: 0 }), /videoIntervalSteps/);
  assert.throws(() => normalizeTrainingStageConfig({ videoWidth: 200 }), /videoWidth/);
});
