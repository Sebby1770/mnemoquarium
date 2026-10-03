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
        : ["./geo.js", "./giants.js"].includes(path)
          ? browserModule(path.slice(2))
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


const { AMBIENT_KINDS, AmbientLife, placeFor } = await import(browserModule("ambient.js"));
const { GIANTS } = await import(browserModule("giants.js"));
const THREE = await import("../vendor/three.module.min.js");
test("giant models have finite animation attributes, pigment, normals and distinct scale", () => {
  for (const [id, spec] of Object.entries(GIANTS)) {
    const g = spec.build();
    for (const attr of ["position", "normal", "color", "aW", "aArm"]) {
      assert.equal(g.attributes[attr].count, g.attributes.position.count, `${id}: ${attr} length`);
      assert.ok([...g.attributes[attr].array].every(Number.isFinite), `${id}: ${attr}`);
    }
    const n = g.attributes.normal;
    let good = 0;
    for (let i = 0; i < n.count; i++) if (Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > .8) good++;
    assert.ok(good / n.count > .97, `${id}: fins must not have cancelling front/back normals`);
    g.computeBoundingBox();
    assert.ok(g.boundingBox.max.z - g.boundingBox.min.z > .6, id);
    assert.ok(g.attributes.position.count < 120000, `${id}: geometry budget`);
    g.dispose();
  }
});
test("large animals need body clearance and stay in the player's water band", () => {
  assert.equal(placeFor("humpback", 14, 12, .5), null, "no whale in a shallow reef pocket");
  assert.equal(placeFor("glassserpent", 1200, 30, .5), null, "no abyssal myth on the shelf");
  assert.equal(placeFor("giantsquid", 150, 120, .5), null);
  for (const [id, spec] of Object.entries(GIANTS)) {
    for (const roll of [0, .5, 1]) {
      const d = placeFor(id, spec.depth[1] + 50, spec.depth[0] + 30, roll);
      assert.ok(d >= spec.depth[0] && d <= spec.depth[1], id);
      assert.ok(d >= spec.clearance * spec.size[1], `${id}: below surface`);
    }
  }
});
function wildlifeRig() {
  let floor = -300;
  const credits = [], events = [];
  const game = { scene: new THREE.Scene(), mode: "dive", profile: { stats: { sighted: [] } },
    sub: { position: new THREE.Vector3(0, -60, 0), depth: 60, forward: v => v.set(0, 0, -1) },
    world: { heightAt: () => floor }, bus: { emit: (name, data) => events.push([name, data]) },
    log() {}, toast() {}, persist() {}, addCredits: n => credits.push(n) };
  return { game, life: new AmbientLife(game), credits, events, floor: n => { floor = n; } };
}
test("whale companions spawn beside a leader and steered animals remain finite", () => {
  const rig = wildlifeRig(), kind = rig.life.kinds.find(k => k.id === "humpback");
  assert.ok(rig.life._place(kind, kind.animals[0]));
  assert.ok(rig.life._place(kind, kind.animals[1]));
  assert.ok(kind.animals[1].position.distanceTo(kind.animals[0].position) < 30);
  assert.ok(kind.animals[0].scale > kind.animals[1].scale);
  for (let i = 0; i < 180; i++) for (const a of kind.animals) rig.life._steer(kind, a, 1 / 30, rig.game.sub);
  for (const a of kind.animals) assert.ok([...a.position.toArray(), a.heading].every(Number.isFinite));
  rig.life.dispose();
});
test("a first sighting pays exactly once and cannot be claimed through seabed", () => {
  const rig = wildlifeRig(), kind = rig.life.kinds.find(k => k.id === "humpback"), animal = kind.animals[0];
  animal.position.set(0, -60, -30); animal.scale = 16; animal.alive = true;
  // update establishes the observer's forward vector before sightings.
  rig.life.update(0);
  rig.game.profile.stats.sighted = []; rig.credits.length = 0;
  rig.floor(-20); rig.life._sight(kind, animal, rig.game.sub);
  assert.equal(rig.credits.length, 0);
  rig.floor(-300); rig.life._sight(kind, animal, rig.game.sub); rig.life._sight(kind, animal, rig.game.sub);
  assert.deepEqual(rig.credits, [AMBIENT_KINDS.humpback.pay]);
  assert.deepEqual(rig.game.profile.stats.sighted, ["humpback"]);
  rig.life.dispose();
});
