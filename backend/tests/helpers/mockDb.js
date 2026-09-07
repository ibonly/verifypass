"use strict";

// Minimal in-memory Prisma stand-in covering the query shapes the API uses.
// Lets auth/isolation tests run with zero database.

function matches(row, where = {}) {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return v.some(w => matches(row, w));
    if (k === "AND") return v.every(w => matches(row, w));
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("isSet" in v) return (row[k] !== undefined) === v.isSet;
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
  // MongoDB-style ids: strings end to end (real DB issues ObjectId hex
  // strings). Deterministic 24-hex-char strings keep tests reproducible and
  // surface any code that still coerces ids to numbers.
  let autoId = 1;
  return {
    rows,
    create({ data }) {
      const row = { id: (autoId++).toString(16).padStart(24, "0"), createdAt: new Date(), ...data };
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
    findMany({ where, orderBy, take } = {}) {
      let result = rows.filter(r => matches(r, where || {}));
      if (orderBy) { const [key, direction] = Object.entries(orderBy)[0]; result.sort((a,b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === "desc" ? -1 : 1)); }
      if (take != null) result = result.slice(0, take);
      return Promise.resolve(result);
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
    evidenceStaging: makeTable([], "evidenceStaging"),
    analysisReceipt: makeTable([], "analysisReceipt"),
    outbox: makeTable([], "outbox"),
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

  // Serialized, rollback-capable transactions for failure/concurrency tests.
  let tail = Promise.resolve();
  db.$transaction = async (fn) => {
    const previous = tail;
    let unlock;
    tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    const tables = Object.values(db).filter(x => x && Array.isArray(x.rows));
    const snapshots = tables.map(x => x.rows.map(row => ({ ...row })));
    try { return await fn(db); }
    catch (e) { tables.forEach((x, i) => { x.rows.splice(0, x.rows.length, ...snapshots[i]); }); throw e; }
    finally { unlock(); }
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
