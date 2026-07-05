"use strict";

// Evidence PDF generation (PRD Phase 2: "Evidence PDF generation").
// Produces a single case file per session: metadata, decision, scores,
// extracted ID data, the evidence images (decrypted server-side, embedded),
// review notes, and the session's audit trail. Every page is marked
// CONFIDENTIAL with the tenant name.

const { AppError } = require("@verifypass/shared");
const { PdfDoc, A4 } = require("./pdf");
const { readEvidence } = require("./evidenceStore");
const { getDb } = require("../lib/db");

const MARGIN = 48;
const LINE = 14;

function layout(doc, tenantName) {
  const state = { doc, page: null, y: 0 };
  function newPage() {
    state.page = doc.addPage();
    state.y = A4.height - MARGIN;
    state.page.text(MARGIN, A4.height - 28, `CONFIDENTIAL — ${tenantName} — VerifyPass evidence export`, { size: 8, gray: 0.55 });
  }
  newPage();
  return {
    get page() { return state.page; },
    ensure(h) { if (state.y - h < MARGIN) newPage(); },
    heading(text) {
      this.ensure(LINE * 2.5);
      state.y -= LINE;
      state.page.text(MARGIN, state.y, text, { size: 13, bold: true });
      state.y -= 6;
      state.page.line(MARGIN, state.y, A4.width - MARGIN, state.y);
      state.y -= LINE;
    },
    row(label, value) {
      this.ensure(LINE);
      state.page.text(MARGIN, state.y, label, { size: 9, gray: 0.45 });
      state.page.text(MARGIN + 150, state.y, value == null || value === "" ? "—" : String(value), { size: 10 });
      state.y -= LINE;
    },
    textLine(text, opts) {
      this.ensure(LINE);
      state.page.text(MARGIN, state.y, text, { size: 9, ...opts });
      state.y -= LINE;
    },
    image(buffer, label) {
      const boxW = A4.width - MARGIN * 2;
      const boxH = 260;
      this.ensure(boxH + LINE * 2);
      state.page.text(MARGIN, state.y, label, { size: 10, bold: true });
      state.y -= LINE;
      const drawn = state.page.image(buffer, MARGIN, state.y, boxW, boxH);
      state.y -= drawn + LINE;
    }
  };
}

function fmtScore(v) {
  return v == null ? null : Number(v).toFixed(4);
}

function fmtDate(d) {
  return d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) + " UTC" : null;
}

/**
 * @returns {Buffer} PDF file
 */
async function buildEvidencePdf(scopedDb, tenant, sessionUid, { evidenceKey } = {}) {
  const session = await scopedDb.sessions.findByUid(sessionUid);
  if (!session) throw new AppError("SESSION_NOT_FOUND");

  const db = getDb();
  const result = await scopedDb.results.latestForSession(session.id);
  const evidence = await scopedDb.evidence.listForSession(session.id);
  const notes = await db.manualReviewNote.findMany({ where: { sessionId: session.id } });
  const auditRows = await db.auditLog.findMany({ where: { sessionId: session.id, tenantId: tenant.id } });

  const doc = new PdfDoc();
  const L = layout(doc, tenant.companyName);

  // --- Case summary ---
  L.heading("Verification case file");
  L.row("Session", session.sessionUid);
  L.row("Customer reference", session.customerReference);
  L.row("Environment", session.isLive ? "production" : "sandbox");
  L.row("Verification type", session.verificationType);
  L.row("Status", session.status);
  L.row("Risk level", session.riskLevel);
  L.row("Reason codes", (session.decisionReason?.reasonCodes || []).join(", ") || "none");
  L.row("Created", fmtDate(session.createdAt));
  L.row("Completed", fmtDate(session.completedAt));
  L.row("Exported", fmtDate(new Date()));

  // --- Scores ---
  L.heading("Verification results");
  if (result) {
    L.row("Liveness", `${fmtScore(result.livenessScore) ?? "—"}  (${result.livenessStatus ?? "n/a"})`);
    L.row("Face match", `${fmtScore(result.faceMatchScore) ?? "—"}  (${result.faceMatchStatus ?? "n/a"})`);
    L.row("Document", result.documentStatus ?? "n/a");
    L.row("OCR confidence", fmtScore(result.ocrConfidence));
    if (result.extractedData && typeof result.extractedData === "object") {
      L.textLine("Extracted document data:", { bold: true });
      for (const [k, v] of Object.entries(result.extractedData)) L.row(`  ${k}`, v);
    } else {
      L.textLine("Extracted document data: removed (biometric deletion) or unavailable.", { gray: 0.45 });
    }
  } else {
    L.textLine("No verification result recorded for this session.", { gray: 0.45 });
  }

  // --- Evidence images ---
  L.heading("Captured evidence");
  const wanted = ["id_front", "id_back", "selfie"];
  const labels = { id_front: "ID document (front)", id_back: "ID document (back)", selfie: "Live selfie" };
  let anyImage = false;
  for (const type of wanted) {
    const file = evidence.filter((e) => e.fileType === type).sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    if (!file) continue;
    try {
      const jpeg = await readEvidence(file.storagePath, { key: evidenceKey });
      L.image(jpeg, `${labels[type]}  —  sha256 ${String(file.checksum || "").slice(0, 16)}…`);
      anyImage = true;
    } catch (_) {
      L.textLine(`${labels[type]}: file unavailable (deleted by retention/erasure).`, { gray: 0.45 });
    }
  }
  if (!anyImage && !evidence.length) {
    L.textLine("No evidence files on record (deleted by retention policy or erasure request).", { gray: 0.45 });
  }

  // --- Review notes ---
  L.heading("Manual review");
  if (notes.length) {
    for (const n of notes) {
      L.textLine(`${fmtDate(n.createdAt)}  user:${n.userId}  decision: ${n.decision || "note"}`, { bold: true });
      if (n.note) L.textLine(`  ${n.note}`);
    }
  } else {
    L.textLine("No manual review actions.", { gray: 0.45 });
  }

  // --- Audit trail ---
  L.heading("Audit trail");
  if (auditRows.length) {
    for (const a of auditRows) {
      L.textLine(`${fmtDate(a.createdAt)}  [${a.actorType}${a.actorId ? ` ${a.actorId}` : ""}]  ${a.action}${a.riskEvent ? "  (RISK)" : ""}`);
    }
  } else {
    L.textLine("No audit entries for this session.", { gray: 0.45 });
  }

  return doc.render();
}

module.exports = { buildEvidencePdf };
