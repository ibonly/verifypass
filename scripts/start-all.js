"use strict";

// VerifyPass Full-Stack Orchestrator
// Starts API (:3000), Worker, Dashboard (:5173), Verify-Page (:5174), and Sample-App (:5175).
//
// Usage:
//   node scripts/start-all.js
//
// Press Ctrl+C to cleanly stop all services.

const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const readline = require("readline");

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
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 5173);
const VERIFY_PORT = Number(process.env.VERIFY_PORT || 5174);
const SAMPLE_PORT = Number(process.env.SAMPLE_PORT || 5175);
const REPO = path.resolve(__dirname, "..");

const { getDb } = require("../backend/src/lib/db");
const { setupInHouse } = require("./setup-inhouse");

// ANSI color helpers
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m"
};

const prefixes = {
  api: `${colors.cyan}[api]        ${colors.reset}`,
  worker: `${colors.yellow}[worker]     ${colors.reset}`,
  dashboard: `${colors.magenta}[dashboard]  ${colors.reset}`,
  verify: `${colors.green}[verify-page]${colors.reset}`,
  sample: `${colors.blue}[sample-app] ${colors.reset}`,
  system: `${colors.bold}${colors.gray}[system]     ${colors.reset}`
};

const children = [];

function pipeLogs(child, prefix) {
  const pipe = (stream) => {
    if (!stream) return;
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
      if (line.trim().length > 0) {
        console.log(`${prefix} ${line}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
}

function spawnService(name, command, args, cwd, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });

  children.push({ name, child });
  pipeLogs(child, prefixes[name] || `[${name}] `);

  child.on("error", (err) => {
    console.error(`${prefixes.system} Error starting ${name}: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.log(`${prefixes.system} ${name} exited with code ${code}`);
    }
  });

  return child;
}

function freePort(port) {
  if (process.platform !== "win32") {
    try {
      execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
    } catch (_) {}
  }
}

