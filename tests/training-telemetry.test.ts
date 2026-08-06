import assert from "node:assert/strict";
import test from "node:test";

import {
  compactTrainingReport,
  completeTrainingTelemetry,
  createTrainingTelemetry,
  ingestTrainingLog,
} from "../lib/training-telemetry";

test("RSL training output becomes structured live telemetry", () => {
  const telemetry = createTrainingTelemetry(5);
  [
    "Learning iteration 3/5",
    "Total steps: 102400",
    "Steps per second: 21499",
    "Mean reward: -1.27",
    "Mean episode length: 10.50",
    "Metrics/motion/error_anchor_pos: 0.1389",
    "Episode_Termination/anchor_pos: 2.6250",
    "Episode_Termination/ee_body_pos: 101.0417",
  ].forEach((line) => ingestTrainingLog(telemetry, line));

  assert.equal(telemetry.currentIteration, 3);
  assert.equal(telemetry.latest?.totalSteps, 102400);
  assert.equal(telemetry.latest?.errors.error_anchor_pos, 0.1389);
  assert.deepEqual(telemetry.dominantTermination, { name: "ee_body_pos", value: 101.0417 });
  assert.deepEqual(telemetry.best, { iteration: 3, meanReward: -1.27 });
});

test("best reward is retained and completion is distinct from evaluation", () => {
  const telemetry = createTrainingTelemetry(2);
  ["Learning iteration 0/2", "Mean reward: -2", "Learning iteration 1/2", "Mean reward: -3"]
    .forEach((line) => ingestTrainingLog(telemetry, line));
  completeTrainingTelemetry(telemetry, true);
  assert.deepEqual(telemetry.best, { iteration: 0, meanReward: -2 });
  assert.equal(telemetry.outcome, "COMPLETED");
  assert.equal(telemetry.qualityStatus, "EVALUATION_PENDING");
});

test("large training histories are compacted for transactional persistence", () => {
  const history = Array.from({ length: 3000 }, (_, iteration) => ({ iteration, meanReward: iteration / 10 }));
  const compact = compactTrainingReport({
    schemaVersion: "training.metrics/v1",
    history,
    latest: history.at(-1),
    best: history.at(-1),
    ignoredLargeField: "x".repeat(10_000),
  }) as Record<string, unknown>;
  assert.ok(Array.isArray(compact.history));
  assert.ok((compact.history as unknown[]).length <= 241);
  assert.equal(compact.historySampledFrom, 3000);
  assert.equal(compact.ignoredLargeField, undefined);
  assert.deepEqual(compact.latest, history.at(-1));
});
