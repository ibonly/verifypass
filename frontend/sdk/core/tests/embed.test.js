"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup(hostedBaseUrl = "https://verify.example.com") {
  const clients = [];
  class Client {
    constructor() { clients.push(this); }
    getChallenge() { return Promise.resolve({ hostedBaseUrl }); }
    waitForResult() { return new Promise((resolve) => { this.complete = resolve; }); }
    dispose() { this.disposed = true; this.complete?.({ status: "abandoned" }); }
  }
  const root = { children: [], replaceChildren(...children) { this.children = children; } };
  const document = {
    querySelector: () => root,
    createElement: (tag) => ({ tag, style: {}, setAttribute() {} })
  };
  const context = { module: { exports: {} }, require: () => ({ VerifyPassClient: Client }), URL, document };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../js/src/global.js"), "utf8"), context);
  return { init: context.module.exports.init, root, clients };
}

test("embed replacement cancels the old client without letting old destroy clear the new iframe", async () => {
  const { init, root, clients } = setup();
  let completions = 0;
  const first = init({ container: root, sessionId: "first", sdkToken: "token", onComplete: () => completions++ });
  await new Promise(setImmediate);
  const second = init({ container: root, sessionId: "second", sdkToken: "token" });
  await new Promise(setImmediate);
  first.destroy();
  assert.equal(clients[0].disposed, true);
  assert.equal(root.children[0].tag, "iframe");
  assert.match(root.children[0].src, /session\/second#t=token$/);
  second.destroy();
  await Promise.all([first.ready, second.ready]);
  assert.equal(completions, 0);
  assert.equal(root.children.length, 0);
});

test("embed rejects insecure and credentialed hosted URLs before inserting a token", async () => {
  for (const url of ["http://verify.example.com", "https://user:password@verify.example.com", "https://verify.example.com?next=evil", "https://verify.example.com#fragment", "https://verify.example.com\\path"]) {
    const { init, root } = setup(url);
    const errors = [];
    const instance = init({ container: root, sessionId: "session", sdkToken: "token", onError: (error) => errors.push(error) });
    await instance.ready;
    assert.equal(errors.length, 1, url);
    assert.equal(root.children[0].tag, "p");
    instance.destroy();
  }
});

test("destroy before challenge resolution never creates an iframe", async () => {
  const { init, root } = setup();
  const instance = init({ container: root, sessionId: "session", sdkToken: "token" });
  instance.destroy();
  await instance.ready;
  assert.equal(root.children.length, 0);
});