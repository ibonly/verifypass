"use strict";

// CSV serialization for compliance exports. Two safety properties:
// 1. RFC 4180 escaping (quotes, commas, newlines)
// 2. Spreadsheet formula-injection guard: cells starting with = + - @ TAB CR
//    are prefixed with ' so Excel/Sheets treat them as text (OWASP CSV injection)

function escapeCell(value) {
  if (value == null) return "";
  let s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {object[]} rows
 * @param {Array<{key: string, header: string}>} columns
 */
function toCsv(rows, columns) {
  const head = columns.map((c) => escapeCell(c.header)).join(",");
  const body = rows.map((row) =>
    columns.map((c) => escapeCell(c.key.split(".").reduce((o, k) => o?.[k], row))).join(",")
  );
  return [head, ...body].join("\r\n") + "\r\n";
}

module.exports = { toCsv, escapeCell };
