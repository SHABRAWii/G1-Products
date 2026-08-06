import assert from "node:assert/strict";
import test from "node:test";
import { decideRunPodAction } from "../lib/runpod-controller";

test("starts a stopped pod when GPU work is ready", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: true,
      readyWorker: false,
      podRunning: false,
      idleExpired: false,
      imageUpdatePending: false,
    }),
    "START",
  );
});

test("dispatches queued work after a worker becomes ready", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: true,
      readyWorker: true,
      podRunning: true,
      idleExpired: false,
      imageUpdatePending: false,
    }),
    "DISPATCH",
  );
});

test("stops only after the idle window expires", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: false,
      readyWorker: true,
      podRunning: true,
      idleExpired: true,
      imageUpdatePending: false,
    }),
    "STOP",
  );
});

test("updates a stopped idle pod before its next start", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: false,
      readyWorker: false,
      podRunning: false,
      idleExpired: false,
      imageUpdatePending: true,
    }),
    "UPDATE",
  );
});

test("updates a stopped pod before starting newly queued work", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: true,
      readyWorker: false,
      podRunning: false,
      idleExpired: false,
      imageUpdatePending: true,
    }),
    "UPDATE",
  );
});

test("a manual hold prevents queued work from restarting a stopped pod", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: true,
      readyWorker: false,
      podRunning: false,
      idleExpired: false,
      imageUpdatePending: false,
      manualStop: true,
    }),
    "WAIT",
  );
});

test("a manual stop request stops a running pod", () => {
  assert.equal(
    decideRunPodAction({
      pendingGpuWork: false,
      readyWorker: true,
      podRunning: true,
      idleExpired: false,
      imageUpdatePending: false,
      manualStop: true,
    }),
    "STOP",
  );
});
