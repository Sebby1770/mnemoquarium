/* The shoals. Every fish down here is one word of the phrase, grown through a
   short lineage by the aquarium's own genetics, and priced by how far from the
   light you were willing to go to net it.

   Three things are worth knowing before reading the rest:

   1. There is one InstancedMesh per species and nothing else. Every difference
      between one fish and the next — the countershading, the rim the lamps
      catch, the mutant's shimmer, the tail beat, the bioluminescent pulse —
      rides in the material's patched shader and in a single per-instance vec4.
      That keeps the whole sea at nine draw calls.
   2. Behaviour is per shoal, not per fish. A shoal picks a mood (cruise,
      forage, shelter, or a predator has found it) and the fish inside it just
      steer. That is why five hundred metres of water can afford to be alive.
   3. Removal is deferred. combat.js can land a net and call capture() a dozen
      times inside one frame, so a captured fish is only flagged; the lists are
      compacted once, at the top of the next update. Nothing that iterates can
      have the floor pulled out from under it. */

import * as THREE from "three";

import { ZONES, zoneForDepth, zoneIndex } from "./config.js";
import { TAU, clamp, clamp01, damp, hslHex, lerp, makeRng } from "./util.js";
import { blade, disposeTree, mergeGeometries, spindle, tube } from "./geo.js";

const MAX_FISH = 360;
const SHOAL_MIN = 4;
const SHOAL_MAX = 22;
const SPAWN_MIN = 12;          // metres from the sub — close enough to matter
const SPAWN_MAX = 72;
const DESPAWN = 165;
const SPAWN_INTERVAL = 0.45;   // seconds between spawn attempts
const NEIGHBOUR_CAP = 10;      // separation checks per fish, for O(n) sanity
const FLOOR_CLEARANCE = 1.6;
const MAX_SHOALS = 26;
const THREAT_SCAN = 0.28;      // seconds between predator sweeps, per shoal

/* three keys its program cache partly on customProgramCacheKey, and water.js
   stamps every material it patches with the same one. Fish carry a second
   patch on top of that, so they need a key of their own or the renderer may
   hand a fish's program to a coral that happens to share its parameters. */
const FISH_CACHE_KEY = "mnemoquarium-water|fish";

// Scratch. Nothing in the per-frame path may allocate.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _flow = new THREE.Vector3();
const _colour = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(0, 0, 1);
const _pale = new THREE.Color(0xdff4ff);

let nextFishId = 1;

/* Every body plan this module can build. ecology.js names one of the six tank
   shapes for each species so the glass tank and the porthole agree on what a
   word is; the five after them are shapes the tank has no word for and the
   deep is full of. An unknown name falls back to a tetra rather than throwing. */
export const FISH_KINDS = [
  "tetra", "guppy", "angel", "betta", "catfish", "eel",
  "ray", "ribbon", "jelly", "grouper", "hatchet",
];

/* Plans that only occur down here. If ecology.js ever starts naming one of
   these directly, it is taken at its word and not translated again. */
const DEEP_PLANS = ["ray", "ribbon", "jelly", "grouper", "hatchet"];

/* How each plan moves. `lateral` is the tail beat, `flap` is a ray's wings,
   `pulse` is a jelly squeezing its whole bell, `wave` is how many radians of
   the travelling wave fit along the body, and `rate` is beats per second at
   a standstill. All of it happens on the GPU; the CPU only carries a phase. */
const SWIM = {
  tetra:   { lateral: 0.055, flap: 0.00, pulse: 0.00, wave: 5.2, rate: 6.6 },
  guppy:   { lateral: 0.060, flap: 0.00, pulse: 0.00, wave: 5.0, rate: 6.2 },
  angel:   { lateral: 0.034, flap: 0.00, pulse: 0.00, wave: 4.0, rate: 4.4 },
  betta:   { lateral: 0.050, flap: 0.00, pulse: 0.00, wave: 4.6, rate: 5.0 },
  catfish: { lateral: 0.048, flap: 0.00, pulse: 0.00, wave: 4.4, rate: 3.9 },
  eel:     { lateral: 0.105, flap: 0.00, pulse: 0.00, wave: 11.0, rate: 4.6 },
  ribbon:  { lateral: 0.135, flap: 0.00, pulse: 0.00, wave: 14.5, rate: 3.0 },
  ray:     { lateral: 0.014, flap: 0.17, pulse: 0.00, wave: 3.0, rate: 1.9 },
  jelly:   { lateral: 0.030, flap: 0.00, pulse: 0.14, wave: 3.0, rate: 1.5 },
  grouper: { lateral: 0.030, flap: 0.00, pulse: 0.00, wave: 3.4, rate: 2.5 },
  hatchet: { lateral: 0.052, flap: 0.00, pulse: 0.00, wave: 5.4, rate: 6.4 },
};

/* Plans that make their living off the floor. Foragers spend most of their
   time nose-down in the silt, which is where the player finds them. */
const FLOOR_PLANS = ["catfish", "eel", "ray", "grouper", "ribbon"];

/* ------------------------------------------------------------- body plans --
   One geometry per plan, built once and cloned by every species that wears it.
   Bodies point down +Z, are one metre nose to tail, and are centred on the
   origin so an instance matrix is just position + rotation + scale.

   spindle()'s profile parameter runs t = 0 at the tail to t = 1 at the nose.
   Getting that backwards gives you a fish that swims arse-first, which reads
   surprisingly well until it turns. */

/* blade() builds a fin lying flat in the XZ plane, extending from the origin
   toward -Z with its thickness in Y. Two orientations follow from that, and
   getting them the wrong way round is how you end up with fish wearing their
   tails as hats:
     vertical fin (caudal, dorsal)  -> rotateZ(PI/2)   width becomes height
     horizontal fin (pectoral)      -> leave it alone
   Both still extend backwards along -Z, which is what a fin does. */
function verticalFin(opts) {
  const g = blade(opts);
  g.rotateZ(Math.PI / 2);
  return g;
}

/* A smooth parametric sheet, indexed so the normals come out smooth rather
   than faceted. `sample(u, v)` returns [x, y, z]; u runs nose to tail, v runs
   across. Rays are one continuous surface and look wrong built any other way. */
function sheet(uSteps, vSteps, sample, flip) {
  const stride = vSteps + 1;
  const pos = new Float32Array((uSteps + 1) * stride * 3);
  const index = [];
  for (let i = 0; i <= uSteps; i += 1) {
    for (let j = 0; j <= vSteps; j += 1) {
      const p = sample(i / uSteps, j / vSteps);
      const k = (i * stride + j) * 3;
      pos[k] = p[0];
      pos[k + 1] = p[1];
      pos[k + 2] = p[2];
    }
  }
  for (let i = 0; i < uSteps; i += 1) {
    for (let j = 0; j < vSteps; j += 1) {
      const a = i * stride + j;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      if (flip) index.push(a, d, b, a, c, d);
      else index.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function tetraBody(parts) {
  // A quick little wedge — the default, and the shape of half the shelf.
  parts.push(spindle({
    length: 0.68, radius: 0.12, rings: 14, segments: 9,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.8),
    flattenX: 0.6,
  }));
  const tail = verticalFin({ length: 0.26, width: 0.24, taper: 0.3, sweep: 0.1 });
  tail.translate(0, 0, -0.3);
  parts.push(tail);
  const dorsal = verticalFin({ length: 0.14, width: 0.13, taper: 0.3, sweep: 0.45 });
  dorsal.translate(0, 0.085, 0.02);
  parts.push(dorsal);
  for (const side of [-1, 1]) {
    const pec = blade({ length: 0.12, width: 0.05, taper: 0.3, sweep: 0.6, thickness: 0.005 });
    pec.rotateY(side * 0.6);
    pec.translate(side * 0.06, -0.02, 0.1);
    parts.push(pec);
  }
}

function guppyBody(parts) {
  parts.push(spindle({
    length: 0.68, radius: 0.13, rings: 14, segments: 9,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.72),
    flattenX: 0.72,
  }));
  const tail = verticalFin({ length: 0.34, width: 0.34, taper: 0.85, sweep: 0.12 });
  tail.translate(0, 0, -0.31);
  parts.push(tail);
  const dorsal = verticalFin({ length: 0.17, width: 0.15, taper: 0.3, sweep: 0.45 });
  dorsal.translate(0, 0.1, 0.04);
  parts.push(dorsal);
}

function angelBody(parts) {
  parts.push(spindle({
    length: 0.74, radius: 0.27, rings: 14, segments: 10,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.85),
    flattenX: 0.3,
  }));
  // The tall paired fins are the whole silhouette.
  const dorsal = verticalFin({ length: 0.4, width: 0.44, taper: 0.12, sweep: 0.6 });
  dorsal.translate(0, 0.22, 0.06);
  parts.push(dorsal);
  const ventral = verticalFin({ length: 0.36, width: 0.4, taper: 0.12, sweep: 0.6 });
  ventral.translate(0, -0.22, 0.04);
  parts.push(ventral);
  const tail = verticalFin({ length: 0.24, width: 0.26, taper: 0.45, sweep: 0.3 });
  tail.translate(0, 0, -0.33);
  parts.push(tail);
  for (const side of [-1, 1]) {
    const trail = blade({ length: 0.34, width: 0.03, taper: 0.2, sweep: 0.3, thickness: 0.005 });
    trail.rotateZ(Math.PI / 2);
    trail.translate(side * 0.03, -0.2, 0.14);
    parts.push(trail);
  }
}

