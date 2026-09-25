/* The rest of the sea: the animals that are not money and not teeth.
 *
 * Octopus working the floor, moon jellies climbing on their own pulse, manta
 * rays flying circles in the blue, and turtles on the shelf. None of them can
 * be netted and none of them will hurt you; they are here so the water is
 * never only fish and threats. The first time you get a good look at each one
 * the Hull pays a small sighting fee, and the logbook keeps the line.
 *
 * Cost is the whole design. Each kind is ONE InstancedMesh — one draw call no
 * matter how many are out — and every limb moves in the vertex shader, driven
 * by a per-vertex weight (how far along an arm, a tentacle, a wing) and a
 * per-instance phase, so no two animals beat in step. The CPU only steers:
 * a position, a heading and a scale per animal, streamed around the boat. */

import * as THREE from "three";

import { SEA } from "./config.js";
import { clamp, clamp01, damp, lerp } from "./util.js";
import { mergeGeometries, spindle, tube } from "./geo.js";

const RESPAWN_RANGE = 190;       // further than this and it is moved back in
const SPAWN_MIN = 40;
const SPAWN_MAX = 150;
const SIGHT_RANGE = 24;
const SIGHT_CONE = 0.55;         // cos of the half-angle you must be looking in

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();
const _col = new THREE.Color();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/* ------------------------------------------------------------ geometry -- */

/* Every builder returns geometry with two extra attributes the shader reads:
   aW   — 0 on the rigid body, rising to 1 at the tip of whatever moves;
   aArm — which limb this vertex belongs to, so neighbours are out of step. */
function tag(geometry, w, arm) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const n = g.attributes.position.count;
  const aw = new Float32Array(n);
  const aa = new Float32Array(n);
  const pos = g.attributes.position;
  for (let i = 0; i < n; i += 1) {
    aw[i] = typeof w === "function" ? w(pos.getX(i), pos.getY(i), pos.getZ(i)) : w;
    aa[i] = arm;
  }
  g.setAttribute("aW", new THREE.BufferAttribute(aw, 1));
  g.setAttribute("aArm", new THREE.BufferAttribute(aa, 1));
  return g;
}

/* mergeGeometries in geo.js keeps position/normal/uv only, so the two
   animation attributes are concatenated here in the same order. */
function mergeTagged(parts) {
  const merged = mergeGeometries(parts);
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const aw = new Float32Array(total);
  const aa = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    aw.set(p.attributes.aW.array, at);
    aa.set(p.attributes.aArm.array, at);
    at += p.attributes.position.count;
  }
  merged.setAttribute("aW", new THREE.BufferAttribute(aw, 1));
  merged.setAttribute("aArm", new THREE.BufferAttribute(aa, 1));
  merged.computeBoundingSphere();
  return merged;
}

/* An octopus about a metre across, lying on the floor facing +Z. The mantle
   sits up and back; eight arms leave the head in a ring and run out flat
   along the ground, thinning and curling at the tips. */
function octopusGeometry() {
  const parts = [];
  const mantle = new THREE.SphereGeometry(0.2, 14, 10);
  mantle.scale(1, 0.9, 1.35);
  mantle.rotateX(-0.55);
  mantle.translate(0, 0.24, -0.16);
  parts.push(tag(mantle, 0, 0));

  const head = new THREE.SphereGeometry(0.14, 12, 8);
  head.scale(1.15, 0.8, 1);
  head.translate(0, 0.1, 0.02);
  parts.push(tag(head, 0, 0));

  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.035, 8, 6);
    eye.translate(side * 0.1, 0.18, 0.07);
    parts.push(tag(eye, 0, 0));
  }

  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    const len = 0.55 + (i % 2) * 0.1;
    const pts = [];
    for (let k = 0; k <= 5; k += 1) {
      const t = k / 5;
      const r = 0.08 + t * len;
      pts.push(new THREE.Vector3(
        dx * r + Math.cos(a) * t * t * 0.12,
        0.06 * (1 - t) + 0.02 + t * t * 0.05,
        dz * r - Math.sin(a) * t * t * 0.12,
      ));
    }
    const arm = tube(pts, { radius: 0.045, taper: 0.12, segments: 12, radial: 5 });
    // Weight is distance from the head, so tips move and roots do not.
    parts.push(tag(arm, (x, y, z) => clamp01((Math.hypot(x, z) - 0.08) / len), i));
  }
  return mergeTagged(parts);
}

