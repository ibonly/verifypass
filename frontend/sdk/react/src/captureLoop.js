// Auto-capture loop (framework-free). Runs per capture step while the camera
// is live: motion/light/document gating, face framing from the detector,
// and the three-phase liveness capture (align → await → burst). Detection is
// UX-only — the server verifies every frame authoritatively.
//
// Extracted verbatim from the widget; React state setters became `set.*`
// callbacks and refs became accessors so any UI (React hook, custom element,
// vanilla) can drive it.
import {
  grabAnalysisFrame, grabSquareFrame, grabFixedFrame, frameMotion, toGrayscale, meanBrightness, laplacianVariance,
  createFramingStabilizer, createActionDetector, bandMotion, createDocumentGate, isDominantFace, isFrontalPose,
  isReferencePose, frontalRefFromSamples, LIVENESS_FRAME_BUDGET
} from "@verifypass/sdk-core";

export const isDocumentStep = (s) => s === "document" || s === "document_back";
const FACE_FOCUS_MIN = 12;

function cropImageData(imageData, box, padRatio = 0.12) {
  if (!imageData || !box) return null;
  const { width, height, data } = imageData;
  const padX = (box.x2 - box.x1) * padRatio;
  const padY = (box.y2 - box.y1) * padRatio;
  const x1 = Math.max(0, Math.floor(box.x1 - padX));
  const y1 = Math.max(0, Math.floor(box.y1 - padY));
  const x2 = Math.min(width, Math.ceil(box.x2 + padX));
  const y2 = Math.min(height, Math.ceil(box.y2 + padY));
  const cropW = x2 - x1;
  const cropH = y2 - y1;
  if (cropW < 16 || cropH < 16) return null;
  const out = new Uint8ClampedArray(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    const srcStart = ((y1 + y) * width + x1) * 4;
    const srcEnd = srcStart + cropW * 4;
    out.set(data.subarray(srcStart, srcEnd), y * cropW * 4);
  }
  return { data: out, width: cropW, height: cropH };
}

/**
 * @param {object} ctx
 * @param {string} ctx.step current flow step
 * @param {string|null} ctx.currentAction current liveness action
 * @param {boolean} ctx.faceModelEnabled a face model is configured
 * @param {"loading"|"ready"|"failed"|"disabled"} ctx.detectorStatus
 * @param {() => HTMLVideoElement|null} ctx.video
 * @param {() => HTMLCanvasElement|null} ctx.overlay framing overlay canvas
 * @param {() => object|null} ctx.detector face detector (createFaceDetector)
 * @param {() => boolean} ctx.isCapturing
 * @param {(action: string) => number} ctx.framesUsed liveness frames uploaded for an action
 * @param {() => object} ctx.telemetry mutable capture telemetry
 * @param {(opts?: object) => Promise<unknown>} ctx.capture capture one frame
 * @param {{current: any}} ctx.framingRef latest framing result (shared with flash)
 * @param {{current: any}} ctx.livenessStabRef @param {{current: any}} ctx.livenessFrontalRef
 * @param {{current: any[]}} ctx.livenessRefSamplesRef
 * @param {object} ctx.set state callbacks: green, framingGuide, livePhase, docSeen, docShapeOk, docFaceBlocked, canReissue, debugInfo
 * @returns {() => void} stop
 */
