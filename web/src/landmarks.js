/* Places worth going to.
 *
 * A four-kilometre sea with nothing in it is just a commute. These are the
 * things that make a heading mean something: a wreck you can fly through, a
 * vent field that is the only warm-coloured thing in the abyss, a whale
 * skeleton with the scavengers still on it. Each one is a fixed consequence of
 * the phrase, so a sea always has the same places in the same spots and coming
 * back to one is coming back to somewhere.
 *
 * Geometry is built lazily the first time the boat comes near, and thrown away
 * again when it leaves, so a hundred landmarks cost nothing until they are
 * looked at. */

import * as THREE from "three";

import { SEA } from "./config.js";
import { TAU, clamp01, lerp, makeRng, randRange, smoothstep } from "./util.js";
import { blade, disposeTree, mergeGeometries, spindle, tube } from "./geo.js";

const BUILD_RANGE = 460;      // start building when the boat is this close
const DROP_RANGE = 620;       // and give the geometry back out here
const FOUND_RANGE = 95;       // close enough to count as having been there
const MAX_BUILT = 7;          // never hold more than this many at once

export const LANDMARK_KINDS = {
  wreck: { label: "wreck", colorHex: 0xc8b48a, icon: "†" },
  vents: { label: "vent field", colorHex: 0xff9a5c, icon: "▲" },
  whalefall: { label: "whale fall", colorHex: 0xe8e2d2, icon: "∴" },
  arch: { label: "arch", colorHex: 0x9fb4c4, icon: "∩" },
  grove: { label: "deep grove", colorHex: 0x7ad6a0, icon: "♣" },
  beacon: { label: "drowned light", colorHex: 0xffd98a, icon: "✵" },
  boneyard: { label: "boneyard", colorHex: 0xb9b0a0, icon: "•" },
};

/* Depth bands each kind is willing to sit in, and what it pays to find. */
const KIND_RULES = {
  wreck: { min: 20, max: 700, weight: 3, pay: 260 },
  vents: { min: 520, max: SEA.maxDepth, weight: 3, pay: 420 },
  whalefall: { min: 300, max: SEA.maxDepth, weight: 2, pay: 380 },
  arch: { min: 30, max: 900, weight: 3, pay: 180 },
  grove: { min: 240, max: 900, weight: 2, pay: 220 },
  beacon: { min: 20, max: 420, weight: 2, pay: 200 },
  boneyard: { min: 60, max: 1200, weight: 3, pay: 160 },
};

const LINES = {
  wreck: "a hull, broken in two. something was carrying something.",
  vents: "chimneys, and water coming up warm. the only warm thing down here.",
  whalefall: "a whale went down here and is still paying for the neighbourhood.",
  arch: "the rock has a hole in it the size of the boat.",
  grove: "kelp, this far down, where kelp has no business being.",
  beacon: "a light still turning. nobody has told it.",
  boneyard: "shells and anchors, half in the silt. a lot of things ended here.",
};

const _v = new THREE.Vector3();

function pickKind(rng, depth) {
  const pool = [];
  for (const id of Object.keys(KIND_RULES)) {
    const rule = KIND_RULES[id];
    if (depth >= rule.min && depth <= rule.max) {
      for (let i = 0; i < rule.weight; i += 1) pool.push(id);
    }
  }
  if (!pool.length) return "boneyard";
  return pool[rng.randrange(pool.length)];
}

/* One soft round dot, shared by every halo. Generated, never loaded. */
let _glow = null;
function glowTexture() {
  if (_glow) return _glow;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _glow = new THREE.CanvasTexture(canvas);
  return _glow;
}

/* ------------------------------------------------------------- the shapes -- */

function rockMat(hex, rough = 0.95) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.05 });
}

/* A ship in two pieces with a gap you can fly through — the whole point of
   putting a wreck in a game about a submarine. */
