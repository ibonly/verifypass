"use strict";

const dns = require("dns/promises");
const { URL } = require("url");
const net = require("net");

// Static rules shared by both configuration APIs and delivery. DNS is checked
// at send time so a temporary resolver outage does not prevent saving a URL.
function parseWebhookUrl(urlStr) {
  const u = new URL(urlStr);
  if (u.username || u.password || u.hash) throw new Error("webhook URL must not contain credentials or a fragment");
  if (u.protocol !== "https:") {
    throw new Error("webhook URL must use https");
  }
  // Only allow standard HTTPS port (or explicit 443)
  const port = u.port ? Number(u.port) : 443;
  if (port !== 443) {
    throw new Error(`webhook URL port ${port} not allowed (use 443)`);
  }
  if (u.hostname === "localhost" || (net.isIP(u.hostname) && isPrivateIp(u.hostname)) || u.hostname.startsWith("[")) {
    throw new Error("webhook URL must use a public IPv4 host");
  }
  return u;
}

async function validateWebhookTarget(urlStr, { resolve4 = host => dns.resolve4(host) } = {}) {
  let u;
  try { u = parseWebhookUrl(urlStr); }
  catch (err) { err.code = "WEBHOOK_TARGET_BLOCKED"; throw err; }
  // Resolve hostname to IPs and check each
  const host = u.hostname;
  let addrs;
  if (net.isIP(host)) {
    addrs = [host];
  } else {
    try {
      let timer;
      try {
        addrs = await Promise.race([
          resolve4(host),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 5000); })
        ]);
      } finally { clearTimeout(timer); }
      if (!addrs.length) throw new Error("no IPv4 addresses");
    } catch (_) {
      throw new Error(`could not resolve webhook host: ${host}`);
    }
  }
  for (const ip of addrs) {
    if (isPrivateIp(ip)) {
      throw Object.assign(new Error(`webhook URL resolves to private/reserved IP (${ip})`), { code: "WEBHOOK_TARGET_BLOCKED" });
    }
  }
}

function isPrivateIp(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return true; // non-IPv4 → block
  const [a, b, c, d] = parts;
  if (a === 127) return true;                          // loopback
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // link-local
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64.0.0/10
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a >= 224) return true;                           // multicast + reserved
  return false;
}

module.exports = { parseWebhookUrl, validateWebhookTarget, isPrivateIp };
