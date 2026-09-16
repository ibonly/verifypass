"use strict";

// One-command REAL stack — MongoDB (Prisma) + real Faceplugin provider.
//
//   node scripts/dev-stack.js
//
// Boots the real Express API against MongoDB, ensures a demo tenant/admin/keys
// exist (persisted to .dev-credentials.json), and runs the REAL verification
// worker as a child process. There is NO stub provider and NO in-memory DB.
//
// Prerequisites:
//   1. MongoDB running as a replica set (mongod --replSet rs0) and DATABASE_URL set in .env
//   2. `npm run prisma:push` (backend/) already applied the schema — Mongo has no migrations
//   3. Faceplugin containers running for actual liveness/match scoring:
//        docker compose -f deploy/faceplugin-compose.yml up -d
//      (Without them, verify jobs fail closed — everything else still works.)
//
// Then, in two more terminals (point the SPAs at this API):
//   VP_API_BASE=http://localhost:3000 npm run dev --prefix frontend/dashboard
//   VP_API_BASE=http://localhost:3000 npm run dev --prefix frontend/verify-page

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function loadEnv() {
  const envPaths = [
    path.resolve(__dirname, "../backend/.env"),
    path.resolve(__dirname, "../.env")
  ];
  for (const p of envPaths) {
    if (!fs.existsSync(p)) continue;
    try {
      require("dotenv").config({ path: p });
    } catch (_) {
      try {
        require("../backend/node_modules/dotenv").config({ path: p });
      } catch (_) {
        const lines = fs.readFileSync(p, "utf8").split("\n");
        for (const l of lines) {
          const t = l.trim();
          if (!t || t.startsWith("#")) continue;
          const eq = t.indexOf("=");
          if (eq > 0) {
            const k = t.slice(0, eq).trim();
            let v = t.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (process.env[k] === undefined) process.env[k] = v;
          }
        }
      }
    }
  }
}

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const REPO = path.resolve(__dirname, "..");

const { getDb } = require("../backend/src/lib/db");
const { setupInHouse } = require("./setup-inhouse");

async function main() {
  const db = getDb();

  async function pingDb() {
    if (typeof db.$runCommandRaw === "function") {
      await db.$runCommandRaw({ ping: 1 });
    } else {
      await db.tenant.findFirst();
    }
  }

  let dbOk = false;
  try {
    await pingDb();
    dbOk = true;
  } catch (_) {
    const mongoScript = path.join(__dirname, "start-mongo.sh");
    if (fs.existsSync(mongoScript) && process.platform !== "win32") {
      console.log("[dev-stack] MongoDB not responding. Attempting to start replica set via scripts/start-mongo.sh...");
      try {
        const { execSync } = require("child_process");
        execSync(`bash "${mongoScript}"`, { stdio: "inherit" });
        await pingDb();
        dbOk = true;
      } catch (startErr) {
        console.warn(`[dev-stack] Auto-start script failed: ${startErr.message}`);
      }
    }
  }

  if (!dbOk) {
    console.error("\n[dev-stack] Cannot reach MongoDB via DATABASE_URL.");
    console.error("            Start MongoDB as a replica set: npm run mongo:start");
    console.error("            Then apply schema if needed: npm run prisma:push\n");
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
 VerifyPass STACK  (MongoDB · ${provider} provider)
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
   VP_API_BASE=http://localhost:${PORT} npm run dev --prefix frontend/dashboard
   VP_API_BASE=http://localhost:${PORT} npm run dev --prefix frontend/verify-page

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
