"use strict";

// Tesseract.js OCR adapter — EXTRACTION ONLY (product decision 2026-07-06).
//
// Role: pull raw text + best-effort structured fields off the ID image so
// reviewers see the data and downstream identity VERIFICATION (government
// database lookup: NIN/BVN/license) has an input to check. It performs NO
// authenticity validation, so it must never flip a session to "valid" on its
// own: the provider result carries `validated: false`, which the decision
// engine maps to a DOCUMENT_UNVERIFIED manual-review flag. Fail-closed is
// preserved end-to-end — good extraction informs the reviewer; it does not
// replace them until a verification API confirms the extracted identity.
//
// tesseract.js is an OPTIONAL dependency (pure WASM, `npm i` on the deploy
// box). When it isn't installed this module returns null and the worker
// degrades exactly as before (DOCUMENT_OCR_FAILED review).
//
// The OCR engine is injectable so every parsing path below is unit-testable
// without the dependency or a real image.

// ---------------------------------------------------------------------------
// MRZ (ICAO 9303) — the one part of an ID that SELF-validates: check digits
// over document number, DOB and expiry catch OCR misreads. Passports (TD3,
// 2×44) and modern ID cards incl. the Nigerian NIN card (TD1, 3×30).
// ---------------------------------------------------------------------------

const MRZ_CHAR_VALUES = (() => {
  const map = { "<": 0 };
  for (let i = 0; i <= 9; i++) map[String(i)] = i;
  for (let i = 0; i < 26; i++) map[String.fromCharCode(65 + i)] = 10 + i;
  return map;
})();

function mrzCheckDigit(str) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const v = MRZ_CHAR_VALUES[str[i]];
    if (v === undefined) return -1; // non-MRZ character → cannot validate
    sum += v * weights[i % 3];
  }
  return sum % 10;
}

function mrzDateToIso(yymmdd, { expiry = false } = {}) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  // Century heuristic: expiry dates are always in the 2000s for a live
  // document; birth years above the current 2-digit year are 19xx.
  const nowYY = new Date().getFullYear() % 100;
  const century = expiry ? 20 : yy > nowYY ? 19 : 20;
  const iso = `${century}${String(yy).padStart(2, "0")}-${mm}-${dd}`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

function mrzNames(field) {
  const [surnamePart, givenPart] = field.split("<<");
  const clean = (s) => (s || "").replace(/</g, " ").trim().replace(/\s+/g, " ");
  return { surname: clean(surnamePart), givenNames: clean(givenPart) };
}

/** Parse a TD3 (passport) MRZ: 2 lines × 44 chars. Returns null if not TD3. */
function parseTd3(lines) {
  const [l1, l2] = lines;
  if (!l1 || !l2 || l1.length !== 44 || l2.length !== 44 || l1[0] !== "P") return null;
  const documentNumber = l2.slice(0, 9).replace(/</g, "");
  const checks = {
    documentNumber: mrzCheckDigit(l2.slice(0, 9)) === Number(l2[9]),
    dateOfBirth: mrzCheckDigit(l2.slice(13, 19)) === Number(l2[19]),
    expiryDate: mrzCheckDigit(l2.slice(21, 27)) === Number(l2[27])
  };
  const { surname, givenNames } = mrzNames(l1.slice(5));
  return {
    format: "TD3",
    documentType: "passport",
    issuingCountry: l1.slice(2, 5).replace(/</g, ""),
    surname,
    givenNames,
    documentNumber,
    nationality: l2.slice(10, 13).replace(/</g, ""),
    dateOfBirth: mrzDateToIso(l2.slice(13, 19)),
    sex: l2[20] === "M" ? "M" : l2[20] === "F" ? "F" : null,
    expiryDate: mrzDateToIso(l2.slice(21, 27), { expiry: true }),
    checks,
    valid: checks.documentNumber && checks.dateOfBirth && checks.expiryDate
  };
}