function buildWreck(rng) {
  const group = new THREE.Group();
  const steel = rockMat(0x4a4338, 0.86);
  steel.metalness = 0.35;
  const rust = rockMat(0x6b3a22, 0.95);
  const L = randRange(rng, 62, 110);
  const beam = L * 0.16;

  const hullPiece = (len, lean, z) => {
    const g = spindle({
      length: len, radius: beam, rings: 10, segments: 9,
      profile: (t) => Math.pow(Math.sin(Math.PI * clamp01(t * 0.86 + 0.1)), 0.7),
      flattenY: 0.72,
    });
    const mesh = new THREE.Mesh(g, steel);
    mesh.position.z = z;
    mesh.rotation.set(lean, randRange(rng, -0.2, 0.2), randRange(rng, -0.5, 0.5));
    group.add(mesh);
    return mesh;
  };

  // Bow and stern, pulled apart and tipped at different angles.
  const gap = randRange(rng, 26, 42);
  hullPiece(L * 0.52, randRange(rng, -0.4, -0.12), L * 0.28 + gap / 2);
  hullPiece(L * 0.44, randRange(rng, 0.14, 0.45), -L * 0.26 - gap / 2);

  // Ribs in the break, so the gap reads as a way in rather than a mistake.
  for (let i = 0; i < 7; i += 1) {
    const t = i / 6;
    const r = beam * lerp(0.95, 0.5, Math.abs(t - 0.5) * 2);
    const rib = new THREE.Mesh(new THREE.TorusGeometry(r, beam * 0.055, 5, 14, Math.PI * 1.25), rust);
    rib.rotation.set(0, Math.PI / 2, Math.PI * 0.12);
    rib.position.z = lerp(gap / 2, -gap / 2, t);
    group.add(rib);
  }

  // A snapped mast, and a boom lying across the sand.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(beam * 0.07, beam * 0.1, L * 0.42, 6), steel);
  mast.position.set(beam * 0.3, L * 0.14, L * 0.3);
  mast.rotation.z = randRange(rng, 0.5, 1.1);
  group.add(mast);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(beam * 0.05, beam * 0.06, L * 0.3, 6), rust);
  boom.rotation.set(Math.PI / 2, 0, randRange(rng, -0.7, 0.7));
  boom.position.set(randRange(rng, -beam, beam), -beam * 0.6, -L * 0.1);
  group.add(boom);

  return { group, materials: [steel, rust], radius: L * 0.8 };
}

/* Chimneys, shimmer, and bacterial mat. The only warmth in the abyss. */
function buildVents(rng) {
  const group = new THREE.Group();
  const stone = rockMat(0x2b2129, 0.98);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd8944a, emissive: 0xc2611f, emissiveIntensity: 0.9, roughness: 0.8,
  });
  const smoke = new THREE.MeshBasicMaterial({
    color: 0x1a1218, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
  });
  // Brighter than white on purpose: the bloom pass is what makes it a glow.
  const haloMat = new THREE.SpriteMaterial({
    map: glowTexture(),
    color: new THREE.Color(0xff7a2e).multiplyScalar(1.4),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });

  const stacks = 4 + rng.randrange(5);
  for (let i = 0; i < stacks; i += 1) {
    const a = rng.random() * TAU;
    const d = Math.sqrt(rng.random()) * 34;
    const h = randRange(rng, 9, 30);
    const r = randRange(rng, 1.4, 3.4);
    const chimney = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.45, r, h, 7, 3), stone);
    chimney.position.set(Math.cos(a) * d, h / 2 - 1, Math.sin(a) * d);
    chimney.rotation.z = randRange(rng, -0.16, 0.16);
    group.add(chimney);

    // The plume: a tall cone of dark water standing over each stack.
    const plume = new THREE.Mesh(new THREE.ConeGeometry(r * 2.2, h * 1.5, 8, 1, true), smoke);
    plume.position.set(chimney.position.x, h + h * 0.7, chimney.position.z);
    group.add(plume);

    const glow = new THREE.PointLight(0xff8a3c, 5, 60, 2);
    glow.position.set(chimney.position.x, h - 1, chimney.position.z);
    group.add(glow);

    /* A halo over each mouth. The water eats orange first, so the chimneys'
       own glow is gone twenty metres out; this is additive and outside the
       water model, so the field reads as a warm smudge in the black from a
       long way off — which is the whole reason to go looking for it. */
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(r * 7.5);
    halo.position.set(chimney.position.x, h + r, chimney.position.z);
    group.add(halo);
  }

  // Mat: flat discs of orange life spreading out from the stacks.
  for (let i = 0; i < 16; i += 1) {
    const a = rng.random() * TAU;
    const d = Math.sqrt(rng.random()) * 46;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(randRange(rng, 2.5, 8), 9), mat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(Math.cos(a) * d, 0.3, Math.sin(a) * d);
    group.add(disc);
  }

  return { group, materials: [stone, mat, smoke, haloMat], radius: 54 };
}

