/* What else is down here. Six of them: three that are only animals, and three
   that the tank could not keep hold of. They are built from core geometry,
   animated by hand, and steered by a small state machine with a turn rate —
   the turn rate is what makes them arc toward you instead of snapping around,
   and the arc is most of the fear. */

import * as THREE from "three";

import { CREATURES, SEA, ZONES, zoneForDepth, zoneIndex } from "./config.js";
import { clamp, clamp01, damp, lerp, makeRng, weightedPick } from "./util.js";
import { blade, disposeTree, mergeGeometries, spindle, tube } from "./geo.js";
import { trophyItem } from "./progression.js";

const SPAWN_INTERVAL = 2.2;
const SPAWN_MIN = 62;          // just past where the lamps give out
const SPAWN_MAX = 118;
const DESPAWN = 230;
const REVEAL_TIME = 6;
const DEATH_TIME = 2.4;
const CORPSE_SINK = 3.5;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(0, 0, 1);
const _colour = new THREE.Color();

let nextCreatureId = 1;

/* ------------------------------------------------------------------ bodies */

function shellMaterial(type, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: opts.color != null ? opts.color : type.color,
    roughness: opts.roughness != null ? opts.roughness : 0.62,
    metalness: 0.08,
    emissive: opts.emissive != null ? opts.emissive : type.bellyColor,
    emissiveIntensity: opts.emissiveIntensity != null ? opts.emissiveIntensity : type.glow * 0.5,
    side: THREE.DoubleSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity != null ? opts.opacity : 1,
    depthWrite: opts.depthWrite !== false,
    blending: opts.blending || THREE.NormalBlending,
  });
}

/* A limb built as a chain of nested groups, so bending the root sweeps the
   whole thing. Returns the root group and the list of joints to wave. */
function limb(segments, length, radius, material) {
  const joints = [];
  const root = new THREE.Group();
  let parent = root;
  const step = length / segments;
  for (let i = 0; i < segments; i += 1) {
    const t = i / segments;
    const joint = new THREE.Group();
    joint.position.z = i === 0 ? 0 : step;
    const r0 = radius * (1 - t * 0.72);
    const geometry = new THREE.CylinderGeometry(r0 * 0.72, r0, step, 6, 1, true);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, step * 0.5);
    const mesh = new THREE.Mesh(geometry, material);
    joint.add(mesh);
    parent.add(joint);
    joints.push(joint);
    parent = joint;
  }
  return { root, joints };
}

function buildShark(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.7 });
  const belly = shellMaterial(type, { color: type.bellyColor, roughness: 0.8, emissiveIntensity: 0 });

  const body = spindle({
    length: type.length, radius: type.length * 0.115, rings: 16, segments: 12,
    profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.05)), 0.62),
    flattenX: 0.78,
  });
  group.add(new THREE.Mesh(body, material));

  const under = spindle({
    length: type.length * 0.7, radius: type.length * 0.07, rings: 10, segments: 8,
    profile: (t) => Math.sin(Math.PI * t),
    flattenX: 0.9, flattenY: 0.45,
  });
  under.translate(0, -type.length * 0.055, type.length * 0.02);
  group.add(new THREE.Mesh(under, belly));

  const dorsal = blade({ length: type.length * 0.24, width: type.length * 0.2, taper: 0.1, sweep: 0.7 });
  dorsal.rotateZ(Math.PI / 2);
  dorsal.rotateY(Math.PI / 2);
  dorsal.translate(0, type.length * 0.11, -type.length * 0.02);
  group.add(new THREE.Mesh(dorsal, material));

  for (const side of [-1, 1]) {
    const pec = blade({ length: type.length * 0.22, width: type.length * 0.12, taper: 0.2, sweep: 0.8 });
    pec.rotateX(Math.PI / 2);
    pec.rotateZ(side * 1.05);
    pec.translate(side * type.length * 0.07, -type.length * 0.03, type.length * 0.08);
    group.add(new THREE.Mesh(pec, material));
  }

  // The tail is a child pivot so it can swing without the body following.
  const tailPivot = new THREE.Group();
  tailPivot.position.z = -type.length * 0.42;
  const upper = blade({ length: type.length * 0.3, width: type.length * 0.16, taper: 0.12, sweep: 0.8 });
  upper.rotateZ(Math.PI / 2);
  upper.rotateY(Math.PI / 2);
  upper.translate(0, type.length * 0.02, 0);
  tailPivot.add(new THREE.Mesh(upper, material));
  const lower = blade({ length: type.length * 0.18, width: type.length * 0.12, taper: 0.2, sweep: 0.7 });
  lower.rotateZ(-Math.PI / 2);
  lower.rotateY(Math.PI / 2);
  tailPivot.add(new THREE.Mesh(lower, material));
  group.add(tailPivot);

  const jaw = new THREE.Group();
  jaw.position.z = type.length * 0.4;
  const teeth = new THREE.Mesh(
    new THREE.ConeGeometry(type.length * 0.075, type.length * 0.16, 8, 1, true),
    shellMaterial(type, { color: 0x120e10, emissive: 0x3a1218, emissiveIntensity: 0.25 }),
  );
  teeth.geometry.rotateX(-Math.PI / 2);
  jaw.add(teeth);
  group.add(jaw);

  return { group, parts: { tail: tailPivot, jaw }, materials: [material, belly] };
}

