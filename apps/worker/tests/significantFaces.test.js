"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFacepluginProvider, significantFaceCount } = require("../src/providers/faceplugin");

const face = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

test("significantFaceCount: tiny spurious detections don't count", () => {
  const main = face(100, 60, 300, 320);       // 200x260 real face
  const speck = face(10, 10, 30, 34);         // 20x24 background false positive (~1% area)
  assert.equal(significantFaceCount([main]), 1);
  assert.equal(significantFaceCount([main, speck]), 1);
});

test("significantFaceCount: a real second person still counts", () => {
  const main = face(60, 50, 260, 310);        // 200x260
  const second = face(300, 80, 430, 250);     // 130x170 → ~42% area of main
  assert.equal(significantFaceCount([main, second]), 2);
});

test("significantFaceCount: edge cases", () => {
  assert.equal(significantFaceCount([]), 0);
  assert.equal(significantFaceCount(null), 0);
  // degenerate zero-area boxes fall back to raw length (fail closed)
  assert.equal(significantFaceCount([face(5, 5, 5, 5), face(9, 9, 9, 9)]), 2);
});

test("checkLiveness uses significant count: real face + speck → faceCount 1", async () => {
  const p = createFacepluginProvider({
    livenessUrl: "http://lv:8888", faceUrl: "http://fr:8889",
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        face_state: { result: "Real", liveness_score: 0.97 },
        faces: [face(100, 60, 300, 320), face(10, 10, 28, 30)]
      })
    })
  });
  const r = await p.checkLiveness(Buffer.alloc(10));
  assert.equal(r.faceCount, 1);
  assert.equal(r.score, 0.97);
});

test("checkLiveness extracts pose from the PRIMARY (largest) face", async () => {
  const p = createFacepluginProvider({
    livenessUrl: "http://lv:8888", faceUrl: "http://fr:8889",
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        face_state: { result: "Real", liveness_score: 0.9 },
        faces: [
          { ...face(10, 10, 40, 44), yaw: 99, pitch: 99, roll: 0 },     // speck with junk pose
          { ...face(100, 60, 300, 320), yaw: -21.5, pitch: 4.2, roll: 1 } // primary
        ]
      })
    })
  });
  const r = await p.checkLiveness(Buffer.alloc(10));
  assert.deepEqual(r.pose, { yaw: -21.5, pitch: 4.2, roll: 1 });
});

test("checkLiveness pose is null when the container provides no angles", async () => {
  const p = createFacepluginProvider({
    livenessUrl: "http://lv:8888", faceUrl: "http://fr:8889",
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({
        face_state: { result: "Real", liveness_score: 0.9 },
        faces: [face(100, 60, 300, 320)]
      })
    })
  });
  const r = await p.checkLiveness(Buffer.alloc(10));
  assert.equal(r.pose, null);
});
