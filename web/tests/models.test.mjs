// Load the browser's vendored Three.js in Node without adding a second copy.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
globalThis.MnemoEngine = createRequire(import.meta.url)("../engine.js");
const urls = new Map();
function browserModule(name) {
  if (urls.has(name)) return urls.get(name);
  const url = new URL(`../src/${name}`, import.meta.url);
  let source = readFileSync(url, "utf8");
  source = source.replace(/from ["']([^"']+)["']/g, (all, path) => {
    const target =
      path === "three"
        ? new URL("../vendor/three.module.min.js", import.meta.url).href
        : path === "./geo.js"
          ? browserModule("geo.js")
          : new URL(path, url).href;
    return `from ${JSON.stringify(target)}`;
  });
  const result = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  urls.set(name, result);
  return result;
}
const { bodyForKind, FISH_KINDS } = await import(browserModule("fish.js"));
const { buildShark } = await import(browserModule("creatures.js"));
const { CREATURES } = await import("../src/config.js");
test("every fish body has finite positions, normals, and readable pigment data", () => {
  for (const kind of FISH_KINDS) {
    const g = bodyForKind(kind);
    for (const attr of ["position", "normal", "color"]) {
      assert.ok(g.attributes[attr], `${kind}: ${attr}`);
      assert.ok([...g.attributes[attr].array].every(Number.isFinite), kind);
    }
    g.computeBoundingBox();
    assert.ok(g.boundingBox.max.z > g.boundingBox.min.z);
    g.dispose();
  }
});
test("the reef shark dorsal stays vertical and pectorals span both sides", () => {
  const b = buildShark(CREATURES.shark),
    L = CREATURES.shark.length;
  const dorsal = b.group.getObjectByName("dorsal-fin").geometry;
  dorsal.computeBoundingBox();
  assert.ok(dorsal.boundingBox.max.x - dorsal.boundingBox.min.x < 0.001);
  assert.ok(dorsal.boundingBox.max.y > L * 0.25);
  const pecs = b.group.children.filter((o) => o.name === "pectoral-fin");
  assert.equal(pecs.length, 2);
  for (const p of pecs) {
    p.geometry.computeBoundingBox();
    assert.ok(
      p.geometry.boundingBox.max.y - p.geometry.boundingBox.min.y < L * 0.05,
    );
  }
  b.group.traverse((o) => {
    if (o.geometry) {
      assert.ok(
        [...o.geometry.attributes.position.array].every(Number.isFinite),
      );
      o.geometry.dispose();
    }
  });
  b.materials.forEach((m) => m.dispose());
});