function buildSquid(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.4, emissiveIntensity: type.glow * 0.9, transparent: true, opacity: 0.88 });

  // The mantle points backwards; a squid travels beak-first.
  const mantle = new THREE.Mesh(
    new THREE.ConeGeometry(type.radius * 0.7, type.length * 0.62, 10, 1, true),
    material,
  );
  mantle.geometry.rotateX(Math.PI / 2);
  mantle.geometry.translate(0, 0, -type.length * 0.3);
  group.add(mantle);

  const head = new THREE.Mesh(new THREE.SphereGeometry(type.radius * 0.44, 10, 8), material);
  head.position.z = type.length * 0.04;
  group.add(head);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(type.radius * 0.16, 8, 6),
      shellMaterial(type, { color: 0x05040a, emissive: type.bellyColor, emissiveIntensity: 1.4 }),
    );
    eye.position.set(side * type.radius * 0.34, type.radius * 0.08, type.length * 0.06);
    group.add(eye);
  }

  const fins = [];
  for (const side of [-1, 1]) {
    const fin = new THREE.Mesh(
      blade({ length: type.length * 0.26, width: type.radius * 0.9, taper: 0.35, sweep: 0.4 }),
      material,
    );
    fin.geometry.rotateX(Math.PI / 2);
    fin.position.set(side * type.radius * 0.5, 0, -type.length * 0.42);
    fin.rotation.z = side * 0.3;
    group.add(fin);
    fins.push(fin);
  }

  const arms = [];
  const count = 8;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const { root, joints } = limb(4, type.length * 0.85, type.radius * 0.15, material);
    root.position.set(
      Math.cos(angle) * type.radius * 0.3,
      Math.sin(angle) * type.radius * 0.3,
      type.length * 0.14,
    );
    root.rotation.x = Math.sin(angle) * 0.35;
    root.rotation.y = -Math.cos(angle) * 0.35;
    group.add(root);
    arms.push({ root, joints, angle });
  }

  return { group, parts: { arms, fins }, materials: [material] };
}

function buildAngler(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.85, emissiveIntensity: 0.12 });
  const lureMat = new THREE.MeshBasicMaterial({
    color: type.lureColor || 0xffe9a8,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const body = spindle({
    length: type.length, radius: type.length * 0.27, rings: 12, segments: 12,
    profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.82 + 0.1)), 0.5),
    flattenX: 0.86,
  });
  group.add(new THREE.Mesh(body, material));

  // The jaw is the whole animal, really.
  const jaw = new THREE.Group();
  jaw.position.z = type.length * 0.2;
  const maw = new THREE.Mesh(
    new THREE.ConeGeometry(type.length * 0.24, type.length * 0.34, 10, 1, true),
    shellMaterial(type, { color: 0x0a0710, emissive: 0x1d0d16, emissiveIntensity: 0.4 }),
  );
  maw.geometry.rotateX(-Math.PI / 2);
  jaw.add(maw);
  for (let i = 0; i < 10; i += 1) {
    const angle = (i / 10) * Math.PI * 2;
    const tooth = new THREE.Mesh(
      new THREE.ConeGeometry(type.length * 0.016, type.length * 0.09, 4),
      shellMaterial(type, { color: 0xd8d2c4, emissive: 0x322c24, emissiveIntensity: 0.2 }),
    );
    tooth.geometry.rotateX(-Math.PI / 2);
    tooth.position.set(Math.cos(angle) * type.length * 0.13, Math.sin(angle) * type.length * 0.13, type.length * 0.16);
    tooth.rotation.x = Math.sin(angle) * 0.3;
    tooth.rotation.y = -Math.cos(angle) * 0.3;
    jaw.add(tooth);
  }
  group.add(jaw);

  const stalk = new THREE.Group();
  stalk.position.set(0, type.length * 0.2, type.length * 0.1);
  const rod = new THREE.Mesh(
    new THREE.CylinderGeometry(type.length * 0.012, type.length * 0.02, type.length * 0.5, 5),
    material,
  );
  rod.geometry.translate(0, type.length * 0.25, 0);
  rod.rotation.x = -0.5;
  stalk.add(rod);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(type.length * 0.06, 10, 8), lureMat);
  bulb.position.set(0, type.length * 0.45, type.length * 0.22);
  stalk.add(bulb);
  const lamp = new THREE.PointLight(type.lureColor || 0xffe9a8, 6, type.length * 9, 2);
  bulb.add(lamp);
  group.add(stalk);

  const tailPivot = new THREE.Group();
  tailPivot.position.z = -type.length * 0.44;
  const tail = blade({ length: type.length * 0.26, width: type.length * 0.22, taper: 0.5, sweep: 0.3 });
  tail.rotateX(Math.PI / 2);
  tailPivot.add(new THREE.Mesh(tail, material));
  group.add(tailPivot);

  return { group, parts: { jaw, stalk, bulb, lamp, tail: tailPivot }, materials: [material, lureMat] };
}

function buildLeviathan(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.42, emissiveIntensity: type.glow * 0.7 });
  const finMat = shellMaterial(type, { color: type.bellyColor, emissiveIntensity: type.glow * 1.1, transparent: true, opacity: 0.8 });

  const head = new THREE.Group();
  const skull = spindle({
    length: type.radius * 3.4, radius: type.radius * 0.95, rings: 12, segments: 10,
    profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.86 + 0.08)), 0.55),
    flattenY: 0.82,
  });
  head.add(new THREE.Mesh(skull, material));
  const crest = blade({ length: type.radius * 1.8, width: type.radius * 1.1, taper: 0.2, sweep: 0.6 });
  crest.rotateZ(Math.PI / 2);
  crest.rotateY(Math.PI / 2);
  crest.translate(0, type.radius * 0.7, -type.radius * 0.4);
  head.add(new THREE.Mesh(crest, finMat));
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(type.radius * 0.2, 8, 6),
      new THREE.MeshBasicMaterial({ color: type.bellyColor }),
    );
    eye.position.set(side * type.radius * 0.6, type.radius * 0.22, type.radius * 1.0);
    head.add(eye);
  }
  group.add(head);

  // The body is a chain of shrinking rings that will be laid along a trail of
  // where the head has been, which is what makes a serpent read as a serpent.
  const segments = [];
  const count = type.segments || 12;
  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const r = type.radius * lerp(0.92, 0.16, Math.pow(t, 0.8));
    const seg = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 7), material);
    shell.scale.z = 1.35;
    seg.add(shell);
    if (i % 2 === 0 && i < count - 2) {
      const fin = blade({ length: r * 2.4, width: r * 1.2, taper: 0.2, sweep: 0.7 });
      fin.rotateZ(Math.PI / 2);
      fin.rotateY(Math.PI / 2);
      fin.translate(0, r * 0.8, 0);
      seg.add(new THREE.Mesh(fin, finMat));
    }
    group.add(seg);
    segments.push(seg);
  }

  return { group, parts: { head, segments }, materials: [material, finMat] };
}