/* Ribs out of the silt, and the scavengers still working. */
function buildWhalefall(rng) {
  const group = new THREE.Group();
  const bone = rockMat(0xd8d2c0, 0.86);
  const L = randRange(rng, 34, 56);

  const spine = [];
  for (let i = 0; i <= 12; i += 1) {
    const t = i / 12;
    spine.push(new THREE.Vector3((t - 0.5) * L, Math.sin(t * Math.PI) * 2.6, Math.sin(t * 5) * 1.4));
  }
  group.add(new THREE.Mesh(tube(spine, { radius: L * 0.022, radialSegments: 6 }), bone));

  // Ribs, arcing out and shrinking toward the tail.
  for (let i = 1; i < 10; i += 1) {
    const t = i / 11;
    const span = Math.sin(t * Math.PI) * L * 0.3 + L * 0.05;
    for (const side of [-1, 1]) {
      const rib = new THREE.Mesh(
        new THREE.TorusGeometry(span, L * 0.012, 5, 10, Math.PI * 0.72),
        bone,
      );
      rib.position.set((t - 0.5) * L, 0.4, 0);
      rib.rotation.set(0, Math.PI / 2, side > 0 ? Math.PI * 0.14 : Math.PI * 0.86);
      group.add(rib);
    }
  }

  // Skull: the one piece that tells you what it was.
  const skull = new THREE.Mesh(new THREE.SphereGeometry(L * 0.1, 10, 8), bone);
  skull.scale.set(2.1, 0.78, 0.9);
  skull.position.set(-L * 0.56, L * 0.03, 0);
  group.add(skull);

  return { group, materials: [bone], radius: L * 0.8 };
}

/* A hole in the rock the size of the boat. */
function buildArch(rng) {
  const group = new THREE.Group();
  const stone = rockMat(0x4a4a44, 0.97);
  const span = randRange(rng, 34, 70);
  const thick = span * randRange(rng, 0.11, 0.2);

  const arch = new THREE.Mesh(new THREE.TorusGeometry(span * 0.5, thick, 7, 18, Math.PI), stone);
  arch.rotation.z = 0;
  group.add(arch);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(thick * randRange(rng, 0.9, 1.3), thick * 1.6, span * 0.3, 7),
      stone,
    );
    leg.position.set(side * span * 0.5, -span * 0.15, 0);
    group.add(leg);
  }
  return { group, materials: [stone], radius: span * 0.8 };
}

/* Kelp where kelp has no business being. */
function buildGrove(rng) {
  const group = new THREE.Group();
  const frond = new THREE.MeshStandardMaterial({
    color: 0x2f7a4e, emissive: 0x0d3a22, emissiveIntensity: 0.4,
    roughness: 0.7, side: THREE.DoubleSide,
  });
  const stalks = 16 + rng.randrange(14);
  for (let i = 0; i < stalks; i += 1) {
    const a = rng.random() * TAU;
    const d = Math.sqrt(rng.random()) * 30;
    const h = randRange(rng, 26, 62);
    const g = blade({ length: h, width: randRange(rng, 1.4, 3.2), taper: 0.45, sweep: 0.3, thickness: 0.02 });
    g.rotateZ(Math.PI / 2);
    const mesh = new THREE.Mesh(g, frond);
    mesh.position.set(Math.cos(a) * d, 0, Math.sin(a) * d);
    mesh.rotation.y = rng.random() * TAU;
    group.add(mesh);
  }
  return { group, materials: [frond], radius: 38 };
}

