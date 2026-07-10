"use strict";

// One-command REAL stack — MySQL (Prisma) + real Faceplugin provider.
//
//   node scripts/dev-stack.js
//
// Boots the real Express API against MySQL, ensures a demo tenant/admin/keys
// exist (persisted to .dev-credentials.json), and runs the REAL verification
// worker as a child process. There is NO stub provider and NO in-memory DB.
//
// Prerequisites:
//   1. MySQL running and DATABASE_URL set in .env
//   2. `npm run db:migrate` (or db:push) already applied the schema
//   3. Faceplugin containers running for actual liveness/match scoring:
//        docker compose -f deploy/faceplugin-compose.yml up -d
//      (Without them, verify jobs fail closed — everything else still works.)
//
// Then, in two more terminals (point the SPAs at this API):
//   VP_API_BASE=http://localhost:3000 npm run dev -w frontend/dashboard
//   VP_API_BASE=http://localhost:3000 npm run dev -w frontend/verify-page

const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "../backend/.env") });

const PORT = Number(process.env.PORT || 3000);
const REPO = path.resolve(__dirname, "..");

const { getDb } = require("../backend/src/lib/db");
const { setupInHouse } = require("./setup-inhouse");

async function main() {
  const db = getDb();

  // Fail fast if the database is unreachable — this stack is DB-backed.
  try {
    await db.$queryRaw`SELECT 1`;
  } catch (err) {
    console.error("\n[dev-stack] Cannot reach MySQL via DATABASE_URL.");
    console.error("            Check .env DATABASE_URL and that MySQL is running,");
    console.error("            then apply the schema:  npm run db:migrate\n");
    console.error(err.message);
    process.exit(1);
  }

  const creds = await setupInHouse({ log: (m) => console.log(`[setup] ${m}`) });

  // Start the real verification worker as a child process.
  const worker = spawn(process.execPath, [path.join(REPO, "backend/worker.js")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env
  });
  worker.on("exit", (code) => console.log(`[worker] exited with code ${code}`));

  // Start the real API in this process.
  const app = require("../backend/src/app");
  const server = app.listen(PORT, () => {
    const fp = process.env.FACEPLUGIN_LIVENESS_URL || "http://127.0.0.1:8888";
    const provider = (process.env.VP_PROVIDER || "onnx").toLowerCase();
    const engineLine = provider === "faceplugin"
      ? `Faceplugin      liveness ${fp} · face ${process.env.FACEPLUGIN_FACE_URL || "http://127.0.0.1:8889"}`
      : `Provider        onnx (server-side onnxruntime-node · no license/Docker)`;
    console.log(`
──────────────────────────────────────────────────────────────
 VerifyPass STACK  (MySQL · ${provider} provider)
──────────────────────────────────────────────────────────────
 API             http://localhost:${PORT}          (/health)
 Database        ${process.env.DATABASE_URL}
 ${engineLine}
 Tenant          ${creds.tenantUid}  (${creds.companyName})
 Public key      ${creds.publicKey}
 Secret key      ${creds.secretKey}
 Dashboard user  ${creds.adminEmail} / ${creds.password} (tenant_admin)
 Reviewer user   ${creds.reviewerEmail} / ${creds.password}

 SPAs (two more terminals):
   VP_API_BASE=http://localhost:${PORT} npm run dev -w frontend/dashboard
   VP_API_BASE=http://localhost:${PORT} npm run dev -w frontend/verify-page

 Create a session:
   curl -s http://localhost:${PORT}/v1/verification-sessions \\
     -H "Authorization: Bearer ${creds.secretKey}" \\
     -H "Content-Type: application/json" \\
     -d '{"customerReference":"DEMO-1"}'

 Open the returned hostedUrl in the verify-page dev server to capture and
 verify. The ONNX provider needs models (npm run models:fetch); the faceplugin
 provider needs its licensed containers running.
──────────────────────────────────────────────────────────────`);
  });

  function shutdown() {
    console.log("\n[dev-stack] shutting down…");
    worker.kill("SIGTERM");
    server.close(() => db.$disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