/* A moon jelly: a bell open underneath, four frilled oral arms and a curtain
   of fine tentacles from the rim. One unit tall-ish; y up. */
function jellyGeometry() {
  const parts = [];
  const bell = new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.52);
  bell.scale(1, 0.62, 1);
  parts.push(tag(bell, 0, -1));

  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2;
    const pts = [];
    for (let k = 0; k <= 5; k += 1) {
      const t = k / 5;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.08 * (1 + t), -t * 0.9, Math.sin(a) * 0.08 * (1 + t)));
    }
    parts.push(tag(tube(pts, { radius: 0.05, taper: 0.3, segments: 10, radial: 4 }), (x, y) => clamp01(-y / 0.9), i));
  }
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    const len = 1.2 + (i % 3) * 0.35;
    const pts = [];
    for (let k = 0; k <= 4; k += 1) {
      const t = k / 4;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.47, 0.02 - t * len, Math.sin(a) * 0.47));
    }
    parts.push(tag(tube(pts, { radius: 0.008, taper: 0.5, segments: 8, radial: 3 }), (x, y) => clamp01(-y / len), 4 + i));
  }
  return mergeTagged(parts);
}

/* A manta: a flat, broad diamond with cephalic fins and a whip of a tail,
   one metre from wingtip to wingtip, facing +Z. aW is the distance out along
   the wing, so the flap starts at the body and grows to the tip. */
function rayGeometry() {
  const parts = [];
  const half = 0.5;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.24);
  shape.bezierCurveTo(0.18, 0.2, 0.34, 0.08, half, -0.04);
  shape.bezierCurveTo(0.3, -0.06, 0.14, -0.14, 0.05, -0.26);
  shape.lineTo(-0.05, -0.26);
  shape.bezierCurveTo(-0.14, -0.14, -0.3, -0.06, -half, -0.04);
  shape.bezierCurveTo(-0.34, 0.08, -0.18, 0.2, 0, 0.24);
  const wing = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: 2, curveSegments: 14 });
  wing.rotateX(-Math.PI / 2);
  wing.translate(0, 0, 0);
  // A body that bulges on top of the wing, so it is not a sheet of card.
  parts.push(tag(wing, (x) => clamp01((Math.abs(x) - 0.06) / (half - 0.06)), 0));
  const body = spindle({ length: 0.46, radius: 0.08, rings: 10, segments: 10, flattenY: 0.55 });
  body.translate(0, 0.02, 0);
  parts.push(tag(body, 0, 0));
  for (const side of [-1, 1]) {
    const lobe = new THREE.SphereGeometry(0.04, 6, 4);
    lobe.scale(0.5, 0.4, 1.4);
    lobe.translate(side * 0.07, 0, 0.27);
    parts.push(tag(lobe, 0, 0));
  }
  const tail = tube([
    new THREE.Vector3(0, 0.01, -0.24),
    new THREE.Vector3(0, 0.01, -0.5),
    new THREE.Vector3(0, 0.0, -0.8),
  ], { radius: 0.012, taper: 0.2, segments: 8, radial: 3 });
  parts.push(tag(tail, (x, y, z) => clamp01((-z - 0.24) / 0.6) * 0.5, 1));
  return mergeTagged(parts);
}

/* A green turtle, one metre nose to tail, facing +Z: a domed shell, a head on
   a short neck, big front flippers and small rear ones. aArm is 1 for the
   front pair and 2 for the back so they stroke differently. */
