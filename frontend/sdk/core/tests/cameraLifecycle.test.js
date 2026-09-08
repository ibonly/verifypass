"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nextVideoFrame, startCamera } = require("../src/camera");
test("frame-aware capture waits for an actual video frame", async () => {
  let callback, cancelled;
  const video = {currentTime:1,requestVideoFrameCallback(cb){callback=cb;return 4;},cancelVideoFrameCallback(id){cancelled=id;}};
  let resolved=false;
  const pending=nextVideoFrame(video).then(()=>{resolved=true;});
  await Promise.resolve();assert.equal(resolved,false);
  callback();await pending;assert.equal(cancelled,4);
});
test("camera frame wait aborts and stalled streams time out", async () => {
  const controller=new AbortController();
  const video={currentTime:1,requestVideoFrameCallback(){return 1;},cancelVideoFrameCallback(){}};
  const wait=nextVideoFrame(video,{signal:controller.signal});controller.abort();
  await assert.rejects(wait,/cancelled/);
  await assert.rejects(nextVideoFrame(video,{timeoutMs:5}),/stopped producing/);
});

function withMedia(t, getUserMedia) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia } } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else delete globalThis.navigator;
  });
}

test("cancelled permission request cannot replace another camera stream", async t => {
  let resolveMedia;
  let stopped = 0;
  withMedia(t, () => new Promise(resolve => { resolveMedia = resolve; }));
  const controller = new AbortController();
  const currentStream = {};
  const video = { srcObject: currentStream };
  const pending = startCamera(video, { signal: controller.signal });
  controller.abort();
  resolveMedia({ getTracks: () => [{ stop: () => { stopped++; } }] });
  await assert.rejects(pending, /cancelled/);
  assert.equal(video.srcObject, currentStream);
  assert.equal(stopped, 1);
});

test("camera startup has a real timeout even when play never resolves", async t => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
  withMedia(t, async () => stream);
  const video = { videoWidth: 640, videoHeight: 480, addEventListener() {}, removeEventListener() {}, play: () => new Promise(() => {}) };
  await assert.rejects(startCamera(video, { timeoutMs: 10 }), { code: "CAMERA_NOT_READY" });
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, null);
});

test("abort during startup preserves a replacement stream", async t => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => { stopped++; } }] };
  withMedia(t, async () => stream);
  const controller = new AbortController();
  const video = { videoWidth: 0, videoHeight: 0, addEventListener() {}, removeEventListener() {}, play: async () => {} };
  const pending = startCamera(video, { signal: controller.signal });
  await Promise.resolve();
  const replacement = {};
  video.srcObject = replacement;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(stopped, 1);
  assert.equal(video.srcObject, replacement);
});
