"use strict";

// Deep tests for the extraction-only tesseract.js adapter. The OCR engine is
// INJECTED so every parsing path runs without the dependency or a real image.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTesseractOcr,
  parseIdText,
  isMeaningful,
  mrzCheckDigit,
  extractDates
} = require("../src/providers/tesseractOcr");

// ICAO 9303 specimen passport MRZ (check digits are valid by spec).
const TD3_L1 = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
const TD3_L2 = "L898902C36UTO7408122F1204159ZE184226B<<<<<10";

const TEXAS_DL = `Texas
DRIVER LICENSE
DL 44970687
Class C
DOB 08/10/1987
EXP 11/12/2029
ADENIYI IBRAHEEM ADELEKE
4746 DALLAS HWY APT 1100
SEX M HGT 5'-07" EYES BLK`;

const NIN_SLIP = `FEDERAL REPUBLIC OF NIGERIA
NATIONAL IDENTITY MANAGEMENT COMMISSION
NIN 12345678901
SURNAME Adeniyi
FIRST NAME Ibraheem`;

// ---------------------------------------------------------------------------
// MRZ math
// ---------------------------------------------------------------------------

test("mrzCheckDigit matches the ICAO specimen values", () => {
  assert.equal(mrzCheckDigit("L898902C3"), 6); // document number → 6
  assert.equal(mrzCheckDigit("740812"), 2);    // date of birth → 2
  assert.equal(mrzCheckDigit("120415"), 9);    // expiry → 9
});

test("TD3 passport MRZ parses with valid check digits", () => {
  const p = parseIdText(`${TD3_L1}\n${TD3_L2}`);
  assert.ok(p.mrz, "MRZ detected");
  assert.equal(p.mrz.format, "TD3");
  assert.equal(p.mrz.valid, true);
  assert.equal(p.mrz.documentNumber, "L898902C3");
  assert.equal(p.mrz.surname, "ERIKSSON");
  assert.equal(p.mrz.givenNames, "ANNA MARIA");
  assert.equal(p.mrz.dateOfBirth, "1974-08-12");
  assert.equal(p.mrz.expiryDate, "2012-04-15");
  assert.equal(p.mrz.sex, "F");
  assert.equal(p.fullNameCandidate, "ANNA MARIA ERIKSSON");
});

test("corrupted MRZ (one OCR misread) fails its check digit — not trusted", () => {
  const corrupted = TD3_L2.replace("L898902C3", "L898902C8"); // one char off
  const p = parseIdText(`${TD3_L1}\n${corrupted}`);
  assert.ok(p.mrz, "still recognized as MRZ-shaped");
  assert.equal(p.mrz.checks.documentNumber, false);
  assert.equal(p.mrz.valid, false, "invalid check digit must never validate");
});

test("MRZ lines with OCR-inserted spaces are still detected", () => {
  const spaced = `${TD3_L1.slice(0, 10)} ${TD3_L1.slice(10)}\n${TD3_L2.slice(0, 20)} ${TD3_L2.slice(20)}`;
  const p = parseIdText(spaced);
  assert.ok(p.mrz && p.mrz.valid);
});

// ---------------------------------------------------------------------------
// Free-text field heuristics
// ---------------------------------------------------------------------------

test("driver's license text: doc number, DOB, expiry, name candidate", () => {
  const p = parseIdText(TEXAS_DL);
  assert.equal(p.documentNumber, "DL44970687");
  assert.ok(p.dateOfBirth, "labeled DOB found");
  assert.ok(p.dateOfBirth.startsWith("1987-"));
  assert.ok(p.expiryDate.startsWith("2029-"), "labeled EXP found");
  assert.equal(p.fullNameCandidate, "ADENIYI IBRAHEEM ADELEKE");
  assert.ok(isMeaningful(p));
});

test("NIN slip: 11-digit NIN candidate + labeled surname", () => {
  const p = parseIdText(NIN_SLIP);
  assert.deepEqual(p.idNumberCandidates, ["12345678901"]);
  assert.equal(p.fullNameCandidate, "Adeniyi");
  assert.ok(isMeaningful(p));
});

test("boilerplate words never become the name candidate", () => {
  const p = parseIdText("DRIVER LICENSE\nFEDERAL REPUBLIC\nNATIONAL IDENTITY CARD");
  assert.equal(p.fullNameCandidate, null);
});

