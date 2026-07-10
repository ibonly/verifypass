"use strict";

// Minimal in-memory Prisma stand-in covering the query shapes the API uses.
// Lets auth/isolation tests run with zero database.

function matches(row, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("lt" in v) return row[k] < v.lt;
      if ("lte" in v) return row[k] <= v.lte;
      if ("gt" in v) return row[k] > v.gt;
      if ("gte" in v) return row[k] >= v.gte;
      return matches(row[k] || {}, v);
    }
    return row[k] === v;
  });
}

function makeTable(rows, name) {
  let autoId = 1;
  return {
    rows,
    create({ data }) {
      const row = { id: autoId++, createdAt: new Date(), ...data };
      rows.push(row);
      return Promise.resolve(row);
    },
    findFirst({ where, include } = {}) {
      const row = rows.find((r) => matches(r, where)) || null;
      if (row && include && include.tenant && typeof row._tenant === "function") {
        return Promise.resolve({ ...row, tenant: row._tenant() });
      }
      return Promise.resolve(row);
    },
    findMany({ where } = {}) {
      return Promise.resolve(rows.filter((r) => matches(r, where || {})));
    },
    updateMany({ where, data }) {
      const hit = rows.filter((r) => matches(r, where || {}));
      hit.forEach((r) => {
        Object.entries(data).forEach(([k, v]) => {
          if (v && typeof v === "object" && "increment" in v) r[k] = (r[k] || 0) + v.increment;
          else r[k] = v;
        });
      });
      return Promise.resolve({ count: hit.length });
    },
    update({ where, data }) {
      return this.updateMany({ where, data }).then(({ count }) => {
        if (!count) throw new Error(`${name}.update: no row`);
        return rows.find((r) => matches(r, where));
      });
    },
    deleteMany({ where } = {}) {
      const keep = rows.filter((r) => !matches(r, where || {}));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return Promise.resolve({ count });
    },
    delete({ where }) {
      return this.deleteMany({ where }).then(({ count }) => {
        if (!count) throw new Error(`${name}.delete: no row`);
        return {};
      });
    }
  };
}

function createMockDb() {
  const db = {
    tenant: makeTable([], "tenant"),
    apiKey: makeTable([], "apiKey"),
    verificationSession: makeTable([], "verificationSession"),
    evidenceFile: makeTable([], "evidenceFile"),
    verificationResult: makeTable([], "verificationResult"),
    user: makeTable([], "user"),
    manualReviewNote: makeTable([], "manualReviewNote"),
    auditLog: makeTable([], "auditLog"),
    webhookDelivery: makeTable([], "webhookDelivery"),
    jobQueue: makeTable([], "jobQueue"),
    $disconnect: () => Promise.resolve()
  };

  // Wire apiKey → tenant include
  const origCreate = db.apiKey.create.bind(db.apiKey);
  db.apiKey.create = ({ data }) => {
    return origCreate({ data }).then((row) => {
      row._tenant = () => db.tenant.rows.find((t) => t.id === row.tenantId) || null;
      return row;
    });
  };

  return db;
}

module.exports = { createMockDb };