export function runCaptureLoop(ctx) {
  const { step, faceModelEnabled, detectorStatus, video: getVideo, overlay, detector, isCapturing, framesUsed, telemetry, capture,
    framingRef, livenessStabRef, livenessFrontalRef, livenessRefSamplesRef, set } = ctx;
  if (!(isDocumentStep(step) || step === "face" || step === "liveness")) return () => {};

  set.green(false);
  framingRef.current = null;
  set.livePhase({ phase: "align", startedAt: 0, total: 0 });
  set.framingGuide(step === "face" || step === "liveness"
    ? detectorStatus === "failed" ? "model_error" : "model_loading"
    : "no_face");
  const DEBUG = /[?&]vpdebug\b/.test(typeof window !== "undefined" ? window.location.search : "");
  let raf = 0;
  let cancelled = false;
  let lastDebugAt = 0;
  let prevGray = null;
  let greenSince = 0;
  let lastDetect = 0;
  let detecting = false;
  let publishedGuide = null;
  const history = [];
  // temporal smoothing: no flicker, no hold-timer resets on jitter. On the
  // liveness step the stabilizer is shared across actions: if the user is
  // still locked from the previous action we go straight to "await".
  const reuseStab = step === "liveness" && !!livenessStabRef.current;
  const stab = reuseStab ? livenessStabRef.current : createFramingStabilizer();
  if (step === "liveness") livenessStabRef.current = stab; else { livenessStabRef.current = null; livenessFrontalRef.current = null; livenessRefSamplesRef.current = []; }
  let stable = null;
  // Document step gate: "change-then-steady" — learns the EMPTY scene first,
  // then requires the ID to actually enter the frame (sustained scene change)
  // and be held still. A bare steadiness check photographed empty rooms.
  const docGate = isDocumentStep(step) ? createDocumentGate() : null;
  let docState = { armed: false, present: false, steady: false, ready: false, shape: null };
  let lastDocSeen = false;
  let lastDocShapeOk = false;
  set.docSeen(false);
  set.docShapeOk(false);
  // Face-vs-card check on the document step (hysteresis so it doesn't flap)
  let docBlockStreak = 0;
  let docClearStreak = 0;
  let docFaceNow = false;
  let docRelaxSince = 0;
  set.docFaceBlocked(false);
  const HOLD_MS = 550;
  const SETTLE_DELTA = 3;
  const DETECT_MS = 110; // faster sampling → triggers fire ~1 frame sooner
  // Liveness three-phase capture:
  //   align     — lock a frontal face (baseline box recorded)
  //   await     — instruction shown; WAIT until the face-box dynamics (or a
  //               motion spike, for blink/smile) show the action is actually
  //               being performed. No timer-based capture: nothing uploads
  //               until the user moves.
  //   capturing — short burst (3 frames over ~700ms) at the action's peak.
  const ALIGN_LOCK_MS = reuseStab ? 120 : 350; // subsequent actions: already locked
  // Burst timing: FIRST frame fires AT the trigger, while the turning face
  // is still detectable by the server's frontal-biased detector — every
  // action needs at least one face-bearing frame or it's INCOMPLETE. Later
  // frames catch the pose peak for the (calibration/pose) evidence.
  const BURST_AT = [0, 350, 700]; // offsets from the trigger moment
  const BURST_TOTAL = 800;        // progress bar duration
  const AWAIT_HINT_MS = 3500;     // no movement detected → coach the user
  // Detection here is UX-only — the server verifies pose magnitude and
  // liveness authoritatively. If THIS action's signature never fires (the
  // frontal-biased detector loses some faces sooner turning one way than
  // the other — turn_right vs turn_left asymmetry on some cameras/lighting),
  // don't starve the flow forever: after the hint has been up a while,
  // capture a fallback burst while the user performs the movement anyway.
  const AWAIT_FALLBACK_MS = 9000; // hint shown + still no trigger → fallback burst
  const AWAIT_FACE_LOST_MS = 4000; // face gone this long → back to align
  // Document step: if something is present, lit and face-clear this long but
  // the strict card-shape gate hasn't passed (hand/forearm in the mask,
  // low-contrast card), capture anyway — server validation backstops.
  const DOC_SHAPE_RELAX_MS = 5000;
  const currentAction = ctx.currentAction || null;
  let phase = "align";
  let baselineBox = null;
  let awaitStart = 0;
  let triggerAt = 0;
  let shots = 0;
  let hintShown = false;
  let lastHint = null;      // last diagnosis shown ("wrong_way" | "face_lost" | "further" | "none")
  let lastHintAt = 0;
  // The pitch proxy from the browser landmarks is noisy on tilted faces: a
  // single "wrong way" tick coaching the user to reverse a correct look-down
  // pushed testers into reissuing the challenge (3 sessions, 2026-09-07).
  // Only a sustained opposite-direction reading is a wrong-way diagnosis.
  let wrongWayStreak = 0;
  const WRONG_WAY_TICKS = 4;
  // What did the detector actually see? Drives the coaching copy.
  //   wrong_way — pose moved past threshold in the OPPOSITE direction
  //   face_lost — the face left detection mid-movement
  //   further   — some movement, below threshold
  //   none      — nothing at all
  const isExprAction = () => currentAction === "blink" || currentAction === "open_mouth" || currentAction === "smile";
  const coachDiag = (now) => (actionState.armed === false && now - lastPresentAt <= 700) ? (isExprAction() ? "none" : "recenter")
    : wrongWayStreak >= WRONG_WAY_TICKS ? "wrong_way"
    : (now - lastPresentAt > 700) ? "face_lost"
    : (actionState.magnitude > 0.08) ? "further"
    : "none";
  // Near-miss: a head movement armed, not the wrong way, and at ≥60 % of
  // the trigger threshold (same bar as a held burst shot) — the user IS
  // doing the movement, just not far enough for the client detector.
  const headNearMiss = () => !isExprAction() && actionState.armed !== false && actionState.hasPose
    && !actionState.wrongWay && actionState.magnitude >= 0.6 * (currentAction === "look_up" || currentAction === "look_down" ? 0.2 : 0.22);
  let lastPresentAt = performance.now();
  // Action-SPECIFIC detector (geometry signature for turns/tilts, eye/mouth
  // band motion for blink/smile) — created when align completes.
  let actionDet = null;
  let actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
  let prevModelGray = null;
  // One frame captured at the FIRST action-consistent detection while the
  // face is still visible — the disappearance-clause trigger often fires
  // after the face has already turned out of detection range, and the
  // server requires at least one face-bearing frame per action.
  let earlyShotTaken = false;
  let expressionShotTaken = false;
  // True when the current burst was started by the AWAIT_FALLBACK_MS timer
  // rather than the action detector — relaxes the per-shot hold/presence
  // gates that a detector-blind movement can never satisfy.
  let fallbackBurst = false;
  let budgetHintShown = false;
  let detectEma = null;     // EMA of the detect+landmark pass (ms)
  let awaitSamples = 0;     // detections seen since the instruction appeared
  const AWAIT_MIN_SAMPLES = 12; // B4: coach after this many looks (and ≥2.5 s)
  const REISSUE_OFFER_MS = 15000; // D3: offer "try a different movement"
  let reissueOffered = false;
  // per-action telemetry entry (E1)
  const telEntry = () => {
    const t = telemetry();
    let e = t.actions.find((a) => a.action === currentAction && !a.done);
    if (!e) { e = { action: currentAction, msToTrigger: null, wrongWay: 0, hints: [], frames: 0, mode: null, reissued: false, done: false }; t.actions.push(e); }
    return e;
  };

  const tick = () => {
    if (cancelled) return;
    if (document.hidden) { raf = requestAnimationFrame(tick); return; }
    const video = getVideo();
    if (video) {
      const now = performance.now();
      const faceStep = step === "face" || step === "liveness";
      const requiresFaceModel = !!faceModelEnabled && faceStep;
      const faceGate = requiresFaceModel && detectorStatus === "ready" && !!detector();

      // motion + light from a cheap downscaled frame
      let settled = false;
      let lightOk = true;
      const small = grabAnalysisFrame(video, 160);
      if (small) {
        const gray = toGrayscale(small);
        const motion = prevGray ? frameMotion(prevGray, gray) : 0;
        prevGray = gray;
        history.push(motion);
        if (history.length > 40) history.shift();
        const baseline = history.length >= 8 ? Math.min(...history) : 0;
        const bright = meanBrightness(small);
        lightOk = bright > 35 && bright < 240;
        settled = history.length >= 8 && motion <= baseline + SETTLE_DELTA;
        if (docGate) {
          // With dims the gate is fail-closed: ready additionally requires
          // the change-region to be CARD-shaped (straight-edged solid
          // rectangle) — a person/hand/wall present+steady never captures.
          docState = docGate.update(gray, small.width, small.height);
          if (docState.present !== lastDocSeen) {
            lastDocSeen = docState.present;
            set.docSeen(docState.present);
          }
          const shapeOk = !!(docState.shape && docState.shape.cardLike);
          if (shapeOk !== lastDocShapeOk) {
            lastDocShapeOk = shapeOk;
            set.docShapeOk(shapeOk);
          }
        }
      }

      // face model framing (throttled) for face/liveness
      if (faceModelEnabled && detectorStatus === "failed" && publishedGuide !== "model_error") {
        publishedGuide = "model_error";
        set.framingGuide("model_error");
      } else if (requiresFaceModel && !faceGate && publishedGuide !== "model_loading") {
        publishedGuide = "model_loading";
        set.framingGuide("model_loading");
      }

      // On the DOCUMENT step the detector serves the opposite purpose:
      // block capture while a LIVE face dominates the frame (people show
      // their face instead of the card).
      const docDetect = isDocumentStep(step) && !!faceModelEnabled && detectorStatus === "ready" && !!detector();

      if ((faceGate || docDetect) && !detecting && now - lastDetect > DETECT_MS && !isCapturing()) {
        lastDetect = now;
        detecting = true;
        // Face steps analyse the SAME center-square the circular preview
        // shows so the green gate agrees with what the user sees. The
        // document step must scan the FULL frame — a face outside the
        // center square (leaning in from the side) still has to block.
        const modelFrame = docDetect ? grabFixedFrame(video, 320, 240) : grabSquareFrame(video, 320, 240);
        const detectStart = performance.now();
        detector()
          .detect(modelFrame)
          .then((f) => {
            if (cancelled) return;
            // B4: running average of the detect+landmark pass; the coaching
            // timers count SAMPLES, not wall-clock, so a slow phone gets the
            // same number of looks before being coached.
            const passMs = performance.now() - detectStart;
            detectEma = detectEma == null ? passMs : detectEma * 0.8 + passMs * 0.2;
            telemetry().detectMs = Math.round(detectEma);
            if (phase === "await") awaitSamples++;
            if (docDetect) {
              // Relative rule when a card region is visible: a real ID's
              // printed portrait is a small fraction of the card's width; a
              // face (live or photo) filling the "document" blocks capture.
              const shape = docState.shape;
              const docWidthPx = shape && shape.found ? shape.widthFrac * 320 : 0;
              const blocked = isDominantFace(f && f.box, 320, { docWidthPx });
              docBlockStreak = blocked ? docBlockStreak + 1 : 0;
              docClearStreak = blocked ? 0 : docClearStreak + 1;
              if (!docFaceNow && docBlockStreak >= 2) {
                docFaceNow = true;
                set.docFaceBlocked(true);
              } else if (docFaceNow && docClearStreak >= 3) {
                docFaceNow = false;
                set.docFaceBlocked(false);
              }
              return;
            }
            let next = f || { present: false, inFrame: false, guide: "no_face" };
            if (next.inFrame) {
              const faceCrop = cropImageData(modelFrame, next.box);
              const focus = faceCrop ? laplacianVariance(faceCrop) : 0;
              next = { ...next, observedAt: performance.now(), focus, inFrame: focus >= FACE_FOCUS_MIN, guide: focus >= FACE_FOCUS_MIN ? "ok" : "focus" };
            }
            framingRef.current = next;
            // Stabilizer absorbs per-detection jitter; publish its guide only
            // on real change (dwell-timed inside), so the pill never flickers.
            stable = stab.update(next, performance.now());
            if (stable.guide && stable.guide !== publishedGuide) {
              publishedGuide = stable.guide;
              set.framingGuide(stable.guide);
            }
            // Feed the per-action detector: box geometry vs baseline, plus
            // eye/mouth band motion between consecutive detection frames
            // (expressions don't move the box). Bands fall back to the
            // baseline box while the head is mid-expression.
            if (actionDet) {
              const gray = toGrayscale(modelFrame);
              const bandBox = next.box || actionDet.baseline;
              const bands = prevModelGray && bandBox
                ? bandMotion(prevModelGray, gray, 320, bandBox)
                : { eyes: 0, mouth: 0 };
              prevModelGray = gray;
              actionState = actionDet.update({ box: next.box, eyes: bands.eyes, mouth: bands.mouth, pose: next.pose || null, expr: next.expr || null });
              wrongWayStreak = actionState.wrongWay ? wrongWayStreak + 1 : 0;
            } else {
              prevModelGray = toGrayscale(modelFrame);
            }
          })
          .catch(() => {
            if (cancelled) return;
            framingRef.current = { present: false, inFrame: false, guide: "no_face" };
            stable = stab.update(framingRef.current, performance.now());
          })
          .finally(() => { detecting = false; });
      }

      const lockedOk = faceGate && !!(stable && stable.locked) && lightOk;

      // Liveness needs the LANDMARK model (pose): with only the box detector
      // a movement cannot be matched to an instruction, so the step fails
      // closed to manual capture instead of guessing from motion.
      const poseGate = faceGate && !!(detector() && detector().hasLandmarks);
      if (step === "liveness" && poseGate) {
        const rawBox = framingRef.current && framingRef.current.box;
        const facePresent = !!(stable && stable.present);
        if (facePresent) lastPresentAt = now;

        if (phase === "align") {
          set.green(lockedOk);
          const alignPose = framingRef.current && framingRef.current.pose;
          const alignFrontal = !alignPose || isFrontalPose(alignPose);
          // accumulate reference-frontal samples (tight band) while aligning
          if (alignPose && lockedOk && isReferencePose(alignPose)) {
            const arr = livenessRefSamplesRef.current;
            if (!arr.length || arr[arr.length - 1].observedAt !== framingRef.current.observedAt) { arr.push({ yaw: alignPose.yaw, pitch: alignPose.pitch, observedAt: framingRef.current.observedAt }); if (arr.length > 15) arr.shift(); }
          }
          if (lockedOk && alignFrontal && stable.lockedSince && now - stable.lockedSince >= ALIGN_LOCK_MS) {
            phase = "await";
            baselineBox = (stable && stable.box) || rawBox || null;
            // session reference = MEDIAN of the reference-frontal samples seen
            // while aligning (a single frame captured mid-lean blocked arming
            // for the whole session in replay)
            const refFromSamples = frontalRefFromSamples(livenessRefSamplesRef.current);
            if (refFromSamples && (!livenessFrontalRef.current || refFromSamples.samples >= 3)) {
              livenessFrontalRef.current = { yaw: refFromSamples.yaw, pitch: refFromSamples.pitch };
            }
            actionDet = createActionDetector(currentAction, baselineBox, {
              frontalRef: livenessFrontalRef.current,
              requireArm: true, // count nothing until the face is frontal again
              mirrorPreview: true // face steps render the video with scaleX(-1); direction is toward the arrow
            });
            actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
            earlyShotTaken = false;
            expressionShotTaken = false;
            awaitStart = now;
            awaitSamples = 0;
            hintShown = false;
            reissueOffered = false;
            set.canReissue(false);
            set.livePhase({ phase: "await", startedAt: now, total: 0, hint: false });
          }
        } else if (phase === "await") {
          // Instruction shown — capture NOTHING until THIS action's own
          // signature is seen (2 consecutive detections; jitter can't fire it).
          set.green(true);
          // Budget spent for this action (redo cycles): nothing more can be
          // uploaded, so asking for ANOTHER head turn is pure neck pain.
          // Advance immediately — the action already carries max evidence.
          if (framesUsed(currentAction) >= LIVENESS_FRAME_BUDGET) {
            // Budget spent: the frames already uploaded carry whatever was
            // seen. Do NOT advance silently (the user would read that as
            // "it accepted a movement I didn't make") — explain and let the
            // user continue explicitly; the server judges the evidence.
            if (!budgetHintShown) { budgetHintShown = true; set.livePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: "budget" }); }
            raf = requestAnimationFrame(tick);
            return;
          }
          // the detector self-heals a bad reference; keep the session in sync
          if (actionDet && actionDet.healed && actionDet.poseBaseline) livenessFrontalRef.current = actionDet.poseBaseline;
          // Taken as soon as the face is detectable in the await phase: it
          // is the FRONTAL reference for this action — the only frame of a
          // look-up/look-down burst the frontal-biased passive model can
          // score, and the start point of the trajectory. The server
          // excludes it from the per-action time window, so coaching time
          // before the movement no longer counts against the user.
          if (rawBox && !earlyShotTaken && !isCapturing()) {
            // movement just started and the face is STILL detectable —
            // grab the guaranteed face-bearing frame for this action now
            capture({ livenessAdvance: false, mode: "auto" }).then(ok => { if (!cancelled && ok) earlyShotTaken = true; });
          }
          if (earlyShotTaken && !expressionShotTaken && ["blink", "open_mouth"].includes(currentAction) && actionState.ok && !isCapturing()) {
            capture({ livenessAdvance: false, mode: "auto" }).then(ok => { if (!cancelled && ok) expressionShotTaken = true; });
          }
          if (facePresent && actionState.triggered) {
            phase = "capturing";
            fallbackBurst = false;
            triggerAt = now;
            shots = 0;
            telEntry().msToTrigger = Math.round(now - awaitStart);
            telEntry().mode = "auto";
            set.canReissue(false);
            set.livePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
          } else if ((awaitSamples >= AWAIT_MIN_SAMPLES || now - awaitStart > AWAIT_HINT_MS) && now - awaitStart >= 2500 && now - lastHintAt > 900 && coachDiag(now) !== lastHint) {
            // Coach from DIAGNOSIS, not a timer (see coachDiag). Only a CHANGED
            // diagnosis stops the chain here, so the fallback / face-lost
            // branches below still run on the other ticks.
            lastHint = coachDiag(now);
            lastHintAt = now;
            hintShown = true;
            telEntry().hints.push(lastHint);
            if (lastHint === "wrong_way") telEntry().wrongWay++;
            set.livePhase({ phase: "await", startedAt: awaitStart, total: 0, hint: lastHint });
            if (now - awaitStart > REISSUE_OFFER_MS && !reissueOffered) { reissueOffered = true; set.canReissue(true); }
          } else if (hintShown && now - awaitStart > AWAIT_FALLBACK_MS
            // With live pose the detector is not blind — keep coaching
            // instead, UNLESS the user is visibly mid-movement but short of
            // the threshold (a near-miss held through the coaching): capture
            // that attempt rather than coach forever; the server judges it.
            && (!actionState.hasPose || headNearMiss())
            && now - lastPresentAt < 2000 && !isCapturing()) {
            // The user has been here, coached, and moving for ~9s without
            // the signature firing — capture anyway; the server is the
            // authoritative judge of whether the action happened.
            phase = "capturing";
            fallbackBurst = true;
            triggerAt = now;
            shots = 0;
            telEntry().mode = "fallback";
            set.canReissue(false);
            set.livePhase({ phase: "capturing", startedAt: now, total: BURST_TOTAL });
          } else if (now - lastPresentAt > AWAIT_FACE_LOST_MS) {
            phase = "align"; // user walked off — re-establish the baseline
            actionDet = null;
            set.livePhase({ phase: "align", startedAt: 0, total: 0 });
          }
        } else {
          // capturing: burst while the pose is HELD. Turns/tilts require the
          // geometric signature at each shot (frames must show the action);
          // blink/smile are momentary, so their shots follow the schedule.
          set.green(true);
          // blink: shots 2–3 deliberately follow the schedule so the burst
          // holds closed-eye (early + trigger) AND re-opened frames.
          const holdRequired = currentAction !== "blink" && currentAction !== "smile" && currentAction !== "open_mouth";
          // Hold is required only for the FIRST shot (fired AT the trigger,
          // inherently mid-action). Demanding it for later shots stalled the
          // whole burst whenever the user snapped back to frontal quickly —
          // the early faced-frame + trigger frame already carry the action
          // evidence, and the server tolerates mid-return frames.
          // B2: later shots must still show the movement (≥60 % of the
          // trigger threshold) or they add frontal frames that read as a
          // static trajectory server-side; if the pose is released, finish
          // the burst with what was captured (the early + trigger frames
          // already carry the action).
          const tiltAction = currentAction === "look_up" || currentAction === "look_down";
          const stillTurned = actionState.holding || actionState.magnitude >= 0.6 * (tiltAction ? 0.2 : 0.22);
          const canShoot = fallbackBurst
            // Fallback burst: the detector never saw the action, so demanding
            // `holding` would stall forever. The FIRST shot still waits for a
            // detectable face (the server needs one face-bearing frame per
            // action); later shots may catch the mid-turn profile the
            // frontal-biased detector loses.
            ? (shots > 0 || facePresent)
            : (shots === 0 ? (!holdRequired || actionState.holding) : (!holdRequired || stillTurned));
          const presenceOk = facePresent || (fallbackBurst && shots > 0);
          if (shots < BURST_AT.length && now - triggerAt >= BURST_AT[shots] && !isCapturing() && presenceOk && canShoot) {
            const isLast = shots === BURST_AT.length - 1;
            capture({ livenessAdvance: isLast, mode: fallbackBurst ? "fallback" : "auto" }).then(ok => { if (!cancelled && ok) shots++; });
          } else if (!fallbackBurst && shots >= 2 && shots < BURST_AT.length && !isCapturing() && now - triggerAt > BURST_AT[shots] + 1200) {
            // pose released before the remaining shots: finish the action
            // with the frames already uploaded — no frontal padding frames
            shots = BURST_AT.length;
            capture({ advanceOnly: true });
          } else if (!isCapturing() && now - triggerAt > BURST_TOTAL + 1500) {
            // Burst stalled (pose released mid-burst, or an upload was
            // rejected by the quality gate) — return to await with a FRESH
            // detector so the user redoes the movement; a stale latched
            // trigger would re-fire instantly.
            phase = "await";
            fallbackBurst = false;
            actionDet = createActionDetector(currentAction, baselineBox, { frontalRef: livenessFrontalRef.current, requireArm: true, mirrorPreview: true });
            actionState = { ok: false, triggered: false, holding: false, armed: true, hasPose: false };
            // redo cycle: the early face-bearing frame already exists for this
            // action — don't spend another budget slot on it
            earlyShotTaken = true;
            awaitStart = now;
            hintShown = true;
            lastHint = "none";
            lastHintAt = now;
            set.livePhase({ phase: "await", startedAt: now, total: 0, hint: "none" });
          }
        }
      } else if (!isCapturing()) {
        // Doc capture may only proceed once the face check has POSITIVELY
        // cleared the frame (>=2 consecutive detections without a dominant
        // face). While the model is still loading nothing has been checked,
        // so capture waits — otherwise a face gets photographed as "ID"
        // during the load window. Detector failed/absent degrades gracefully.
        const docFaceClear = !faceModelEnabled || detectorStatus === "failed"
          ? true
          : docDetect && !docFaceNow && docClearStreak >= 2;
        // Shape-relax timer: real hands holding real cards can corrupt the
        // change-mask (the forearm merges into the region), starving the
        // strict cardLike gate forever. If SOMETHING has been present, lit
        // and face-clear for a sustained window, capture anyway — the
        // dominant-face veto stays active and the server independently
        // rejects a live face submitted as a document.
        if (docGate && docState.present && lightOk && docFaceClear) {
          if (!docRelaxSince) docRelaxSince = now;
        } else {
          docRelaxSince = 0;
        }
        const docRelaxed = docRelaxSince > 0 && now - docRelaxSince > DOC_SHAPE_RELAX_MS;
        // Selfie: besides the framing lock, require a FRONTAL pose when the
        // landmark model is available — passive liveness and face-match
        // score turned/tilted faces low, and replayed sessions showed the
        // selfie being captured mid-lean (→ manual review).
        const latestPose = framingRef.current && framingRef.current.pose;
        const frontalOk = step !== "face" || !latestPose || isFrontalPose(latestPose);
        // FAIL CLOSED on the liveness step: with no face detector there is
        // nothing to match the instruction against, so motion-settle
        // auto-capture would "complete" every action the moment the user
        // holds still (this is what happened on the hosted page, which
        // shipped without models). Manual capture stays available and the
        // server verifies pose on what it receives.
        const livenessBlind = step === "liveness" && !(faceGate && detector() && detector().hasLandmarks);
        const inPosition = livenessBlind ? false
          : requiresFaceModel
          ? lockedOk && frontalOk
          : docGate ? (docState.ready || docRelaxed) && lightOk && docFaceClear
            : settled && lightOk;
        set.green(inPosition);
        if (inPosition) {
          if (!greenSince) greenSince = now;
          else if (now - greenSince > HOLD_MS) { greenSince = 0; capture(); }
        } else {
          greenSince = 0;
        }
      }

      if (DEBUG && faceStep && now - lastDebugAt > 250) {
        lastDebugAt = now;
        const p = framingRef.current && framingRef.current.pose;
        const pb = actionDet && actionDet.poseBaseline;
        set.debugInfo({
          phase, action: currentAction, guide: publishedGuide,
          yaw: p ? p.yaw : null, pitch: p ? p.pitch : null,
          dYaw: p && pb ? p.yaw - pb.yaw : null, dPitch: p && pb ? p.pitch - pb.pitch : null,
          ratio: framingRef.current && framingRef.current.ratio,
          ok: actionState.ok, holding: actionState.holding, wrongWay: actionState.wrongWay,
          frames: framesUsed(currentAction)
        });
      }

      // Overlay: draw the detected face box (mapped to the display square) so
      // framing is visible. The canvas shares the video's mirror transform.
      const canvas = overlay();
      if (canvas && faceStep) {
        const cw = canvas.width;
        const ch = canvas.height;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, cw, ch);
        if (DEBUG) {
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(cw / 2, ch / 2, cw * 0.11, 0, 2 * Math.PI); ctx.stroke();
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.beginPath(); ctx.arc(cw / 2, ch / 2, 2, 0, 2 * Math.PI); ctx.fill();
        }
        // Align phase: the SMOOTHED box (EMA) glides instead of twitching.
        // During the movement itself draw the RAW detection — the EMA trails
        // a moving face by 200–450 ms and reads as "it can't see me".
        const moving = step === "liveness" && phase !== "align";
        const b = moving
          ? (framingRef.current && framingRef.current.box) || (stable && stable.box)
          : (stable && stable.box) || (framingRef.current && framingRef.current.box);
        if (b) {
          const x = (b.x1 / 320) * cw;
          const y = (b.y1 / 240) * ch;
          const w = ((b.x2 - b.x1) / 320) * cw;
          const h = ((b.y2 - b.y1) / 240) * ch;
          ctx.strokeStyle = stable && stable.locked ? "#10B981" : "#F59E0B";
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);
          if (DEBUG) {
            ctx.fillStyle = "red";
            ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, 3, 0, 2 * Math.PI); ctx.fill();
          }
        }
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(raf); set.green(false); framingRef.current = null; };
}
