"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { nextVideoFrame } = require("../src/camera");
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