function bettaBody(parts) {
  parts.push(spindle({
    length: 0.66, radius: 0.16, rings: 14, segments: 10,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.7),
    flattenX: 0.66,
  }));
  // Three veils: up, down, and the long one behind.
  const top = verticalFin({ length: 0.34, width: 0.3, taper: 0.6, sweep: 0.55, thickness: 0.007 });
  top.translate(0, 0.13, -0.1);
  parts.push(top);
  const bottom = verticalFin({ length: 0.32, width: 0.28, taper: 0.6, sweep: 0.55, thickness: 0.007 });
  bottom.translate(0, -0.13, -0.1);
  parts.push(bottom);
  const rear = verticalFin({ length: 0.42, width: 0.4, taper: 0.75, sweep: 0.4, thickness: 0.007 });
  rear.translate(0, 0, -0.3);
  parts.push(rear);
}

function catfishBody(parts) {
  parts.push(spindle({
    length: 1, radius: 0.14, rings: 16, segments: 10,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.52) * (1 - 0.35 * Math.max(0, t - 0.55)),
    flattenY: 0.74,
  }));
  const tail = verticalFin({ length: 0.26, width: 0.3, taper: 0.55, sweep: 0.25 });
  tail.translate(0, 0, -0.4);
  parts.push(tail);
  const dorsal = verticalFin({ length: 0.16, width: 0.14, taper: 0.3, sweep: 0.5 });
  dorsal.translate(0, 0.1, 0.12);
  parts.push(dorsal);
  // Pectorals stay flat — a bottom feeder holds itself off the sand with them.
  for (const side of [-1, 1]) {
    const pec = blade({ length: 0.2, width: 0.1, taper: 0.3, sweep: 0.7 });
    pec.rotateY(side * 0.7);
    pec.translate(side * 0.09, -0.04, 0.16);
    parts.push(pec);
  }
  // Barbels point forward, so they need turning right round.
  for (const side of [-1, 1]) {
    const whisker = blade({ length: 0.24, width: 0.026, taper: 0.25, sweep: 0.5, thickness: 0.005 });
    whisker.rotateY(Math.PI + side * 0.42);
    whisker.translate(side * 0.05, -0.035, 0.44);
    parts.push(whisker);
  }
}

function eelBody(parts) {
  parts.push(spindle({
    length: 1, radius: 0.07, rings: 22, segments: 8,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.35),
    flattenX: 0.78,
  }));
  // One ribbon fin running most of the back.
  const ridge = verticalFin({ length: 0.66, width: 0.09, taper: 0.7, sweep: 0.5, thickness: 0.006 });
  ridge.translate(0, 0.035, 0.2);
  parts.push(ridge);
  const belly = verticalFin({ length: 0.4, width: 0.06, taper: 0.7, sweep: 0.5, thickness: 0.006 });
  belly.translate(0, -0.03, 0.0);
  parts.push(belly);
}

/* A ray. One continuous wing, swept back at the tips, with a whip behind it.
   Built as two sheets that meet at a rim of zero thickness, so the top can be
   dark and the underside pale without a seam. */
function rayBody(parts) {
  const point = (u, v, side) => {
    const s = v * 2 - 1;
    const edge = 1 - Math.abs(s);
    const half = 0.66 * Math.sin(Math.PI * Math.pow(clamp01(u), 0.62));
    // The tips trail behind the nose; that sweep is most of what says "ray".
    const z = 0.46 - u * 0.92 - Math.abs(s) * 0.2;
    const thick = 0.082 * Math.sin(Math.PI * Math.pow(clamp01(u), 0.85)) * Math.pow(edge, 1.5);
    // A low skull ridge between the eyes, so the head is not just membrane.
    const skull = 0.05 * Math.exp(-Math.pow((u - 0.22) * 5.2, 2)) * Math.pow(edge, 3);
    return [s * half, side * (thick + skull), z];
  };
  parts.push(sheet(7, 9, (u, v) => point(u, v, 1), false));
  parts.push(sheet(7, 9, (u, v) => point(u, v, -1), true));

  const whip = [];
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4;
    whip.push(new THREE.Vector3(0, t * 0.03, -0.42 - t * 0.5));
  }
  parts.push(tube(whip, { radius: 0.024, taper: 0.15, segments: 5, radial: 4 }));
}

/* Something long and ribbon-like — an oarfish, more or less. Almost no width,
   a crest along the entire back, and streamers off the head that never quite
   catch up with the rest of it. */
function ribbonBody(parts) {
  parts.push(spindle({
    length: 1, radius: 0.09, rings: 26, segments: 7,
    profile: (t) => {
      const nose = Math.min(1, (1 - t) * 7);      // pinch only the last few percent
      const taper = 0.24 + 0.76 * Math.pow(t, 0.62);
      return Math.min(nose, taper);
    },
    flattenX: 0.28,
  }));
  const crest = verticalFin({ length: 0.92, width: 0.12, taper: 0.7, sweep: 0.08, thickness: 0.005 });
  crest.translate(0, 0.1, 0.46);
  parts.push(crest);
  const keel = verticalFin({ length: 0.5, width: 0.05, taper: 0.6, sweep: 0.3, thickness: 0.004 });
  keel.translate(0, -0.07, 0.1);
  parts.push(keel);
  // Head streamers. They are the reason anyone remembers seeing one.
  for (let i = 0; i < 3; i += 1) {
    const streamer = verticalFin({
      length: 0.3 + i * 0.09, width: 0.028, taper: 0.5, sweep: 0.25, thickness: 0.004,
    });
    streamer.rotateX(-0.5 + i * 0.12);
    streamer.translate((i - 1) * 0.012, 0.17 + i * 0.02, 0.42);
    parts.push(streamer);
  }
}

/* A jelly. The bell is a hemisphere with its apex forward; the shader squeezes
   it, so the geometry only has to be the resting shape. */
function jellyBody(parts) {
  parts.push(spindle({
    length: 0.5, radius: 0.3, rings: 9, segments: 10,
    // t = 0 is the open rim, t = 1 the apex: a hemisphere, flared at the skirt.
    profile: (t) => Math.sqrt(Math.max(0, 1 - t * t)) * (1 + 0.14 * Math.pow(1 - t, 3)),
  }));
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * TAU;
    const tentacle = blade({ length: 0.52, width: 0.03, taper: 0.15, sweep: 0.55, thickness: 0.004 });
    tentacle.rotateZ(a);
    tentacle.translate(Math.cos(a) * 0.27, Math.sin(a) * 0.27, -0.23);
    parts.push(tentacle);
  }
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * TAU + 0.4;
    const arm = blade({ length: 0.32, width: 0.08, taper: 0.35, sweep: 0.45, thickness: 0.005 });
    arm.rotateZ(a);
    arm.translate(Math.cos(a) * 0.1, Math.sin(a) * 0.1, -0.2);
    parts.push(arm);
  }
}

