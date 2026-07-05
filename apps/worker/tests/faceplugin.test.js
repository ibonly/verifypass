"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFacepluginProvider, ProviderError } = require("../src/providers/faceplugin");

function mockFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responder(url, opts);
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

const URLS = { livenessUrl: "http://lv:8888", faceUrl: "http://fr:8889", idOcrUrl: "http://ocr:8890" };

test("checkLiveness: posts multipart to /liveness-detection, normalizes Real result", async () => {
  const fetch = mockFetch(() => ({
    body: { face_state: { result: "Real", liveness_score: 0.97, is_occluded: false, quality: "High" }, faces: [{ x1: 1 }] }
  }));
  const p = createFacepluginProvider({ ...URLS, fetchImpl: fetch });

  const r = await p.checkLiveness(Buffer.from("selfie"));
  assert.equal(fetch.calls[0].url, "http://lv:8888/liveness-detection");
  assert.ok(fetch.calls[0].opts.body instanceof FormData);
  assert.ok(fetch.calls[0].opts.body.get("file"));
  assert.equal(r.score, 0.97);
  assert.equal(r.faceCount, 1);
  assert.equal(r.occluded, false);
});

test("checkLiveness: No face / Multiple face map to faceCount", async () => {
  const none = createFacepluginProvider({
    ...URLS,
    fetchImpl: mockFetch(() => ({ body: { face_state: { result: "No face", liveness_score: null }, faces: [] } }))
  });
  assert.equal((await none.checkLiveness(Buffer.alloc(1))).faceCount, 0);

  const multi = createFacepluginProvider({
    ...URLS,
    fetchImpl: mockFetch(() => ({ body: { face_state: { result: "Multiple face" }, faces: [{}, {}] } }))
  });
  const r = await multi.checkLiveness(Buffer.alloc(1));
  assert.equal(r.faceCount, 2);
});

test("compareFaces: reads result.similarity (0..1), sends both files to /face_compare", async () => {
  const fetch = mockFetch(() => ({ body: { result: { similarity: 0.91, status: "Same Person", message: "Success" } } }));
  const p = createFacepluginProvider({ ...URLS, fetchImpl: fetch });
  const r = await p.compareFaces(Buffer.from("a"), Buffer.from("b"));
  assert.equal(fetch.calls[0].url, "http://fr:8889/face_compare");
  assert.equal(r.score, 0.91);
  assert.equal(r.idFaceFound, true);
  const form = fetch.calls[0].opts.body;
  assert.ok(form.get("file1") && form.get("file2"));
});

test("compareFaces: tolerates a 0..100 build defensively", async () => {
  const fetch = mockFetch(() => ({ body: { result: { similarity: 91, status: "Same Person", message: "Success" } } }));
  const p = createFacepluginProvider({ ...URLS, fetchImpl: fetch });
  const r = await p.compareFaces(Buffer.from("a"), Buffer.from("b"));
  assert.equal(r.score, 0.91);
});

test("compareFaces: no face on ID (file2) → idFaceFound false, score null", async () => {
  const p = createFacepluginProvider({
    ...URLS,
    fetchImpl: mockFetch(() => ({ body: { result: { similarity: 0, status: null, message: "Failed to extract feature on image2" } } }))
  });
  const r = await p.compareFaces(Buffer.alloc(1), Buffer.alloc(1));
  assert.equal(r.idFaceFound, false);
  assert.equal(r.score, null);
});

test("compareFaces: selfie extraction fail (image1) → score null, idFace still assumed", async () => {
  const p = createFacepluginProvider({
    ...URLS,
    fetchImpl: mockFetch(() => ({ body: { result: { similarity: 0, status: null, message: "Failed to extract feature on image1" } } }))
  });
  const r = await p.compareFaces(Buffer.alloc(1), Buffer.alloc(1));
  assert.equal(r.score, null);
  assert.equal(r.idFaceFound, true);
});

test("extractDocument: unavailable when no OCR URL configured", async () => {
  const p = createFacepluginProvider({ ...URLS, idOcrUrl: null, fetchImpl: mockFetch(() => ({ body: {} })) });
  const r = await p.extractDocument(Buffer.alloc(1));
  assert.deepEqual(r, { available: false, ocrConfidence: null, extractedData: null, expired: null, raw: null });
});

test("extractDocument: parses expiry and confidence", async () => {
  const p = createFacepluginProvider({
    ...URLS,
    fetchImpl: mockFetch(() => ({
      body: { confidence: 94, data: { fullName: "ADEBAYO JOHN", expiryDate: "2020-01-01" } }
    }))
  });
  const r = await p.extractDocument(Buffer.alloc(1));
  assert.equal(r.available, true);
  assert.equal(r.ocrConfidence, 0.94);
  assert.equal(r.expired, true); // 2020 is past
  assert.equal(r.extractedData.fullName, "ADEBAYO JOHN");
});

test("HTTP failure surfaces as ProviderError", async () => {
  const p = createFacepluginProvider({ ...URLS, fetchImpl: mockFetch(() => ({ status: 500, body: {} })) });
  await assert.rejects(() => p.checkLiveness(Buffer.alloc(1)), ProviderError);
});
