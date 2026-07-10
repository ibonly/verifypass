"use strict";

// Diagnostic: re-run the current ONNX provider against a session's ACTUAL
// stored evidence (decrypted) to confirm faceCount / liveness after code
// changes — without needing a fresh webcam capture.
//   node scripts/recheck-session.js [sessionUid]

require("../backend/src/env");

const fs = require("fs/promises");
const config = require("../backend/src/config");
const { getDb } = require("../backend/src/lib/db");
const { createOnnxProvider } = require("../backend/src/providers/onnx");
const { defaultEvidenceKey } = require("../backend/src/worker/pipeline");
const { decryptBuffer } = require("@verifypass/shared");

async function main() {
  const sessionUid = process.argv[2] || "vps_1JSO61OSQZARXKJ28FJ6V";
  const db = getDb();
  const evidenceKey = defaultEvidenceKey(config);
  const provider = createOnnxProvider({
    modelsDir: config.onnx.modelsDir,
    matchThreshold: config.onnx.matchThreshold
  });

  const session =
    (await db.verificationSession.findFirst({ where: { sessionUid } })) ||
    (await db.verificationSession.findFirst({ orderBy: { id: "desc" } }));
  if (!session) throw new Error("no session found");

  console.log(`session ${session.sessionUid}  status=${session.status}  type=${session.verificationType}`);
  console.log("challenge actions:", JSON.stringify(session.livenessChallenge?.actions || null));

  const evidence = await db.evidenceFile.findMany({ where: { sessionId: session.id } });
  const load = async (f) => decryptBuffer(await fs.readFile(f.storagePath), evidenceKey);

  const selfie = evidence.filter((e) => e.fileType === "selfie").sort((a, b) => b.id - a.id)[0];
  if (selfie) {
    const lv = await provider.checkLiveness(await load(selfie));
    console.log(`\nselfie        -> faceCount=${lv.faceCount}  score=${lv.score?.toFixed(4)}  pose=${JSON.stringify(lv.pose)}`);
  }

  const frames = evidence.filter((e) => e.fileType === "liveness_frame");
  for (const fr of frames) {
    const lv = await provider.checkLiveness(await load(fr));
    console.log(`liveness[${fr.label}] -> faceCount=${lv.faceCount}  score=${lv.score?.toFixed(4)}  pose=${JSON.stringify(lv.pose)}`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
