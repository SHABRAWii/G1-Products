import assert from "node:assert/strict";
import test from "node:test";
import { PipelineStage } from "@prisma/client";

import {
  deserializeWorkerDetail,
  isExecutablePipelineStage,
  parseWorkerStages,
  serializeWorkerDetail,
  workerRequirements,
} from "../lib/worker-capabilities";

test("motion and training workers advertise independent capabilities", () => {
  const motion = parseWorkerStages("pose_extraction,robot_retargeting,visualization");
  assert.deepEqual(workerRequirements(motion), { promptHmr: true, gmr: true, training: false });

  const training = parseWorkerStages("training");
  assert.deepEqual(workerRequirements(training), { promptHmr: false, gmr: false, training: true });
});

test("unsupported worker capabilities fail before a heartbeat is published", () => {
  assert.throws(() => parseWorkerStages("training,unknown"), /Unsupported/);
});

test("heartbeat capability serialization is explicit and round-trippable", () => {
  const stages = new Set([PipelineStage.TRAINING]);
  const detail = deserializeWorkerDetail(serializeWorkerDetail(stages, null));
  assert.deepEqual([...detail.capabilities], [PipelineStage.TRAINING]);
  assert.equal(detail.error, null);
});

test("an empty advertised capability set is not interpreted as all stages", () => {
  const detail = deserializeWorkerDetail(JSON.stringify({ capabilities: [], error: null }));
  assert.equal(detail.capabilities.size, 0);
  assert.match(detail.error ?? "", /did not advertise/);
});

test("human and provider stages do not require a local worker", () => {
  assert.equal(isExecutablePipelineStage(PipelineStage.POSE_REVIEW), false);
  assert.equal(isExecutablePipelineStage(PipelineStage.VIDEO_GENERATION), false);
  assert.equal(isExecutablePipelineStage(PipelineStage.TRAINING), true);
});