function buildWraith(type) {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: type.color,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const coreMat = new THREE.MeshBasicMaterial({
    color: type.bellyColor,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const shells = [];
  for (let i = 0; i < 3; i += 1) {
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(type.radius * (0.8 + i * 0.42), 1),
      material,
    );
    group.add(shell);
    shells.push(shell);
  }

  const core = new THREE.Mesh(new THREE.SphereGeometry(type.radius * 0.34, 10, 8), coreMat);
  group.add(core);

  // Trailing threads, because the thing you cannot quite see is worse.
  const threads = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    const { root, joints } = limb(3, type.length * 0.8, type.radius * 0.1, material);
    root.position.set(Math.cos(angle) * type.radius * 0.4, Math.sin(angle) * type.radius * 0.4, -type.radius * 0.4);
    root.rotation.y = Math.PI;
    group.add(root);
    threads.push({ root, joints, angle });
  }

  return { group, parts: { shells, core, threads }, materials: [material, coreMat] };
}

function buildKraken(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.5, emissiveIntensity: type.glow * 0.55 });
  const armMat = shellMaterial(type, { color: type.color, roughness: 0.55, emissiveIntensity: type.glow * 0.35 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: type.bellyColor });

  const mantle = new THREE.Mesh(
    new THREE.ConeGeometry(type.radius * 0.78, type.length * 0.62, 14, 1, true),
    material,
  );
  mantle.geometry.rotateX(Math.PI / 2);
  mantle.geometry.translate(0, 0, -type.length * 0.26);
  group.add(mantle);

  const hood = new THREE.Mesh(new THREE.SphereGeometry(type.radius * 0.62, 14, 10), material);
  hood.scale.set(1, 0.82, 1.1);
  group.add(hood);

  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(type.radius * 0.17, 10, 8), eyeMat);
    eye.position.set(side * type.radius * 0.5, type.radius * 0.12, type.radius * 0.3);
    group.add(eye);
  }

  const beak = new THREE.Mesh(
    new THREE.ConeGeometry(type.radius * 0.2, type.radius * 0.5, 6),
    shellMaterial(type, { color: 0x1a0c12, emissive: 0x3c1119, emissiveIntensity: 0.5 }),
  );
  beak.geometry.rotateX(-Math.PI / 2);
  beak.position.z = type.radius * 0.5;
  group.add(beak);

  const arms = [];
  const count = type.arms || 8;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    const long = i < 2;   // two hunting tentacles, longer than the rest
    const { root, joints } = limb(6, type.length * (long ? 1.5 : 1.0), type.radius * 0.15, armMat);
    root.position.set(
      Math.cos(angle) * type.radius * 0.45,
      Math.sin(angle) * type.radius * 0.45,
      type.radius * 0.4,
    );
    group.add(root);
    arms.push({ root, joints, angle, long });
  }

  return { group, parts: { arms, mantle, hood }, materials: [material, armMat, eyeMat] };
}

/* A knot of teeth on a ribbon. Individually pathetic, which is the point:
   lamprey arrive in numbers and the sonar lance is the answer. */
function buildLamprey(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.5, emissiveIntensity: type.glow * 0.8 });

  const body = spindle({
    length: type.length, radius: type.radius * 0.3, rings: 14, segments: 7,
    profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.08)), 0.4),
    flattenX: 0.85,
  });
  group.add(new THREE.Mesh(body, material));

  // The mouth is a ring, and it is most of the animal's personality.
  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(type.radius * 0.26, type.radius * 0.09, 6, 10),
    shellMaterial(type, { color: type.bellyColor, emissive: type.bellyColor, emissiveIntensity: 1.2 }),
  );
  mouth.position.z = type.length * 0.46;
  group.add(mouth);

  const fin = blade({ length: type.length * 0.45, width: type.radius * 0.34, taper: 0.6, sweep: 0.5, thickness: 0.005 });
  fin.rotateZ(Math.PI / 2);
  fin.translate(0, type.radius * 0.2, -type.length * 0.05);
  group.add(new THREE.Mesh(fin, material));

  return { group, parts: { mouth }, materials: [material] };
}

/* Terrain with a hinge in it. Flat, silted, the same colours as the floor —
   until the jaw opens and it is suddenly the size of your boat. */
function buildTrapjaw(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.95, emissiveIntensity: 0.03 });
  const mawMat = shellMaterial(type, { color: 0x120b0b, emissive: 0x5a1c1c, emissiveIntensity: 0.35 });

  const body = spindle({
    length: type.length, radius: type.radius * 0.62, rings: 12, segments: 10,
    profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.8 + 0.12)), 0.7),
    flattenY: 0.34,
  });
  group.add(new THREE.Mesh(body, material));

  // Lumps, so it reads as a rock while it is waiting.
  for (let i = 0; i < 7; i += 1) {
    const a = (i / 7) * Math.PI * 2;
    const lump = new THREE.Mesh(new THREE.IcosahedronGeometry(type.radius * 0.3, 0), material);
    lump.position.set(Math.cos(a) * type.radius * 0.55, type.radius * 0.14, Math.sin(a) * type.length * 0.24);
    lump.scale.set(1, 0.5, 1);
    group.add(lump);
  }

  const jaw = new THREE.Group();
  jaw.position.z = type.length * 0.3;
  const maw = new THREE.Mesh(new THREE.ConeGeometry(type.radius * 0.7, type.length * 0.5, 9, 1, true), mawMat);
  maw.geometry.rotateX(-Math.PI / 2);
  jaw.add(maw);
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    const tooth = new THREE.Mesh(
      new THREE.ConeGeometry(type.radius * 0.055, type.radius * 0.34, 4),
      shellMaterial(type, { color: type.bellyColor, emissiveIntensity: 0.1 }),
    );
    tooth.geometry.rotateX(-Math.PI / 2);
    tooth.position.set(Math.cos(a) * type.radius * 0.5, Math.sin(a) * type.radius * 0.22, type.length * 0.2);
    group.add(tooth);
  }
  group.add(jaw);

  return { group, parts: { jaw }, materials: [material, mawMat] };
}

