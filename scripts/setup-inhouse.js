"use strict";

// In-house setup: ensures a demo tenant + admin/reviewer users + API keys exist
// in the REAL MongoDB database. Idempotent — safe to run repeatedly.
//
//   node scripts/setup-inhouse.js
//
// Because API secret keys are stored only as hashes, the plaintext keys are
// written ONCE to .dev-credentials.json (gitignored) so local/in-house testers
// can retrieve them across restarts. Delete that file + re-run to rotate.

const fs = require("fs");
const path = require("path");

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

const { getDb } = require("../backend/src/lib/db");
const { issueKey } = require("../backend/src/services/apiKeyService");
const { createUser } = require("../backend/src/services/userService");
const { uid } = require("../backend/src/lib/ids");

const CRED_FILE = path.resolve(__dirname, "../.dev-credentials.json");
const DEMO_COMPANY = "In-House Demo Tenant";
const ADMIN_EMAIL = "admin@demo.local";
const REVIEWER_EMAIL = "reviewer@demo.local";
const DEMO_PASSWORD = "demo-password-123";

async function ensureUser(db, { tenantId, email, role }) {
  const existing = await db.user.findFirst({ where: { email } });
  if (existing) {
    if (existing.tenantId !== tenantId || existing.role !== role || existing.status !== "active") {
      throw new Error(`Demo account ${email} does not match the selected workspace and role; refusing to move an existing user`);
    }
    return existing;
  }
  return createUser({ tenantId, email, password: DEMO_PASSWORD, role });
}

async function setupInHouse({ log = () => {}, credentialFile = CRED_FILE } = {}) {
  const db = getDb();
  const saved = fs.existsSync(credentialFile) ? JSON.parse(fs.readFileSync(credentialFile, "utf8")) : null;
  const admin = await db.user.findFirst({ where: { email: ADMIN_EMAIL } });
  // The dashboard login determines the demo workspace. A lost/recreated
  // credential file must not create keys for a different tenant while reusing
  // the old login (which would save webhooks in the wrong workspace).
  let tenant = admin
    ? await db.tenant.findFirst({ where: { id: admin.tenantId } })
    : saved ? await db.tenant.findFirst({ where: { tenantUid: saved.tenantUid } }) : null;
  if (admin && !tenant) throw new Error("Existing demo administrator has no workspace; repair the account before running setup");
  if (!tenant) tenant = await db.tenant.create({
    data: { tenantUid: uid("tnt"), companyName: DEMO_COMPANY, status: "active", settings: {} }
  });
  if (["suspended", "disabled"].includes(tenant.status)) throw new Error("Demo workspace is unavailable");
  await ensureUser(db, { tenantId: tenant.id, email: ADMIN_EMAIL, role: "tenant_admin" });
  await ensureUser(db, { tenantId: tenant.id, email: REVIEWER_EMAIL, role: "compliance_reviewer" });

  // Check the keys themselves too: cached metadata alone cannot establish
  // which tenant an API request will actually use.
  if (saved?.tenantUid === tenant.tenantUid) {
    const { resolveKey } = require("../backend/src/services/apiKeyService");
    try {
      const pub = await resolveKey(saved.publicKey, "public");
      const sec = await resolveKey(saved.secretKey, "secret");
      if (pub.tenant.id === tenant.id && sec.tenant.id === tenant.id && !pub.isLive && !sec.isLive) {
        log("Reusing in-house credentials for the demo administrator's workspace");
        return saved;
      }
    } catch (_) { /* revoked, expired or stale cached keys — replace cache */ }
  }
  if (saved) log("Repairing demo API credentials to match the demo administrator's workspace");
  const pub = await issueKey(tenant.id, "public", false);
  const sec = await issueKey(tenant.id, "secret", false);

  const creds = {
    tenantUid: tenant.tenantUid,
    companyName: tenant.companyName,
    publicKey: pub.key,
    secretKey: sec.key,
    adminEmail: ADMIN_EMAIL,
    reviewerEmail: REVIEWER_EMAIL,
    password: DEMO_PASSWORD,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(credentialFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log(`In-house credentials saved to ${credentialFile}`);
  return creds;
}

module.exports = { setupInHouse, CRED_FILE, DEMO_PASSWORD };

if (require.main === module) {
  setupInHouse({ log: console.log })
    .then((c) => {
      console.log("\nIn-house tenant ready:");
      console.log(`  tenantUid:  ${c.tenantUid}`);
      console.log(`  public key: ${c.publicKey}`);
      console.log(`  secret key: ${c.secretKey}`);
      console.log(`  admin:      ${c.adminEmail} / ${c.password}`);
      console.log(`  reviewer:   ${c.reviewerEmail} / ${c.password}`);
      return getDb().$disconnect();
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
