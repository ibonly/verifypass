"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const { tenantScope } = require("../src/middleware/tenantScope");
const { PdfDoc, jpegDimensions } = require("../src/services/pdf");
const { saveEvidence } = require("../src/services/evidenceStore");
const { buildEvidencePdf } = require("../src/services/evidencePdfService");

const KEY_HEX = crypto.randomBytes(32).toString("hex");

/** Structurally valid JPEG header (APP0 + SOF0 + scan + EOI) — enough for
 *  dimension parsing and DCTDecode passthrough; not visually decodable. */
function syntheticJpeg(width = 64, height = 48) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00], 9);
  const scan = crypto.randomBytes(1500);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof, scan, eoi]);
}

function scopeFor(tenant) {
  const req = { tenant };
  tenantScope(req, {}, () => {});
  return req.scopedDb;
}

test("jpegDimensions parses SOF, rejects non-JPEG", () => {
  const d = jpegDimensions(syntheticJpeg(320, 240));
  assert.deepEqual(d, { width: 320, height: 240 });
  assert.throws(() => jpegDimensions(Buffer.from("not a jpeg at all")));
});

test("PdfDoc renders structurally valid PDF with text + embedded JPEG", () => {
  const doc = new PdfDoc();
  const p1 = doc.addPage();
  p1.text(50, 800, "Hello (parens) & back\\slash", { bold: true });
  const jpeg = syntheticJpeg(100, 80);
  p1.image(jpeg, 50, 700, 200, 200);
  doc.addPage().text(50, 800, "Page two");

  const pdf = doc.render();
  const s = pdf.toString("latin1");

  assert.ok(s.startsWith("%PDF-1.4"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));
  assert.ok(s.includes("/Count 2"));
  assert.ok(s.includes("/BaseFont /Helvetica-Bold"));
  assert.ok(s.includes("(Hello \\(parens\\) & back\\\\slash)"));
  assert.ok(s.includes("(Page two)"));
  assert.ok(s.includes("/Filter /DCTDecode"));
  assert.ok(pdf.includes(jpeg)); // image bytes passed through untouched
  // xref sanity: startxref points at the xref table
  const startxref = Number(s.match(/startxref\n(\d+)/)[1]);
  assert.equal(s.slice(startxref, startxref + 4), "xref");
  // every object offset in xref points at "N 0 obj"
  const xrefBlock = s.slice(startxref);
  const entries = [...xrefBlock.matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
  entries.forEach((off, i) => {
    assert.ok(new RegExp(`^${i + 1} 0 obj`).test(s.slice(off, off + 12)), `object ${i + 1} offset`);
  });
});

test("non-ASCII text degrades safely instead of corrupting the file", () => {
  const doc = new PdfDoc();
  doc.addPage().text(50, 800, "Adébáyò — ₦5,000 “quoted”");
  const s = doc.render().toString("latin1");
  // common punctuation/currency mapped; unmappable accents become ?
  assert.ok(s.includes('(Ad?b?y? - NGN 5,000 "quoted")'));
});

async function seedCase({ withImages = true, extractedData = { fullName: "ADEBAYO JOHN", documentNumber: "A12345678" } } = {}) {
  const db = createMockDb();
  setDb(db);
  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_pdf", companyName: "Acme MFB", status: "active" } });
  const session = await db.verificationSession.create({
    data: {
      sessionUid: "vps_PDF1", tenantId: tenant.id, customerReference: "CUST-PDF",
      verificationType: "ID_AND_FACE", status: "approved", riskLevel: "low",
      decisionReason: { reasonCodes: [] }, isLive: true,
      createdAt: new Date("2026-07-01T10:00:00Z"), completedAt: new Date("2026-07-01T10:00:20Z")
    }
  });
  await db.verificationResult.create({
    data: {
      sessionId: session.id, livenessScore: 0.97, livenessStatus: "passed",
      faceMatchScore: 0.91, faceMatchStatus: "matched", documentStatus: "valid",
      ocrConfidence: 0.94, extractedData
    }
  });
  const jpegs = {};
  if (withImages) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vp-pdf-"));
    for (const fileType of ["id_front", "selfie"]) {
      const jpeg = syntheticJpeg(200, 150);
      const stored = await saveEvidence({
        tenantUid: tenant.tenantUid, sessionUid: session.sessionUid, fileType,
        buffer: jpeg, baseDir: dir, key: KEY_HEX
      });
      await db.evidenceFile.create({
        data: { sessionId: session.id, fileType, storagePath: stored.storagePath, checksum: stored.checksum }
      });
      jpegs[fileType] = jpeg;
    }
  }
  await db.manualReviewNote.create({ data: { sessionId: session.id, userId: 7, decision: "approved", note: "Face and ID accepted." } });
  await db.auditLog.create({ data: { tenantId: tenant.id, sessionId: session.id, actorType: "system", action: "verification.decided", riskEvent: false, createdAt: new Date() } });
  return { db, tenant, session, jpegs };
}

test("buildEvidencePdf: full case file with embedded decrypted images", async (t) => {
  const { tenant, jpegs } = await seedCase();
  t.after(() => setDb(null));

  const pdf = await buildEvidencePdf(scopeFor(tenant), tenant, "vps_PDF1", { evidenceKey: KEY_HEX });
  const s = pdf.toString("latin1");

  assert.ok(s.startsWith("%PDF-1.4"));
  assert.ok(s.includes("CONFIDENTIAL"));
  assert.ok(s.includes("Acme MFB"));
  assert.ok(s.includes("vps_PDF1"));
  assert.ok(s.includes("CUST-PDF"));
  assert.ok(s.includes("0.9700"));           // liveness score
  assert.ok(s.includes("ADEBAYO JOHN"));     // extracted data
  assert.ok(s.includes("Face and ID accepted.")); // review note
  assert.ok(s.includes("verification.decided"));  // audit trail
  assert.ok(pdf.includes(jpegs.id_front));   // decrypted image bytes embedded
  assert.ok(pdf.includes(jpegs.selfie));
});

test("buildEvidencePdf: erased case degrades gracefully", async (t) => {
  const { tenant } = await seedCase({ withImages: false, extractedData: null });
  t.after(() => setDb(null));

  const pdf = await buildEvidencePdf(scopeFor(tenant), tenant, "vps_PDF1", { evidenceKey: KEY_HEX });
  const s = pdf.toString("latin1");
  assert.ok(s.includes("removed \\(biometric deletion\\) or unavailable"));
  assert.ok(s.includes("No evidence files on record"));
});

test("buildEvidencePdf: tenant isolation — other tenant gets 404", async (t) => {
  const { db, tenant } = await seedCase();
  t.after(() => setDb(null));
  const other = await db.tenant.create({ data: { tenantUid: "tnt_other", companyName: "Other", status: "active" } });
  await assert.rejects(
    () => buildEvidencePdf(scopeFor(other), other, "vps_PDF1", { evidenceKey: KEY_HEX }),
    (e) => e.code === "SESSION_NOT_FOUND"
  );
  assert.ok(tenant); // silence unused
});
