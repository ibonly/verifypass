"use strict";

// Client-side model cache for WebAssembly & ONNX model binaries.
// Uses browser CacheStorage (window.caches) with fallback to direct fetch.
// Enables instant sub-second cold starts on low-bandwidth mobile devices.

const DEFAULT_CACHE_NAME = "verifypass-models-policy-v2";

/**
 * Fetch a binary model file with CacheStorage caching.
 * @param {string} url Model URL or path
 * @param {object} [options]
 * @param {string} [options.cacheName] Custom cache name
 * @param {boolean} [options.forceRefresh] Bypass cache read and fetch fresh from network
 * @param {Function} [options.fetchFn] Custom fetch function (for testing/environments)
 * @param {object} [options.cachesObj] Custom CacheStorage instance (for testing/environments)
 * @returns {Promise<ArrayBuffer>}
 */
async function fetchWithCache(url, options = {}) {
  const { cacheName = DEFAULT_CACHE_NAME, forceRefresh = false,
    fetchFn = globalThis.fetch, cachesObj = globalThis.caches, signal,
    timeoutMs = 15000, maxBytes = 32 * 1024 * 1024 } = options;
  if (signal?.aborted) throw new Error("Model load cancelled");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Invalid model download limits");
  }
  const manifest = require("./modelManifest.json");
  const name = String(url).split("?")[0].split("/").pop();
  const expected = options.sha256 || manifest[name];
  async function verified(response) {
    if (!response?.ok) throw new Error(`Failed to fetch model (status: ${response?.status})`);
    if (response.headers?.get("content-type")?.toLowerCase().includes("text/html")) throw new Error("Model endpoint returned HTML");
    if (Number(response.headers?.get("content-length")) > maxBytes) throw new Error("Model exceeds size limit");
    let bytes;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            reader.cancel().catch(() => {});
            throw new Error("Model exceeds size limit");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const output = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
      bytes = output.buffer;
    } else {
      bytes = await response.arrayBuffer();
    }
    if (bytes.byteLength > maxBytes) throw new Error("Model exceeds size limit");
    if (!bytes.byteLength) throw new Error("Empty model");
    if (expected) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      const hex = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, "0")).join("");
      if (hex !== expected) throw new Error("Model checksum mismatch");
    }
    return bytes;
  }
  if (!fetchFn) throw new Error("fetch is not available in the current environment");
  let cache;
  try { cache = await cachesObj?.open(cacheName); } catch (_) { /* direct fetch */ }
  if (cache && !forceRefresh) {
    const cached = await cache.match(url).catch(() => null);
    if (cached) {
      try { return await verified(cached); }
      catch (_) { try { await cache.delete?.(url); } catch (_) {} }
    }
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchFn(url, { signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    const bytes = await verified(response);
    if (controller.signal.aborted) throw new Error("Model load cancelled or timed out");
    if (cache && typeof Response !== "undefined") {
      try { await cache.put(url, new Response(bytes)); } catch (_) {}
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Clear the VerifyPass model cache.
 * @param {string} [cacheName] Custom cache name
 * @param {object} [options]
 * @param {object} [options.cachesObj] Custom CacheStorage instance
 * @returns {Promise<boolean>}
 */
async function clearModelCache(cacheName = DEFAULT_CACHE_NAME, options = {}) {
  const cachesObj = options.cachesObj || (typeof caches !== "undefined" ? caches : null);
  if (cachesObj && typeof cachesObj.delete === "function") {
    return await cachesObj.delete(cacheName);
  }
  return false;
}

async function evictModel(url, options = {}) {
  try { const cache = await (options.cachesObj || globalThis.caches)?.open(options.cacheName || DEFAULT_CACHE_NAME); return await cache?.delete(url); } catch (_) { return false; }
}
module.exports = {
  evictModel,
  fetchWithCache,
  clearModelCache,
  DEFAULT_CACHE_NAME
};
