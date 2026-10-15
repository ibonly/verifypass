"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createVerificationController, LIVENESS_FRAME_BUDGET } = require("../src/controller");

// Minimal API double: routes by path suffix, records calls.
function api(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname.replace(/^\/v1\/verification-sessions\/[^/]+/, "");
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[path] || (() => ({ success: true }));
    const out = await handler(init.body ? JSON.parse(init.body) : null, calls);
    const status = out && out.__status || 200;
    return { ok: status < 400, status, json: async () => out };
  };
  return { fetchImpl, calls, count: (p) => calls.filter((c) => c.path === p).length };
}

function controller(routes, extra = {}) {
  const a = api(routes);
  const events = { complete: [], errors: [], steps: [] };
  const c = createVerificationController({
    sessionId: "vps_1", sdkToken: "sdk_x", baseUrl: "https://api.test", fetchImpl: a.fetchImpl,
    onComplete: (r) => events.complete.push(r), onError: (e) => events.errors.push(e), onStepChange: (s) => events.steps.push(s),
    ...extra
  });
  return { c, a, events };
}

const approved = () => ({ success: true, status: "approved", decision: { status: "approved", reasonCodes: [] } });

test("init failure is reported as INIT_FAILED with the server message", async () => {
  const { c, events } = controller({ "/challenge": () => ({ __status: 503, success: false, error: { code: "UNAVAILABLE", message: "outage" } }) });
  await c.start();
  assert.equal(c.getState().status, "error");
  assert.equal(c.getState().initError, "outage");
  assert.equal(events.errors[0].code, "UNAVAILABLE");
});

test("face flow: consent starts the challenge clock, liveness advances, face submits once", async () => {
  const { c, a, events } = controller({
    "/challenge": () => ({ success: true, verificationType: "FACE_ONLY", livenessActions: ["turn_left", "look_up"] }),
    "/status": approved
  });
  await c.start();
  assert.equal(c.getState().flow.step, "liveness");
  assert.equal(a.count("/challenge/begin"), 0, "clock waits for consent");
  await c.recordConsent("v1");
  assert.equal(c.getState().consented, true);
  assert.equal(a.count("/challenge/begin"), 1);
  await c.runCapture((cap) => cap.livenessFrame("data:img", "auto"));
  assert.equal(c.currentAction(), "look_up");
  await c.runCapture((cap) => cap.livenessFrame("data:img", "auto"));
  assert.equal(c.getState().flow.step, "face");
  let flashed = 0;
  await c.runCapture((cap) => cap.face("data:selfie", { flash: async () => { flashed++; return { base64: "m", sequence: [], tile: 64 }; } }));
  assert.equal(flashed, 1);
  assert.equal(a.count("/flash"), 1);
  assert.equal(a.count("/verify"), 1);
  assert.equal(c.getState().flow.step, "complete");
  assert.equal(events.complete.length, 1);
  assert.deepEqual(a.calls.find((x) => x.path === "/liveness-frame").body.captureMode, "auto");
});

test("liveness uploads stop at the frame budget and a server budget error counts as complete", async () => {
  const { c, a } = controller({ "/challenge": () => ({ success: true, verificationType: "FACE_ONLY", livenessActions: ["blink"] }) });
  await c.start();
  for (let i = 0; i < LIVENESS_FRAME_BUDGET + 3; i++) await c.runCapture((cap) => cap.livenessFrame("f", "auto", false));
  assert.equal(a.count("/liveness-frame"), LIVENESS_FRAME_BUDGET);
  assert.equal(c.livenessBudgetSpent(), true);

  const second = controller({
    "/challenge": () => ({ success: true, verificationType: "FACE_ONLY", livenessActions: ["blink"] }),
    "/liveness-frame": () => ({ __status: 429, success: false, error: { code: "LIMIT", message: "Too many liveness frames for this action" } })
  });
  await second.c.start();
  const ok = await second.c.runCapture((cap) => cap.livenessFrame("f", "auto"));
  assert.equal(ok, true);
  assert.equal(second.c.getState().flow.error, null);
  assert.equal(second.c.getState().flow.step, "face");
});

test("capture errors latch the step, report CAPTURE codes and block further captures until retryStep", async () => {
  const { c, a, events } = controller({
    "/challenge": () => ({ success: true, verificationType: "ID_ONLY", documentTypes: ["PASSPORT"] }),
    "/document": () => ({ __status: 422, success: false, error: { code: "EVIDENCE_LIMIT", message: "limit" } })
  });
  await c.start();
  await c.runCapture((cap) => cap.document("d"));
  assert.equal(c.getState().flow.error.code, "EVIDENCE_LIMIT");
  assert.equal(events.errors[0].code, "EVIDENCE_LIMIT");
  await c.runCapture((cap) => cap.document("d"));
  assert.equal(a.count("/document"), 1, "latched error skips capture");
  c.retryStep();
  assert.equal(c.getState().flow.error, null);
});

test("ID-only document capture submits once and completes", async () => {
  const { c, a, events } = controller({ "/challenge": () => ({ success: true, verificationType: "ID_ONLY", documentTypes: ["PASSPORT"] }), "/status": approved });
  await c.start();
  await c.runCapture((cap) => cap.document("d"));
  assert.equal(a.count("/verify"), 1);
  assert.equal(events.complete[0].status, "approved");
});

test("retry reopens the session with a fresh challenge and attempt counters", async () => {
  const { c } = controller({
    "/challenge": () => ({ success: true, verificationType: "FACE_ONLY", livenessActions: ["blink"] }),
    "/retry": () => ({ success: true, attempts: 2, attemptsRemaining: 3, manualUploadSuggested: false, livenessChallenge: { actions: ["turn_right"] } })
  });
  await c.start();
  const before = c.getState();
  await c.retry();
  const s = c.getState();
  assert.deepEqual(s.actions, ["turn_right"]);
  assert.equal(s.challengeEpoch, before.challengeEpoch + 1);
  assert.equal(s.attemptEpoch, before.attemptEpoch + 1);
  assert.equal(s.attempts.attempts, 2);
});

test("mobile handoff builds a fragment-bearer URL and settles from polling", async () => {
  const { c, events } = controller({
    "/challenge": () => ({ success: true, verificationType: "FACE_ONLY", hostedBaseUrl: "https://verify.test", handoffToken: "vph_t", expiresAt: new Date(Date.now() + 60000).toISOString() }),
    "/status": approved
  }, { mobileHandoff: true });
  await c.start();
  assert.match(c.getState().handoff.url, /^https:\/\/verify\.test\/session\/vps_1#h=vph_t$/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.complete.length, 1);
  assert.equal(c.getState().flow.step, "complete");
  c.selectHandoff(false); // fixed mode: ignored
  assert.equal(c.getState().handoff.enabled, true);
  c.dispose();
});

test("omitted mobileHandoff lets the user switch to the QR flow", async () => {
  const { c, a } = controller({
    "/challenge": () => ({ success: true, verificationType: "FACE_ONLY", hostedBaseUrl: "https://verify.test", handoffToken: "vph_t" }),
    "/status": () => ({ success: true, status: "created" })
  });
  await c.start();
  assert.equal(c.getState().handoff.enabled, false);
  c.selectHandoff(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.getState().handoff.enabled, true);
  assert.equal(c.getState().flow.step, "mobile");
  assert.ok(a.calls.some((x) => x.path === "/challenge" ) );
  c.dispose();
});