/* It shows you a docking light the colour of the Hull's. There is no dock. */
function buildSiren(type) {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: type.color,
    transparent: true,
    opacity: 0.3,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const lampMat = new THREE.MeshBasicMaterial({
    color: type.bellyColor,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  // A soft body you only half see, hung under a very convincing light.
  const veil = new THREE.Mesh(new THREE.ConeGeometry(type.radius * 0.8, type.length, 10, 1, true), material);
  veil.geometry.rotateX(Math.PI / 2);
  veil.geometry.translate(0, 0, -type.length * 0.4);
  group.add(veil);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(type.radius * 0.66, type.radius * 0.07, 6, 20), lampMat);
  ring.position.z = type.length * 0.22;
  group.add(ring);

  const bulb = new THREE.Mesh(new THREE.SphereGeometry(type.radius * 0.2, 10, 8), lampMat);
  bulb.position.z = type.length * 0.24;
  group.add(bulb);
  const lamp = new THREE.PointLight(type.bellyColor, 14, type.radius * 26, 1.6);
  bulb.add(lamp);

  const threads = [];
  for (let i = 0; i < 5; i += 1) {
    const a = (i / 5) * Math.PI * 2;
    const { root, joints } = limb(3, type.length * 0.9, type.radius * 0.07, material);
    root.position.set(Math.cos(a) * type.radius * 0.4, Math.sin(a) * type.radius * 0.4, -type.length * 0.3);
    root.rotation.y = Math.PI;
    group.add(root);
    threads.push({ root, joints, angle: a });
  }

  return { group, parts: { ring, bulb, lamp, threads }, materials: [material, lampMat] };
}

/* Mostly mouth. The body behind it is an afterthought and looks it. */
function buildGulper(type) {
  const group = new THREE.Group();
  const material = shellMaterial(type, { roughness: 0.8, emissiveIntensity: type.glow * 0.4 });
  const mawMat = shellMaterial(type, { color: 0x2a0f22, emissive: type.bellyColor, emissiveIntensity: 0.5 });

  const jaw = new THREE.Group();
  const maw = new THREE.Mesh(new THREE.ConeGeometry(type.radius * 1.05, type.length * 0.46, 12, 1, true), mawMat);
  maw.geometry.rotateX(-Math.PI / 2);
  maw.geometry.translate(0, 0, type.length * 0.16);
  jaw.add(maw);
  group.add(jaw);

  const tail = spindle({
    length: type.length * 0.8, radius: type.radius * 0.3, rings: 14, segments: 8,
    profile: (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.7 + 0.3)), 1.3),
    flattenX: 0.8,
  });
  tail.translate(0, 0, -type.length * 0.34);
  group.add(new THREE.Mesh(tail, material));

  // A thin line of light down the tail, the only way you see it coming.
  const strip = blade({ length: type.length * 0.6, width: type.radius * 0.12, taper: 0.2, sweep: 0.4, thickness: 0.004 });
  strip.rotateZ(Math.PI / 2);
  strip.translate(0, type.radius * 0.22, -type.length * 0.2);
  group.add(new THREE.Mesh(strip, shellMaterial(type, {
    color: type.bellyColor, emissive: type.bellyColor, emissiveIntensity: 1.1,
  })));

  const tailPivot = new THREE.Group();
  tailPivot.position.z = -type.length * 0.62;
  const fin = blade({ length: type.length * 0.2, width: type.radius * 0.5, taper: 0.4, sweep: 0.3 });
  fin.rotateZ(Math.PI / 2);
  tailPivot.add(new THREE.Mesh(fin, material));
  group.add(tailPivot);

  return { group, parts: { jaw, tail: tailPivot }, materials: [material, mawMat] };
}

const BUILDERS = {
  lamprey: buildLamprey,
  trapjaw: buildTrapjaw,
  siren: buildSiren,
  gulper: buildGulper,
  shark: buildShark,
  squid: buildSquid,
  angler: buildAngler,
  leviathan: buildLeviathan,
  wraith: buildWraith,
  kraken: buildKraken,
};

/* ---------------------------------------------------------------- manager */

export class CreatureManager {
  constructor(game) {
    this.game = game;
    this.all = [];
    this.threatLevel = 0;
    this.group = new THREE.Group();
    this.group.name = "creatures";
    game.scene.add(this.group);

    this.rng = makeRng(game.seed, "creatures");
    this.time = 0;
    this.spawnTimer = 3;
    this.revealUntil = 0;
    this.noise = 0;            // recent weapon fire and boost: they can hear it

    this._onFire = () => { this.noise = Math.min(2.5, this.noise + 1.1); };
    game.bus.on("combat:fire", this._onFire);
  }

  /* --------------------------------------------------------------- spawning */

  _bossAlive() {
    for (const c of this.all) if (c.alive && c.type.boss) return true;
    return false;
  }

  _countAlive() {
    let n = 0;
    for (const c of this.all) if (c.alive) n += 1;
    return n;
  }

