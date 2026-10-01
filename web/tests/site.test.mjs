import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function worker({ failInstall = false } = {}) {
  const handlers = {};
  const deleted = [];
  let skipped = false;
  const cache = { match: async (key) => typeof key === "string" ? new Response(key) : undefined,
    addAll: async () => { if (failInstall) throw new Error("missing shell asset"); } };
  vm.runInNewContext(read("sw.js"), {
    URL, Response, Request: class { constructor(url) { this.url = url; } },
    fetch: async () => { throw new Error("offline"); },
    caches: { open: async () => cache, keys: async () => ["another-app", "mnemoquarium-deep-old", read("sw.js").match(/const CACHE = "([^"]+)"/)[1]],
      delete: async (key) => deleted.push(key) },
    self: { location: { origin: "https://example.com" }, clients: { claim: async () => {} },
      skipWaiting: () => { skipped = true; }, addEventListener: (name, fn) => { handlers[name] = fn; } },
  });
  return { handlers, deleted, skipped: () => skipped };
}

test("offline shared links select the correct page under a project subpath", async () => {
  const { handlers } = worker();
  for (const [path, expected] of [["play.html?phrase=new+sea", "play.html"], ["play.html?daily", "play.html"], ["guide.html?from=menu", "guide.html"], ["?phrase=old+link", "index.html"]]) {
    let response;
    handlers.fetch({ request: { method: "GET", mode: "navigate", url: `https://example.com/mnemoquarium/${path}` }, respondWith: (promise) => { response = promise; } });
    assert.equal(await (await response).text(), `./${expected}`);
  }
});

test("offline missing modules fail rather than receiving the homepage as JavaScript", async () => {
  let response;
  worker().handlers.fetch({ request: { method: "GET", mode: "cors", url: "https://example.com/mnemoquarium/src/missing.js" }, respondWith: (promise) => { response = promise; } });
  assert.equal((await response).type, "error");
});

test("a failed precache leaves the previous working service worker in place", async () => {
  const rig = worker({ failInstall: true });
  let installation;
  rig.handlers.install({ waitUntil: (promise) => { installation = promise; } });
  await assert.rejects(installation, /missing shell asset/);
  assert.equal(rig.skipped(), false);
});

test("activation preserves caches belonging to other apps on the same origin", async () => {
  const rig = worker();
  let activation;
  rig.handlers.activate({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(rig.deleted, ["mnemoquarium-deep-old"]);
});

test("website, guide, and game local links resolve to packaged files", () => {
  for (const file of ["index.html", "guide.html", "play.html"]) {
    for (const [, path] of read(file).matchAll(/(?:href|src|action)="\.\/([^"?#]*)/g)) {
      assert.ok(existsSync(new URL(`../${path || "index.html"}`, import.meta.url)), `${file}: missing ${path}`);
    }
  }
  assert.equal(JSON.parse(read("manifest.webmanifest")).start_url, "./play.html");
});
