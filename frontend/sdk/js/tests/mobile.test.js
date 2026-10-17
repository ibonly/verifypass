"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag) {
    this.tag = tag;
    this.style = {};
    this.children = [];
    this.hidden = false;
    this.listeners = {};
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  click() { return this.listeners.click?.(); }
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)];
}

function setup() {
  const clients = [];
  class Client {
    constructor() {
      this.controller = new AbortController();
      clients.push(this);
    }
    getChallenge() {
      return Promise.resolve({
        verificationType: "ID_ONLY",
        hostedBaseUrl: "https://verify.example.com",
        handoffToken: "vph_test",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      });
    }
    getHostedUrl() { return "https://verify.example.com/session/vps_1#h=vph_test"; }
    waitForResult() { return new Promise(() => {}); }
    dispose() { this.controller.abort(); }
  }
  const root = new Element("root");
  const document = {
    querySelector: () => root,
    createElement: (tag) => new Element(tag)
  };
  const writes = [];
  const context = {
    module: { exports: {} },
    require: () => ({
      VerifyPassClient: Client,
      createFlow: () => ({ finish() {}, fail() {}, retry() {} }),
      pollingTimeoutForExpiry: () => 60_000
    }),
    URL,
    AbortController,
    document,
    navigator: { clipboard: { writeText: async (value) => writes.push(value) } },
    setTimeout,
    clearTimeout,
    console
  };
  const source = fs.readFileSync(path.join(__dirname, "../src/global.js"), "utf8");
  vm.runInNewContext(source, context, {
    importModuleDynamically: (specifier) => import(specifier)
  });
  return { init: context.module.exports.init, root, clients, writes };
}

test("mobile handoff renders accessible fallbacks and never copies a token to telemetry", async () => {
  const { init, root, writes } = setup();
  const telemetry = [];
  const instance = init({
    container: root,
    sessionId: "vps_1",
    sdkToken: "sdk_desktop",
    mobileHandoff: true,
    onTelemetry: (event) => telemetry.push(event)
  });
  let image;
  for (let index = 0; index < 40; index++) {
    image = descendants(root).find((node) => node.tag === "img");
    if (image?.src) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const nodes = descendants(root);
  const copy = nodes.find((node) => node.textContent === "Copy secure link");
  const open = nodes.find((node) => node.textContent === "Open on this device");
  const qrRetry = nodes.find((node) => node.textContent === "Retry QR code");
  if (image.src) assert.match(image.src, /^data:image\/png;base64,/);
  else {
    assert.equal(qrRetry.hidden, false);
    assert.equal(telemetry[0].type, "mobile_handoff_qr_failed");
  }
  assert.equal(open.href, "https://verify.example.com/session/vps_1#h=vph_test");
  await copy.click();
  assert.deepEqual(writes, ["https://verify.example.com/session/vps_1#h=vph_test"]);
  assert.equal(telemetry.at(-1).type, "mobile_handoff_link_copied");
  assert.equal(JSON.stringify(telemetry).includes("vph_test"), false);
  instance.destroy();
});