  _trySpawn() {
    const sub = this.game.sub;
    if (!sub || this.game.mode !== "dive") return;

    const zone = zoneForDepth(sub.depth);
    const budget = zone.hostileBudget || 0;
    if (this._countAlive() >= budget) return;

    // Nothing hunts you in the station's floodlights.
    if (this.game.world.distanceToStation(sub.position) < SEA.dockRadius * 2.4) return;

    const table = zone.hostiles || [];
    if (!table.length) return;
    let id = weightedPick(this.rng, table);
    if (!id) return;
    if (CREATURES[id] && CREATURES[id].boss && this._bossAlive()) {
      id = weightedPick(this.rng, table.filter(([k]) => !CREATURES[k] || !CREATURES[k].boss));
      if (!id) return;
    }

    const type = CREATURES[id];
    if (!type) return;

    // Behind and below, at the edge of what the lamps can reach.
    const angle = this.rng.random() * Math.PI * 2;
    const radius = lerp(SPAWN_MIN, SPAWN_MAX, this.rng.random());
    const x = sub.position.x + Math.cos(angle) * radius;
    const z = sub.position.z + Math.sin(angle) * radius;
    const floor = this.game.world.heightAt(x, z);
    const y = clamp(
      sub.position.y + (this.rng.random() - 0.45) * 30,
      floor + type.radius * 2.2,
      -type.radius * 1.5,
    );
    if (y <= floor + type.radius) return;

    _v.set(x, y, z);

    /* Some things do not arrive alone. One lamprey is nothing to worry about,
       which is exactly why they come as a knot of them. */
    if (type.swarm) {
      const [lo, hi] = type.swarm;
      const count = lo + this.rng.randrange(Math.max(1, hi - lo + 1));
      const room = Math.max(0, budget + 6 - this._countAlive());
      for (let i = 0; i < Math.min(count, room); i += 1) {
        _v2.set(
          x + (this.rng.random() - 0.5) * 16,
          clamp(y + (this.rng.random() - 0.5) * 10, floor + type.radius * 2, -type.radius),
          z + (this.rng.random() - 0.5) * 16,
        );
        this.spawn(id, _v2);
      }
      return;
    }

    this.spawn(id, _v);
  }

  spawn(typeId, position) {
    const type = CREATURES[typeId];
    if (!type) return null;

    const built = BUILDERS[typeId] ? BUILDERS[typeId](type) : buildShark(type);
    built.group.position.copy(position);

    const creature = {
      id: nextCreatureId++,
      type,
      hp: type.hp,
      hpMax: type.hp,
      position: built.group.position,
      velocity: new THREE.Vector3(),
      heading: this.rng.random() * Math.PI * 2,
      state: "patrol",
      stateTime: 0,
      object: built.group,
      parts: built.parts,
      materials: built.materials,
      radius: type.radius,
      alive: true,
      stun: 0,
      lastAttack: 0,
      aggro: false,
      phase: this.rng.random() * Math.PI * 2,
      home: position.clone(),
      wander: position.clone(),
      wanderTimer: 0,
      windup: 0,
      dying: 0,
      buried: false,
      lunge: 0,
      trail: [],
      jet: 0,
      revealed: 0,
      baseEmissive: built.materials.map((m) => (m.emissiveIntensity != null ? m.emissiveIntensity : 0)),
    };

    // The serpent needs a trail to lay its body along before it first moves.
    if (typeId === "leviathan") {
      for (let i = 0; i < 200; i += 1) creature.trail.push(position.clone());
    }

    /* An ambusher is terrain until it is not: it starts flat on the floor,
       barely aggroed, and does not move at all until you are close enough that
       moving is the last thing you want it to do. */
    if (type.ambush) {
      const floor = this.game.world.heightAt(position.x, position.z);
      creature.position.y = floor + type.radius * 0.55;
      creature.buried = true;
      creature.state = "idle";
      built.group.rotation.x = 0;
    }

    this.group.add(built.group);
    this.all.push(creature);
    this.game.bus.emit("creature:spawn", { creature });
    return creature;
  }

  /* -------------------------------------------------------------- updating */

  update(dt) {
    this.time += dt;
    this.noise = Math.max(0, this.noise - dt * 0.55);

    const sub = this.game.sub;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      this._trySpawn();
      this._despawn();
    }

    let threat = 0;
    for (let i = this.all.length - 1; i >= 0; i -= 1) {
      const c = this.all[i];
      if (c.dying > 0) {
        this._updateDying(c, dt);
        if (c.dying <= 0) {
          disposeTree(c.object);
          this.group.remove(c.object);
          this.all.splice(i, 1);
        }
        continue;
      }
      if (!c.alive) continue;

      this._think(c, dt, sub);
      this._move(c, dt);
      this._animate(c, dt);
      this._reveal(c, dt);

      if (sub && c.aggro) {
        const d = c.position.distanceTo(sub.position);
        const close = clamp01(1 - d / Math.max(30, c.type.aggro));
        threat = Math.max(threat, close * (c.type.boss ? 1 : c.type.mythic ? 0.85 : 0.6));
      }
    }