/* A light still turning, which nobody has told. */
function buildBeacon(rng) {
  const group = new THREE.Group();
  const stone = rockMat(0x53504a, 0.9);
  const h = randRange(rng, 30, 52);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.08, h * 0.16, h, 9, 3), stone);
  tower.position.y = h / 2;
  tower.rotation.z = randRange(rng, 0.05, 0.22);
  group.add(tower);

  const lampMat = new THREE.MeshBasicMaterial({
    color: 0xffd98a, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.1, h * 0.1, h * 0.12, 9, 1, true), stone);
  housing.position.y = h * 1.02;
  group.add(housing);

  const lamp = new THREE.Mesh(new THREE.SphereGeometry(h * 0.055, 10, 8), lampMat);
  lamp.position.y = h * 1.02;
  group.add(lamp);
  const light = new THREE.PointLight(0xffd98a, 9, 190, 1.6);
  light.position.y = h * 1.02;
  group.add(light);

  return { group, materials: [stone, lampMat], radius: h, spin: lamp, light };
}

/* Shells and anchors, half in the silt. */
function buildBoneyard(rng) {
  const group = new THREE.Group();
  const shellMat = rockMat(0xbfb6a4, 0.9);
  const ironMat = rockMat(0x53382a, 0.95);
  const parts = [];
  for (let i = 0; i < 40; i += 1) {
    const a = rng.random() * TAU;
    const d = Math.sqrt(rng.random()) * 40;
    const s = randRange(rng, 0.7, 2.6);
    const g = new THREE.SphereGeometry(s, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
    g.scale(1, randRange(rng, 0.4, 0.8), 1);
    g.rotateX(randRange(rng, -0.5, 0.5));
    g.rotateY(rng.random() * TAU);
    g.translate(Math.cos(a) * d, randRange(rng, -0.3, 0.6), Math.sin(a) * d);
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  group.add(new THREE.Mesh(merged, shellMat));

  // A couple of anchors, because a boneyard needs one thing with a shape.
  for (let i = 0; i < 2; i += 1) {
    const a = rng.random() * TAU;
    const d = Math.sqrt(rng.random()) * 28;
    const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 12, 6), ironMat);
    shank.position.set(Math.cos(a) * d, 1.5, Math.sin(a) * d);
    shank.rotation.set(Math.PI * 0.44, 0, randRange(rng, -0.7, 0.7));
    group.add(shank);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.42, 5, 12, Math.PI), ironMat);
    ring.position.set(shank.position.x, 1.2, shank.position.z + 5);
    ring.rotation.set(Math.PI * 0.5, 0, 0);
    group.add(ring);
  }
  return { group, materials: [shellMat, ironMat], radius: 46 };
}

const BUILDERS = {
  wreck: buildWreck,
  vents: buildVents,
  whalefall: buildWhalefall,
  arch: buildArch,
  grove: buildGrove,
  beacon: buildBeacon,
  boneyard: buildBoneyard,
};

/* ----------------------------------------------------------------- the set -- */

export class Landmarks {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = "landmarks";
    game.scene.add(this.group);

