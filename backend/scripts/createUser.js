"use strict";

// Usage: node scripts/createUser.js <email> <password> <role> [tenantUid]
// Roles: super_admin | tenant_admin | compliance_reviewer | developer | auditor
// tenantUid required for all roles except super_admin.

const { getDb } = require("../src/lib/db");
const { createUser, ROLES } = require("../src/services/userService");

async function main() {
  const [email, password, role, tenantUid] = process.argv.slice(2);
  if (!email || !password || !role) {
    console.error("Usage: node scripts/createUser.js <email> <password> <role> [tenantUid]");
    console.error(`Roles: ${ROLES.join(" | ")}`);
    process.exit(1);
  }
  const db = getDb();
  let tenantId = null;
  if (role !== "super_admin") {
    if (!tenantUid) {
      console.error("tenantUid is required for non-super-admin users");
      process.exit(1);
    }
    const tenant = await db.tenant.findFirst({ where: { tenantUid } });
    if (!tenant) {
      console.error(`Tenant ${tenantUid} not found`);
      process.exit(1);
    }
    tenantId = tenant.id;
  }
  const user = await createUser({ tenantId, email, password, role });
  console.log(`Created ${role} user ${user.email} (id ${user.id})`);
  console.log("Recommend enrolling MFA on first login: POST /v1/auth/mfa/enroll");
  await db.$disconnect();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
