"use strict";

// Client-side model cache for WebAssembly & ONNX model binaries.
// Uses browser CacheStorage (window.caches) with fallback to direct fetch.
// Enables instant sub-second cold starts on low-bandwidth mobile devices.

const DEFAULT_CACHE_NAME = "verifypass-models-v1";

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
  const {
    cacheName = DEFAULT_CACHE_NAME,
    forceRefresh = false,
    fetchFn = typeof fetch !== "undefined" ? fetch : null,
    cachesObj = typeof caches !== "undefined" ? caches : null
  } = options;

  if (!fetchFn) {
    throw new Error("fetch is not available in the current environment");
  }

  // 1. If CacheStorage is supported
  if (cachesObj && typeof cachesObj.open === "function") {
    try {
      const cache = await cachesObj.open(cacheName);

      // Check cache first (unless forced refresh)
      if (!forceRefresh) {
        const cachedResponse = await cache.match(url);
        if (cachedResponse && cachedResponse.ok) {
          return await cachedResponse.arrayBuffer();
        }
      }

      // Fetch from network
      try {
        const response = await fetchFn(url);
        if (response && response.ok) {
          // Store clone in cache for future offline / fast loads
          try {
            await cache.put(url, response.clone());
          } catch (_) {
            // Cache write failure (e.g. quota/permissions) shouldn't block execution
          }
          return await response.arrayBuffer();
        }
        throw new Error(`Failed to fetch model from ${url} (status: ${response?.status})`);
      } catch (fetchErr) {
        // Fallback: If network failed (offline), check if we have a stale cached version
        const fallback = await cache.match(url);
        if (fallback && fallback.ok) {
          return await fallback.arrayBuffer();
        }
        throw fetchErr;
      }
    } catch (cacheErr) {
      // If CacheStorage failed entirely, fall through to direct fetch
    }
  }

  // 2. Direct fetch fallback (Node.js, private browsing without CacheStorage, etc.)
  const directResponse = await fetchFn(url);
  if (!directResponse || !directResponse.ok) {
    throw new Error(`Failed to fetch model from ${url} (status: ${directResponse?.status})`);
  }
  return await directResponse.arrayBuffer();
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

module.exports = {
  fetchWithCache,
  clearModelCache,
  DEFAULT_CACHE_NAME
};