function turtleGeometry() {
  const parts = [];
  const shell = new THREE.SphereGeometry(0.4, 16, 10);
  shell.scale(0.8, 0.34, 1);
  shell.translate(0, 0.04, 0);
  parts.push(tag(shell, 0, 0));
  const plastron = new THREE.SphereGeometry(0.36, 14, 6, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5);
  plastron.scale(0.78, 0.12, 0.96);
  parts.push(tag(plastron, 0, 0));
  const head = new THREE.SphereGeometry(0.1, 10, 8);
  head.scale(0.9, 0.8, 1.3);
  head.translate(0, 0.04, 0.47);
  parts.push(tag(head, 0, 0));
  for (const side of [-1, 1]) {
    for (const [front, z, len, wid] of [[1, 0.2, 0.36, 0.13], [2, -0.3, 0.18, 0.09]]) {
      const fl = new THREE.SphereGeometry(0.5, 10, 6);
      fl.scale(len, 0.035, wid);
      fl.rotateY(side * (front === 1 ? -0.45 : 0.6));
      fl.translate(side * (0.26 + len * 0.42), 0, z);
      parts.push(tag(fl, (x) => clamp01((Math.abs(x) - 0.22) / (len * 0.9)), front * side));
    }
  }
  return mergeTagged(parts);
}

/* ------------------------------------------------------------- shaders -- */

/* The motion, per kind, in the animal's own frame before instancing. */
const MOTION = {
  octopus: /* glsl */ `
    float w = aW * aW;
    float ph = uTime * 1.9 + aPhase + aArm * 1.7;
    transformed.y += (sin(ph - aW * 4.0) * 0.5 + 0.35) * w * 0.28 * uReach;
    transformed.x += cos(ph * 0.8 - aW * 3.0) * w * 0.12;
    transformed.z += sin(ph * 0.7 - aW * 3.0) * w * 0.12;
    // The mantle breathes.
    if (aW == 0.0 && transformed.y > 0.18) {
      transformed.xz *= 1.0 + sin(uTime * 1.3 + aPhase) * 0.05;
    }`,
  jelly: /* glsl */ `
    float beat = sin(uTime * 1.6 + aPhase);
    if (aArm < 0.0) {
      // Contract hardest at the rim, not the crown.
      float rim = clamp(1.0 - transformed.y / 0.31, 0.0, 1.0);
      transformed.xz *= 1.0 - max(beat, 0.0) * 0.2 * rim;
      transformed.y *= 1.0 + max(beat, 0.0) * 0.12;
    } else {
      float ph = uTime * 1.1 + aPhase + aArm * 0.9;
      transformed.x += sin(ph + aW * 3.2) * aW * 0.22;
      transformed.z += cos(ph * 0.9 + aW * 2.7) * aW * 0.22;
      transformed.y += max(beat, 0.0) * aW * 0.12;
    }`,
  ray: /* glsl */ `
    float w = aW * aW;
    float flap = sin(uTime * 1.35 + aPhase - aW * 1.6);
    if (aArm < 0.5) transformed.y += flap * w * 0.3;
    else transformed.x += sin(uTime * 2.0 + aPhase - aW * 5.0) * aW * 0.06;`,
  turtle: /* glsl */ `
    float front = abs(aArm) < 1.5 ? 1.0 : 0.45;
    float stroke = sin(uTime * 1.05 + aPhase + (front < 1.0 ? 1.4 : 0.0));
    transformed.y += stroke * aW * 0.2 * front;
    transformed.z += cos(uTime * 1.05 + aPhase) * aW * 0.08 * front;`,
};