/* A grouper: deep-bodied, heavy in the shoulders, all mouth, in no hurry. */
function grouperBody(parts) {
  parts.push(spindle({
    length: 0.92, radius: 0.25, rings: 16, segments: 12,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.42) *
      (1 + 0.3 * Math.exp(-Math.pow((t - 0.66) * 3.0, 2))),
    flattenX: 0.74,
  }));
  const tail = verticalFin({ length: 0.24, width: 0.42, taper: 0.85, sweep: 0.22 });
  tail.translate(0, 0, -0.4);
  parts.push(tail);
  const dorsal = verticalFin({ length: 0.46, width: 0.2, taper: 0.55, sweep: 0.3 });
  dorsal.translate(0, 0.17, 0.2);
  parts.push(dorsal);
  const anal = verticalFin({ length: 0.2, width: 0.15, taper: 0.5, sweep: 0.4 });
  anal.translate(0, -0.16, -0.12);
  parts.push(anal);
  for (const side of [-1, 1]) {
    const pec = blade({ length: 0.23, width: 0.17, taper: 0.7, sweep: 0.5, thickness: 0.008 });
    pec.rotateZ(side * 0.5);
    pec.rotateY(side * 0.8);
    pec.translate(side * 0.14, -0.02, 0.13);
    parts.push(pec);
  }
  // The underslung jaw. Nothing else about the animal is this deliberate.
  const jaw = blade({ length: 0.16, width: 0.19, taper: 0.8, sweep: 0.5, thickness: 0.035 });
  jaw.rotateY(Math.PI);
  jaw.translate(0, -0.08, 0.3);
  parts.push(jaw);
}

/* A hatchetfish: a silver plate seen edge-on, with a keel it hangs from. */
function hatchetBody(parts) {
  parts.push(spindle({
    length: 0.5, radius: 0.24, rings: 12, segments: 9,
    profile: (t) => Math.pow(Math.sin(Math.PI * t), 0.6) * (0.5 + 0.5 * Math.min(1, t * 1.7)),
    flattenX: 0.17,
  }));
  const keel = verticalFin({ length: 0.3, width: 0.28, taper: 0.45, sweep: 0.55, thickness: 0.006 });
  keel.translate(0, -0.17, 0.2);
  parts.push(keel);
  const dorsal = verticalFin({ length: 0.13, width: 0.16, taper: 0.25, sweep: 0.5, thickness: 0.005 });
  dorsal.translate(0, 0.17, 0.0);
  parts.push(dorsal);
  const tail = verticalFin({ length: 0.2, width: 0.2, taper: 0.4, sweep: 0.2 });
  tail.translate(0, 0, -0.24);
  parts.push(tail);
  for (const side of [-1, 1]) {
    const pec = blade({ length: 0.17, width: 0.04, taper: 0.3, sweep: 0.5, thickness: 0.004 });
    pec.rotateZ(side * 1.1);
    pec.translate(side * 0.03, -0.05, 0.12);
    parts.push(pec);
  }
}

const BUILDERS = {
  tetra: tetraBody,
  guppy: guppyBody,
  angel: angelBody,
  betta: bettaBody,
  catfish: catfishBody,
  eel: eelBody,
  ray: rayBody,
  ribbon: ribbonBody,
  jelly: jellyBody,
  grouper: grouperBody,
  hatchet: hatchetBody,
};

