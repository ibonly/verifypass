"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFlow, STEP_SEQUENCES } = require("../src/flow");

test("step sequences per verification type (includes active-liveness step)", () => {
  assert.deepEqual(createFlow("ID_AND_FACE").steps, ["document", "liveness", "face", "processing", "complete"]);
  assert.deepEqual(createFlow("FACE_ONLY").steps, ["liveness", "face", "processing", "complete"]);
  assert.deepEqual(createFlow("ID_ONLY").steps, ["document", "processing", "complete"]);
  assert.throws(() => createFlow("NOPE"), /Unknown verificationType/);
});

test("advance walks steps and clamps at the end", () => {
  const flow = createFlow("ID_AND_FACE");
  assert.equal(flow.state().step, "document");
  flow.advance();
  assert.equal(flow.state().step, "liveness");
  flow.advance();
  assert.equal(flow.state().step, "face");
  flow.advance();
  flow.advance();
  assert.equal(flow.state().step, "complete");
  flow.advance(); // no-op
  assert.equal(flow.state().step, "complete");
  assert.equal(flow.state().done, true);
});

test("fail records error on current step; retry clears it", () => {
  const flow = createFlow("ID_AND_FACE");
  flow.fail({ code: "DOCUMENT_BLURRY", message: "blurry" });
  assert.equal(flow.state().error.code, "DOCUMENT_BLURRY");
  assert.equal(flow.state().step, "document"); // stays on step
  flow.retry();
  assert.equal(flow.state().error, null);
});

test("finish jumps to complete with result", () => {
  const flow = createFlow("ID_AND_FACE");
  flow.advance();
  flow.finish({ status: "approved" });
  const s = flow.state();
  assert.equal(s.step, "complete");
  assert.equal(s.result.status, "approved");
});

test("onChange notifies and unsubscribes", () => {
  const flow = createFlow("FACE_ONLY"); // steps: liveness → face → processing → complete
  const seen = [];
  const off = flow.onChange((s) => seen.push(s.step));
  flow.advance(); // liveness → face
  off();
  flow.advance(); // face → processing (not observed)
  assert.deepEqual(seen, ["face"]);
});
