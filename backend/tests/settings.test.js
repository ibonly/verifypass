"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { setDb } = require("../src/lib/db");
const { createMockDb } = require("./helpers/mockDb");
const {
  validateThresholds, validateRetention, effectiveSettings, saveSettingsPatch, retentionFor
} = require("../src/services/settingsService");

test("validateThresholds: accepts valid overrides, returns clean object", () => {
  const clean = validateThresholds({
    liveness: { pass: 0.9 },
    faceMatch: { reject: 0.7, pass: 0.88 },
    maxFailedAttempts: 5,
    risk: { maxIdentitiesPerDevice: 2, maxSessionsPerIpPerHour: 50 }
  });
  assert.deepEqual(clean, {
    liveness: { pass: 0.9 },
    faceMatch: { reject: 0.7, pass: 0.88 },
    maxFailedAttempts: 5,
    risk: { maxIdentitiesPerDevice: 2, maxSessionsPerIpPerHour: 50 }
  });
});

test("validateThresholds: rejects out-of-bounds and inverted bands", () => {
  const cases = [
    { liveness: { reject: 0.3 } },                    // below platform rejectMin
    { faceMatch: { pass: 0.999 } },                   // above passMax
    { liveness: { reject: 0.9, pass: 0.8 } },         // inverted
    { maxFailedAttempts: 0 },                          // below min
    { maxFailedAttempts: 2.5 },                        // not integer
    { risk: { maxSessionsPerIpPerHour: 2 } },          // below min
    { risk: { somethingElse: 5 } },                    // unknown key
    { liveness: { reject: "high" } }                   // wrong type
  ];
  for (const input of cases) {
    assert.throws(() => validateThresholds(input), (e) => e.code === "VALIDATION_ERROR", JSON.stringify(input));
  }
});

test("validateRetention: bounds + unknown keys", () => {
  assert.deepEqual(validateRetention({ rawEvidenceDays: 90, failedSessionDays: 3 }),
    { rawEvidenceDays: 90, failedSessionDays: 3 });
  for (const input of [
    { rawEvidenceDays: 3 },        // below min 7
    { rawEvidenceDays: 999 },      // above max 365
    { failedSessionDays: 45 },     // above max 30
    { keepForever: true }          // unknown
  ]) {
    assert.throws(() => validateRetention(input), (e) => e.code === "VALIDATION_ERROR", JSON.stringify(input));
  }
});

test("settings persist, merge into effective view, and drive the decision thresholds", async (t) => {
  const db = createMockDb();
  setDb(db);
  t.after(() => setDb(null));

  const tenant = await db.tenant.create({ data: { tenantUid: "tnt_set", companyName: "S", status: "active", settings: {} } });

  const clean = validateThresholds({ faceMatch: { pass: 0.95 } });
  await saveSettingsPatch(tenant, "thresholds", clean);
  const stored = await db.tenant.findFirst({ where: { id: tenant.id } });
  assert.equal(stored.settings.thresholds.faceMatch.pass, 0.95);

  const view = effectiveSettings(stored);
  assert.equal(view.thresholds.effective.faceMatch.pass, 0.95);   // override applied
  assert.equal(view.thresholds.effective.liveness.pass, 0.85);    // default kept
  assert.equal(view.retention.effective.rawEvidenceDays, 30);     // defaults

  // saving retention doesn't clobber thresholds
  await saveSettingsPatch(stored, "retention", validateRetention({ rawEvidenceDays: 14 }));
  const after = await db.tenant.findFirst({ where: { id: tenant.id } });
  assert.equal(after.settings.thresholds.faceMatch.pass, 0.95);
  assert.equal(after.settings.retention.rawEvidenceDays, 14);
  assert.deepEqual(retentionFor(after), { rawEvidenceDays: 14, failedSessionDays: 7 });
});
