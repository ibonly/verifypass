"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchWithCache, clearModelCache } = require("../src/modelCache");

function createMockCache() {
  const store = new Map();
  const deleted = [];
  return {
    store,
    deleted,
    async open(name) {
      return {
        async match(url) {
          const item = store.get(`${name}:${url}`);
          if (!item) return null;
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => item.buffer,
            clone: () => ({ ok: true, status: 200, arrayBuffer: async () => item.buffer })
          };
        },
        async put(url, response) {
          const buf = await response.arrayBuffer();
          store.set(`${name}:${url}`, { buffer: buf });
        }
      };
    },
    async delete(name) {
      deleted.push(name);
      return true;
    }
  };
}

test("direct fetch when cachesObj is absent", async () => {
  const rawBytes = new Uint8Array([1, 2, 3, 4]).buffer;
  let fetchCalled = 0;
  const fetchFn = async (url) => {
    fetchCalled++;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => rawBytes
    };
  };

  const res = await fetchWithCache("https://models.test/model.onnx", {
    fetchFn,
    cachesObj: null
  });

  assert.equal(fetchCalled, 1);
  assert.deepEqual(new Uint8Array(res), new Uint8Array([1, 2, 3, 4]));
});

test("cache miss calls network fetch and stores in cache", async () => {
  const rawBytes = new Uint8Array([10, 20, 30]).buffer;
  let fetchCalls = 0;
  const fetchFn = async (url) => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => rawBytes,
      clone: () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => rawBytes
      })
    };
  };
  const mockCaches = createMockCache();

  const res = await fetchWithCache("https://models.test/model.onnx", {
    fetchFn,
    cachesObj: mockCaches
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(new Uint8Array(res), new Uint8Array([10, 20, 30]));

  // Subsequent call should hit cache without network fetch
  const cachedRes = await fetchWithCache("https://models.test/model.onnx", {
    fetchFn: async () => {
      throw new Error("Network should not be called on cache hit");
    },
    cachesObj: mockCaches
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(new Uint8Array(cachedRes), new Uint8Array([10, 20, 30]));
});

test("forceRefresh: true updates cache from network", async () => {
  const oldBytes = new Uint8Array([1, 1, 1]).buffer;
  const newBytes = new Uint8Array([2, 2, 2]).buffer;
  const mockCaches = createMockCache();

  // Populate cache
  await fetchWithCache("https://models.test/model.onnx", {
    fetchFn: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => oldBytes,
      clone: () => ({ ok: true, status: 200, arrayBuffer: async () => oldBytes })
    }),
    cachesObj: mockCaches
  });

  // Force refresh
  const refreshed = await fetchWithCache("https://models.test/model.onnx", {
    forceRefresh: true,
    fetchFn: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => newBytes,
      clone: () => ({ ok: true, status: 200, arrayBuffer: async () => newBytes })
    }),
    cachesObj: mockCaches
  });

  assert.deepEqual(new Uint8Array(refreshed), new Uint8Array([2, 2, 2]));
});

test("network error falls back to cached model if available", async () => {
  const cachedBytes = new Uint8Array([99, 98, 97]).buffer;
  const mockCaches = createMockCache();

  // Populate cache initially
  await fetchWithCache("https://models.test/model.onnx", {
    fetchFn: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => cachedBytes,
      clone: () => ({ ok: true, status: 200, arrayBuffer: async () => cachedBytes })
    }),
    cachesObj: mockCaches
  });

  // Network now fails (offline), but should gracefully recover from cache
  const recovered = await fetchWithCache("https://models.test/model.onnx", {
    forceRefresh: true, // will attempt network, fail, and fall back
    fetchFn: async () => {
      throw new Error("Network offline");
    },
    cachesObj: mockCaches
  });

  assert.deepEqual(new Uint8Array(recovered), new Uint8Array([99, 98, 97]));
});

test("network error without cache throws error", async () => {
  const mockCaches = createMockCache();
  await assert.rejects(
    () =>
      fetchWithCache("https://models.test/model.onnx", {
        fetchFn: async () => {
          throw new Error("Fetch failed");
        },
        cachesObj: mockCaches
      }),
    /Fetch failed/
  );
});

test("clearModelCache removes named cache", async () => {
  const mockCaches = createMockCache();
  const res = await clearModelCache("verifypass-models-v1", { cachesObj: mockCaches });
  assert.equal(res, true);
  assert.deepEqual(mockCaches.deleted, ["verifypass-models-v1"]);
});