/** Parse a TD1 (ID card) MRZ: 3 lines × 30 chars. Returns null if not TD1. */
function parseTd1(lines) {
  const [l1, l2, l3] = lines;
  if (!l1 || !l2 || !l3 || l1.length !== 30 || l2.length !== 30 || l3.length !== 30) return null;
  if (!/^[AICV]/.test(l1[0])) return null;
  const checks = {
    documentNumber: mrzCheckDigit(l1.slice(5, 14)) === Number(l1[14]),
    dateOfBirth: mrzCheckDigit(l2.slice(0, 6)) === Number(l2[6]),
    expiryDate: mrzCheckDigit(l2.slice(8, 14)) === Number(l2[14])
  };
  const { surname, givenNames } = mrzNames(l3);
  return {
    format: "TD1",
    documentType: "id_card",
    issuingCountry: l1.slice(2, 5).replace(/</g, ""),
    surname,
    givenNames,
    documentNumber: l1.slice(5, 14).replace(/</g, ""),
    nationality: l2.slice(15, 18).replace(/</g, ""),
    dateOfBirth: mrzDateToIso(l2.slice(0, 6)),
    sex: l2[7] === "M" ? "M" : l2[7] === "F" ? "F" : null,
    expiryDate: mrzDateToIso(l2.slice(8, 14), { expiry: true }),
    checks,
    valid: checks.documentNumber && checks.dateOfBirth && checks.expiryDate
  };
}

