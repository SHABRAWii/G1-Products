import assert from "node:assert/strict";
import test from "node:test";
import { artifactDisplayName } from "../lib/artifact-display-name";

test("generated artifact IDs are hidden from display labels", () => {
  assert.equal(
    artifactDisplayName(
      "cms1fk1zs000scjhjb5vjxffh · pose_extraction · smplx.npz",
    ),
    "pose_extraction · smplx.npz",
  );
});

test("operator-provided and short asset names remain unchanged", () => {
  assert.equal(artifactDisplayName("T1"), "T1");
  assert.equal(artifactDisplayName("Runner source.mp4"), "Runner source.mp4");
});

test("a long prefix is retained unless it matches a generated pipeline name", () => {
  assert.equal(
    artifactDisplayName(
      "thisisalongoperatorname123 · reference · source.mp4",
    ),
    "thisisalongoperatorname123 · reference · source.mp4",
  );
});
