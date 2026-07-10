"use strict";

// Faceplugin on-premise Docker adapter — REAL integration (no stubs).
//
// Contracts verified against Faceplugin's published source:
//   Liveness  (Faceplugin-ltd/FaceLivenessDetection-Linux, app.py):
//     POST {livenessUrl}/liveness-detection   multipart field "file"
//     → { face_state: { result: "Real"|"Spoof"|"No face"|"Multiple face"|
//                       "Failed to open file",
//                       liveness_score: <float 0..1|null>,
//                       is_occluded, quality: "Low"|"Medium"|"High",
//                       luminance: "Dark"|"Normal"|"Light", ... },
//         faces: [ { x1,y1,x2,y2, liveness, face_quality, ... } ] }
//
//   Face compare (Faceplugin-ltd/FaceRecognition-Docker, app.py):
//     POST {faceUrl}/face_compare   multipart fields "file1" (selfie),
//                                   "file2" (ID face), form "threshold"
//     → { result: { similarity: <float 0..1>,
//                   status: "Same Person"|"Different Person"|null,
//                   message: "Success"|"Failed to extract feature on image1"|
//                            "Failed to extract feature on image2"|... } }
//
//   ID OCR is a SEPARATE Faceplugin product (ID-Card-Recognition). It is
//   optional here: when FACEPLUGIN_IDOCR_URL is unset the pipeline degrades
//   to manual_review via DOCUMENT_OCR_FAILED (fail-closed, PRD §13.2).
//
// Both liveness and face containers listen on 8888 internally, so they are
// published on different host ports (see deploy/faceplugin.md + docker-compose).

class ProviderError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProviderError";
    this.cause = cause;
  }
}

function makeForm(files, fields = {}) {
  const form = new FormData();
  for (const [field, buffer] of Object.entries(files)) {
    form.append(field, new Blob([buffer], { type: "application/octet-stream" }), `${field}.jpg`);
  }
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  return form;
}

/**
 * Count SIGNIFICANT faces only. RetinaFace occasionally emits a tiny spurious
 * second box (pattern on clothing/background, or a duplicate the NMS missed),
 * which made single-person frames fail the faceCount===1 gate — rejecting real
 * users with MULTIPLE_FACES_DETECTED / LIVENESS_CHALLENGE_INCOMPLETE.
 * A face counts only if its area is >= 25% of the largest face's area
 * (50% of its linear size) — a real second person near the camera still
 * counts; background objects/faces-on-shelves don't. (Raised from 15% after
 * real sessions still produced spurious secondary detections; multi-face is
 * also now a manual-review signal rather than a hard reject, so a reviewer
 * backstops this heuristic.)
 */
function significantFaceCount(faces) {
  if (!Array.isArray(faces) || faces.length === 0) return 0;
  const areas = faces.map((f) => {
    const w = Math.max(0, Number(f.x2) - Number(f.x1));
    const h = Math.max(0, Number(f.y2) - Number(f.y1));
    return w * h;
  });
  const max = Math.max(...areas);
  if (!(max > 0)) return faces.length;
  return areas.filter((a) => a >= max * 0.25).length;
}

