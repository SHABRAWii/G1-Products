import assert from "node:assert/strict";
import test from "node:test";

import { artifactDownloadFilename, contentDisposition } from "../lib/artifact-download";

test("generated artifacts receive stable job and stage filenames", () => {
  assert.equal(artifactDownloadFilename({
    assetName: "cms65sxt70009cjqsrbd14zqy · training · policy-checkpoint.pt",
    contentType: "application/octet-stream",
    jobName: "Runner study",
  }), "Runner-study-training-policy-checkpoint.pt");
});

test("uploaded files keep their useful original extension", () => {
  assert.equal(artifactDownloadFilename({
    assetName: "runner source.mp4",
    contentType: "video/mp4",
  }), "runner-source.mp4");
});

test("content disposition includes ASCII and UTF-8 names", () => {
  assert.match(contentDisposition("attachment", "training-report.json"), /^attachment; filename="training-report\.json"; filename\*=UTF-8''/);
});