test("date disambiguation: day-first when a part exceeds 12", () => {
  const dates = extractDates("ISSUED 25/03/2024");
  assert.equal(dates[0].iso, "2024-03-25");
  const mdy = extractDates("EXP 03/25/2024"); // month-first forced the same way
  assert.equal(mdy[0].iso, "2024-03-25");
});

test("garbage text: nothing meaningful", () => {
  const p = parseIdText("~~ %% @@ ..\n. -");
  assert.equal(isMeaningful(p), false);
});

// The EXACT real-session bug (2026-07-06): tesseract mangled "DOB" into
// "00s", the labeled-date lookup missed, and the old fallback classified a
// 1987 BIRTH date as the EXPIRY → false DOCUMENT_EXPIRED.
test("mangled DOB label: a decades-old date classifies as DOB, never as expiry", () => {
  const p = parseIdText(`Bem Texas? (Wmmeoverm)
Oirector: aor 37H DRIVER LICENSE
sd. oL: 44970557 (
1 00s: 08/10/1987 .
1. ADENIY1
2/|IBRAHEEM ADELEKE
DALLAS, TX 752564
as ral`);
  assert.equal(p.dateOfBirth, "1987-10-08", "old date → DOB candidate");
  assert.equal(p.expiryDate, null, "a 39-year-old date is not an expiry");
  assert.equal(p.fullNameCandidate, "IBRAHEEM ADELEKE", "enumerated name line wins; lowercase junk ('as ral') never does");
});

test("lowercase OCR junk is never the name candidate", () => {
  const p = parseIdText("as ral\nsome noise");
  assert.equal(p.fullNameCandidate, null);
});

// ---------------------------------------------------------------------------
// Adapter contract (engine injected — no tesseract.js needed)
// ---------------------------------------------------------------------------

const passthrough = { preprocess: async (b) => b };

function adapterWith(text, confidence = 82) {
  return createTesseractOcr({
    ...passthrough,
    recognize: async () => ({ text, confidence })
  });
}

test("adapter: meaningful extraction → confidence mapped, validated:false, fields present", async () => {
  const ocr = adapterWith(TEXAS_DL, 82);
  const r = await ocr.extractDocument(Buffer.alloc(10));
  assert.equal(r.available, true);
  assert.equal(r.validated, false, "extraction-only data must NEVER be marked validated");
  assert.ok(r.ocrConfidence > 0 && r.ocrConfidence <= 0.9);
  assert.equal(r.extractedData.documentNumber, "DL44970687");
  assert.ok(r.extractedData.rawText.includes("DRIVER LICENSE"));
  assert.equal(r.expired, null, "heuristic dates are informational — only a valid MRZ may assert expiry");
});

test("adapter: check-digit-valid MRZ lifts confidence to >=0.95 and computes expired", async () => {
  const ocr = adapterWith(`${TD3_L1}\n${TD3_L2}`, 60);
  const r = await ocr.extractDocument(Buffer.alloc(10));
  assert.ok(r.ocrConfidence >= 0.95, "self-validating MRZ outranks engine confidence");
  assert.equal(r.expired, true, "specimen passport expired 2012");
  assert.equal(r.validated, false, "MRZ self-consistency is still not identity verification");
});

test("adapter: unreadable image → ocrConfidence 0 (DOCUMENT_OCR_FAILED path)", async () => {
  const ocr = adapterWith("%%% ~~ ..", 12);
  const r = await ocr.extractDocument(Buffer.alloc(10));
  assert.equal(r.ocrConfidence, 0);
  assert.equal(r.extractedData, null);
});

test("adapter: engine crash degrades to failed-OCR result, never throws", async () => {
  const ocr = createTesseractOcr({
    ...passthrough,
    recognize: async () => { throw new Error("wasm exploded"); }
  });
  const r = await ocr.extractDocument(Buffer.alloc(10));
  assert.equal(r.available, true);
  assert.equal(r.ocrConfidence, 0);
  assert.match(r.raw.error, /wasm exploded/);
});

test("adapter: no engine injected and tesseract.js not installed → null (worker degrades)", () => {
  // sandbox/CI never has tesseract.js installed — this asserts the optional-
  // dependency behavior directly. On the user's machine (dep installed) the
  // factory returns an adapter instead, which the contract tests above cover.
  let installed = true;
  try { require.resolve("tesseract.js"); } catch { installed = false; }
  const ocr = createTesseractOcr();
  assert.equal(ocr === null, !installed);
});