function createFacepluginProvider({
  livenessUrl,
  faceUrl,
  idOcrUrl,
  matchThreshold = 0.6,
  timeoutMs = 20000,
  fetchImpl,
  paths = {}
} = {}) {
  const doFetch = fetchImpl || fetch;
  const P = {
    liveness: paths.liveness || "/liveness-detection",
    compare: paths.compare || "/face_compare",
    idOcr: paths.idOcr || "/ocr-id"
  };

  async function post(baseUrl, path, files, fields) {
    let res;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        body: makeForm(files, fields),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      throw new ProviderError(`Faceplugin unreachable at ${baseUrl}${path}: ${err.message}`, err);
    }
    if (!res.ok) throw new ProviderError(`Faceplugin ${path} returned HTTP ${res.status}`);
    return res.json();
  }

  return {
    name: "faceplugin",

    /**
     * Passive liveness on the selfie.
     * @param {Buffer} selfieBuffer
     * @returns {{score:number|null, faceCount:number, occluded:boolean,
     *            quality:string|null, luminance:string|null, raw:object}}
     */
    async checkLiveness(selfieBuffer) {
      const json = await post(livenessUrl, P.liveness, { file: selfieBuffer });
      const state = json.face_state || {};
      const result = state.result || "";
      const faceCount = Array.isArray(json.faces) && json.faces.length
        ? significantFaceCount(json.faces)
        : result === "No face" ? 0
          : result === "Multiple face" ? 2
            : result === "Real" || result === "Spoof" ? 1
              : 0;
      // Pose of the PRIMARY (largest) face — the liveness container returns
      // yaw/roll/pitch per face. Used by the challenge verifier to confirm the
      // requested head movement actually happened (magnitude-based).
      let pose = null;
      if (Array.isArray(json.faces) && json.faces.length) {
        const primary = json.faces.reduce((best, f) => {
          const area = Math.max(0, Number(f.x2) - Number(f.x1)) * Math.max(0, Number(f.y2) - Number(f.y1));
          return !best || area > best.area ? { f, area } : best;
        }, null).f;
        if (typeof primary.yaw === "number" || typeof primary.pitch === "number") {
          pose = {
            yaw: Number(primary.yaw) || 0,
            pitch: Number(primary.pitch) || 0,
            roll: Number(primary.roll) || 0
          };
        }
      }
      return {
        score: typeof state.liveness_score === "number" ? state.liveness_score : null,
        // The container's verbatim verdict ("Real"|"Spoof"|"No face"|...).
        // Used by the pipeline's document validation: a "Real" verdict on the
        // ID-front image means a live face was shown, not a card.
        verdict: state.result || null,
        faceCount,
        pose,
        occluded: state.is_occluded === true,
        quality: state.quality || null,
        luminance: state.luminance || null,
        raw: json
      };
    },

    /**
     * Compare selfie face (file1) to ID-document face (file2).
     * @returns {{score:number|null, idFaceFound:boolean, raw:object}} score 0..1
     */
    async compareFaces(selfieBuffer, idImageBuffer) {
      const json = await post(faceUrl, P.compare, { file1: selfieBuffer, file2: idImageBuffer }, { threshold: matchThreshold });
      const result = json.result || json;
      const message = String(result.message || "");
      const status = result.status;

      let idFaceFound = true;
      let score = null;

      const extractionFailed =
        status === null || status === undefined || status === "None" ||
        /failed to extract feature|no ?face|failed to open/i.test(message);

      if (!extractionFailed && typeof result.similarity === "number") {
        // Faceplugin returns 0..1; tolerate a 0..100 build defensively.
        score = result.similarity > 1 ? result.similarity / 100 : result.similarity;
      }

      // "image2" is file2 = the ID-document face. Its absence is the signal
      // the decision engine uses for NO_FACE_ON_DOCUMENT (review, not reject).
      if (/image2/i.test(message)) idFaceFound = false;

      // The container's OWN verdict (against the threshold we sent). Recorded
      // for calibration: if the model's similarity scale differs from our
      // faceMatch thresholds, providerMatch=true alongside a "low" score is
      // the signal that the tenant thresholds need recalibrating — not the user.
      const providerMatch = status === "Same Person" ? true
        : status === "Different Person" ? false
          : null;

      return { score, idFaceFound, providerMatch, raw: json };
    },

    /**
     * OCR the ID document. Optional external service (ID-Card-Recognition).
     * @returns {{available:boolean, ocrConfidence:number|null,
     *            extractedData:object|null, expired:boolean|null, raw:object|null}}
     */
    async extractDocument(idImageBuffer) {
      if (!idOcrUrl) return { available: false, ocrConfidence: null, extractedData: null, expired: null, raw: null };
      const json = await post(idOcrUrl, P.idOcr, { file: idImageBuffer });
      const data = json.data || json.extracted || json.result || null;
      let expired = null;
      const expiry = data?.expiryDate || data?.expiry_date || data?.dateOfExpiry || null;
      if (expiry) {
        const d = new Date(expiry);
        if (!Number.isNaN(d.getTime())) expired = d < new Date();
      }
      let conf = json.confidence ?? json.ocr_confidence ?? (data ? 0.9 : null);
      if (typeof conf === "number" && conf > 1) conf /= 100;
      return { available: true, ocrConfidence: conf, extractedData: data, expired, raw: json };
    }
  };
}

module.exports = { createFacepluginProvider, ProviderError, significantFaceCount };
