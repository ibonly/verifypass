"use strict";

// Usage: node scripts/seedTenant.js "Company Name"
// Creates a sandbox tenant with public+secret test keys. Prints keys ONCE.

const { getDb } = require("../src/lib/db");
const { issueKey } = require("../src/services/apiKeyService");
const { uid } = require("../src/lib/ids");

async function main() {
  const companyName = process.argv[2];
  if (!companyName) {
    console.error('Usage: node scripts/seedTenant.js "Company Name"');
    process.exit(1);
  }
  const db = getDb();
  const tenant = await db.tenant.create({
    data: {
      tenantUid: uid("tnt"),
      companyName,
      status: "sandbox",
      settings: {}
    }
  });
  const pub = await issueKey(tenant.id, "public", false);
  const sec = await issueKey(tenant.id, "secret", false);

  console.log("Tenant created:");
  console.log(`  tenantUid:  ${tenant.tenantUid}`);
  console.log(`  company:    ${companyName}`);
  console.log("Sandbox keys (store these now — they are not retrievable):");
  console.log(`  public: ${pub.key}`);
  console.log(`  secret: ${sec.key}`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
