"use strict";

// In-house setup: ensures a demo tenant + admin/reviewer users + API keys exist
// in the REAL MySQL database. Idempotent — safe to run repeatedly.
//
//   node scripts/setup-inhouse.js
//
// Because API secret keys are stored only as hashes, the plaintext keys are
// written ONCE to .dev-credentials.json (gitignored) so local/in-house testers
// can retrieve them across restarts. Delete that file + re-run to rotate.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

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
  if (existing) return existing;
  return createUser({ tenantId, email, password: DEMO_PASSWORD, role });
}

async function setupInHouse({ log = () => {} } = {}) {
  const db = getDb();

  // Reuse persisted credentials if the tenant still exists.
  if (fs.existsSync(CRED_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CRED_FILE, "utf8"));
    const tenant = await db.tenant.findFirst({ where: { tenantUid: saved.tenantUid } });
    if (tenant) {
      await ensureUser(db, { tenantId: tenant.id, email: ADMIN_EMAIL, role: "tenant_admin" });
      await ensureUser(db, { tenantId: tenant.id, email: REVIEWER_EMAIL, role: "compliance_reviewer" });
      log("Reusing existing in-house tenant from .dev-credentials.json");
      return saved;
    }
  }

  const tenant = await db.tenant.create({
    data: { tenantUid: uid("tnt"), companyName: DEMO_COMPANY, status: "active", settings: {} }
  });
  const pub = await issueKey(tenant.id, "public", false);
  const sec = await issueKey(tenant.id, "secret", false);
  await ensureUser(db, { tenantId: tenant.id, email: ADMIN_EMAIL, role: "tenant_admin" });
  await ensureUser(db, { tenantId: tenant.id, email: REVIEWER_EMAIL, role: "compliance_reviewer" });

  const creds = {
    tenantUid: tenant.tenantUid,
    companyName: DEMO_COMPANY,
    publicKey: pub.key,
    secretKey: sec.key,
    adminEmail: ADMIN_EMAIL,
    reviewerEmail: REVIEWER_EMAIL,
    password: DEMO_PASSWORD,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  log(`Created in-house tenant; credentials saved to ${CRED_FILE}`);
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