function bodyForKind(kind) {
  const parts = [];
  const build = BUILDERS[kind] || BUILDERS.tetra;
  build(parts);
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/* Which body a species actually wears.

   ecology.js names a tank shape for every species so the glass tank upstairs
   and the porthole down here agree on what a word is. But the tank only knows
   six small freshwater silhouettes, and below the twilight none of them is
   what that band is actually full of. So past 240 m the same word grows into
   the shape the pressure would have given it. The rule is a pure function of
   traits the phrase already fixed, so a phrase is still a place. */
function planForSpecies(sp) {
  const named = String((sp && sp.kind) || "");
  // If ecology ever names a deep plan outright, take it at its word.
  if (DEEP_PLANS.indexOf(named) >= 0) return named;
  const base = FISH_KINDS.indexOf(named) >= 0 ? named : "tetra";
  if (!sp) return base;

  const band = zoneIndex(sp.zoneId);
  if (band < 2) return base;    // the tank shapes still hold in the light

  // Slow, bright and solitary is a jelly wherever you find it.
  if (sp.glow >= 0.55 && sp.speed <= 2.3 && sp.schooling <= 0.42) return "jelly";
  // Big and unhurried is a grouper, whatever the tank called it.
  if (sp.size >= 1.5 && sp.speed <= 3.2) return "grouper";
  if (base === "eel") return "ribbon";
  if (base === "catfish") return "ray";
  if (base === "angel") return "hatchet";
  return base;
}

/* ------------------------------------------------------------------ shader --
   Patched onto the per-species standard material with onBeforeCompile, which
   needs no addons. water.js patches the same materials afterwards and calls
   whatever was there first, so this has to be installed before register(). */

const FISH_VERTEX_COMMON = /* glsl */ `
  attribute vec4 aFish;      // shimmer, glow pulse, swim phase, panic
  varying vec4 vFish;
  varying vec3 vFishBody;
  uniform float uSwimLateral;
  uniform float uSwimFlap;
  uniform float uSwimPulse;
  uniform float uSwimWave;

  /* One displacement, three ways of using it: a fish beats its tail, a ray
     beats its wings, and a jelly beats the whole of itself. Species that do
     not do a given one carry a zero amplitude and pay only the arithmetic. */
  vec3 fishSwim(vec3 p, float phase) {
    vec3 d = vec3(0.0);
    float aft = clamp(0.5 - p.z, 0.0, 1.5);
    d.x += sin(phase - p.z * uSwimWave) * uSwimLateral * aft * aft;
    d.y += sin(phase - abs(p.x) * uSwimWave * 0.8) * uSwimFlap * abs(p.x) * 1.7;
    float bell = smoothstep(-0.30, 0.22, p.z);
    float squeeze = sin(phase) * uSwimPulse;
    d.x += p.x * squeeze * bell;
    d.y += p.y * squeeze * bell;
    d.z -= squeeze * 0.3 * bell;
    return d;
  }
`;

const FISH_FRAGMENT_COMMON = /* glsl */ `
  varying vec4 vFish;
  varying vec3 vFishBody;
  uniform vec3 uBackTint;
  uniform vec3 uBellyTint;
  uniform vec3 uRimColour;
  uniform float uRimStrength;
  uniform vec3 uGlowColour;
  uniform float uGlowGain;
  uniform vec3 uShimA;
  uniform vec3 uShimB;
  uniform float uLampRange;
  uniform float uLampOn;
  uniform float uShimPhase;
`;

export class FishManager {
  constructor(game) {
    this.game = game;
    this.all = [];
    this.shoals = [];
    this.group = new THREE.Group();
    this.group.name = "shoals";
    game.scene.add(this.group);

    this.rng = makeRng(game.seed, "shoals");
    this.time = 0;
    this.spawnTimer = 0;
    this.geometries = new Map();
    this.species = game.ecology.species;

    /* Uniforms every species shares. One object, assigned into each patched
       shader, so the lamps only have to be written once a frame. */
    this.shared = {
      uLampRange: { value: 34 },
      uLampOn: { value: 0.2 },
      uShimPhase: { value: 0 },
    };

    this.perSpecies = Math.max(24, Math.ceil(MAX_FISH / Math.max(1, this.species.length)) + 16);
    this.kits = this.species.map((sp) => this._buildKit(sp));
    this.meshes = this.kits.map((kit) => kit.mesh);
    this._counts = new Array(this.species.length).fill(0);

    this.glow = this._buildGlowLayer();

    // Deferred removal. capture() only flags; these are drained at the top of
    // update(), so a net taking nine fish at once cannot corrupt a live loop.
    this._graveyard = [];
    this._dirtyShoals = [];
    this._cargoWarned = false;
    this._forageBubble = 0;
  }

  /* ------------------------------------------------------------- building */

  _geometryFor(kind) {
    if (!this.geometries.has(kind)) this.geometries.set(kind, bodyForKind(kind));
    return this.geometries.get(kind);
  }

  /* Everything one species needs: its mesh, its material, its per-instance
     buffer, and the handful of numbers that decide how it looks and moves. */
  _buildKit(sp) {
    const plan = planForSpecies(sp);
    const swim = SWIM[plan] || SWIM.tetra;
    const rng = makeRng(this.game.seed, "fish-look", sp.seed, sp.index);
    const glow = clamp01(sp.glow);

    // Cloned so the per-instance attribute below belongs to this species only.
    const geometry = this._geometryFor(plan).clone();
    const aux = new THREE.InstancedBufferAttribute(new Float32Array(this.perSpecies * 4), 4);
    aux.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aFish", aux);

    /* The instance colour carries the fish's own body colour, so the material
       stays white and the countershading below is a pure multiplier. That is
       what lets one material serve a mutant and its plain cousin. */
    const base = new THREE.Color(sp.colorHex);
    const belly = new THREE.Color(sp.bellyHex);
    const ratio = (b, c) => clamp(c / Math.max(0.02, b), 0.3, 3.0);
    const bellyTint = new THREE.Color(
      ratio(base.r, belly.r) * 1.12,
      ratio(base.g, belly.g) * 1.12,
      ratio(base.b, belly.b) * 1.14,
    );
    // Backs go dark and slightly blue: it is the one colour the water leaves.
    const dark = lerp(0.56, 0.34, zoneIndex(sp.zoneId) / Math.max(1, ZONES.length - 1));
    const backTint = new THREE.Color(dark * 0.9, dark * 0.98, dark * 1.14);

    const rimColour = new THREE.Color(0xcfe8ff).lerp(new THREE.Color(sp.glowHex), glow * 0.8);
    const shimA = new THREE.Color(hslHex((sp.hue + 52) % 360, 88, 63));
    const shimB = new THREE.Color(hslHex((sp.hue + 208) % 360, 92, 57));

    const uniforms = {
      uBackTint: { value: backTint },
      uBellyTint: { value: bellyTint },
      uRimColour: { value: rimColour },
      uRimStrength: { value: 0.42 + glow * 0.55 },
      uGlowColour: { value: new THREE.Color(sp.glowHex) },
      uGlowGain: { value: lerp(0.15, 2.3, glow) },
      uShimA: { value: shimA },
      uShimB: { value: shimB },
      uSwimLateral: { value: swim.lateral },
      uSwimFlap: { value: swim.flap },
      uSwimPulse: { value: swim.pulse },
      uSwimWave: { value: swim.wave },
      uLampRange: this.shared.uLampRange,
      uLampOn: this.shared.uLampOn,
      uShimPhase: this.shared.uShimPhase,
    };

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.44,
      metalness: 0.12,
      emissive: sp.glowHex,
      // Deep species carry their own light; shelf species only borrow yours.
      emissiveIntensity: lerp(0.02, 0.34, glow),
      side: THREE.DoubleSide,
    });
    this._paint(material, uniforms);

    const mesh = new THREE.InstancedMesh(geometry, material, this.perSpecies);
    mesh.count = 0;
    mesh.frustumCulled = false;   // instances roam; the bounding sphere lies
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `shoal-${sp.name}`;
    // Seed instanceColor so setColorAt has somewhere to write later.
    _colour.setHex(sp.colorHex);
    for (let i = 0; i < this.perSpecies; i += 1) mesh.setColorAt(i, _colour);
    if (mesh.instanceColor) {
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor.needsUpdate = true;
    }
    this.group.add(mesh);

    /* Who this species is, behaviourally. Every number is a pure function of
       traits the phrase already fixed, so the same sea comes back every time. */
    const forager = FLOOR_PLANS.indexOf(plan) >= 0 || sp.appetite >= 3;
    return {
      species: sp,
      plan,
      swim,
      mesh,
      material,
      aux,
      uniforms,
      geometry,
      forager,
      // A bright animal that is also curious answers a floodlight; everything
      // else that has never seen one goes dark and hopes.
      lampFlare: (sp.curiosity + (sp.seed % 3)) >= 6,
      pulseRate: 0.55 + rng.random() * 1.5,
      pulseBase: 0.18 + glow * 0.34,
      pulseDepth: 0.2 + glow * 0.55,
      glow,
      // How far below the shoal's band a forager will go to work the floor.
      floorHug: forager ? FLOOR_CLEARANCE * 0.95 : FLOOR_CLEARANCE * 2,
    };
  }

  /* Install the fish shader, then hand the material to water.js so the water
     wraps it rather than the other way round. */
  _paint(material, uniforms) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${FISH_VERTEX_COMMON}`)
        .replace(
          "#include <beginnormal_vertex>",
          `#include <beginnormal_vertex>
          float fishLen = length(objectNormal);
          vFishBody = fishLen > 0.0001 ? objectNormal / fishLen : vec3(0.0, 1.0, 0.0);
          // The wave slides the body sideways as a function of z, so the normal
          // leans by the slope of that. One term is honest enough at this size.
          float fishSlope = cos(aFish.z - position.z * uSwimWave) * uSwimLateral * uSwimWave
            * clamp(0.5 - position.z, 0.0, 1.5);
          objectNormal.z -= fishSlope * objectNormal.x;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          transformed += fishSwim(transformed, aFish.z);
          vFish = aFish;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${FISH_FRAGMENT_COMMON}`)
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          /* Countershading is pigment, not lighting. It is read off the body's
             own normal so it stays put when the fish rolls, which is the whole
             point: dark from above, pale from below, gone from both. */
          float fishVentral = 1.0 - smoothstep(-0.55, 0.32, vFishBody.y);
          diffuseColor.rgb *= mix(uBackTint, uBellyTint, fishVentral);`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          `#include <emissivemap_fragment>
          vec3 fishEye = normalize(vViewPosition);
          float fishRim = pow(1.0 - clamp(dot(normal, fishEye), 0.0, 1.0), 3.0);

          /* The lamps ride on the boat and the camera rides in the boat, so the
             range to the eye is the range to the light — no second varying is
             needed for the falloff. This is what catches a fish at the edge of
             the beam, where the diffuse term has already given up. */
          float fishLamp = 1.0 - smoothstep(uLampRange * 0.3, uLampRange, length(vViewPosition));
          totalEmissiveRadiance += uRimColour * (fishRim * uRimStrength * fishLamp * uLampOn);

          // Bioluminescence, pulsed on the CPU so it can answer your lamps.
          totalEmissiveRadiance += uGlowColour * (vFish.y * uGlowGain);

          if (vFish.x > 0.002) {
            /* A mutant is iridescent, not merely repainted: the band walks
               across the flank as the angle changes. You should be able to
               pick one out of a shoal before the manifest prices it. */
            float fishBand = fract(fishRim * 1.7 + vFishBody.y * 0.28 + uShimPhase);
            vec3 fishIrid = mix(uShimA, uShimB, abs(fishBand * 2.0 - 1.0));
            totalEmissiveRadiance += fishIrid * vFish.x * (0.12 + fishRim * 1.3);
            diffuseColor.rgb = mix(
              diffuseColor.rgb,
              diffuseColor.rgb * (0.55 + fishIrid * 1.5),
              vFish.x * 0.5
            );
          }`,
        );
    };

    if (this.game.water) this.game.water.register(material);
    // register() stamps water's own cache key; ours is a strictly different
    // program, so say so or three may hand a coral's shader to a fish.
    material.customProgramCacheKey = () => FISH_CACHE_KEY;
    material.needsUpdate = true;
    return material;
  }

  /* One additive sprite per glowing fish, so a lantern species reads as a
     smear of light long before its body resolves out of the fog. */
  _buildGlowLayer() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_FISH * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_FISH * 3), 3));
    geometry.setDrawRange(0, 0);
    /* Points are squares unless they are given a shape. A soft round dot, or
       a lantern fish under bloom reads as a glowing tile. */
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.45)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    this.glowMap = new THREE.CanvasTexture(canvas);
    const material = new THREE.PointsMaterial({
      map: this.glowMap,
      size: 1.6,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.name = "shoal-glow";
    this.group.add(points);
    return points;
  }

  /* --------------------------------------------------------------- spawning */

  _targetCount() {
    const depth = this.game.sub ? this.game.sub.depth : 0;
    const zone = zoneForDepth(depth);
    // Life thins out as you descend; it is also worth more down there.
    const thin = 1 - 0.5 * (zoneIndex(zone.id) / Math.max(1, ZONES.length - 1));
    return Math.floor(MAX_FISH * thin);
  }

  /* Which species could plausibly be at this depth: the band's residents, plus
     a little bleed from the neighbouring bands so boundaries are not walls. */
  _candidates(zone) {
    const home = this.game.ecology.speciesInZone(zone.id);
    if (this.rng.random() < 0.22) {
      const drift = zoneIndex(zone.id) + (this.rng.random() < 0.5 ? -1 : 1);
      const neighbour = ZONES[clamp(drift, 0, ZONES.length - 1)];
      const list = this.game.ecology.speciesInZone(neighbour.id);
      if (list && list.length) return list;
    }
    return home;
  }

  _spawnShoal() {
    const sub = this.game.sub;
    if (!sub) return;
    const zone = zoneForDepth(sub.depth);
    const pool = this._candidates(zone);
    if (!pool || !pool.length) return;

    const sp = pool[this.rng.randrange(pool.length)];
    const kit = this.kits[sp.index];
    if (!kit) return;
    const rng = this.rng;

    // A ring around the player, at a bearing we are not currently looking at
    // hard, so shoals do not materialise in the middle of the viewport.
    const angle = rng.random() * TAU;
    const radius = lerp(SPAWN_MIN, SPAWN_MAX, rng.random());
    const cx = sub.position.x + Math.cos(angle) * radius;
    const cz = sub.position.z + Math.sin(angle) * radius;

    // Sit the shoal inside its own band, but never inside the seabed.
    const floor = this.game.world.heightAt(cx, cz);
    const bandTop = -Math.max(2, zone.top + 4);
    const bandBottom = -Math.max(6, zone.bottom - 4);
    let cy = lerp(bandTop, bandBottom, rng.random());
    cy = clamp(cy, floor + FLOOR_CLEARANCE + 2, -2);
    if (cy <= floor + FLOOR_CLEARANCE) return;

    const size = Math.round(lerp(SHOAL_MIN, SHOAL_MAX, Math.pow(rng.random(), 1 - sp.schooling * 0.6)));
    const room = Math.min(size, this.perSpecies - this._countSpecies(sp.index), MAX_FISH - this.all.length);
    if (room < 1) return;

    const shoal = {
      species: sp,
      kit,
      centre: new THREE.Vector3(cx, cy, cz),
      target: new THREE.Vector3(cx, cy, cz),
      aim: new THREE.Vector3(cx, cy, cz),
      fish: [],
      phase: rng.random() * TAU,
      wanderTimer: 0,
      // Mood is the whole of the behaviour: cruise, forage, or shelter.
      mood: "cruise",
      moodTimer: rng.random() * 6,
      scanTimer: rng.random() * THREAT_SCAN,
      threat: null,
      threatRange: 1,
      alarm: 0,
      // Slow vertical migration. A band of water is not a shelf; everything in
      // it rises and sinks over minutes, and you learn the rhythm or you miss
      // the shoal you came down for.
      driftPhase: rng.random() * TAU,
      driftRate: 0.012 + rng.random() * 0.035,
      driftAmp: 6 + rng.random() * 22,
      floorWant: kit.floorHug,
      __dirty: false,
    };

    const spread = lerp(1.4, 5.5, 1 - sp.schooling) + size * 0.12;
    for (let i = 0; i < room; i += 1) {
      const individual = this.game.ecology.rollIndividual(sp, rng);
      /* The mutation premium has to be legible through the window, so it is
         carried as a shimmer amount rather than a tint: the shader turns it
         into a band that slides across the flank as you circle the fish. */
      const shimmer = clamp01(
        individual.mutations * 0.2 +
        (individual.rarity === "mythic" ? 0.34 : individual.rarity === "rare" ? 0.16 : 0),
      ) * 0.92;
      const fish = {
        id: nextFishId++,
        species: sp,
        position: new THREE.Vector3(
          cx + (rng.random() - 0.5) * spread * 2,
          clamp(cy + (rng.random() - 0.5) * spread, floor + FLOOR_CLEARANCE, -1),
          cz + (rng.random() - 0.5) * spread * 2,
        ),
        velocity: new THREE.Vector3(
          (rng.random() - 0.5) * sp.speed,
          (rng.random() - 0.5) * 0.4,
          (rng.random() - 0.5) * sp.speed,
        ),
        heading: rng.random() * TAU,
        scale: individual.scale * sp.size,
        genome: individual.genome,
        generation: individual.generation,
        mutations: individual.mutations,
        traits: individual.traits,
        value: individual.value,
        rarity: individual.rarity,
        alive: true,
        capturing: 0,
        shoal,
        beat: rng.random() * TAU,
        bank: 0,
        panic: 0,
        shimmer,
        pulse: kit.pulseBase,
        lamp: 0,
        // No two fish in a shoal are quite the same colour; it is what keeps a
        // hundred instances of one mesh from reading as wallpaper.
        tint: new THREE.Color(sp.colorHex).offsetHSL(
          (rng.random() - 0.5) * 0.02,
          (rng.random() - 0.5) * 0.09,
          (rng.random() - 0.5) * 0.11,
        ),
        __dead: false,
      };
      shoal.fish.push(fish);
      this.all.push(fish);
    }

    if (shoal.fish.length) this.shoals.push(shoal);
  }

  _countSpecies(index) {
    let n = 0;
    for (const f of this.all) if (f.alive && f.species.index === index) n += 1;
    return n;
  }

  _despawn() {
    const sub = this.game.sub;
    if (!sub) return;
    const limit = DESPAWN * DESPAWN;
    for (let i = this.shoals.length - 1; i >= 0; i -= 1) {
      const shoal = this.shoals[i];
      if (!shoal.fish.length) {
        this.shoals.splice(i, 1);
        continue;
      }
      if (shoal.centre.distanceToSquared(sub.position) < limit) continue;
      for (const fish of shoal.fish) {
        fish.alive = false;
        fish.__dead = true;
      }
      shoal.fish.length = 0;
      this._compactAll();
      this.shoals.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------- removal --
     Deferred, because the net lands several fish inside one frame and whoever
     called us may be halfway through iterating one of these lists. */

  _remove(fish) {
    if (!fish || fish.__dead) return;
    fish.__dead = true;
    fish.alive = false;
    fish.capturing = 0;
    this._graveyard.push(fish);
    const shoal = fish.shoal;
    if (shoal && !shoal.__dirty) {
      shoal.__dirty = true;
      this._dirtyShoals.push(shoal);
    }
  }

  _compactAll() {
    let write = 0;
    for (let i = 0; i < this.all.length; i += 1) {
      const f = this.all[i];
      if (f.__dead) continue;
      this.all[write] = f;
      write += 1;
    }
    this.all.length = write;
  }

  _flushRemovals() {
    if (!this._graveyard.length) return;
    this._compactAll();
    for (const shoal of this._dirtyShoals) {
      shoal.__dirty = false;
      const list = shoal.fish;
      let write = 0;
      for (let i = 0; i < list.length; i += 1) {
        const f = list[i];
        if (f.__dead) continue;
        list[write] = f;
        write += 1;
      }
      list.length = write;
      if (shoal.fish.length) continue;
      const at = this.shoals.indexOf(shoal);
      if (at >= 0) this.shoals.splice(at, 1);
    }
    this._dirtyShoals.length = 0;
    for (const f of this._graveyard) f.shoal = null;
    this._graveyard.length = 0;
  }

  /* ------------------------------------------------------------ behaviour */

  update(dt) {
    this._flushRemovals();
    this._cargoWarned = false;
    this.time += dt;
    const sub = this.game.sub;
    if (!sub) return;

    // The lamps, written once for every species that borrows them.
    const range = Math.max(8, (this.game.stats && this.game.stats.lightRange) || 34);
    this.shared.uLampRange.value = damp(this.shared.uLampRange.value, range, 4, dt);
    this.shared.uLampOn.value = damp(
      this.shared.uLampOn.value, sub.lightsOn ? 1 : 0.16, 5, dt,
    );
    this.shared.uShimPhase.value = (this.time * 0.055) % 1;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      this._despawn();
      if (this.all.length < this._targetCount() && this.shoals.length < MAX_SHOALS) {
        this._spawnShoal();
      }
    }

    this._forageBubble -= dt;
    for (const shoal of this.shoals) this._updateShoal(shoal, dt, sub);
    this._writeInstances(sub);
  }

  /* What is hunting near this shoal. Bounded twice over: creatures are a
     handful at most, and each shoal only looks a few times a second. */
  _scanThreat(shoal) {
    const creatures = this.game.creatures && this.game.creatures.all;
    shoal.threat = null;
    if (!creatures || !creatures.length) return;

    let bestD2 = Infinity;
    let best = null;
    let bestRange = 1;
    for (const c of creatures) {
      if (!c || !c.alive || !c.position) continue;
      const type = c.type || {};
      /* A patrolling animal is scenery. One that is hunting is a fact about
         the water, and a shoal knows it a long way off. */
      const hunting = c.state === "hunt" || c.state === "attack";
      const notice = hunting
        ? Math.max(34, (type.aggro || 60) * 0.55)
        : (c.radius || 2) * 5 + 12;
      const d2 = c.position.distanceToSquared(shoal.centre);
      if (d2 > notice * notice || d2 >= bestD2) continue;
      bestD2 = d2;
      best = c;
      bestRange = notice;
    }
    if (!best) return;
    shoal.threat = best;
    shoal.threatRange = bestRange;

    /* Break for open water, across the predator's line rather than straight
       down it — a shoal that runs in a straight line is a queue. */
    _v4.copy(shoal.centre).sub(best.position);
    _v4.y *= 0.35;
    if (_v4.lengthSq() < 0.001) _v4.set(1, 0.2, 0);
    _v4.normalize();
    _v5.crossVectors(_up, _v4).normalize();
    shoal.target.copy(shoal.centre)
      .addScaledVector(_v4, 34)
      .addScaledVector(_v5, (shoal.phase > Math.PI ? 1 : -1) * 18);
    shoal.moodTimer = Math.max(shoal.moodTimer, 3);
  }

  /* Pick what the shoal is doing with itself for the next stretch of minutes.
     Foragers work the floor, the nervous keep to cover, everything else wanders
     the middle of its band. */
  _pickMood(shoal, sub) {
    const sp = shoal.species;
    const kit = shoal.kit;
    const rng = this.rng;
    const roll = rng.random();
    const feedChance = kit.forager ? 0.5 : 0.16;
    const hideChance = feedChance + 0.14 + sp.skittish * 0.34;

    if (roll < feedChance) {
      shoal.mood = "forage";
      shoal.moodTimer = 12 + rng.random() * 16;
      shoal.floorWant = kit.floorHug;
      const a = rng.random() * TAU;
      const reach = 6 + rng.random() * 18;
      const x = shoal.centre.x + Math.cos(a) * reach;
      const z = shoal.centre.z + Math.sin(a) * reach;
      shoal.target.set(x, this.game.world.heightAt(x, z) + kit.floorHug + 1.2, z);
      return;
    }

    if (roll < hideChance) {
      shoal.mood = "shelter";
      shoal.moodTimer = 9 + rng.random() * 14;
      shoal.floorWant = FLOOR_CLEARANCE * 1.4;
      this._findShelter(shoal);
      return;
    }

    shoal.mood = "cruise";
    shoal.moodTimer = 10 + rng.random() * 18;
    shoal.floorWant = FLOOR_CLEARANCE * 2;
    const a = rng.random() * TAU;
    const reach = 10 + rng.random() * 26;
    shoal.target.set(
      shoal.centre.x + Math.cos(a) * reach,
      shoal.centre.y + (rng.random() - 0.5) * 12,
      shoal.centre.z + Math.sin(a) * reach,
    );
    if (sub) shoal.target.y = Math.min(shoal.target.y, -2);
  }

  /* Structure, approximated from the terrain itself. There is no prop index to
     ask, but the heightfield already knows where the ridges and the outcrops
     are, and a fish sheltering against the lee of a ridge looks exactly like a
     fish sheltering against a rock. Seven samples, a few times a minute. */
  _findShelter(shoal) {
    const world = this.game.world;
    const cx = shoal.centre.x;
    const cz = shoal.centre.z;
    let bestX = cx;
    let bestZ = cz;
    let bestH = world.heightAt(cx, cz);
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * TAU + shoal.phase;
      const r = 14 + (i % 3) * 9;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const h = world.heightAt(x, z);
      if (h <= bestH) continue;
      bestH = h;
      bestX = x;
      bestZ = z;
    }
    // Just off the high ground, not on top of it: the lee, not the summit.
    shoal.target.set(
      lerp(cx, bestX, 0.8),
      bestH + FLOOR_CLEARANCE * 1.4 + 1.6,
      lerp(cz, bestZ, 0.8),
    );
  }

  _updateShoal(shoal, dt, sub) {
    const sp = shoal.species;
    const kit = shoal.kit;
    const list = shoal.fish;
    if (!list.length || !kit) return;

    // Centroid and mean heading, computed once and shared by the whole shoal.
    _v.set(0, 0, 0);
    _v2.set(0, 0, 0);
    let live = 0;
    for (const f of list) {
      if (!f.alive) continue;
      _v.add(f.position);
      _v2.add(f.velocity);
      live += 1;
    }
    if (!live) return;
    shoal.centre.copy(_v).divideScalar(live);
    _v2.divideScalar(live);

    /* Predators, a few times a second per shoal. This is the one thing in the
       sea the player can read at a distance: when the shoals ball up and go,
       something is already hunting and it is not far away. */
    shoal.scanTimer -= dt;
    if (shoal.scanTimer <= 0) {
      shoal.scanTimer = THREAT_SCAN + this.rng.random() * 0.2;
      this._scanThreat(shoal);
    }
    const threat = shoal.threat && shoal.threat.alive ? shoal.threat : null;
    if (!threat) shoal.threat = null;
    let alarmTarget = 0;
    if (threat) {
      const d = threat.position.distanceTo(shoal.centre);
      alarmTarget = clamp01(1 - d / Math.max(6, shoal.threatRange));
    }
    // Fear arrives faster than it leaves. That asymmetry is most of the read.
    shoal.alarm = damp(shoal.alarm, alarmTarget, alarmTarget > shoal.alarm ? 6 : 0.9, dt);
    const alarm = shoal.alarm;

    shoal.moodTimer -= dt;
    if (shoal.moodTimer <= 0) this._pickMood(shoal, sub);

    // The shoal itself wanders inside its mood, so a school drifts as a body
    // rather than hovering around one point forever.
    shoal.wanderTimer -= dt;
    if (shoal.wanderTimer <= 0) {
      shoal.wanderTimer = 4 + this.rng.random() * 7;
      if (shoal.mood === "forage") {
        const a = this.rng.random() * TAU;
        const reach = 5 + this.rng.random() * 13;
        const x = shoal.centre.x + Math.cos(a) * reach;
        const z = shoal.centre.z + Math.sin(a) * reach;
        shoal.target.set(x, this.game.world.heightAt(x, z) + shoal.floorWant + 1.1, z);
      } else if (shoal.mood === "cruise" && alarm < 0.2) {
        const a = this.rng.random() * TAU;
        const reach = 8 + this.rng.random() * 22;
        shoal.target.set(
          shoal.centre.x + Math.cos(a) * reach,
          shoal.centre.y + (this.rng.random() - 0.5) * 9,
          shoal.centre.z + Math.sin(a) * reach,
        );
      }
    }

    /* The whole band breathes: everything in it rises and sinks over minutes.
       Foragers opt out — their target is already pinned to the floor. */
    shoal.aim.copy(shoal.target);
    if (shoal.mood !== "forage") {
      shoal.aim.y += Math.sin(this.time * shoal.driftRate * TAU + shoal.driftPhase) * shoal.driftAmp;
      shoal.aim.y = Math.min(shoal.aim.y, -2);
    }

    const world = this.game.world;
    /* Fear has to stay inside the beam's reach or the game is unfishable: the
       stock capture beam is 14 m, so a skittish fish must only bolt at about
       that, and creeping up with the lamps off must actually work. */
    const lit = sub.lightsOn ? 1.35 : 1;
    const rush = 1 + Math.min(1.1, sub.speed * 0.045);
    const fearRange = lerp(5.5, 15, sp.skittish) * lit * rush;
    const fear2 = fearRange * fearRange;
    // Alarm is what turns a loose school into a bait ball: pull hard to the
    // centre, stop minding your neighbours, and start to spin.
    const cohesion = (0.45 + sp.schooling * 1.5) * (1 + alarm * 3.4);
    const alignment = (0.25 + sp.schooling * 1.1) * (1 + alarm * 1.2);
    const separation = 2.6 * (1 - alarm * 0.55);
    const swirl = alarm * (2.2 + sp.schooling * 2.6);
    const cruise = sp.speed * (1 + alarm * 0.55);
    const lampRange = Math.max(6, (this.game.stats && this.game.stats.lightRange) || 34);
    const lampOn = sub.lightsOn;
    const forage = shoal.mood === "forage";

    world.sampleFlow(shoal.centre, this.time, _flow);

    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      if (!f.alive) continue;
      _v3.set(0, 0, 0);

      // Cohesion toward the shoal, and the shoal toward its wander target.
      _v.copy(shoal.centre).sub(f.position);
      const spread = _v.length();
      if (spread > 0.001) {
        _v.divideScalar(spread);
        _v3.addScaledVector(_v, cohesion * clamp01(spread / 6));
        // Bait ball: a tangential push around the centre, which is what makes
        // the thing revolve instead of merely clumping.
        if (swirl > 0.05) {
          _v5.crossVectors(_up, _v);
          const tl = _v5.length();
          if (tl > 0.001) _v3.addScaledVector(_v5.divideScalar(tl), -swirl);
        }
      }
      _v.copy(shoal.aim).sub(f.position);
      if (_v.lengthSq() > 0.001) _v3.addScaledVector(_v.normalize(), forage ? 0.85 : 0.55);

      // Alignment with the mean heading.
      _v3.addScaledVector(_v2, alignment * 0.12);

      // Separation — only against a handful of neighbours, striding the list
      // so every fish still eventually checks every other one.
      let checked = 0;
      for (let j = (i + 1) % list.length; checked < NEIGHBOUR_CAP && j !== i; j = (j + 1) % list.length) {
        checked += 1;
        const other = list[j];
        if (!other.alive) continue;
        _v.copy(f.position).sub(other.position);
        const d2 = _v.lengthSq();
        const want = 0.9 + f.scale * 0.8;
        if (d2 > 0.0001 && d2 < want * want) {
          _v3.addScaledVector(_v.normalize(), separation * (1 - Math.sqrt(d2) / want));
        }
      }

      // The predator itself, up close. This is a bolt, not a drift.
      if (threat && alarm > 0.08) {
        _v.copy(f.position).sub(threat.position);
        const d = _v.length() || 0.001;
        if (d < shoal.threatRange) {
          _v3.addScaledVector(_v.divideScalar(d), alarm * (3 + (1 - d / shoal.threatRange) * 9));
        }
        f.panic = Math.max(f.panic, alarm);
      }

      // The sub. Lights and speed both make you worse to be near.
      _v.copy(f.position).sub(sub.position);
      const subD2 = _v.lengthSq();
      if (subD2 < fear2) {
        const d = Math.sqrt(subD2) || 0.001;
        const push = (1 - d / fearRange) * (2.4 + sp.skittish * 5 + sub.speed * 0.22);
        _v3.addScaledVector(_v.divideScalar(d), push);
        f.panic = Math.max(f.panic, clamp01(1 - d / fearRange));
      }
      // How much of your lamp is actually landing on this fish. The glowing
      // species answer it; everything else just gets a rim.
      f.lamp = lampOn && subD2 < lampRange * lampRange
        ? clamp01(1 - Math.sqrt(subD2) / lampRange)
        : 0;

      // A fish being netted stops fighting the beam and is drawn in.
      if (f.capturing > 0) {
        _v.copy(sub.position).sub(f.position);
        const d = _v.length() || 0.001;
        _v3.addScaledVector(_v.divideScalar(d), f.capturing * 6);
      }
      f.panic = Math.max(0, f.panic - dt * 0.7);

      // Never swim into the floor, and never break the surface. Foragers are
      // allowed much closer to the silt — that is where the food is.
      const floor = world.heightAt(f.position.x, f.position.z);
      const clearance = f.position.y - floor;
      const want = shoal.floorWant;
      if (clearance < want) {
        _v3.y += (want - clearance) * 1.8;
      } else if (forage && clearance > want + 2.4) {
        // Nose down. A feeding shoal hangs over the floor, not above it.
        _v3.y -= Math.min(2.2, (clearance - want - 2.4) * 0.55);
      }
      if (f.position.y > -1.2) _v3.y -= (f.position.y + 1.2) * 2.2;

      // Drift with the current, plus a private wander so no two fish in a
      // shoal ever trace quite the same line.
      f.beat += dt * (kit.swim.rate + cruise * 0.55 + f.panic * 5);
      _v3.x += Math.sin(f.beat * 0.7 + f.id) * 0.35;
      _v3.y += Math.sin(f.beat * 0.43 + f.id * 1.7) * 0.28;
      _v3.z += Math.cos(f.beat * 0.61 + f.id) * 0.35;
      _v3.add(_flow);

      // Integrate, then clamp to the species' comfortable speed (panic lets
      // it briefly exceed that — a bolting fish is the one that gets away).
      f.velocity.addScaledVector(_v3, dt * 2.6);
      const top = cruise * (1 + f.panic * 1.6);
      const speed = f.velocity.length();
      if (speed > top) f.velocity.multiplyScalar(top / speed);
      f.velocity.multiplyScalar(1 - Math.min(0.92, dt * 1.1));
      f.position.addScaledVector(f.velocity, dt);

      // Hard floor, in case a violent frame pushed it through.
      const hardFloor = floor + FLOOR_CLEARANCE * 0.5;
      if (f.position.y < hardFloor) {
        f.position.y = hardFloor;
        if (f.velocity.y < 0) f.velocity.y = 0;
      }

      // Bank into the turn: the roll is what makes a fish look alive.
      const turn = _v3.x * f.velocity.z - _v3.z * f.velocity.x;
      f.bank = damp(f.bank, clamp(turn * 0.02, -0.6, 0.6), 4, dt);

      /* Bioluminescence. A slow private rhythm, lifted or doused by your lamps
         depending on whether the animal has any reason to answer one, and
         flashed outright by fright — the deep's burglar alarm, which is meant
         to call something bigger down on whatever is chasing it. */
      if (kit.glow > 0.04) {
        let pulse = kit.pulseBase + kit.pulseDepth *
          (0.5 + 0.5 * Math.sin(this.time * kit.pulseRate + f.beat * 0.21 + f.id));
        if (f.lamp > 0) {
          pulse *= kit.lampFlare ? 1 + f.lamp * 1.5 : 1 - f.lamp * 0.78;
        }
        if (f.panic > 0.2) pulse = Math.max(pulse, f.panic * 1.35);
        if (f.capturing > 0) pulse = Math.max(pulse, 0.4 + f.capturing * 1.1);
        f.pulse = damp(f.pulse, pulse, 9, dt);
      } else {
        f.pulse = f.capturing > 0 ? f.capturing * 0.5 : 0;
      }
    }

    /* A little silt where a shoal is working the floor. Rate-limited across
       the whole sea, not per shoal, so a busy seabed still costs one puff. */
    if (forage && this._forageBubble <= 0 && this.game.vfx && live > 2) {
      const near = shoal.centre.distanceToSquared(sub.position) < 90 * 90;
      if (near) {
        this._forageBubble = 0.55;
        const f = list[(Math.random() * list.length) | 0];
        if (f && f.alive) {
          this.game.vfx.bubbles(f.position, 2, { spread: 0.5, rise: 0.35, size: 0.12, life: 1.6 });
        }
      }
    }
  }

  /* Rebuild the instance matrices. Every fish moves every frame, so there is
     nothing to be gained from tracking dirty ranges. */
  _writeInstances(sub) {
    const counts = this._counts;
    counts.fill(0);

    const glowPos = this.glow.geometry.attributes.position;
    const glowCol = this.glow.geometry.attributes.color;
    let glowCount = 0;

    for (const f of this.all) {
      if (!f.alive) continue;
      const index = f.species.index;
      const kit = this.kits[index];
      if (!kit) continue;
      const slot = counts[index];
      if (slot >= this.perSpecies) continue;
      counts[index] = slot + 1;

      // Face the direction of travel and roll into the turn. The tail beat is
      // the shader's problem now, so the body no longer yaws to fake it.
      const speed = f.velocity.length();
      if (speed > 0.02) {
        _v.copy(f.velocity).divideScalar(speed);
        _q.setFromUnitVectors(_forward, _v);
      } else {
        _q.identity();
      }
      _q2.setFromAxisAngle(_forward, f.bank);
      _q.multiply(_q2);

      const s = f.scale * (1 + f.capturing * 0.12);
      _scale.set(s, s, s);
      _m.compose(f.position, _q, _scale);
      kit.mesh.setMatrixAt(slot, _m);

      _colour.copy(f.tint);
      // A fish in the beam goes to white, which is the only tell that the
      // capture has actually taken hold of that one and not its neighbour.
      if (f.capturing > 0) _colour.lerp(_pale, f.capturing * 0.6);
      kit.mesh.setColorAt(slot, _colour);

      const aux = kit.aux.array;
      const k = slot * 4;
      aux[k] = f.shimmer;
      aux[k + 1] = f.pulse;
      aux[k + 2] = f.beat;
      aux[k + 3] = f.panic;

      if (kit.glow > 0.25 && f.pulse > 0.02 && glowCount < MAX_FISH) {
        glowPos.setXYZ(glowCount, f.position.x, f.position.y, f.position.z);
        _colour.setHex(f.species.glowHex)
          .multiplyScalar(clamp(0.2 + f.pulse * kit.glow * 0.95, 0, 1.6));
        glowCol.setXYZ(glowCount, _colour.r, _colour.g, _colour.b);
        glowCount += 1;
      }
    }

    for (let i = 0; i < this.kits.length; i += 1) {
      const kit = this.kits[i];
      const mesh = kit.mesh;
      mesh.count = counts[i];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      kit.aux.needsUpdate = true;
    }

    this.glow.geometry.setDrawRange(0, glowCount);
    glowPos.needsUpdate = true;
    glowCol.needsUpdate = true;
    if (sub && this.glow.material) {
      // Glows read as smears near the boat and as pinpricks far off; sizing
      // them with the lamp range keeps that honest as the lights improve.
      this.glow.material.size = 1.1 + clamp01(sub.depth / 900) * 0.9;
    }
  }

  /* ---------------------------------------------------------- the fishing */

  /* The best fish in the camera's forward cone — best meaning nearest to the
     centre of the crosshair, not merely nearest to the boat. */
  beamTarget(range, coneCos) {
    const camera = this.game.camera;
    if (!camera) return null;
    camera.getWorldPosition(_eye);
    camera.getWorldDirection(_dir);
    const max2 = range * range;
    let best = null;
    let bestScore = coneCos;

    for (const f of this.all) {
      if (!f.alive) continue;
      _v.copy(f.position).sub(_eye);
      const d2 = _v.lengthSq();
      if (d2 > max2 || d2 < 0.0001) continue;
      const dot = _v.divideScalar(Math.sqrt(d2)).dot(_dir);
      if (dot < coneCos) continue;
      // Weight slightly toward the near one when two are equally centred.
      const score = dot + (1 - Math.sqrt(d2) / range) * 0.02;
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  raycast(origin, dir, range) {
    let best = null;
    let bestDist = range;
    for (const f of this.all) {
      if (!f.alive) continue;
      _v.copy(f.position).sub(origin);
      const along = _v.dot(dir);
      if (along < 0 || along > bestDist) continue;
      const radius = Math.max(0.35, f.scale * 0.55);
      // Perpendicular distance from the ray to the fish's centre.
      const off2 = _v.lengthSq() - along * along;
      if (off2 > radius * radius) continue;
      bestDist = along;
      best = f;
    }
    if (!best) return null;
    return {
      fish: best,
      distance: bestDist,
      point: _v2.copy(origin).addScaledVector(dir, bestDist).clone(),
    };
  }

  /* Pull a fish out of the water and into the hold. This is the only authority
     on whether the hold had room — combat.js defers to it.

     Safe to call as many times as you like inside one frame: a fish that is
     already gone returns null without a sound, the removal is deferred to the
     next update, and the instanced meshes are only ever rewritten from a list
     that has been compacted first. The net depends on all three. */
  capture(fish) {
    if (!fish || !fish.alive || fish.__dead) return null;
    const sub = this.game.sub;
    const depth = sub ? sub.depth : 0;
    const species = fish.species;
    const kit = this.kits[species.index];
    const value = this.game.ecology.valueOf(species, fish, depth);

    const item = {
      id: `fish-${fish.id}-${(this.game.seed ^ fish.id) >>> 0}`,
      kind: "fish",
      speciesIndex: species.index,
      name: species.name,
      word: species.word,
      glyph: species.glyph,
      hue: species.hue,
      rarity: fish.rarity,
      value,
      depth: Math.round(depth),
      genome: fish.genome,
      generation: fish.generation,
      mutations: fish.mutations,
      // The body plan, not the tank's name for it: the manifest should agree
      // with the thing the player watched come up the beam.
      label: (kit && kit.plan) || species.kind,
    };

    if (!sub || !sub.addCargo(item)) {
      /* sub.addCargo already shouts when it refuses. Only cover the case where
         there is no boat at all, and only once a frame — a full net would
         otherwise fire this a dozen times in a row. */
      if (!sub && !this._cargoWarned) {
        this._cargoWarned = true;
        this.game.bus.emit("fish:cargo-full", {});
      }
      return null;
    }

    this._remove(fish);
    this.game.bus.emit("fish:captured", { item, fish });
    return item;
  }

  /* A harpooned fish is worth a fraction of a netted one: you get the meat,
     not the specimen. Called by combat.js through the bus, and by nothing else. */
  kill(fish) {
    if (!fish || !fish.alive || fish.__dead) return 0;
    const worth = Math.max(1, Math.round(fish.value * 0.2));
    if (this.game.vfx) this.game.vfx.bloodCloud(fish.position, fish.species.colorHex);
    this._remove(fish);
    return worth;
  }

  scatter(position, radius, force) {
    const r2 = radius * radius;
    for (const f of this.all) {
      if (!f.alive) continue;
      _v.copy(f.position).sub(position);
      const d2 = _v.lengthSq();
      if (d2 > r2 || d2 < 0.0001) continue;
      const d = Math.sqrt(d2);
      const falloff = 1 - d / radius;
      f.velocity.addScaledVector(_v.divideScalar(d), force * falloff);
      f.panic = 1;
      // Whatever just happened, the shoal has noticed it too.
      if (f.shoal) f.shoal.alarm = Math.max(f.shoal.alarm, falloff);
    }
  }

  countInZone(zoneId) {
    let n = 0;
    for (const f of this.all) if (f.alive && f.species.zoneId === zoneId) n += 1;
    return n;
  }

  dispose() {
    this._graveyard.length = 0;
    this._dirtyShoals.length = 0;
    this.all.length = 0;
    this.shoals.length = 0;
    const water = this.game.water;
    for (const kit of this.kits) {
      if (water) water.forget(kit.material);
      kit.material.onBeforeCompile = () => {};
    }
    this.kits.length = 0;
    this.meshes.length = 0;
    // disposeTree frees the per-species clones and the glow layer; the shared
    // masters they were cloned from are ours alone and go here.
    disposeTree(this.group);
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    if (this.glowMap) this.glowMap.dispose();
    if (this.game.scene) this.game.scene.remove(this.group);
  }
}