    this.threatLevel = damp(this.threatLevel, clamp01(threat), 3, dt);
  }

  _despawn() {
    const sub = this.game.sub;
    if (!sub) return;
    const limit = DESPAWN * DESPAWN;
    for (let i = this.all.length - 1; i >= 0; i -= 1) {
      const c = this.all[i];
      if (!c.alive || c.dying > 0) continue;
      if (c.position.distanceToSquared(sub.position) < limit) continue;
      disposeTree(c.object);
      this.group.remove(c.object);
      this.all.splice(i, 1);
    }
  }

  /* The state machine. Short, and deliberately not clever: patrol until you
     are worth the swim, close, bite, and think better of it when losing. */
  _think(c, dt, sub) {
    const type = c.type;
    c.stateTime += dt;
    c.stun = Math.max(0, c.stun - dt);
    if (c.stun > 0) return;
    if (!sub || this.game.mode !== "dive") {
      c.aggro = false;
      c.state = "patrol";
      return;
    }

    const distance = c.position.distanceTo(sub.position);
    // Lamps off halves how far it can find you; noise gives you back away.
    const dark = sub.lightsOn ? 1 : 0.5;
    const reach = type.aggro * dark + this.noise * 22 + sub.speed * 1.4;

    if (c.state === "flee") {
      if (c.stateTime > 9 || c.hp > c.hpMax * 0.45) {
        c.state = "patrol";
        c.stateTime = 0;
      }
      return;
    }

    // Bosses and the mythics do not lose interest.
    const persistent = type.boss || type.mythic;
    if (!c.aggro && distance < reach) {
      c.aggro = true;
      c.state = "hunt";
      c.stateTime = 0;
      this.game.bus.emit("creature:aggro", { creature: c });
    } else if (c.aggro && !persistent && distance > type.aggro * 2.4) {
      c.aggro = false;
      c.state = "patrol";
      c.stateTime = 0;
    }

    if (!c.aggro) {
      c.state = "patrol";
      return;
    }

    // Beasts break off when they are losing; the mythics never do.
    if (!persistent && c.hp < c.hpMax * 0.22 && c.state !== "flee") {
      c.state = "flee";
      c.stateTime = 0;
      return;
    }

    // The moment it stops being scenery.
    if (c.buried && c.aggro) {
      c.buried = false;
      c.lunge = 1.1;
      if (this.game.vfx) {
        this.game.vfx.bloodCloud(c.position, 0x6b5d43);
        this.game.vfx.screenShake(0.4);
      }
      if (this.game.audio) this.game.audio.sfx("roar");
      this.game.log("the floor opens. it was never the floor.", "bad");
    }

    if (distance <= type.attackRange) {
      if (c.state !== "attack") {
        c.state = "attack";
        c.stateTime = 0;
        c.windup = type.boss ? 0.9 : 0.45;
      }
      this._attack(c, dt, sub, distance);
    } else {
      c.state = "hunt";
    }
  }

  _attack(c, dt, sub, distance) {
    const type = c.type;
    if (c.windup > 0) {
      c.windup -= dt;
      return;
    }
    if (this.time - c.lastAttack < type.attackCooldown) return;
    c.lastAttack = this.time;
    c.windup = type.boss ? 0.9 : 0.45;

    // The wraith would rather take a memory than a bite out of the hull.
    if (type.memoryDrain && Math.random() < 0.5 && this._forget(c)) return;

    sub.damage(type.damage, c);
    this.game.bus.emit("creature:attack", { creature: c, damage: type.damage });

    if (type.batteryDrain) {
      sub.drainBattery(type.batteryDrain);
      if (this.game.vfx) this.game.vfx.inkCloud(sub.position, 6);
      this.game.log("the arms find the housing. the cell bleeds down.", "bad");
    }

    // Knock the boat around: a hit you do not feel is not a hit.
    _v.copy(sub.position).sub(c.position);
    if (_v.lengthSq() > 0.0001) {
      _v.normalize().multiplyScalar(type.damage * (type.boss ? 1.1 : 0.45));
      sub.nudge(_v);
    }
    if (this.game.vfx) this.game.vfx.screenShake(clamp01(type.damage / 60));
    if (this.game.audio) this.game.audio.sfx(type.boss || type.mythic ? "roar" : "damage");
    void distance;
  }

  /* The sea forgets one thing in your hold. This is the wraith's whole point:
     it costs you the run, not the hull. */
  _forget(c) {
    const cargo = this.game.profile && this.game.profile.cargo;
    if (!cargo || !cargo.length) return false;
    const at = Math.floor(Math.random() * cargo.length);
    const lost = cargo.splice(at, 1)[0];
    if (!lost) return false;
    if (this.game.sub) this.game.sub.cargoFull = cargo.length >= (this.game.stats.cargoSlots || 6);
    this.game.log(`the wraith takes ${lost.name} out of the hold, and out of the record.`, "bad");
    this.game.bus.emit("creature:attack", { creature: c, damage: 0, forgot: lost });
    if (this.game.vfx) this.game.vfx.inkCloud(c.position, 8);
    if (this.game.audio) this.game.audio.sfx("roar");
    this.game.persist();
    return true;
  }

  /* Steering. Everything turns at its own rate toward where it wants to be,
     which is the difference between a shark and a homing missile. */
  _move(c, dt) {
    const type = c.type;
    const sub = this.game.sub;

    // Buried things do not patrol. They wait, which is worse.
    if (c.buried) {
      const floor = this.game.world.heightAt(c.position.x, c.position.z);
      c.position.y = damp(c.position.y, floor + type.radius * 0.55, 3, dt);
      c.velocity.set(0, 0, 0);
      return;
    }

    if (c.state === "patrol" || !sub) {
      c.wanderTimer -= dt;
      if (c.wanderTimer <= 0) {
        c.wanderTimer = 5 + this.rng.random() * 8;
        const angle = this.rng.random() * Math.PI * 2;
        const reach = 18 + this.rng.random() * 46;
        c.wander.set(
          c.home.x + Math.cos(angle) * reach,
          c.home.y + (this.rng.random() - 0.5) * 22,
          c.home.z + Math.sin(angle) * reach,
        );
      }
      _v.copy(c.wander);
    } else if (c.state === "flee") {
      _v.copy(c.position).sub(sub.position).normalize().multiplyScalar(90).add(c.position);
    } else {
      _v.copy(sub.position);
      // Lead the target a little, so a fast boat does not simply outrun them.
      if (c.state === "hunt" && sub.velocity) _v.addScaledVector(sub.velocity, 0.55);
      // The angler does not chase: it waits, and lets the light do the work.
      if (type.lure && c.state === "hunt" && c.position.distanceTo(sub.position) > type.attackRange * 2.2) {
        _v.copy(c.position);
      }
    }

    // Keep off the floor and out of the sky.
    const floor = this.game.world.heightAt(c.position.x, c.position.z);
    const minY = floor + type.radius * 1.6;
    if (_v.y < minY) _v.y = minY;
    if (_v.y > -type.radius * 1.2) _v.y = -type.radius * 1.2;

    _v2.copy(_v).sub(c.position);
    const distance = _v2.length();
    if (distance > 0.001) {
      _v2.divideScalar(distance);
      // Turn the heading toward the goal at the type's turn rate.
      _q.setFromUnitVectors(_forward, _v2);
      c.object.quaternion.slerp(_q, clamp01(type.turn * dt));
    }

    let speed = type.speed;
    if (c.lunge > 0) {
      // A short, committed burst — far faster than it can sustain.
      c.lunge -= dt;
      speed = type.lungeSpeed || type.speed * 2;
    }
    if (c.state === "patrol") speed *= 0.42;
    else if (c.state === "attack") speed *= 0.55;
    else if (c.state === "flee") speed *= 1.15;
    if (c.stun > 0) speed *= 0.15;
    if (c.windup > 0) speed *= 0.4;

    // A squid does not cruise; it jets. Accelerate hard, then coast.
    if (type.grapple) {
      c.jet -= dt;
      if (c.jet <= 0) {
        c.jet = 1.1 + this.rng.random() * 0.9;
        c.jetPulse = 1;
      }
      c.jetPulse = Math.max(0, (c.jetPulse || 0) - dt * 1.8);
      speed *= 0.35 + c.jetPulse * 2.2;
    }
    // The wraith drifts. It does not appear to be swimming at all.
    if (type.phasing) speed *= 0.6 + Math.sin(this.time * 0.7 + c.phase) * 0.35;

    c.object.getWorldDirection(_v3);
    c.velocity.lerp(_v3.multiplyScalar(speed), clamp01(dt * 2.2));
    c.position.addScaledVector(c.velocity, dt);

    // Hard floor, and a hard ceiling just under the surface.
    if (c.position.y < minY) c.position.y = minY;
    if (c.position.y > -type.radius) c.position.y = -type.radius;
  }

  _animate(c, dt) {
    const t = this.time + c.phase;
    const parts = c.parts;
    const moving = clamp01(c.velocity.length() / Math.max(1, c.type.speed));

    if (parts.tail) {
      parts.tail.rotation.y = Math.sin(t * (3 + moving * 5)) * (0.22 + moving * 0.38);
    }
    if (parts.jaw && c.type.id !== "angler") {
      parts.jaw.scale.z = 1 + Math.max(0, Math.sin(t * 2.2)) * 0.12;
    }
    if (c.type.id === "angler") {
      // The lure sways on its stalk; the jaw gapes when it is about to commit.
      if (parts.stalk) {
        parts.stalk.rotation.z = Math.sin(t * 0.9) * 0.22;
        parts.stalk.rotation.x = Math.sin(t * 0.6) * 0.14;
      }
      if (parts.bulb) {
        const pulse = 0.85 + Math.sin(t * 2.6) * 0.15;
        parts.bulb.scale.setScalar(pulse);
        if (parts.lamp) parts.lamp.intensity = 4 + pulse * 4 + (c.state === "attack" ? 6 : 0);
      }
      if (parts.jaw) {
        const gape = c.state === "attack" ? 1 + (1 - clamp01(c.windup / 0.45)) * 0.9 : 1;
        parts.jaw.scale.set(gape, gape, gape);
      }
    }
    if (parts.mouth) {
      // The ring opens and shuts whether or not there is anything in it.
      const gape = 1 + Math.sin(t * 5.5) * 0.22 + (c.state === "attack" ? 0.4 : 0);
      parts.mouth.scale.set(gape, gape, 1);
    }
    if (parts.ring && parts.bulb) {
      /* The siren's whole trick is that its light looks like a docking ring,
         so it turns slowly and steadily the way a real beacon does — and only
         flares once it has you. */
      parts.ring.rotation.z += dt * 0.8;
      const flare = c.state === "attack" ? 1.8 : 1;
      const pulse = (0.85 + Math.sin(t * 1.4) * 0.15) * flare;
      parts.bulb.scale.setScalar(pulse);
      if (parts.lamp) parts.lamp.intensity = 9 * pulse;
    }
    if (parts.arms) {
      const sweep = c.state === "attack" ? 1.5 : 0.55;
      for (let i = 0; i < parts.arms.length; i += 1) {
        const arm = parts.arms[i];
        const lead = i * 0.5;
        for (let j = 0; j < arm.joints.length; j += 1) {
          const joint = arm.joints[j];
          const wave = Math.sin(t * 2.1 - j * 0.65 + lead) * sweep * (0.12 + j * 0.05);
          joint.rotation.x = wave + (arm.long ? 0.1 : 0);
          joint.rotation.y = Math.cos(t * 1.7 - j * 0.5 + lead) * sweep * 0.09;
        }
      }
    }
    if (parts.fins) {
      for (let i = 0; i < parts.fins.length; i += 1) {
        parts.fins[i].rotation.x = Math.sin(t * 3.2 + i) * 0.3;
      }
    }
    if (parts.threads) {
      for (let i = 0; i < parts.threads.length; i += 1) {
        const thread = parts.threads[i];
        for (let j = 0; j < thread.joints.length; j += 1) {
          thread.joints[j].rotation.x = Math.sin(t * 1.3 + j * 0.8 + i) * 0.4;
          thread.joints[j].rotation.y = Math.cos(t * 1.1 + j * 0.7 + i) * 0.4;
        }
      }
    }
    if (parts.shells) {
      // Phasing: the shells breathe out of step and the whole thing fades.
      for (let i = 0; i < parts.shells.length; i += 1) {
        const s = 1 + Math.sin(t * (0.8 + i * 0.35)) * 0.18;
        parts.shells[i].scale.setScalar(s);
        parts.shells[i].rotation.y += dt * (0.2 + i * 0.1);
        parts.shells[i].rotation.x += dt * 0.08;
      }
      const fade = 0.16 + (0.5 + Math.sin(t * 0.9) * 0.5) * 0.3;
      if (c.materials[0]) c.materials[0].opacity = c.state === "attack" ? 0.55 : fade;
    }
    if (parts.segments) {
      // Lay the body along where the head has been.
      c.trail.unshift(_v.copy(c.position).clone());
      if (c.trail.length > 260) c.trail.pop();
      const spacing = Math.max(2, Math.floor(c.trail.length / (parts.segments.length + 2)));
      for (let i = 0; i < parts.segments.length; i += 1) {
        const point = c.trail[Math.min(c.trail.length - 1, (i + 1) * spacing)];
        if (!point) continue;
        const seg = parts.segments[i];
        seg.position.copy(point).sub(c.position);
        const ahead = c.trail[Math.max(0, Math.min(c.trail.length - 1, i * spacing))];
        if (ahead) {
          _v2.copy(ahead).sub(point);
          if (_v2.lengthSq() > 0.0001) seg.quaternion.setFromUnitVectors(_forward, _v2.normalize());
        }
      }
    }
  }

  /* Sonar paint: hold the emissive up for a few seconds so a ping shows you
     exactly what you would rather not have found. */
  _reveal(c, dt) {
    void dt;
    const left = c.revealed - this.time;
    const lift = left > 0 ? clamp01(left / REVEAL_TIME) : 0;
    for (let i = 0; i < c.materials.length; i += 1) {
      const m = c.materials[i];
      if (m.emissiveIntensity == null) continue;
      m.emissiveIntensity = c.baseEmissive[i] + lift * 2.2;
    }
  }

  _updateDying(c, dt) {
    c.dying -= dt;
    const t = clamp01(1 - c.dying / DEATH_TIME);
    // Roll over and sink, the way everything does.
    c.object.rotation.z = lerp(c.object.rotation.z, Math.PI * 0.85, clamp01(dt * 1.6));
    c.position.y -= CORPSE_SINK * dt * t;
    const floor = this.game.world.heightAt(c.position.x, c.position.z);
    if (c.position.y < floor + c.radius * 0.5) c.position.y = floor + c.radius * 0.5;
    for (const m of c.materials) {
      if (!m.transparent) {
        m.transparent = true;
        m.depthWrite = false;
      }
      m.opacity = Math.max(0, (m.opacity != null ? m.opacity : 1) * (1 - dt * 0.9));
    }
  }

  /* ------------------------------------------------------------- queries */

  raycast(origin, dir, range) {
    let best = null;
    let bestDist = range;
    for (const c of this.all) {
      if (!c.alive || c.dying > 0) continue;
      _v.copy(c.position).sub(origin);
      const along = _v.dot(dir);
      // Fat bodies deserve a fat hit sphere; a leviathan is mostly not its head.
      const radius = c.radius * (c.type.segments ? 1.6 : 1.1);
      if (along < -radius || along > bestDist + radius) continue;
      const off2 = _v.lengthSq() - along * along;
      if (off2 > radius * radius) continue;
      const hit = Math.max(0, along - Math.sqrt(Math.max(0, radius * radius - off2)));
      if (hit > bestDist) continue;
      bestDist = hit;
      best = c;
    }
    if (!best) return null;
    return {
      creature: best,
      distance: bestDist,
      point: _v2.copy(origin).addScaledVector(dir, bestDist).clone(),
    };
  }

  sphereHit(point, radius) {
    const out = [];
    for (const c of this.all) {
      if (!c.alive || c.dying > 0) continue;
      if (c.position.distanceTo(point) - c.radius <= radius) out.push(c);
    }
    return out;
  }

  nearestHostile(position, range) {
    let best = null;
    let bestD2 = range * range;
    for (const c of this.all) {
      if (!c.alive || c.dying > 0) continue;
      const d2 = c.position.distanceToSquared(position);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best;
  }

  pingReveal(range) {
    const sub = this.game.sub;
    if (!sub) return;
    const r2 = range * range;
    for (const c of this.all) {
      if (!c.alive) continue;
      if (c.position.distanceToSquared(sub.position) > r2) continue;
      c.revealed = this.time + REVEAL_TIME;
    }
  }

  /* ------------------------------------------------------------- damage */

  damage(creature, amount, opts = {}) {
    if (!creature || !creature.alive || creature.dying > 0) return false;
    creature.hp -= amount;
    creature.stun = Math.max(creature.stun, opts.stun || 0);
    creature.revealed = Math.max(creature.revealed, this.time + 2);

    // Hitting something is how you introduce yourself.
    if (!creature.aggro && !opts.silent) {
      creature.aggro = true;
      creature.state = "hunt";
      creature.stateTime = 0;
      this.game.bus.emit("creature:aggro", { creature });
    }

    if (creature.hp > 0) return false;

    creature.alive = false;
    creature.hp = 0;
    creature.dying = DEATH_TIME;

    const depth = Math.max(0, -creature.position.y);
    const item = trophyItem(creature.type, depth);
    const bounty = creature.type.bounty;

    if (this.game.vfx) {
      this.game.vfx.bloodCloud(creature.position, creature.type.bellyColor);
      if (creature.type.boss) this.game.vfx.explosion(creature.position, 2.2, creature.type.bellyColor);
    }
    this.game.bus.emit("creature:killed", { creature, bounty, item });
    return true;
  }

  dispose() {
    this.game.bus.off("combat:fire", this._onFire);
    for (const c of this.all) {
      disposeTree(c.object);
      this.group.remove(c.object);
    }
    this.all.length = 0;
    disposeTree(this.group);
    if (this.game.scene) this.game.scene.remove(this.group);
  }
}