function findMrz(rawLines) {
  // MRZ lines are long runs of A-Z, 0-9 and '<'. OCR often inserts spaces —
  // strip them before matching. Common OCR confusions in the filler char
  // («, ‹, poor '<') are normalized upstream by the A-Z0-9< filter itself.
  const candidates = rawLines
    .map((l) => l.toUpperCase().replace(/\s+/g, ""))
    .filter((l) => l.length >= 28 && /^[A-Z0-9<]+$/.test(l) && l.includes("<"));
  for (let i = 0; i < candidates.length - 1; i++) {
    const td3 = parseTd3([candidates[i], candidates[i + 1]]);
    if (td3) return td3;
    if (i < candidates.length - 2) {
      const td1 = parseTd1([candidates[i], candidates[i + 1], candidates[i + 2]]);
      if (td1) return td1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Free-text field heuristics (non-MRZ documents: driver's licenses, voter
// cards). Extraction candidates only — never treated as authoritative.
// ---------------------------------------------------------------------------

const DATE_PATTERNS = [
  // dd/mm/yyyy or mm/dd/yyyy (ambiguity resolved when one part > 12)
  { re: /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})\b/g, kind: "dmy_or_mdy" },
  // yyyy-mm-dd
  { re: /\b(\d{4})[/\-.](\d{2})[/\-.](\d{2})\b/g, kind: "ymd" },
  // dd MON yyyy
  { re: /\b(\d{1,2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s?(\d{4})\b/gi, kind: "dMonY" }
];

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

function toIso(y, m, d) {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const iso = `${y}-${mm}-${dd}`;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  if (Number(y) < 1900 || Number(y) > 2100 || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return iso;
}

function extractDates(text) {
  const found = [];
  for (const { re, kind } of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      let iso = null;
      if (kind === "ymd") iso = toIso(m[1], m[2], m[3]);
      else if (kind === "dMonY") iso = toIso(m[3], MONTHS[m[2].slice(0, 3).toUpperCase()], m[1]);
      else {
        const a = Number(m[1]);
        const b = Number(m[2]);
        // dd/mm when the first part can't be a month; mm/dd when the second
        // can't be a day-in-month-position. Ambiguous → try dd/mm (Nigerian
        // documents use day-first), the raw string is kept either way.
        if (a > 12 && b <= 12) iso = toIso(m[3], b, a);
        else if (b > 12 && a <= 12) iso = toIso(m[3], a, b);
        else iso = toIso(m[3], b, a);
      }
      if (iso) found.push({ raw: m[0], iso, index: m.index });
    }
  }
  return found.sort((x, y) => x.index - y.index);
}

/** Find a date whose surrounding text (same line) matches a label pattern. */
function labeledDate(lines, dates, labelRe) {
  for (const line of lines) {
    if (!labelRe.test(line)) continue;
    const hit = dates.find((d) => line.includes(d.raw));
    if (hit) return hit.iso;
  }
  return null;
}

const NAME_STOPWORDS = /LICENSE|LICENCE|DRIVER|DRIVING|FEDERAL|REPUBLIC|NIGERIA|NATIONAL|IDENTITY|IDENTIFICATION|CARD|PERMIT|VOTER|COMMISSION|CLASS|SEX|HGT|HEIGHT|EYES|DOB|EXP|ISS|RESTR|END|DONOR|ADDRESS|STATE|TEXAS|USA|DEPARTMENT|PUBLIC|SAFETY|AUTHORITY|GOVERNMENT|UNITED|KINGDOM|PASSPORT/;

/** Strip layout enumeration OCR picks up on cards: "1. ", "2/|", "4d) ". */
function stripEnumeration(line) {
  return line.replace(/^(?:\d{1,2}[a-z]?[.,:/|)\-]+\s*|[/|]+\s*)+/i, "").trim();
}

function extractNameCandidate(lines) {
  const cleaned = lines.map(stripEnumeration).filter(Boolean);
  // Labeled first: "SURNAME X" / "LAST NAME X" / "NAME: X"
  for (const line of cleaned) {
    const m = line.match(/(?:SURNAME|LAST\s*NAME|FIRST\s*NAME|GIVEN\s*NAMES?|FULL\s*NAME|NAME)\s*[:\-]?\s+([A-Z][A-Za-z' -]{2,40})$/i);
    if (m && !NAME_STOPWORDS.test(m[1].toUpperCase())) return m[1].trim();
  }
  // Fallback: first line of 2+ CAPITALIZED alphabetic words that isn't
  // boilerplate. Capitalization required — lowercase fragments are OCR noise
  // (the "as ral" bug: a junk line beat the real name line).
  for (const line of cleaned) {
    const words = line.split(/\s+/);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Z][A-Za-z'-]{2,}$/.test(w))) continue;
    if (NAME_STOPWORDS.test(line.toUpperCase())) continue;
    return line;
  }
  return null;
}

/**
 * Parse OCR text into extraction candidates. Pure — deeply unit-tested.
 * @returns {{mrz, idNumberCandidates, documentNumber, dates, dateOfBirth,
 *            expiryDate, fullNameCandidate, rawText}}
 */
function parseIdText(text) {
  const rawText = String(text || "").trim();
  const lines = rawText.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  const mrz = findMrz(lines);
  const dates = extractDates(rawText);

  // 11-digit runs = NIN/BVN candidates (both are exactly 11 digits).
  const idNumberCandidates = [...new Set((rawText.match(/\b\d{11}\b/g) || []))];

  // Generic document-number pattern (letters + digits, e.g. "A12345678").
  const docNumMatch = rawText.match(/\b[A-Z]{1,3}[- ]?\d{6,12}\b/);

  // Unlabeled-date classification by PLAUSIBILITY, not position: OCR mangles
  // labels ("DOB" → "00s"), and blindly calling the latest date "expiry" once
  // turned a 1987 birth date into DOCUMENT_EXPIRED. A date >15 years past can
  // only be a birth/issue date; an expiry is recent-past or future.
  const nowY = new Date().getFullYear();
  const yearOf = (iso) => Number(iso.slice(0, 4));
  const oldDates = dates.filter((d) => yearOf(d.iso) <= nowY - 15);
  const recentOrFuture = dates.filter((d) => yearOf(d.iso) > nowY - 15);

  const dateOfBirth = (mrz && mrz.dateOfBirth)
    || labeledDate(lines, dates, /DOB|BIRTH|BORN/i)
    || (oldDates.length ? oldDates[0].iso : null)
    || null;
  const expiryDate = (mrz && mrz.expiryDate)
    || labeledDate(lines, dates, /EXP|EXPIR|VALID\s*(TO|UNTIL|THRU)/i)
    || (recentOrFuture.length
      ? [...recentOrFuture].sort((a, b) => (a.iso < b.iso ? 1 : -1))[0].iso
      : null);

  return {
    mrz,
    idNumberCandidates,
    documentNumber: (mrz && mrz.documentNumber) || (docNumMatch ? docNumMatch[0].replace(/[- ]/g, "") : null),
    dates: dates.map((d) => ({ raw: d.raw, iso: d.iso })),
    dateOfBirth,
    expiryDate,
    fullNameCandidate: mrz && (mrz.surname || mrz.givenNames)
      ? [mrz.givenNames, mrz.surname].filter(Boolean).join(" ")
      : extractNameCandidate(lines),
    rawText: rawText.slice(0, 2000) // cap for result-row / PDF sanity
  };
}

/** Did extraction find anything a reviewer or a verification API can use? */
function isMeaningful(parsed) {
  return Boolean(
    (parsed.mrz && parsed.mrz.valid)
    || parsed.idNumberCandidates.length
    || parsed.documentNumber
    || parsed.dateOfBirth
    || parsed.expiryDate
    || (parsed.fullNameCandidate && parsed.rawText.length >= 20)
  );
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function tesseractInstalled() {
  try {
    require.resolve("tesseract.js");
    return true;
  } catch {
    return false;
  }
}

/** Upscale + grayscale + normalize markedly improves tesseract on webcam
 *  captures. sharp is already a worker dependency; degrade to the raw buffer
 *  wherever its native binary can't load (e.g. Linux CI on macOS modules). */
async function defaultPreprocess(buffer) {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    return buffer;
  }
  try {
    return await sharp(buffer)
      .grayscale()
      .normalize()
      .resize({ width: 1400, withoutEnlargement: false })
      .png()
      .toBuffer();
  } catch {
    return buffer;
  }
}

/**
 * @param {object} [opts]
 * @param {(buf:Buffer)=>Promise<{text:string, confidence:number|null}>} [opts.recognize]
 *   injectable engine (tests); defaults to a shared lazy tesseract.js worker
 * @param {(buf:Buffer)=>Promise<Buffer>} [opts.preprocess]
 * @param {string} [opts.langs]
 * @returns adapter or null when tesseract.js isn't installed (and no engine injected)
 */
function createTesseractOcr(opts = {}) {
  if (!opts.recognize && !tesseractInstalled()) return null;

  let workerPromise = null;
  async function defaultRecognize(buffer) {
    const { createWorker } = require("tesseract.js");
    if (!workerPromise) workerPromise = createWorker(opts.langs || "eng");
    const worker = await workerPromise;
    const { data } = await worker.recognize(buffer);
    return {
      text: data && data.text ? data.text : "",
      confidence: data && typeof data.confidence === "number" ? data.confidence : null
    };
  }

  const recognize = opts.recognize || defaultRecognize;
  const preprocess = opts.preprocess || defaultPreprocess;

  return {
    name: "tesseract-js",

    /**
     * Same contract as the other providers' extractDocument, with one
     * addition: `validated: false` — this data was READ, never VERIFIED.
     * @returns {{available, ocrConfidence, extractedData, expired, validated, raw}}
     */
    async extractDocument(idImageBuffer) {
      let out;
      try {
        const img = await preprocess(idImageBuffer);
        out = await recognize(img);
      } catch (err) {
        // Engine failure = no extraction — fail closed (OCR_FAILED review),
        // never crash the verification job.
        return {
          available: true,
          ocrConfidence: 0,
          extractedData: null,
          expired: null,
          validated: false,
          raw: { engine: "tesseract.js", error: String(err && err.message) }
        };
      }

      const parsed = parseIdText(out.text);
      if (!isMeaningful(parsed)) {
        return {
          available: true,
          ocrConfidence: 0, // nothing usable read → DOCUMENT_OCR_FAILED review
          extractedData: null,
          expired: null,
          validated: false,
          raw: { engine: "tesseract.js", textLength: parsed.rawText.length, engineConfidence: out.confidence }
        };
      }

      // Confidence: a check-digit-valid MRZ is self-verifying (the strongest
      // signal OCR alone can produce); otherwise trust the engine's own
      // 0-100 estimate, floored so a "meaningful" read never reports 0.
      const engineConf = typeof out.confidence === "number" ? out.confidence / 100 : 0.5;
      const ocrConfidence = parsed.mrz && parsed.mrz.valid
        ? Math.max(0.95, engineConf)
        : Math.max(0.1, Math.min(engineConf, 0.9));

      // `expired` is a DECISION signal (→ DOCUMENT_EXPIRED review), so it may
      // only come from a CHECK-DIGIT-VALID MRZ — the one extraction that
      // self-verifies. Heuristic dates stay informational in extractedData;
      // authoritative expiry checks belong to the later verification phase.
      const expired = parsed.mrz && parsed.mrz.valid && parsed.mrz.expiryDate
        ? new Date(parsed.mrz.expiryDate) < new Date()
        : null;

      return {
        available: true,
        ocrConfidence,
        extractedData: {
          source: "tesseract.js (extraction only — not validated)",
          fullNameCandidate: parsed.fullNameCandidate,
          documentNumber: parsed.documentNumber,
          idNumberCandidates: parsed.idNumberCandidates,
          dateOfBirth: parsed.dateOfBirth,
          expiryDate: parsed.expiryDate,
          mrz: parsed.mrz,
          datesFound: parsed.dates,
          rawText: parsed.rawText
        },
        expired,
        validated: false,
        raw: { engine: "tesseract.js", engineConfidence: out.confidence, mrzValid: !!(parsed.mrz && parsed.mrz.valid) }
      };
    }
  };
}

module.exports = {
  createTesseractOcr,
  parseIdText,
  isMeaningful,
  mrzCheckDigit,
  findMrz,
  extractDates
};