    this.all = [];
    this.built = [];
    this._place();
    this._restoreFound();
  }

  /* Scatter them by seed, on the floor, in bands that suit them, and never so
     close to the Hull that the first one is free. */
  _place() {
    const rng = makeRng(this.game.seed, "landmarks");
    const world = this.game.world;
    const station = world.stationPosition;

    /* Pick the KIND first and then go looking for water that suits it. Picking
       a spot first and asking what fits there sounds equivalent, but it is
       not: area grows with radius, so a uniform scatter lands almost
       everything deep and the shallow kinds — wrecks, drowned lights — simply
       never got built. */
    const order = [];
    for (const id of Object.keys(KIND_RULES)) {
      for (let i = 0; i < KIND_RULES[id].weight; i += 1) order.push(id);
    }
    rng.shuffle(order);
    const want = 18;
    while (order.length < want) order.push(order[order.length % Object.keys(KIND_RULES).length]);

    for (let n = 0; n < want; n += 1) {
      const kind = order[n % order.length];
      const rule = KIND_RULES[kind];
      const placed = this._placeOne(rng, world, station, kind, rule);
      if (!placed) continue;
    }
  }

  _placeOne(rng, world, station, kind, rule) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const a = rng.random() * TAU;
      const r = lerp(380, SEA.worldRadius * 0.93, Math.sqrt(rng.random()));
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      const dsx = x - station.x;
      const dsz = z - station.z;
      if (dsx * dsx + dsz * dsz < 300 * 300) continue;

      const y = world.heightAt(x, z);
      const depth = -y;
      if (depth < rule.min || depth > rule.max) continue;

      // Not on a wall.
      world.normalAt(x, z, _v);
      if (_v.y < 0.7) continue;

      // Not on top of another one.
      let clash = false;
      for (const other of this.all) {
        const dx = x - other.position.x;
        const dz = z - other.position.z;
        if (dx * dx + dz * dz < 320 * 320) { clash = true; break; }
      }
      if (clash) continue;

      this.all.push({
        id: `lm-${this.all.length}`,
        kind,
        name: LANDMARK_KINDS[kind].label,
        position: new THREE.Vector3(x, y, z),
        depth,
        radius: 60,
        found: false,
        blurb: LINES[kind],
        pay: Math.round(rule.pay * (1 + depth / 900)),
        seed: rng.next(),
        node: null,
        materials: null,
        spin: null,
      });
      return true;
    }
    return false;
  }

  _restoreFound() {
    const stats = this.game.profile && this.game.profile.stats;
    if (!stats) return;
    if (!Array.isArray(stats.landmarks)) stats.landmarks = [];
    const seen = new Set(stats.landmarks);
    for (const lm of this.all) if (seen.has(lm.id)) lm.found = true;
  }

  discovered() {
    return this.all.filter((lm) => lm.found);
  }

  nearest(position, maxDistance = Infinity) {
    let best = null;
    let bd = maxDistance * maxDistance;
    for (const lm of this.all) {
      const d = lm.position.distanceToSquared(position);
      if (d < bd) { bd = d; best = lm; }
    }
    return best;
  }

  _build(lm) {
    if (lm.node) return;
    const make = BUILDERS[lm.kind];
    if (!make) return;
    const built = make(makeRng(lm.seed, lm.kind));
    built.group.position.copy(lm.position);
    built.group.rotation.y = (lm.seed % 628) / 100;
    this.group.add(built.group);
    lm.node = built.group;
    lm.materials = built.materials;
    lm.spin = built.spin || null;
    lm.light = built.light || null;
    lm.radius = built.radius || 60;
    this.built.push(lm);

    if (this.game.water) {
      for (const m of built.materials) {
        if (m && m.isMeshStandardMaterial) this.game.water.register(m);
      }
    }
  }

  _drop(lm) {
    if (!lm.node) return;
    this.group.remove(lm.node);
    disposeTree(lm.node);
    lm.node = null;
    lm.materials = null;
    lm.spin = null;
    lm.light = null;
    const i = this.built.indexOf(lm);
    if (i >= 0) this.built.splice(i, 1);
  }

  update(dt) {
    const sub = this.game.sub;
    if (!sub) return;
    const p = sub.position;

    for (const lm of this.all) {
      const d = Math.hypot(lm.position.x - p.x, lm.position.z - p.z);

      if (!lm.node && d < BUILD_RANGE && this.built.length < MAX_BUILT) this._build(lm);
      else if (lm.node && d > DROP_RANGE) this._drop(lm);

      if (lm.spin) lm.spin.rotation.y += dt * 1.4;

      if (!lm.found && lm.position.distanceTo(p) < FOUND_RANGE) this._find(lm);
    }
  }

  _find(lm) {
    lm.found = true;
    const game = this.game;
    const stats = game.profile && game.profile.stats;
    if (stats) {
      if (!Array.isArray(stats.landmarks)) stats.landmarks = [];
      if (!stats.landmarks.includes(lm.id)) stats.landmarks.push(lm.id);
    }
    game.bus.emit("landmark:found", { landmark: lm });
    game.log(lm.blurb, "lore");
    game.addCredits(lm.pay, "survey");
    game.log(`survey paid: ${lm.pay} credits for the position.`, "good");
    if (game.audio) game.audio.sfx("upgrade");
    if (game.persist) game.persist();
  }

  dispose() {
    for (const lm of [...this.built]) this._drop(lm);
    if (this.group.parent) this.group.parent.remove(this.group);
    this.all = [];
    this.built = [];
  }
}
