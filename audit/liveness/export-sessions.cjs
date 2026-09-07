"use strict";

require("../../backend/src/env");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const backendRequire = createRequire(path.resolve(__dirname, "../../backend/package.json"));
const sharp = backendRequire("sharp");
const { getDb } = require("../../backend/src/lib/db");
const { readEvidence } = require("../../backend/src/services/evidenceStore");
const config = require("../../backend/src/config");

const secretFields = /password|secret|token|authorization|apiKey|keyHash|bindingHmac|challengeNonce|^nonce$/i;

function redact(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, secretFields.test(key) ? "[REDACTED]" : redact(entry)]));
  }
  return value;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

async function rowsFor(model) {
  const rows = [];
  let cursor;
  while (true) {
    const page = await model.findMany({ take: 250, orderBy: { id: "asc" }, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    rows.push(...page);
    if (page.length < 250) return rows;
    cursor = page.at(-1).id;
  }
}

async function main() {
  process.umask(0o077);
  process.chdir(path.resolve(__dirname, "../../backend"));
  const privateRoot = path.join(__dirname, "private");
  await fs.mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(privateRoot, ".gitignore"), "*\n");
  const output = await fs.mkdtemp(path.join(privateRoot, "sessions-"));
  const db = getDb();
  const startedAt = new Date().toISOString();
  try {
    const models = ["tenant", "verificationSession", "verificationResult", "evidenceFile", "manualReviewNote", "auditLog", "jobQueue", "outbox", "webhookDelivery", "evidenceStaging"];
    const data = {};
    const countsBefore = {};
    for (const name of models) countsBefore[name] = await db[name].count();
    for (const name of models) data[name] = await rowsFor(db[name]);
    await fs.writeFile(path.join(output, "database.json"), JSON.stringify(redact(data), null, 2));
    const sessions = [...data.verificationSession].sort((first, second) => first.createdAt - second.createdAt);
    const manifest = [];
    const summaries = [];
    const tiles = [];
    for (const [sessionIndex, session] of sessions.entries()) {
      const directory = path.join(output, "sessions", session.sessionUid);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const results = data.verificationResult.filter(row => row.sessionId === session.id).sort((first, second) => first.createdAt - second.createdAt);
      const evidence = data.evidenceFile.filter(row => row.sessionId === session.id).sort((first, second) => first.createdAt - second.createdAt);
      const logs = data.auditLog.filter(row => row.sessionId === session.id).sort((first, second) => first.createdAt - second.createdAt);
      const jobs = data.jobQueue.filter(row => row.payload?.sessionUid === session.sessionUid || row.payload?.sessionId === session.id);
      const files = [];
      for (const [evidenceIndex, file] of evidence.entries()) {
        const entry = { sessionUid: session.sessionUid, sessionIndex: sessionIndex + 1, evidenceIndex: evidenceIndex + 1, evidenceId: file.id, attemptId: file.attemptId, fileType: file.fileType, label: file.label, createdAt: file.createdAt, checksum: file.checksum };
        try {
          let buffer;
          try {
            buffer = file.encrypted === false ? await fs.readFile(file.storagePath) : await readEvidence(file.storagePath);
          } catch (error) {
            if (config.env === "production" || file.encrypted === false) throw error;
            const key = crypto.createHash("sha256").update(`evidence:${config.sdkTokenSecret}`).digest("hex");
            buffer = await readEvidence(file.storagePath, { key });
            entry.keyFallback = true;
          }
          entry.actualChecksum = crypto.createHash("sha256").update(buffer).digest("hex");
          entry.integrity = file.checksum ? entry.actualChecksum === file.checksum ? "verified" : "mismatch" : "no-stored-checksum";
          const metadata = await sharp(buffer).metadata().catch(() => null);
          const extension = metadata?.format === "jpeg" ? "jpg" : metadata?.format || (buffer.subarray(0, 4).toString() === "%PDF" ? "pdf" : "bin");
          const name = `${String(evidenceIndex + 1).padStart(3, "0")}_${file.id}.${extension}`;
          await fs.writeFile(path.join(directory, name), buffer);
          entry.file = path.relative(output, path.join(directory, name));
          entry.bytes = buffer.length;
          entry.width = metadata?.width;
          entry.height = metadata?.height;
          if (metadata) {
            const thumb = await sharp(buffer).rotate().resize(156, 132, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).png().toBuffer();
            const label = `<svg width="156" height="32"><rect width="156" height="32" fill="white"/><text x="3" y="12" font-size="10">S${sessionIndex + 1} E${evidenceIndex + 1} ${escapeHtml(file.label || file.fileType)}</text><text x="3" y="26" font-size="9">${escapeHtml(file.attemptId?.slice(-8) || "legacy")}</text></svg>`;
            tiles.push(await sharp({ create: { width: 156, height: 164, channels: 3, background: "white" } }).composite([{ input: thumb, top: 0, left: 0 }, { input: Buffer.from(label), top: 132, left: 0 }]).png().toBuffer());
            entry.contactSheet = Math.floor((tiles.length - 1) / 64) + 1;
            entry.contactTile = (tiles.length - 1) % 64 + 1;
          }
        } catch (error) {
          entry.error = { code: error.code || error.name, message: error.message.replaceAll(config.sdkTokenSecret, "[REDACTED]") };
        }
        files.push(entry);
        manifest.push(entry);
      }
      const latest = results.at(-1);
      const raw = latest?.rawResult || {};
      const summary = {
        number: sessionIndex + 1, sessionUid: session.sessionUid, tenantId: session.tenantId, createdAt: session.createdAt,
        updatedAt: session.updatedAt, completedAt: session.completedAt, expiresAt: session.expiresAt,
        status: session.status, type: session.verificationType, isLive: session.isLive,
        attemptNumber: session.attemptNumber, attemptId: session.attemptId, consentAt: session.consentAt,
        resultCount: results.length, evidenceCount: evidence.length, reasonCodes: session.decisionReason?.reasonCodes || [],
        pipelineVersion: raw.pipelineVersion, release: raw.release, livenessScore: latest?.livenessScore,
        latestResultAttemptId: latest?.attemptId, livenessStatus: latest?.livenessStatus,
        livenessChallenge: raw.livenessChallenge, livenessIdentity: raw.livenessIdentity,
        liveness: raw.liveness, policy: raw.policy, deviceMeta: session.deviceMeta,
        jobs: jobs.map(job => ({ id: job.id, status: job.status, attempts: job.attempts, lastError: job.lastError, lockedBy: job.lockedBy })),
        imageErrors: files.filter(file => file.error || file.integrity !== "verified").length
      };
      summaries.push(summary);
      await fs.writeFile(path.join(directory, "session.json"), JSON.stringify(redact({ session, results, evidence, logs, jobs, files }), null, 2));
      const gallery = files.map(file => `<figure>${file.file && file.width ? `<a href="${escapeHtml(path.basename(file.file))}"><img loading="lazy" src="${escapeHtml(path.basename(file.file))}"></a>` : ""}<figcaption>E${file.evidenceIndex}: ${escapeHtml(file.label || file.fileType)}<br>Attempt ${escapeHtml(file.attemptId || "legacy")}<br>${escapeHtml(file.integrity || file.error?.code)}</figcaption></figure>`).join("\n");
      await fs.writeFile(path.join(directory, "index.html"), `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(session.sessionUid)}</title><style>body{font:14px sans-serif;margin:24px}main{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;width:280px}img{width:280px;height:230px;object-fit:contain}figcaption{overflow-wrap:anywhere}</style><a href="../../index.html">All sessions</a><h1>S${sessionIndex + 1}: ${escapeHtml(session.sessionUid)}</h1><p>${escapeHtml(session.status)} | ${escapeHtml(session.verificationType)} | ${escapeHtml(summary.reasonCodes.join(", "))}</p><a href="session.json">Full session data and all attempts</a><main>${gallery}</main></html>`);
    }
    await fs.mkdir(path.join(output, "contact-sheets"), { mode: 0o700 });
    for (let offset = 0; offset < tiles.length; offset += 64) {
      const subset = tiles.slice(offset, offset + 64);
      await sharp({ create: { width: 1248, height: Math.ceil(subset.length / 8) * 164, channels: 3, background: "#dddddd" } }).composite(subset.map((input, index) => ({ input, left: (index % 8) * 156, top: Math.floor(index / 8) * 164 }))).jpeg({ quality: 90 }).toFile(path.join(output, "contact-sheets", `${String(offset / 64 + 1).padStart(2, "0")}.jpg`));
    }
    const countsAfter = {};
    for (const name of models) countsAfter[name] = await db[name].count();
    const inventory = { startedAt, finishedAt: new Date().toISOString(), output, countsBefore, exported: Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length])), countsAfter, snapshotAtomic: false, excluded: ["users", "api_keys", "rate_limit_counters", "analysis_receipts", "credential and authentication fields"], evidence: { total: manifest.length, exported: manifest.filter(file => file.file).length, verified: manifest.filter(file => file.integrity === "verified").length, errors: manifest.filter(file => file.error), mismatches: manifest.filter(file => file.integrity === "mismatch") }, contactSheets: Math.ceil(tiles.length / 64) };
    await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(inventory, null, 2));
    await fs.writeFile(path.join(output, "evidence-manifest.json"), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(output, "summaries.json"), JSON.stringify(redact(summaries), null, 2));
    await fs.writeFile(path.join(output, "index.html"), `<!doctype html><html><meta charset="utf-8"><title>VerifyPass session audit</title><h1>Session audit</h1><p>Private biometric evidence. Exported ${escapeHtml(inventory.finishedAt)}. No database writes.</p><ol>${summaries.map(summary => `<li><a href="sessions/${encodeURIComponent(summary.sessionUid)}/index.html">${escapeHtml(summary.sessionUid)}</a> ${escapeHtml(summary.status)} | ${escapeHtml(summary.type)} | ${summary.resultCount} results | ${summary.evidenceCount} files</li>`).join("\n")}</ol></html>`);
    console.log(JSON.stringify({ ...inventory, evidence: { ...inventory.evidence, errors: inventory.evidence.errors.length, mismatches: inventory.evidence.mismatches.length } }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch(error => { console.error(error.name, error.code || "", "Export failed; inspect local configuration and database availability."); process.exitCode = 1; });