async function main() {
  const db = getDb();

  console.log(`\n${colors.bold}${colors.cyan}==============================================================${colors.reset}`);
  console.log(`${colors.bold} Starting VerifyPass Full-Stack Development Services...${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}==============================================================${colors.reset}\n`);

  // Clear any stale listeners on our target ports
  [PORT, DASHBOARD_PORT, VERIFY_PORT, SAMPLE_PORT].forEach(freePort);

  // 1. Check MongoDB connectivity
  try {
    if (typeof db.$runCommandRaw === "function") {
      await db.$runCommandRaw({ ping: 1 });
    } else {
      await db.tenant.findFirst();
    }
    console.log(`${prefixes.system} Connected to MongoDB successfully.`);
  } catch (err) {
    console.error(`\n${prefixes.system} ${colors.yellow}Cannot reach MongoDB via DATABASE_URL.${colors.reset}`);
    console.error(`         Check .env DATABASE_URL and that mongod runs as a replica set (--replSet rs0),`);
    console.error(`         then apply schema: (cd backend && npm run prisma:push)\n`);
    console.error(`         Error: ${err.message}\n`);
    process.exit(1);
  }

  // 2. Setup demo tenant, credentials, and users
  const creds = await setupInHouse({
    log: (m) => console.log(`${prefixes.system} ${m}`)
  });

  const apiBase = `http://localhost:${PORT}`;

  // 3. Start Verification Worker
  console.log(`${prefixes.system} Spawning verification worker...`);
  spawnService("worker", process.execPath, [path.join(REPO, "backend/worker.js")], path.join(REPO, "backend"));

  // 4. Start API Server (in child process for clean isolation)
  console.log(`${prefixes.system} Spawning backend API server on port ${PORT}...`);
  spawnService("api", process.execPath, [path.join(REPO, "backend/server.js")], path.join(REPO, "backend"), {
    PORT: String(PORT)
  });

  // 5. Start Frontend Dashboard
  console.log(`${prefixes.system} Spawning Dashboard on port ${DASHBOARD_PORT}...`);
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  spawnService("dashboard", npxCmd, ["vite", "--port", String(DASHBOARD_PORT), "--strictPort"], path.join(REPO, "frontend/dashboard"), {
    VP_API_BASE: apiBase
  });

  // 6. Start Hosted Verify Page
  console.log(`${prefixes.system} Spawning Verify Page on port ${VERIFY_PORT}...`);
  spawnService("verify", npxCmd, ["vite", "--port", String(VERIFY_PORT), "--strictPort", "--force"], path.join(REPO, "frontend/verify-page"), {
    VP_API_BASE: apiBase
  });

  // 7. Start Sample App
  console.log(`${prefixes.system} Spawning Sample App on port ${SAMPLE_PORT}...`);
  spawnService("sample", npxCmd, ["vite", "--port", String(SAMPLE_PORT), "--strictPort", "--force"], path.join(REPO, "sample-app"), {
    VP_API_BASE: apiBase,
    VP_API_PROXY_TARGET: apiBase,
    VP_SECRET_KEY: creds.secretKey
  });

  // 8. Print Banner
  const provider = (process.env.VP_PROVIDER || "onnx").toLowerCase();
  setTimeout(() => {
    console.log(`
${colors.cyan}───────────────────────────────────────────────────────────────────────────────${colors.reset}
 ${colors.bold}VerifyPass All Services Running${colors.reset} (MongoDB · ${provider} provider)
${colors.cyan}───────────────────────────────────────────────────────────────────────────────${colors.reset}
  ${colors.bold}API Server:${colors.reset}     ${colors.cyan}http://localhost:${PORT}${colors.reset} (/health, /v1)
  ${colors.bold}Dashboard:${colors.reset}      ${colors.magenta}http://localhost:${DASHBOARD_PORT}${colors.reset}
  ${colors.bold}Verify Page:${colors.reset}    ${colors.green}http://localhost:${VERIFY_PORT}${colors.reset}
  ${colors.bold}Sample App:${colors.reset}     ${colors.blue}http://localhost:${SAMPLE_PORT}${colors.reset}

  ${colors.bold}Demo Tenant:${colors.reset}    ${creds.tenantUid} (${creds.companyName})
  ${colors.bold}Public Key:${colors.reset}     ${creds.publicKey}
  ${colors.bold}Secret Key:${colors.reset}     ${creds.secretKey}

  ${colors.bold}Admin Login:${colors.reset}    ${creds.adminEmail} / ${creds.password}
  ${colors.bold}Reviewer Login:${colors.reset} ${creds.reviewerEmail} / ${creds.password}

  ${colors.dim}Quick Test Session (run in another terminal):${colors.reset}
  curl -s http://localhost:${PORT}/v1/verification-sessions \\
    -H "Authorization: Bearer ${creds.secretKey}" \\
    -H "Content-Type: application/json" \\
    -d '{"customerReference":"TEST-001"}'

  ${colors.dim}Press ${colors.bold}Ctrl+C${colors.reset}${colors.dim} to stop all services.${colors.reset}
${colors.cyan}───────────────────────────────────────────────────────────────────────────────${colors.reset}
`);
  }, 1200);

  // 9. Graceful Shutdown
  let isShuttingDown = false;
  function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${prefixes.system} Shutting down all VerifyPass services...`);

    for (const { name, child } of children) {
      try {
        if (child.pid) {
          if (process.platform !== "win32") {
            // Kill the entire process group
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch (_) {
              child.kill("SIGTERM");
            }
          } else {
            child.kill("SIGTERM");
          }
        }
      } catch (_) {}
    }

    db.$disconnect().finally(() => {
      console.log(`${prefixes.system} All services stopped.`);
      setTimeout(() => process.exit(0), 500).unref();
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", shutdown);
}

main().catch((err) => {
  console.error(`\n${prefixes.system} Fatal error:`, err);
  process.exit(1);
});