function animatedMaterial(kind, opts, uniforms) {
  const m = new THREE.MeshStandardMaterial(opts);
  m.userData.shaderTag = `ambient:${kind}`;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aW;
        attribute float aArm;
        attribute float aPhase;
        uniform float uTime;
        uniform float uReach;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          ${MOTION[kind]}
        }`);
  };
  m.customProgramCacheKey = () => `ambient:${kind}`;
  return m;
}

/* ------------------------------------------------------------- the cast -- */

/* depth: where it will be found. floor: lives on the bottom. size: metres of
   whatever the geometry's one unit is. pay: the sighting fee. */
export const AMBIENT_KINDS = {
  octopus: {
    name: "Reef Octopus", count: 6, depth: [8, 520], floor: true,
    size: [1.1, 2.4], speed: 0.45, pay: 45,
    line: "an octopus, changing its mind about what colour to be.",
    build: octopusGeometry,
    material: { color: 0xffffff, roughness: 0.55, metalness: 0.0 },
    colours: [0xb4553c, 0xd08a5a, 0x7a3a3a, 0x9c6b4a],
  },
  jelly: {
    name: "Moon Jelly", count: 22, depth: [0, 1600], floor: false,
    size: [0.5, 1.6], speed: 0.35, pay: 20,
    line: "moon jellies, climbing on nothing but their own pulse.",
    build: jellyGeometry,
    material: {
      color: 0xffffff, roughness: 0.45, metalness: 0.0, transparent: true, opacity: 0.3,
      depthWrite: false, side: THREE.DoubleSide, emissive: 0x9fd8ff, emissiveIntensity: 0.02,
    },
    colours: [0x9fb8d6, 0xb4a4cc, 0x8fc4be, 0xc9a6bd],
  },
  ray: {
    name: "Manta", count: 3, depth: [10, 380], floor: false,
    size: [3.2, 5.6], speed: 2.4, pay: 70,
    line: "a manta goes over, and the light goes grey for a moment.",
    build: rayGeometry,
    material: { color: 0xffffff, roughness: 0.7, metalness: 0.0 },
    colours: [0x2a3440, 0x323b46, 0x262d36],
  },
  turtle: {
    name: "Green Turtle", count: 3, depth: [4, 150], floor: false,
    size: [0.9, 1.4], speed: 1.1, pay: 55,
    line: "a turtle, older than the Hull, and in less of a hurry.",
    build: turtleGeometry,
    material: { color: 0xffffff, roughness: 0.85, metalness: 0.0 },
    colours: [0x3a4527, 0x44402a, 0x33402c],
  },
};

/* Where a new animal may appear: in its depth range, with room for it. Pure
   so the rule can be tested without a scene. */
export function placeFor(kind, floorDepth, subDepth, roll) {
  const spec = AMBIENT_KINDS[kind];
  if (!spec) return null;
  const [lo, hi] = spec.depth;
  if (spec.floor) {
    if (floorDepth < lo || floorDepth > hi) return null;
    return floorDepth;
  }
  const top = Math.max(lo, 2);
  const bottom = Math.min(hi, floorDepth - 3);
  if (bottom <= top) return null;
  // Near the boat's own depth, so you meet them rather than hear about them.
  const want = clamp(subDepth + (roll - 0.5) * 50, top, bottom);
  return want;
}

export class AmbientLife {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = "ambient";
    game.scene.add(this.group);

    const stats = game.profile && game.profile.stats;
    if (stats && !Array.isArray(stats.sighted)) stats.sighted = [];

    this.kinds = [];
    for (const [id, spec] of Object.entries(AMBIENT_KINDS)) {
      const uniforms = { uTime: { value: 0 }, uReach: { value: 1 } };
      const geometry = spec.build();
      const phase = new Float32Array(spec.count);
      for (let i = 0; i < spec.count; i += 1) phase[i] = Math.random() * 100;
      geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
      const material = animatedMaterial(id, spec.material, uniforms);
      if (game.water) game.water.register(material);
      const mesh = new THREE.InstancedMesh(geometry, material, spec.count);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      // Instances wander far from the origin; a stale bounding sphere would cull them.
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      for (let i = 0; i < spec.count; i += 1) {
        mesh.setColorAt(i, _col.setHex(spec.colours[i % spec.colours.length]));
      }
      this.group.add(mesh);

      const animals = [];
      for (let i = 0; i < spec.count; i += 1) {
        animals.push({
          alive: false,
          position: new THREE.Vector3(),
          heading: Math.random() * Math.PI * 2,
          pitch: 0,
          turn: 0,
          scale: 1,
          speed: spec.speed,
          flee: 0,
          colour: new THREE.Color(spec.colours[i % spec.colours.length]),
          target: new THREE.Color(spec.colours[i % spec.colours.length]),
          retarget: 0,
          bob: Math.random() * 10,
        });
      }
      this.kinds.push({ id, spec, mesh, material, uniforms, animals });
    }
  }

  /* ---------------------------------------------------------- streaming -- */

  _place(kind, animal) {
    const game = this.game;
    const sub = game.sub;
    const world = game.world;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = lerp(SPAWN_MIN, SPAWN_MAX, Math.sqrt(Math.random()));
      const x = sub.position.x + Math.cos(a) * r;
      const z = sub.position.z + Math.sin(a) * r;
      if (x * x + z * z > SEA.worldRadius * SEA.worldRadius) continue;
      const floor = -world.heightAt(x, z);
      const depth = placeFor(kind.id, floor, sub.depth, Math.random());
      if (depth == null) continue;
      animal.position.set(x, -depth, z);
      animal.alive = true;
      animal.heading = Math.random() * Math.PI * 2;
      animal.scale = lerp(kind.spec.size[0], kind.spec.size[1], Math.random());
      animal.flee = 0;
      return true;
    }
    animal.alive = false;
    return false;
  }

  /* ------------------------------------------------------------- update -- */

  update(dt) {
    const game = this.game;
    const sub = game.sub;
    if (!sub || !game.world) return;
    this.time += dt;
    // In the Hull there is nothing to look at out here.
    if (sub.docked && game.mode !== "dive") return;

    sub.forward(_fwd);
    for (const kind of this.kinds) {
      kind.uniforms.uTime.value = this.time;
      if (kind.id === "jelly") {
        // In the dark a jelly is its own light.
        kind.material.emissiveIntensity = lerp(0.02, 0.7, clamp01((sub.depth - 150) / 500));
      }
      let n = 0;
      for (const animal of kind.animals) {
        if (!animal.alive || animal.position.distanceTo(sub.position) > RESPAWN_RANGE) {
          if (!this._place(kind, animal)) continue;
        }
        this._steer(kind, animal, dt, sub);
        this._sight(kind, animal, sub);
        this._write(kind, animal, n);
        n += 1;
      }
      kind.mesh.count = n;
      kind.mesh.instanceMatrix.needsUpdate = true;
      if (kind.mesh.instanceColor) kind.mesh.instanceColor.needsUpdate = true;
    }
  }

  _steer(kind, a, dt, sub) {
    const world = this.game.world;
    const spec = kind.spec;
    const dist = a.position.distanceTo(sub.position);

    a.retarget -= dt;
    if (a.retarget <= 0) {
      a.retarget = 3 + Math.random() * 6;
      a.turn = (Math.random() - 0.5) * 0.6;
    }
    a.heading += a.turn * dt;

    if (kind.id === "octopus") {
      // Close enough to be a threat: ink, and jet off the floor backwards.
      if (dist < 13 && a.flee <= 0) {
        a.flee = 2.6;
        a.heading = Math.atan2(a.position.x - sub.position.x, a.position.z - sub.position.z);
        if (this.game.vfx) this.game.vfx.inkCloud(a.position, 2.5 * a.scale);
      }
      const floor = world.heightAt(a.position.x, a.position.z);
      if (a.flee > 0) {
        a.flee -= dt;
        const push = 6 * (a.flee / 2.6);
        a.position.x += Math.sin(a.heading) * push * dt;
        a.position.z += Math.cos(a.heading) * push * dt;
        a.position.y = damp(a.position.y, floor + 2.5 * (a.flee / 2.6), 4, dt);
      } else {
        a.position.x += Math.sin(a.heading) * spec.speed * dt;
        a.position.z += Math.cos(a.heading) * spec.speed * dt;
        a.position.y = damp(a.position.y, world.heightAt(a.position.x, a.position.z) + 0.02, 5, dt);
      }
      // Camouflage: drift toward a new colour every few seconds.
      if (Math.random() < dt * 0.25) a.target.setHex(spec.colours[Math.floor(Math.random() * spec.colours.length)]);
      a.colour.lerp(a.target, clamp01(dt * 1.5));
      a.pitch = 0;
      return;
    }

    let speed = spec.speed;
    if (kind.id === "jelly") {
      // Mostly drift; the pulse lifts it a little each beat.
      const beat = Math.max(0, Math.sin(this.time * 1.6 + a.bob));
      a.position.y += (beat * 0.35 - 0.12) * dt;
      speed *= 0.3;
    } else if (kind.id === "ray") {
      a.position.y += Math.sin(this.time * 0.3 + a.bob) * 0.4 * dt;
    } else if (kind.id === "turtle") {
      a.position.y += Math.sin(this.time * 0.2 + a.bob) * 0.3 * dt;
      // Turtles give the boat a wide berth.
      if (dist < 15) a.heading = damp(a.heading, Math.atan2(a.position.x - sub.position.x, a.position.z - sub.position.z), 1.2, dt);
    }
    a.position.x += Math.sin(a.heading) * speed * dt;
    a.position.z += Math.cos(a.heading) * speed * dt;

    const floor = world.heightAt(a.position.x, a.position.z);
    const [lo, hi] = spec.depth;
    const minY = Math.max(floor + 2 + a.scale, -hi);
    const maxY = Math.min(-lo, -1.5);
    if (a.position.y < minY) { a.position.y = damp(a.position.y, minY, 2, dt); a.turn = 0.4; }
    if (a.position.y > maxY) a.position.y = damp(a.position.y, maxY, 2, dt);
    a.pitch = kind.id === "ray" ? Math.sin(this.time * 0.3 + a.bob) * 0.12 : 0;
  }

  /* The first good look at each kind goes in the logbook, and pays. */
  _sight(kind, a, sub) {
    const stats = this.game.profile && this.game.profile.stats;
    if (!stats || this.game.mode !== "dive") return;
    if (!Array.isArray(stats.sighted)) stats.sighted = [];
    if (stats.sighted.includes(kind.id)) return;
    _to.copy(a.position).sub(sub.position);
    const d = _to.length();
    if (d > SIGHT_RANGE + a.scale || d < 0.01) return;
    if (_to.divideScalar(d).dot(_fwd) < SIGHT_CONE) return;
    stats.sighted.push(kind.id);
    const game = this.game;
    game.log(kind.spec.line, "lore");
    game.addCredits(kind.spec.pay, "sighting");
    game.log(`sighting logged: ${kind.spec.name}. ${kind.spec.pay} credits from the Hull.`, "good");
    game.bus.emit("ambient:sighted", { kind: kind.id });
    if (game.persist) game.persist();
  }

  _write(kind, a, i) {
    _euler.set(a.pitch, a.heading, 0);
    _q.setFromEuler(_euler);
    _s.setScalar(a.scale);
    _p.copy(a.position);
    _m.compose(_p, _q, _s);
    kind.mesh.setMatrixAt(i, _m);
    kind.mesh.setColorAt(i, a.colour);
  }

  /* How many of each are in the water right now — for the chart and tests. */
  census() {
    const out = {};
    for (const kind of this.kinds) out[kind.id] = kind.mesh.count;
    return out;
  }

  dispose() {
    for (const kind of this.kinds) {
      kind.mesh.geometry.dispose();
      kind.material.dispose();
      if (this.game.water) this.game.water.forget(kind.material);
    }
    if (this.group.parent) this.group.parent.remove(this.group);
    this.kinds = [];
  }
}
