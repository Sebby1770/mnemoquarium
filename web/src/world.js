/* The sea itself.

   One seeded heightfield under one sheet of moving water, with the light
   failing on the way down. The important promise here is that `heightAt` and
   the floor you can see are the same surface: the analytic function below is
   sampled once into a grid, the mesh is built from that grid, and every
   runtime query bilinearly reads the same grid back. Nothing can drift apart.

   Everything else in this file is dressing that hangs off that floor: flora in
   its depth band, marine snow that thickens as you sink, the surface seen from
   underneath, and the Hull — the one warm thing down here. */

import * as THREE from "three";
import { SCENERY, SEA, ZONES, zoneForDepth } from "./config.js";
import { mergeGeometries, weldVertices } from "./geo.js";
import { stationPush } from "./walk.js";
import {
  TAU,
  clamp,
  clamp01,
  lerp,
  smoothstep,
  smootherstep,
  damp,
  fbm2D,
  ridge2D,
  makeRng,
  randRange,
} from "./util.js";

/* ------------------------------------------------------------------ scratch */
/* Hoisted so nothing in a per-frame loop ever allocates. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

/* --------------------------------------------------------------- constants */

const ZONE_FADE = 1.5;          // seconds to cross-fade fog and light
const SNOW_COUNT = 3000;        // marine snow budget
const SNOW_BOX = 110;           // cube of snow recycled around the camera
const LAYER_SLACK = 440;        // hide a flora band this far outside the view

/* Radius -> fraction of the shelf..trench span. The shape of the whole sea in
   nine numbers: a reef shelf, a shoulder, a long slope, then the rim. */
const PROFILE = [
  [0, 0.0],
  [250, 0.012],
  [430, 0.052],
  [620, 0.14],
  [840, 0.28],
  [1040, 0.47],
  [1230, 0.68],
  [1420, 0.89],
  [1600, 1.0],
];

/* Floor colour by depth. Sand bleaches out fast; below the kelp everything is
   silt, and below that everything is the colour of a closed eye. */
const FLOOR_STOPS = [
  [0, 0xb8a582],
  [70, 0x94815c],
  [150, 0x5f6a4c],
  [300, 0x46564d],
  [520, 0x2a3844],
  [820, 0x18212c],
  [1100, 0x0f141f],
  [1600, 0x0a0813],
];

/* Exposed rock on the steep faces, same depth ramp but colder and flatter. */
const ROCK_STOPS = [
  [0, 0x9c8f77],
  [150, 0x6b6a5c],
  [420, 0x3a4048],
  [820, 0x1c2029],
  [1600, 0x0c0a12],
];

function buildStops(table) {
  return table.map(([depth, hex]) => ({ depth, color: new THREE.Color(hex) }));
}

const NEAR_SIZE = 1760;            // metres of high-detail ground under the sub
const NEAR_SEG = 176;              // 10 m quads
/* Height sampling costs about six microseconds a call and a row is 177 of
   them, so two rows is already a millisecond of frame time. Shading is ten
   times cheaper and can take bigger bites. A full tile takes a couple of
   seconds this way, against the twenty-odd seconds of travel between
   re-centres — slack enough that a rebuild is never visible. */
const NEAR_HEIGHT_ROWS_PER_FRAME = 2;
const NEAR_SHADE_ROWS_PER_FRAME = 14;

const _nearFloor = new THREE.Color();
const _nearRock = new THREE.Color();

const FLOOR_RAMP = buildStops(FLOOR_STOPS);
const ROCK_RAMP = buildStops(ROCK_STOPS);

/* --------------------------------------------------------------- helpers */

/* Sample a depth ramp. Linear between stops is enough — the vertex colours get
   mottled afterwards anyway. */
function rampColor(ramp, depth, out) {
  if (depth <= ramp[0].depth) return out.copy(ramp[0].color);
  const last = ramp[ramp.length - 1];
  if (depth >= last.depth) return out.copy(last.color);
  for (let i = 1; i < ramp.length; i += 1) {
    const b = ramp[i];
    if (depth <= b.depth) {
      const a = ramp[i - 1];
      const t = (depth - a.depth) / (b.depth - a.depth);
      return out.lerpColors(a.color, b.color, t);
    }
  }
  return out.copy(last.color);
}

/* Radial depth profile, smootherstepped between control points so the slope
   never kinks — a kink shows up as a hard crease across the whole seabed. */
function profileFraction(r) {
  if (r <= PROFILE[0][0]) return PROFILE[0][1];
  const last = PROFILE[PROFILE.length - 1];
  if (r >= last[0]) return last[1] + (r - last[0]) * 0.00006;
  for (let i = 1; i < PROFILE.length; i += 1) {
    if (r <= PROFILE[i][0]) {
      const [r0, f0] = PROFILE[i - 1];
      const [r1, f1] = PROFILE[i];
      return lerp(f0, f1, smootherstep(r0, r1, r));
    }
  }
  return last[1];
}

/* A soft round dot. Everything that glows down here uses this one texture:
   snow, beacons, polyp haze. Generated, never loaded — no asset files. */
function makeGlowTexture(size = 64, core = 0.16) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, size * core, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(0.72, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* Tileable interference pattern that reads as caustics on the underside of the
   surface. Integer frequencies only, or the tile seams show. */
function makeCausticTexture(size = 192) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y += 1) {
    const v = (y / size) * TAU;
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * TAU;
      let n = Math.sin(u * 3) * Math.sin(v * 3);
      n += Math.sin(u * 5 + v * 2 + 1.1) * 0.7;
      n += Math.sin(u * 2 - v * 4 + 0.4) * 0.6;
      const a = Math.pow(clamp01(n * 0.42 + 0.5), 5);
      const k = (y * size + x) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(a * 235);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* Bake a vertical gradient into a geometry's vertex colours. Cheaper than a
   texture and it survives instancing. */
function paintByHeight(geo, lowHex, highHex, jitter = 0) {
  const pos = geo.attributes.position;
  const count = pos.count;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const y = pos.getY(i);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const span = hi - lo || 1;
  const low = _c1.setHex(lowHex).clone();
  const high = _c2.setHex(highHex).clone();
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const t = clamp01((pos.getY(i) - lo) / span);
    _c1.lerpColors(low, high, t * t * (3 - 2 * t));
    if (jitter > 0) {
      // Deterministic-ish speckle: geometry index, not the world seed.
      const n = ((i * 2654435761) % 1000) / 1000;
      _c1.multiplyScalar(1 - jitter * 0.5 + n * jitter);
    }
    colors[i * 3] = _c1.r;
    colors[i * 3 + 1] = _c1.g;
    colors[i * 3 + 2] = _c1.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/* Concatenate geometries into one buffer. three's merge helper lives in the
   addons, which are not vendored, so this is the hand-rolled version: position,
   normal and colour only, always non-indexed. */
/* The station's name, painted on the hub band. */
function makeSignTexture() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#e0a02c";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#1b1d1f";
  g.font = "700 76px ui-monospace, Menlo, Consolas, monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("THE HULL  ·  H-01", c.width / 2, c.height / 2 + 4);
  g.fillRect(0, 6, c.width, 6);
  g.fillRect(0, c.height - 12, c.width, 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function mergeGeos(list) {
  const parts = [];
  let total = 0;
  for (const src of list) {
    const geo = src.index ? src.toNonIndexed() : src;
    if (geo !== src) src.dispose();
    parts.push(geo);
    total += geo.attributes.position.count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  let offset = 0;
  for (const geo of parts) {
    const p = geo.attributes.position;
    const n = geo.attributes.normal;
    const c = geo.attributes.color;
    position.set(p.array.subarray(0, p.count * 3), offset * 3);
    if (n) normal.set(n.array.subarray(0, n.count * 3), offset * 3);
    if (c) {
      color.set(c.array.subarray(0, c.count * 3), offset * 3);
    } else {
      color.fill(1, offset * 3, (offset + p.count) * 3);
    }
    offset += p.count;
    geo.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setAttribute("color", new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}


/* Place a geometry by position/rotation/scale without leaving a matrix behind. */
function placeGeo(geo, x, y, z, dir, scale) {
  _q1.setFromUnitVectors(UP, dir);
  _v1.set(x, y, z);
  _v2.set(scale, scale, scale);
  _m1.compose(_v1, _q1, _v2);
  geo.applyMatrix4(_m1);
  return geo;
}

/* ------------------------------------------------------------ flora makers */




/* Tube worms: a fist of stiff tubes with a lit crown. Returns the dark body
   and the additive crowns separately so they can share instance matrices. */
function buildWorms(rng, tubeLow, tubeHigh) {
  const tubes = [];
  const crowns = [];
  const n = 4 + rng.randrange(4);
  for (let i = 0; i < n; i += 1) {
    const yaw = rng.random() * TAU;
    const lean = randRange(rng, 0.08, 0.46);
    const len = randRange(rng, 0.8, 2.3);
    const rad = randRange(rng, 0.07, 0.13);
    const dir = new THREE.Vector3(
      Math.sin(yaw) * Math.sin(lean),
      Math.cos(lean),
      Math.cos(yaw) * Math.sin(lean),
    );
    const ox = randRange(rng, -0.5, 0.5);
    const oz = randRange(rng, -0.5, 0.5);
    const tube = new THREE.CylinderGeometry(rad * 0.8, rad * 1.25, len, 5, 1, true);
    tube.translate(0, len / 2, 0);
    tubes.push(placeGeo(tube, ox, 0, oz, dir, 1));
    const crown = new THREE.SphereGeometry(rad * 1.7, 6, 4);
    crown.translate(ox + dir.x * len, dir.y * len, oz + dir.z * len);
    crowns.push(crown);
  }
  return {
    body: paintByHeight(mergeGeos(tubes), tubeLow, tubeHigh, 0.2),
    crown: mergeGeos(crowns),
  };
}

/* A wreck. Nobody says whose. Half a hull, some ribs, a mast that went over. */


/* ------------------------------------------------------------ scenery kit --
   Build-time noise and the rock and coral shapes. Nothing here runs per frame,
   so it is written for clarity over speed. */

function hash3(x, y, z, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + Math.imul(seed, 144269504)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function noise3(x, y, z, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fy = y - yi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, seed);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u);
  const x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u);
  const x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

function fbm3(x, y, z, seed, octaves = 4) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i += 1) {
    sum += noise3(x * f, y * f, z * f, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return sum / norm;
}

/* Vivid on purpose: the shelf is lit by the sun and should look like a reef.
   Depth does the rest — red goes first, so a coral that is scarlet at 20 m is
   brown at 80 and blue-grey at 200, which is exactly how it looks down there. */
const REEF_PALETTES = [
  [0x4a1530, 0xff7aa8],
  [0x4d2310, 0xffa257],
  [0x281a52, 0xb792ff],
  [0x4f420d, 0xffe070],
  [0x0c403c, 0x5ff0c8],
  [0x4f0f16, 0xff5d62],
  [0x14345a, 0x80ccff],
];

function paintSolid(geo, colour, jitter, rng) {
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const k = 1 - jitter * 0.5 + rng.random() * jitter;
    colors[i * 3] = colour.r * k;
    colors[i * 3 + 1] = colour.g * k;
    colors[i * 3 + 2] = colour.b * k;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/* A boulder. A welded sphere pushed around by three scales of noise — big
   lumps, mid knuckles, and cracks cut in with ridged noise — then squashed and
   given a flat seat so it sits in the silt instead of on it. Colour is baked
   ambient occlusion: dark in the hollows and underneath, pale on the tops,
   which is what makes a grey shape read as a heavy one. The band tint comes
   from the instance colour; moss comes from the shader. */
function buildBoulder(rng, detail = 3) {
  const seed = rng.randrange(1 << 30);
  const geo = weldVertices(new THREE.IcosahedronGeometry(1, detail));
  const pos = geo.attributes.position;
  const disp = new Float32Array(pos.count);
  const sx = randRange(rng, 0.85, 1.25);
  const sz = randRange(rng, 0.85, 1.25);
  const squash = randRange(rng, 0.62, 0.86);
  let mean = 0;
  for (let i = 0; i < pos.count; i += 1) {
    _v1.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const x = _v1.x;
    const y = _v1.y;
    const z = _v1.z;
    let d = fbm3(x * 1.25, y * 1.25, z * 1.25, seed, 3) * 0.3;
    d += fbm3(x * 3.1, y * 3.1, z * 3.1, seed + 7, 3) * 0.11;
    d -= Math.pow(1 - Math.abs(noise3(x * 5.2, y * 5.2, z * 5.2, seed + 13)), 6) * 0.07;
    d += Math.sin(y * 17 + noise3(x * 2, y * 2, z * 2, seed + 19) * 3) * 0.012;
    disp[i] = d;
    mean += d;
    const r = 1 + d;
    let py = y * r * squash;
    if (py < -0.32) py = -0.32 + (py + 0.32) * 0.25;
    pos.setXYZ(i, x * r * sx, py, z * r * sz);
  }
  mean /= pos.count;
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    const hollow = clamp01(0.62 + (disp[i] - mean) * 2.6);
    const up = nrm.getY(i);
    const top = lerp(0.42, 1.05, smoothstep(-0.7, 0.75, up));
    const speck = 0.9 + hash3(i, 3, 7, seed) * 0.2;
    const v = hollow * top * speck;
    // A faint warm/cool split so a rock face is not one flat grey.
    colors[i * 3] = v * 0.96;
    colors[i * 3 + 1] = v * 0.95;
    colors[i * 3 + 2] = v * 0.9;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

/* Staghorn: a stem that forks, and forks again, and ends in pale growing
   tips. The tips are the brightest thing on it, as they are on the real one. */
function buildBranchCoral(rng, palette, levels = 3) {
  const base = new THREE.Color(palette[0]);
  const tip = new THREE.Color(palette[1]);
  const parts = [];
  const colour = new THREE.Color();
  const grow = (origin, dir, len, rad, level) => {
    const t = 1 - level / levels;
    const seg = new THREE.CylinderGeometry(rad * 0.74, rad, len, 6, 1, true);
    seg.translate(0, len / 2, 0);
    _q1.setFromUnitVectors(UP, dir);
    _m1.compose(origin, _q1, ONE);
    seg.applyMatrix4(_m1);
    parts.push(paintSolid(seg, colour.lerpColors(base, tip, 0.25 + t * 0.55), 0.12, rng));
    const end = origin.clone().addScaledVector(dir, len);
    if (level <= 0) {
      const cap = new THREE.SphereGeometry(rad * 0.85, 5, 3);
      cap.translate(end.x, end.y, end.z);
      parts.push(paintSolid(cap, colour.copy(tip).multiplyScalar(1.12), 0.08, rng));
      return;
    }
    const forks = 2 + rng.randrange(2);
    for (let i = 0; i < forks; i += 1) {
      const axis = new THREE.Vector3(randRange(rng, -1, 1), randRange(rng, -0.25, 0.25), randRange(rng, -1, 1)).normalize();
      const next = dir.clone().applyAxisAngle(axis, randRange(rng, 0.38, 0.82));
      next.y = Math.abs(next.y) * 0.7 + 0.3;
      next.normalize();
      grow(end, next, len * randRange(rng, 0.6, 0.8), rad * 0.66, level - 1);
    }
  };
  grow(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(randRange(rng, -0.15, 0.15), 1, randRange(rng, -0.15, 0.15)).normalize(),
    randRange(rng, 0.5, 0.72),
    randRange(rng, 0.09, 0.13),
    levels,
  );
  return mergeGeos(parts);
}

/* Brain coral: a low dome ploughed with meandering grooves. The grooves are
   darker and the ridges catch the light, so it reads from ten metres off. */
function buildBrainCoral(rng, palette, detail = 3) {
  const seed = rng.randrange(1 << 30);
  const base = new THREE.Color(palette[0]);
  // Ridges pale toward bone, but not all the way: under the lamps a near-white
  // dome blows out to a blank shape.
  const ridge = new THREE.Color(palette[1]).lerp(new THREE.Color(0xd8ccb0), 0.15).multiplyScalar(0.82);
  const geo = weldVertices(new THREE.IcosahedronGeometry(1, detail));
  const pos = geo.attributes.position;
  const groove = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i += 1) {
    _v1.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const { x, y, z } = _v1;
    const u = x * 10 + noise3(x * 2.4, y * 2.4, z * 2.4, seed) * 2.2;
    const w = z * 10 + noise3(x * 2.4 + 5, y * 2.4, z * 2.4, seed) * 2.2;
    const g = Math.abs(Math.sin(u) * Math.cos(w) + Math.sin(w * 0.7 + u * 0.45) * 0.55);
    const cut = 1 - smoothstep(0, 0.28, g);
    groove[i] = cut;
    const r = 1 - cut * 0.06 + fbm3(x * 1.6, y * 1.6, z * 1.6, seed + 3, 2) * 0.08;
    const py = Math.max(y * r, -0.06) * 0.72;
    pos.setXYZ(i, x * r, py, z * r);
  }
  geo.computeVertexNormals();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 1) {
    _c1.lerpColors(ridge, base, groove[i] * 0.85);
    colors[i * 3] = _c1.r;
    colors[i * 3 + 1] = _c1.g;
    colors[i * 3 + 2] = _c1.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.scale(0.62, 0.62, 0.62);
  return geo.toNonIndexed();
}

/* Table coral: plates on a stalk, pale on top where the sun lands, dark under
   the rim. Two or three tiers, each rim wavy so it does not read as a disc. */
function buildTableCoral(rng, palette) {
  const top = new THREE.Color(palette[1]).multiplyScalar(0.85);
  const under = new THREE.Color(palette[0]);
  const parts = [];
  const stalk = new THREE.CylinderGeometry(0.06, 0.11, 0.5, 6, 1);
  stalk.translate(0, 0.25, 0);
  parts.push(paintSolid(stalk, under, 0.1, rng));
  const tiers = 2 + rng.randrange(2);
  for (let t = 0; t < tiers; t += 1) {
    const r = randRange(rng, 0.45, 0.8) * (1 - t * 0.22);
    const plate = new THREE.CylinderGeometry(r, r * 0.9, 0.045, 22, 1);
    const pp = plate.attributes.position;
    const phase = rng.random() * TAU;
    const lobes = 4 + rng.randrange(4);
    for (let i = 0; i < pp.count; i += 1) {
      const x = pp.getX(i);
      const z = pp.getZ(i);
      const rr = Math.hypot(x, z);
      if (rr > r * 0.7) {
        const a = Math.atan2(z, x);
        pp.setY(i, pp.getY(i) + Math.sin(a * lobes + phase) * 0.05 * (rr / r) + (rr / r) * 0.04);
      }
    }
    plate.computeVertexNormals();
    plate.translate(randRange(rng, -0.08, 0.08), 0.5 + t * 0.2, randRange(rng, -0.08, 0.08));
    const colors = new Float32Array(pp.count * 3);
    const nn = plate.attributes.normal;
    for (let i = 0; i < pp.count; i += 1) {
      _c1.lerpColors(under, top, smoothstep(-0.4, 0.6, nn.getY(i)));
      colors[i * 3] = _c1.r;
      colors[i * 3 + 1] = _c1.g;
      colors[i * 3 + 2] = _c1.b;
    }
    plate.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(plate);
  }
  return mergeGeos(parts);
}

/* Tube sponges: open-mouthed chimneys in a clump. Double-sided, so you can see
   down the throat of the ones leaning toward you. */
function buildTubeSponge(rng, palette) {
  const parts = [];
  const tubes = 3 + rng.randrange(4);
  for (let i = 0; i < tubes; i += 1) {
    const h = randRange(rng, 0.55, 1.35);
    const r = randRange(rng, 0.07, 0.13);
    const tube = new THREE.CylinderGeometry(r * 1.15, r * 0.85, h, 10, 3, true);
    tube.translate(0, h / 2, 0);
    tube.rotateZ(randRange(rng, -0.25, 0.25));
    tube.rotateX(randRange(rng, -0.25, 0.25));
    tube.translate(randRange(rng, -0.18, 0.18), 0, randRange(rng, -0.18, 0.18));
    parts.push(paintByHeight(tube, palette[0], palette[1], 0.14));
  }
  return mergeGeos(parts);
}

/* Moss and crust on the tops of rocks, thick on the shelf where there is sun
   to grow it and gone by the twilight. Done in the shader because it depends
   on which way a face points in the world and how deep it is, and a boulder
   instance can be anywhere. */
function patchMoss(material) {
  material.userData.shaderTag = "rock";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMossN;\nvarying vec3 vMossP;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 mossP = vec4(transformed, 1.0);
        vec3 mossN = objectNormal;
        #ifdef USE_INSTANCING
          mossP = instanceMatrix * mossP;
          mossN = mat3(instanceMatrix) * mossN;
        #endif
        vMossP = (modelMatrix * mossP).xyz;
        vMossN = normalize(mat3(modelMatrix) * mossN);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMossN;\nvarying vec3 vMossP;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        {
          float up = smoothstep(0.35, 0.85, normalize(vMossN).y);
          float sun = 1.0 - smoothstep(30.0, 280.0, -vMossP.y);
          float grain = fract(sin(dot(floor(vMossP.xz * 1.7), vec2(12.9898, 78.233))) * 43758.5453);
          vec3 moss = mix(vec3(0.2, 0.34, 0.16), vec3(0.42, 0.46, 0.2), grain);
          diffuseColor.rgb = mix(diffuseColor.rgb, moss * (0.8 + grain * 0.4), up * sun * 0.62);
          // Deeper down the tops pale with silt instead.
          float silt = up * smoothstep(200.0, 600.0, -vMossP.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.48, 0.44), silt * 0.35);
        }`);
  };
  return material;
}

/* Weed that moves. The blades are unit height, so position.y is how far up
   the blade a vertex is; the tip travels most and the holdfast not at all.
   Phase comes from where the instance stands, so a curtain ripples across
   rather than nodding in unison. */
function patchSway(material, time, amp = 1) {
  material.userData.shaderTag = `sway:${amp}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayTime = time;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uSwayTime;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        {
          vec3 swayAt = vec3(0.0);
          #ifdef USE_INSTANCING
            swayAt = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #endif
          float h = clamp(position.y, 0.0, 1.2);
          float bend = h * h;
          float ph = uSwayTime * 0.85 + swayAt.x * 0.045 + swayAt.z * 0.038;
          float amp = ${amp.toFixed(3)};
          transformed.x += (sin(ph + position.y * 2.4) * 0.13 + sin(ph * 2.3 + position.y * 5.0) * 0.025) * bend * amp;
          transformed.z += (cos(ph * 0.8 + position.y * 1.9) * 0.1) * bend * amp;
        }`);
  };
  return material;
}

/* Giant kelp: a stipe with blades off it all the way up and a float at each
   blade's root, unit height. About eighty triangles, because a cathedral of
   it needs a lot of them and they all sway in the shader. */
function buildKelpStalk(rng) {
  const parts = [];
  const stem = new THREE.Color(0x3a4a1c);
  const leaf = new THREE.Color(0x6b7a24);
  const lean = randRange(rng, 0.03, 0.1);
  const stipe = new THREE.PlaneGeometry(0.018, 1, 1, 12);
  stipe.translate(0, 0.5, 0);
  const sp = stipe.attributes.position;
  for (let i = 0; i < sp.count; i += 1) sp.setX(i, sp.getX(i) + sp.getY(i) * sp.getY(i) * lean);
  stipe.computeVertexNormals();
  parts.push(paintSolid(stipe, stem, 0.1, rng));
  const blades = 9 + rng.randrange(5);
  for (let i = 0; i < blades; i += 1) {
    const y = 0.12 + (i / blades) * 0.86;
    const len = randRange(rng, 0.09, 0.17) * (1.2 - y * 0.4);
    const blade = new THREE.PlaneGeometry(len, 0.035, 3, 1);
    blade.translate(len / 2, 0, 0);
    const bp = blade.attributes.position;
    for (let k = 0; k < bp.count; k += 1) {
      const t = bp.getX(k) / len;
      bp.setY(k, bp.getY(k) * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)) - t * t * 0.03);
    }
    blade.rotateY(rng.random() * TAU);
    blade.rotateZ(-0.35);
    blade.translate(y * y * lean, y, 0);
    blade.computeVertexNormals();
    _c1.copy(leaf).lerp(stem, rng.random() * 0.4);
    parts.push(paintSolid(blade, _c1, 0.15, rng));
  }
  return mergeGeos(parts);
}

/* A sea fan: a flat lattice of branches grown in one plane, darker at the
   holdfast and bright at the rim, unit height. */
function buildSeaFan(rng, palette) {
  const base = new THREE.Color(palette[0]);
  const rim = new THREE.Color(palette[1]);
  const parts = [];
  const colour = new THREE.Color();
  const grow = (x, y, angle, len, width, level) => {
    const seg = new THREE.PlaneGeometry(width, len, 1, 2);
    seg.translate(0, len / 2, 0);
    seg.rotateZ(angle);
    seg.translate(x, y, 0);
    const t = clamp01(y + len * 0.5);
    parts.push(paintSolid(seg, colour.lerpColors(base, rim, t), 0.12, rng));
    if (level <= 0) return;
    const ex = x - Math.sin(angle) * len;
    const ey = y + Math.cos(angle) * len;
    const forks = 2 + (rng.random() < 0.3 ? 1 : 0);
    for (let i = 0; i < forks; i += 1) {
      const spread = (i - (forks - 1) / 2) * randRange(rng, 0.35, 0.6);
      grow(ex, ey, angle * 0.6 + spread, len * randRange(rng, 0.7, 0.85), width * 0.72, level - 1);
    }
  };
  grow(0, 0, randRange(rng, -0.1, 0.1), 0.26, 0.035, 4);
  const geo = mergeGeos(parts);
  geo.computeBoundingBox();
  const h = geo.boundingBox.max.y || 1;
  geo.scale(1 / h, 1 / h, 1 / h);
  return geo;
}

/* One of the four, in a reef palette. */
function buildCoral(rng, palette, detail = 2) {
  const pal = palette || REEF_PALETTES[rng.randrange(REEF_PALETTES.length)];
  const kind = rng.randrange(4);
  if (kind === 0) return buildBranchCoral(rng, pal, detail);
  if (kind === 1) return buildBrainCoral(rng, pal, detail);
  if (kind === 2) return buildTableCoral(rng, pal);
  return buildTubeSponge(rng, pal);
}

/* A reef bommie. A single displaced column always read as a lump, however it
   was coloured, because a real bommie is not a rock with coral on it — it is
   a mound built out of coral heads, generation on generation, with the rock
   underneath mostly hidden. So that is how this is made: a rough core, then
   rings of brain, table, branching and sponge coral stacked up it, big and
   flat at the foot, smaller and branchier toward the crown. Unit height. */
function buildCoralTower(rng) {
  const seed = rng.randrange(1 << 30);
  const parts = [];

  const core = weldVertices(new THREE.ConeGeometry(0.36, 0.86, 10, 5));
  const kp = core.attributes.position;
  for (let i = 0; i < kp.count; i += 1) {
    const x = kp.getX(i);
    const y = kp.getY(i);
    const z = kp.getZ(i);
    const k = 1 + noise3(x * 6, y * 6, z * 6, seed) * 0.25;
    kp.setXYZ(i, x * k, y + 0.43, z * k);
  }
  core.computeVertexNormals();
  parts.push(paintSolid(core.toNonIndexed(), new THREE.Color(0x4a4239), 0.3, rng));

  // [height up the mound, radius out from the axis, heads in the ring, scale]
  const rings = [
    [0.06, 0.36, 5, 0.3],
    [0.3, 0.29, 5, 0.25],
    [0.55, 0.2, 3, 0.22],
    [0.76, 0.11, 2, 0.2],
    [0.9, 0.0, 1, 0.22],
  ];
  const kinds = [
    (pal) => buildBrainCoral(rng, pal, 1),
    (pal) => buildTableCoral(rng, pal),
    (pal) => buildBranchCoral(rng, pal, 2),
    (pal) => buildTubeSponge(rng, pal),
  ];
  for (let r = 0; r < rings.length; r += 1) {
    const [y01, radius, count, scale] = rings[r];
    const spin = rng.random() * TAU;
    for (let k = 0; k < count; k += 1) {
      const a = spin + (k / count) * TAU + randRange(rng, -0.25, 0.25);
      // The foot is brains and tables; the crown is branches and sponges.
      const pick = r < 2 ? rng.randrange(2) : 2 + rng.randrange(2);
      const piece = kinds[pick](REEF_PALETTES[rng.randrange(REEF_PALETTES.length)]);
      const sc = scale * randRange(rng, 0.8, 1.2);
      _v1.set(Math.cos(a) * radius, y01, Math.sin(a) * radius);
      const out = radius > 0.01 ? 0.55 : 0;
      _v2.set(Math.cos(a) * out, 1, Math.sin(a) * out).normalize();
      _q1.setFromUnitVectors(UP, _v2);
      _v3.set(sc, sc, sc);
      _m1.compose(_v1, _q1, _v3);
      piece.applyMatrix4(_m1);
      parts.push(piece);
    }
  }
  return mergeGeos(parts);
}

/* A curtain of weed: a handful of tall ribbons on one base, so a patch of them
   reads as something to push through rather than something to look at. */
function buildWeedCurtain(rng) {
  const parts = [];
  const blades = 7 + rng.randrange(6);
  for (let i = 0; i < blades; i += 1) {
    const h = randRange(rng, 0.55, 1);
    const w = randRange(rng, 0.035, 0.075);
    const geo = new THREE.PlaneGeometry(w, h, 1, 5);
    geo.translate(0, h / 2, 0);
    const pos = geo.attributes.position;
    const lean = randRange(rng, 0.1, 0.3);
    const twist = rng.random() * TAU;
    for (let k = 0; k < pos.count; k += 1) {
      const t = clamp01(pos.getY(k) / h);
      pos.setX(k, pos.getX(k) * (0.5 + 0.9 * Math.sin(Math.pow(t, 0.7) * Math.PI * 0.9)));
      pos.setZ(k, pos.getZ(k) + t * t * h * lean);
    }
    geo.rotateY(twist);
    geo.translate(randRange(rng, -0.17, 0.17), 0, randRange(rng, -0.17, 0.17));
    geo.computeVertexNormals();
    parts.push(geo);
  }
  const merged = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return paintByHeight(merged, 0x14301d, 0x74a05c, 0.2);
}

function buildWreck(rng) {
  const parts = [];
  const hull = new THREE.CylinderGeometry(3.2, 4.1, 19, 10, 1, true);
  hull.rotateZ(Math.PI / 2);
  hull.rotateY(randRange(rng, -0.12, 0.12));
  hull.translate(0, 1.6, 0);
  parts.push(hull);

  const stern = new THREE.CylinderGeometry(2.0, 3.2, 6.5, 8, 1, true);
  stern.rotateZ(Math.PI / 2);
  stern.rotateY(randRange(rng, 0.3, 0.7));
  stern.translate(-12.4, 1.1, randRange(rng, -1.6, 1.6));
  parts.push(stern);

  for (let i = 0; i < 5; i += 1) {
    const rib = new THREE.TorusGeometry(3.5 - i * 0.16, 0.2, 5, 9, Math.PI * 1.05);
    rib.rotateY(Math.PI / 2);
    rib.rotateZ(randRange(rng, -0.1, 0.1));
    rib.translate(2.2 + i * 2.3, 1.4, 0);
    parts.push(rib);
  }

  const mast = new THREE.CylinderGeometry(0.24, 0.42, 13, 6, 1, true);
  mast.translate(0, 6.5, 0);
  mast.rotateZ(randRange(rng, 0.9, 1.25));
  mast.translate(3.5, 2.4, randRange(rng, -0.8, 0.8));
  parts.push(mast);

  const spar = new THREE.CylinderGeometry(0.16, 0.16, 7, 5, 1, true);
  spar.rotateX(Math.PI / 2);
  spar.translate(8.4, 3.1, 0);
  parts.push(spar);

  return paintByHeight(mergeGeos(parts), 0x14110f, 0x4e3a28, 0.22);
}

/* ------------------------------------------------------------- the palette */

function makePalette() {
  return {
    fog: new THREE.Color(),
    water: new THREE.Color(),
    ambient: new THREE.Color(),
    fogDensity: 0,
    ambientIntensity: 0,
    sunIntensity: 0,
  };
}

function paletteFromZone(zone, out) {
  out.fog.setHex(zone.fog);
  out.water.setHex(zone.water);
  out.ambient.setHex(zone.ambient);
  out.fogDensity = zone.fogDensity;
  out.ambientIntensity = zone.ambientIntensity;
  out.sunIntensity = zone.sunIntensity;
  return out;
}

function copyPalette(src, out) {
  out.fog.copy(src.fog);
  out.water.copy(src.water);
  out.ambient.copy(src.ambient);
  out.fogDensity = src.fogDensity;
  out.ambientIntensity = src.ambientIntensity;
  out.sunIntensity = src.sunIntensity;
  return out;
}

function lerpPalette(a, b, t, out) {
  out.fog.lerpColors(a.fog, b.fog, t);
  out.water.lerpColors(a.water, b.water, t);
  out.ambient.lerpColors(a.ambient, b.ambient, t);
  out.fogDensity = lerp(a.fogDensity, b.fogDensity, t);
  out.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity, t);
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  return out;
}

/* ================================================================= SeaWorld */

export class SeaWorld {
  constructor(game) {
    this.game = game;
    this.seed = (game.seed >>> 0) || 1;
    this.time = 0;

    this.group = new THREE.Group();
    this.group.name = "sea";
    this.group.matrixAutoUpdate = false;

    this.stationPosition = new THREE.Vector3().fromArray(SEA.stationPos);
    this.bounds = { radius: SEA.worldRadius };

    /* Things to hand back to the GPU when this world stops existing. */
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();

    /* Seeded shape parameters for the canyon — one per phrase, so a trench
       learned once stays learned. */
    const shapeRng = makeRng(this.seed, "deep-shape");
    const angle = shapeRng.random() * Math.PI;
    this.canyonCos = Math.cos(angle);
    this.canyonSin = Math.sin(angle);
    this.canyonPhaseA = shapeRng.random() * TAU;
    this.canyonPhaseB = shapeRng.random() * TAU;
    this.canyonPhaseC = shapeRng.random() * TAU;
    this.canyonAmpA = randRange(shapeRng, 150, 280);
    this.canyonAmpB = randRange(shapeRng, 70, 160);

    /* A margin, not a bowl. One direction is the shallow side — a broad
       continental shelf you can work for a long time — and the opposite side
       falls away early. Without this the depth is a pure function of distance
       from the Hull and every heading is the same journey. */
    const marginAngle = shapeRng.random() * TAU;
    this.marginCos = Math.cos(marginAngle);
    this.marginSin = Math.sin(marginAngle);

    /* A second trench arm, so the deep is a system rather than one ditch. */
    const armAngle = marginAngle + randRange(shapeRng, 0.7, 2.3);
    this.armCos = Math.cos(armAngle);
    this.armSin = Math.sin(armAngle);
    this.armPhase = shapeRng.random() * TAU;
    this.armAmp = randRange(shapeRng, 120, 240);

    /* Seamounts: isolated peaks off the deep floor. Some break up into the
       twilight, which makes them visible from a long way out and worth the
       swim. */
    this.seamounts = [];
    const mounts = 9 + shapeRng.randrange(4);
    for (let i = 0; i < mounts; i += 1) {
      const a = shapeRng.random() * TAU;
      const rad = lerp(700, SEA.worldRadius * 0.94, Math.sqrt(shapeRng.random()));
      this.seamounts.push({
        x: Math.cos(a) * rad,
        z: Math.sin(a) * rad,
        radius: randRange(shapeRng, 180, 420),
        height: randRange(shapeRng, 220, 760),
        sharp: randRange(shapeRng, 1.5, 2.6),
      });
    }

    /* Palette state. Everything zone-coloured reads from `paletteNow`. */
    this.zone = zoneForDepth(-this.stationPosition.y);
    this.paletteFrom = paletteFromZone(this.zone, makePalette());
    this.paletteTo = copyPalette(this.paletteFrom, makePalette());
    this.paletteNow = copyPalette(this.paletteFrom, makePalette());
    this.fade = 1;

    this.skyColor = new THREE.Color(this.zone.fog);

    this.glowTexture = this._track(makeGlowTexture(), this._textures);
    this.causticTexture = this._track(makeCausticTexture(), this._textures);

    this._buildLights();
    this._buildTerrain();
    /* The old underside sheet and the hanging light cones are gone: sky.js
       owns the surface now, from both sides, and there is a sky above it. */
    this._buildFlora();
    this._buildSnow();
    this._buildStation();
    this._buildFlowField();

    game.scene.add(this.group);
    game.scene.fog = new THREE.FogExp2(this.zone.fog, this.zone.fogDensity);
    game.scene.background = this.skyColor;
    this._ownsFog = true;
    this.applyPalette(1);
  }

  _track(thing, bucket) {
    bucket.add(thing);
    return thing;
  }

  _geo(geometry) { return this._track(geometry, this._geometries); }
  _mat(material) { return this._track(material, this._materials); }

  /* ------------------------------------------------------------- the floor */

  /* The analytic seabed. Pure, seeded, and deliberately band-limited: nothing
     in here has a wavelength shorter than about three terrain quads, so the
     mesh built from it never lies to the collision by more than a hand. */
  sampleHeight(x, z) {
    const s = this.seed;
    const r = Math.sqrt(x * x + z * z);
    const R = SEA.worldRadius;

    /* Domain warp first. Sampling noise at a position that has itself been
       pushed around by noise is the cheapest way to stop a landscape reading
       as symmetrical blobs — it buys creases, overhangs in silhouette, and
       ridgelines that wander. */
    const wx = x + fbm2D((s ^ 0x51ed270b) >>> 0, x * 0.00042, z * 0.00042, 3) * 320;
    const wz = z + fbm2D((s ^ 0x1b56c4e9) >>> 0, x * 0.00042, z * 0.00042, 3) * 320;

    /* The margin. `along` runs from -1 deep in the shelf to +1 out over the
       basin, warped so the coastline is not a straight edge and offset so the
       Hull sits well inside the shallow side. */
    const along = clamp((x * this.marginCos + z * this.marginSin) / R - 0.28
      + fbm2D((s ^ 0x2f9a1c77) >>> 0, x * 0.00055, z * 0.00055, 3) * 0.2, -1, 1);
    const tDir = smootherstep(-0.34, 0.72, along);

    /* Distance still counts, but only a fifth as much on the shelf side as on
       the basin side. That is what buys a shallow half of the map you can work
       for a long time and a deep half that drops away early — instead of a
       single funnel where every heading is the same journey. */
    const radial = smootherstep(250, R * 0.95, r);
    let t = clamp01(radial * (0.22 + 0.78 * tDir) + tDir * 0.3);

    let depth = lerp(SEA.shelfDepth, SEA.trenchDepth, t);

    /* The shelf break: a real escarpment where the shelf gives up, rather than
       a gradient. It follows the warped margin, so it reads as a coastline you
       can fly along and navigate by. */
    const brk = smootherstep(0.20, 0.33, t) - smootherstep(0.33, 0.46, t) * 0.25;
    depth += brk * 210;

    /* Relief, quiet on the plains and violent on the slope. */
    const slopeBand = smoothstep(0.12, 0.42, t) * (1 - smoothstep(0.62, 0.92, t));
    const relief = lerp(7, 54, smoothstep(140, 1400, r)) + slopeBand * 70;
    depth += fbm2D(s, wx * 0.00171, wz * 0.00169, 5) * relief;

    // Rock ridges, strongest on the slope where the sediment has run off.
    const spine = lerp(10, 42, smoothstep(90, 1100, r)) * (0.45 + slopeBand);
    depth -= (ridge2D((s ^ 0x9e3779b9) >>> 0, wx * 0.0029, wz * 0.0031, 3) - 0.45) * spine;

    // Coarse grain, no finer than the near mesh can carry.
    depth += fbm2D((s + 4409) >>> 0, x * 0.0125, z * 0.0125, 2) * 3.1;

    /* Two trench arms that meet. Each is a meandering cut that deepens as it
       runs out, and both keep clear of the Hull so the approach stays flyable. */
    depth += this._trenchCut(x, z, r, this.canyonCos, this.canyonSin,
      this.canyonPhaseA, this.canyonPhaseB, this.canyonPhaseC,
      this.canyonAmpA, this.canyonAmpB, 130, 105, 330);
    depth += this._trenchCut(x, z, r, this.armCos, this.armSin,
      this.armPhase, this.armPhase * 1.7, this.armPhase * 0.6,
      this.armAmp, this.armAmp * 0.5, 92, 70, 240);

    /* Seamounts. Subtracted last among the features so a peak can stand in the
       middle of a trench and still be a peak. */
    for (let i = 0; i < this.seamounts.length; i += 1) {
      const m = this.seamounts[i];
      const dx = x - m.x;
      const dz = z - m.z;
      const d2 = (dx * dx + dz * dz) / (m.radius * m.radius);
      if (d2 < 9) depth -= m.height * Math.exp(-Math.pow(d2, m.sharp * 0.5));
    }

    // Flatten a pad under each outpost. Applied last so nothing eats it.
    depth = this._flattenPads(x, z, depth);

    /* A tall seamount on a shallow bearing can otherwise punch through the
       surface, and there is no island in this game for it to become. */
    return -Math.max(depth, 16);
  }

  /* One meandering cut. Pulled out of sampleHeight so the trench system can
     have more than one arm without the function turning into a wall of maths. */
  _trenchCut(x, z, r, cos, sin, phaseA, phaseB, phaseC, ampA, ampB, width, near, far) {
    const across = x * cos - z * sin;
    const along = x * sin + z * cos;
    const meander = Math.sin(along * 0.0028 + phaseA) * ampA + Math.sin(along * 0.0011 + phaseB) * ampB;
    const halfWidth = width + Math.sin(along * 0.0017 + phaseC) * (width * 0.35);
    const offset = Math.abs(across - meander);
    const cut = 1 - smootherstep(halfWidth * 0.22, halfWidth, offset);
    if (cut <= 0) return 0;
    const sx = x - this.stationPosition.x;
    const sz = z - this.stationPosition.z;
    const clearStation = smoothstep(190, 560, Math.sqrt(sx * sx + sz * sz));
    return cut * clearStation * (near + far * smoothstep(300, 1800, r));
  }

  /* Every outpost needs somewhere flat to stand. */
  _flattenPads(x, z, depth) {
    let out = depth;
    const pads = this.pads || [[this.stationPosition.x, this.stationPosition.z, SEA.shelfDepth, 75, 265]];
    for (let i = 0; i < pads.length; i += 1) {
      const [px, pz, target, inner, outer] = pads[i];
      const dx = x - px;
      const dz = z - pz;
      const pad = 1 - smootherstep(inner, outer, Math.sqrt(dx * dx + dz * dz));
      if (pad > 0) out = lerp(out, target, pad * 0.92);
    }
    return out;
  }

  _buildTerrain() {
    const size = SEA.terrainSize;
    const seg = Math.max(8, SEA.terrainSegments | 0);
    const n = seg + 1;
    this.gridN = n;
    this.cell = size / seg;
    this.halfExtent = size / 2;

    const geo = this._geo(new THREE.PlaneGeometry(size, size, seg, seg));
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const heights = new Float32Array(n * n);

    for (let k = 0; k < pos.count; k += 1) {
      const h = this.sampleHeight(pos.getX(k), pos.getZ(k));
      heights[k] = h;
      pos.setY(k, h);
    }
    this.heights = heights;

    /* Vertex colours: depth ramp, slope blend toward exposed rock, and a low
       mottle so a flat plain still has something to read. */
    const colors = new Float32Array(pos.count * 3);
    const cell = this.cell;
    const floorC = new THREE.Color();
    const rockC = new THREE.Color();
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const k = j * n + i;
        const h = heights[k];
        const depth = -h;
        const hx = heights[j * n + Math.min(i + 1, n - 1)] - heights[j * n + Math.max(i - 1, 0)];
        const hz = heights[Math.min(j + 1, n - 1) * n + i] - heights[Math.max(j - 1, 0) * n + i];
        const slope = clamp01(Math.sqrt(hx * hx + hz * hz) / (cell * 2.4));

        rampColor(FLOOR_RAMP, depth, floorC);
        rampColor(ROCK_RAMP, depth, rockC);
        floorC.lerp(rockC, smoothstep(0.2, 0.75, slope));

        const mottle = fbm2D((this.seed + 991) >>> 0, pos.getX(k) * 0.022, pos.getZ(k) * 0.022, 2);
        floorC.multiplyScalar(clamp(1 + mottle * 0.26, 0.55, 1.45));

        colors[k * 3] = floorC.r;
        colors[k * 3 + 1] = floorC.g;
        colors[k * 3 + 2] = floorC.b;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    this.terrainMaterial = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.97,
      metalness: 0.0,
      dithering: true,
      fog: true,
    }));
    this.terrain = new THREE.Mesh(geo, this.terrainMaterial);
    this.terrain.name = "seabed";
    /* Across 9.6 km this sheet carries 40 m quads: fine as a horizon, far too
       coarse underfoot. It is dropped a couple of metres so the detail mesh
       below always wins where the two overlap, and the error is invisible at
       the distance you ever see it from. */
    this.terrain.position.y = -2.5;
    this.terrain.matrixAutoUpdate = false;
    this.terrain.updateMatrix();
    this.terrain.receiveShadow = false;
    this.group.add(this.terrain);

    this._buildNearTerrain();
  }

  /* The ground you are actually flying over: a single high-resolution tile
     that follows the sub. Re-sampling it is thousands of noise evaluations, so
     the work is spread over several frames into a scratch buffer and only
     copied into the live attributes when the whole tile is ready — a partly
     rebuilt tile would visibly ripple. */
  _buildNearTerrain() {
    const size = NEAR_SIZE;
    const seg = NEAR_SEG;
    const n = seg + 1;
    this.nearN = n;
    this.nearStep = size / seg;
    this.nearHalf = size / 2;

    const geo = this._geo(new THREE.PlaneGeometry(size, size, seg, seg));
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));

    this.nearGeo = geo;
    this.nearScratchY = new Float32Array(n * n);
    this.nearScratchC = new Float32Array(n * n * 3);
    this.nearScratchN = new Float32Array(n * n * 3);
    /* Published alongside nearCentre, so heightAt never reads a tile that is
       half way through being rebuilt for a different centre. */
    this.nearHeights = null;
    this.nearJob = null;
    this.nearCentre = new THREE.Vector2(Infinity, Infinity);

    this.near = new THREE.Mesh(geo, this.terrainMaterial);
    this.near.name = "seabed-near";
    this.near.frustumCulled = false;
    this.group.add(this.near);
  }

  /* Kick off a rebuild centred on (cx, cz), snapped to the vertex grid so the
     tile never shifts by a fraction of a quad and shimmers. */
  _startNearJob(cx, cz) {
    const step = this.nearStep;
    const sx = Math.round(cx / step) * step;
    const sz = Math.round(cz / step) * step;
    if (this.nearJob && this.nearJob.x === sx && this.nearJob.z === sz) return;
    this.nearJob = { x: sx, z: sz, row: 0, shade: 0 };
  }

  _advanceNearJob() {
    const job = this.nearJob;
    if (!job) return;

    const n = this.nearN;
    const step = this.nearStep;
    const half = this.nearHalf;
    const heights = this.nearScratchY;

    /* Phase one: heights. This is the expensive half — sampleHeight runs about
       six microseconds a call and there are thirty thousand of them. */
    if (job.row < n) {
      const rows = Math.min(n - job.row, NEAR_HEIGHT_ROWS_PER_FRAME);
      for (let rr = 0; rr < rows; rr += 1) {
        const j = job.row + rr;
        const wz = job.z - half + j * step;
        for (let i = 0; i < n; i += 1) {
          heights[j * n + i] = this.sampleHeight(job.x - half + i * step, wz);
        }
      }
      job.row += rows;
      return;
    }

    /* Phase two: shading and normals, spread the same way. Normals come from
       the height field directly rather than computeVertexNormals(), which
       would be one long stall at the end and no more accurate. */
    const colors = this.nearScratchC;
    const normals = this.nearScratchN;
    const floorC = _nearFloor;
    const rockC = _nearRock;

    if (job.shade < n) {
      const rows = Math.min(n - job.shade, NEAR_SHADE_ROWS_PER_FRAME);
      for (let rr = 0; rr < rows; rr += 1) {
        const j = job.shade + rr;
        const jm = Math.max(j - 1, 0);
        const jp = Math.min(j + 1, n - 1);
        for (let i = 0; i < n; i += 1) {
          const k = j * n + i;
          const im = Math.max(i - 1, 0);
          const ip = Math.min(i + 1, n - 1);
          const hx = heights[j * n + ip] - heights[j * n + im];
          const hz = heights[jp * n + i] - heights[jm * n + i];
          const span = step * 2;

          // Analytic normal for a heightfield: the gradient, flipped.
          let nx = -hx;
          let ny = span;
          let nz = -hz;
          const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          normals[k * 3] = nx * inv;
          normals[k * 3 + 1] = ny * inv;
          normals[k * 3 + 2] = nz * inv;

          const depth = -heights[k];
          const slope = clamp01(Math.sqrt(hx * hx + hz * hz) / (step * 2.4));
          rampColor(FLOOR_RAMP, depth, floorC);
          rampColor(ROCK_RAMP, depth, rockC);
          floorC.lerp(rockC, smoothstep(0.18, 0.7, slope));

          const wx = job.x - half + i * step;
          const wz = job.z - half + j * step;
          const mottle = fbm2D((this.seed + 991) >>> 0, wx * 0.022, wz * 0.022, 2);
          floorC.multiplyScalar(clamp(1 + mottle * 0.28, 0.55, 1.45));

          colors[k * 3] = floorC.r;
          colors[k * 3 + 1] = floorC.g;
          colors[k * 3 + 2] = floorC.b;
        }
      }
      job.shade += rows;
      return;
    }

    /* Phase three: publish the whole tile at once. A partly written tile would
       visibly ripple, and heightAt would read a floor that is not there. */
    const geo = this.nearGeo;
    const pos = geo.attributes.position;
    for (let k = 0; k < heights.length; k += 1) pos.setY(k, heights[k]);
    geo.attributes.color.array.set(colors);
    geo.attributes.normal.array.set(normals);
    pos.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;

    if (!this.nearHeights) this.nearHeights = new Float32Array(heights.length);
    this.nearHeights.set(heights);

    this.near.position.set(job.x, 0, job.z);
    this.nearCentre.set(job.x, job.z);
    this.nearJob = null;
  }

  _updateNear(cam) {
    if (!this.near) return;
    // Re-centre once the camera leaves the comfortable middle of the tile.
    const drift = Math.max(Math.abs(cam.x - this.nearCentre.x), Math.abs(cam.z - this.nearCentre.y));
    if (!this.nearJob && drift > this.nearHalf * 0.34) this._startNearJob(cam.x, cam.z);
    if (this.nearJob) this._advanceNearJob();
  }

  /* Bilinear read of the grid the mesh was built from. Fast enough to call a
     few hundred times a frame, and exact against what you can see. */
  heightAt(x, z) {
    /* The detail tile is sampled at 10 m and the backdrop sheet at 40 m, so
       inside the tile we read that instead: the coarse grid is off by up to
       two metres, which is the difference between flying over the seabed and
       clipping through the seabed you can see. */
    const nh = this.nearHeights;
    if (nh) {
      const n = this.nearN;
      const step = this.nearStep;
      const fx = (x - this.nearCentre.x + this.nearHalf) / step;
      const fz = (z - this.nearCentre.y + this.nearHalf) / step;
      if (fx >= 0 && fz >= 0 && fx <= n - 1 && fz <= n - 1) {
        const i = fx | 0;
        const j = fz | 0;
        const i1 = i + 1 < n ? i + 1 : i;
        const j1 = j + 1 < n ? j + 1 : j;
        const tx = fx - i;
        const tz = fz - j;
        const a = nh[j * n + i];
        const b = nh[j * n + i1];
        const c = nh[j1 * n + i];
        const d = nh[j1 * n + i1];
        const top = a + (b - a) * tx;
        return top + ((c + (d - c) * tx) - top) * tz;
      }
    }

    const h = this.heights;
    if (!h) return this.sampleHeight(x, z);
    const n = this.gridN;
    const fx = (x + this.halfExtent) / this.cell;
    const fz = (z + this.halfExtent) / this.cell;
    if (!(fx >= 0 && fz >= 0 && fx <= n - 1 && fz <= n - 1)) return this.sampleHeight(x, z);
    const i = fx | 0;
    const j = fz | 0;
    const i1 = i + 1 < n ? i + 1 : i;
    const j1 = j + 1 < n ? j + 1 : j;
    const tx = fx - i;
    const tz = fz - j;
    const a = h[j * n + i];
    const b = h[j * n + i1];
    const c = h[j1 * n + i];
    const d = h[j1 * n + i1];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
  }

  normalAt(x, z, out) {
    const target = out || new THREE.Vector3();
    const e = this.cell * 0.75;
    const l = this.heightAt(x - e, z);
    const r = this.heightAt(x + e, z);
    const d = this.heightAt(x, z - e);
    const u = this.heightAt(x, z + e);
    return target.set(l - r, e * 2, d - u).normalize();
  }

  /* -------------------------------------------------------------- surface */



  /* --------------------------------------------------------------- lights */

  _buildLights() {
    this.hemi = new THREE.HemisphereLight(0x9fd8e6, 0x10202c, 0.85);
    this.hemi.position.set(0, 1, 0);
    this.group.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0x9fd8e6, 0.45);
    this.group.add(this.ambient);

    /* The sun does not follow you — it is up there whether you look or not. */
    this.sun = new THREE.DirectionalLight(0xdff2ff, 1.15);
    this.sun.position.set(120, 420, 90);
    this.sun.target.position.set(0, -200, 0);
    this.group.add(this.sun);
    this.group.add(this.sun.target);
  }

  /* ---------------------------------------------------------------- flora */

  /* Rejection-sample points on the floor inside a depth band and under a slope
     limit. Seeded, so the same phrase grows the same garden every time. */
  _scatter(rng, count, minDepth, maxDepth, minNormalY, keepClear, onPoint) {
    const limit = count * 14;
    let placed = 0;
    const normal = new THREE.Vector3();
    for (let tries = 0; tries < limit && placed < count; tries += 1) {
      const a = rng.random() * TAU;
      const rad = Math.sqrt(rng.random()) * (SEA.worldRadius - 30);
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      const y = this.heightAt(x, z);
      const depth = -y;
      if (depth < minDepth || depth > maxDepth) continue;
      if (keepClear > 0) {
        const dx = x - this.stationPosition.x;
        const dz = z - this.stationPosition.z;
        if (dx * dx + dz * dz < keepClear * keepClear) continue;
      }
      this.normalAt(x, z, normal);
      if (normal.y < minNormalY) continue;
      onPoint(x, y, z, depth, normal, placed);
      placed += 1;
    }
    return placed;
  }

  _addLayer(root, minDepth, maxDepth) {
    root.matrixAutoUpdate = false;
    root.updateMatrix();
    this.group.add(root);
    this.layers.push({ root, minDepth, maxDepth });
    return root;
  }

  _buildFlora() {
    this.layers = [];

    this._buildWormField();
    this._buildPolypField();
    this._buildRockField();
    this._buildGiantField();
    this._buildWreckField();
  }




  _buildWormField() {
    const rng = makeRng(this.seed, "worms");
    const root = new THREE.Group();
    root.name = "worms";
    const bodyMat = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0,
      fog: true,
    }));
    this.wormGlowMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0x9fe2d4,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }));

    const shapes = [];
    for (let i = 0; i < 3; i += 1) {
      const built = buildWorms(rng, 0x120f14, 0x5a4a52);
      shapes.push({ body: this._geo(built.body), crown: this._geo(built.crown) });
    }

    const per = 130;
    for (const shape of shapes) {
      const body = new THREE.InstancedMesh(shape.body, bodyMat, per);
      const crown = new THREE.InstancedMesh(shape.crown, this.wormGlowMaterial, per);
      body.frustumCulled = false;
      crown.frustumCulled = false;
      crown.renderOrder = 1;
      let i = 0;
      this._scatter(rng, per, 260, SEA.maxDepth, 0.72, 40, (x, y, z, depth) => {
        const s = randRange(rng, 0.8, 2.4);
        _e1.set(randRange(rng, -0.18, 0.18), rng.random() * TAU, randRange(rng, -0.18, 0.18));
        _q1.setFromEuler(_e1);
        _v1.set(x, y - 0.1, z);
        _v2.set(s, s * randRange(rng, 0.85, 1.5), s);
        _m1.compose(_v1, _q1, _v2);
        body.setMatrixAt(i, _m1);
        crown.setMatrixAt(i, _m1);
        // The deeper they sit, the colder and stranger the light they keep.
        _c1.setHSL(lerp(0.44, 0.72, smoothstep(300, 1300, depth)) + randRange(rng, -0.05, 0.05),
          0.65, 0.6);
        crown.setColorAt(i, _c1);
        _c2.setHex(0xffffff).multiplyScalar(randRange(rng, 0.7, 1.15));
        body.setColorAt(i, _c2);
        i += 1;
      });
      body.count = i;
      crown.count = i;
      body.instanceMatrix.needsUpdate = true;
      crown.instanceMatrix.needsUpdate = true;
      if (body.instanceColor) body.instanceColor.needsUpdate = true;
      if (crown.instanceColor) crown.instanceColor.needsUpdate = true;
      root.add(body);
      root.add(crown);
    }
    this._addLayer(root, 200, SEA.maxDepth + 200);
  }

  _buildPolypField() {
    const rng = makeRng(this.seed, "polyps");
    const root = new THREE.Group();
    root.name = "polyps";
    const geo = this._geo(new THREE.OctahedronGeometry(0.3, 0));
    this.polypMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }));
    const count = 760;
    const mesh = new THREE.InstancedMesh(geo, this.polypMaterial, count);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    let i = 0;
    this._scatter(rng, count, 300, SEA.maxDepth, 0.6, 30, (x, y, z, depth) => {
      const s = randRange(rng, 0.5, 2.0);
      _e1.set(rng.random() * TAU, rng.random() * TAU, rng.random() * TAU);
      _q1.setFromEuler(_e1);
      _v1.set(x, y + randRange(rng, 0.15, 1.4), z);
      _v2.set(s, s, s);
      _m1.compose(_v1, _q1, _v2);
      mesh.setMatrixAt(i, _m1);
      _c1.setHSL(lerp(0.5, 0.83, smoothstep(300, 1400, depth)) + randRange(rng, -0.07, 0.07),
        0.8, 0.62);
      mesh.setColorAt(i, _c1);
      i += 1;
    });
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    root.add(mesh);
    this._addLayer(root, 240, SEA.maxDepth + 200);
  }

  _buildRockField() {
    const rng = makeRng(this.seed, "rocks");
    const root = new THREE.Group();
    root.name = "rocks";
    const material = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      fog: true,
    }));
    patchMoss(material);
    const shapes = [];
    for (let i = 0; i < 3; i += 1) shapes.push(this._geo(buildBoulder(rng, 1)));
    const per = 300;
    for (const geo of shapes) {
      const mesh = new THREE.InstancedMesh(geo, material, per);
      mesh.frustumCulled = false;
      let i = 0;
      this._scatter(rng, per, 6, SEA.maxDepth, 0.55, 36, (x, y, z, depth) => {
        const s = randRange(rng, 0.8, 5.5);
        _e1.set(rng.random() * TAU, rng.random() * TAU, rng.random() * TAU);
        _q1.setFromEuler(_e1);
        _v1.set(x, y - s * randRange(rng, 0.2, 0.55), z);
        _v2.set(s * randRange(rng, 0.8, 1.3), s * randRange(rng, 0.5, 1.0), s * randRange(rng, 0.8, 1.3));
        _m1.compose(_v1, _q1, _v2);
        mesh.setMatrixAt(i, _m1);
        // Boulders take the colour of the band they sit in.
        rampColor(ROCK_RAMP, depth, _c1);
        _c1.multiplyScalar(randRange(rng, 1.5, 2.6));
        mesh.setColorAt(i, _c1);
        i += 1;
      });
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      root.add(mesh);
    }
    this._addLayer(root, 0, SEA.maxDepth + 400);
  }

  /* The big stuff. Everything else on the floor is texture you fly over; these
     are objects you fly *between* — boulders taller than the boat, coral towers
     you can lose a shark behind, and curtains of weed thick enough that going
     through is a decision. Each shape is one instanced draw call, so the whole
     field costs four. */
  /* ------------------------------------------------------- big scenery --
     Measured problem: scattering nine hundred props over a world of radius
     4200 — fifty-five square kilometres — put exactly two of them within 120 m
     of the boat, against a fog-limited view of about 150. The player had never
     seen a boulder. Raising the count until the density is right anywhere
     would mean tens of thousands of instances.

     So the field is streamed instead. The world is divided into cells; a cell's
     contents are a pure function of (seed, cellX, cellZ), so a patch of sea
     always has the same rocks in the same places and leaving and coming back
     shows you the same scene. Only the cells near the boat are ever written
     into the instance buffers, which keeps the count bounded and the density
     high exactly where it is looked at. */
  _buildGiantField() {
    const rng = makeRng(this.seed, "giants");
    const root = new THREE.Group();
    root.name = "giants";

    const rockMat = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0, fog: true,
    }));
    const coralMat = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, fog: true,
    }));
    const weedMat = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, fog: true,
    }));
    this.swayTime = { value: 0 };
    patchMoss(rockMat);
    patchSway(weedMat, this.swayTime, 1);
    const kelpMat = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0, side: THREE.DoubleSide, fog: true,
    }));
    patchSway(kelpMat, this.swayTime, 1.6);
    const fanMat = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, fog: true,
    }));
    patchSway(fanMat, this.swayTime, 0.35);
    if (this.game.water) {
      this.game.water.register(kelpMat);
      this.game.water.register(fanMat);
    }
    if (this.game.water) {
      this.game.water.register(rockMat);
      this.game.water.register(coralMat);
      this.game.water.register(weedMat);
    }

    // A handful of shapes each, so a field does not read as one rock repeated.
    this.sceneryKinds = [
      {
        key: "boulders",
        max: SCENERY.maxBoulders,
        range: SCENERY.boulders,
        minDepth: 6,
        maxDepth: SEA.maxDepth + 400,
        shapes: [0, 1, 2].map(() => this._geo(buildBoulder(rng, 6))),
        mesh: null,
      },
      {
        key: "towers",
        max: SCENERY.maxTowers,
        range: SCENERY.towers,
        minDepth: 12,
        maxDepth: 340,
        shapes: [0, 1, 2].map(() => this._geo(buildCoralTower(rng))),
        mesh: null,
      },
      {
        /* The reef itself: branching, brain, table and sponge, in the reef
           palettes. Streamed with the rest, so it is dense wherever you are
           on the shelf instead of thinly spread across all of it. */
        key: "reef",
        max: SCENERY.maxReef,
        range: SCENERY.reef,
        minDepth: 6,
        maxDepth: 190,
        shapes: [0, 1, 2, 3, 4, 5].map((i) => {
          const pal = REEF_PALETTES[(i * 3 + rng.randrange(REEF_PALETTES.length)) % REEF_PALETTES.length];
          const kinds = [buildBranchCoral, buildBrainCoral, buildTableCoral, buildTubeSponge, buildBranchCoral, buildBrainCoral];
          return this._geo(kinds[i](rng, pal, i === 1 || i === 5 ? 2 : 3));
        }),
        mesh: null,
      },
      {
        // The Kelp Cathedral, in stands you can get lost in.
        key: "kelp",
        max: SCENERY.maxKelp,
        range: SCENERY.kelp,
        clump: [6, 16],
        clumpRadius: 16,
        minDepth: 45,
        maxDepth: 300,
        shapes: [0, 1, 2].map(() => this._geo(buildKelpStalk(rng))),
        mesh: null,
      },
      {
        key: "fans",
        max: SCENERY.maxFans,
        range: SCENERY.fans,
        clump: [2, 6],
        clumpRadius: 9,
        minDepth: 10,
        maxDepth: 170,
        shapes: [0, 1, 2].map((i) => this._geo(buildSeaFan(rng, REEF_PALETTES[(i * 2 + 1) % REEF_PALETTES.length]))),
        mesh: null,
      },
      {
        key: "weed",
        max: SCENERY.maxWeed,
        range: SCENERY.weed,
        minDepth: 8,
        maxDepth: 520,
        shapes: [0, 1, 2].map(() => this._geo(buildWeedCurtain(rng))),
        mesh: null,
      },
    ];

    const matFor = { boulders: rockMat, towers: coralMat, reef: coralMat, kelp: kelpMat, fans: fanMat, weed: weedMat };
    for (const kind of this.sceneryKinds) {
      // One mesh per shape so the whole field is nine draw calls, not nine
      // hundred, and each can be filled independently as cells come and go.
      kind.meshes = kind.shapes.map((geo) => {
        const mesh = new THREE.InstancedMesh(geo, matFor[kind.key], Math.ceil(kind.max / kind.shapes.length));
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        root.add(mesh);
        return mesh;
      });
    }

    this.sceneryRoot = root;
    this.sceneryCell = { x: Infinity, z: Infinity };
    this._addLayer(root, 0, SEA.maxDepth + 400);
  }

  /* Rewrite the instance buffers for the window around (cx, cz). Cheap enough
     to do in one frame: about a thousand height lookups, and heightAt inside
     the detail tile is a bilinear read rather than a noise evaluation. */
  _fillScenery(cx, cz) {
    const cell = SCENERY.cell;
    const reach = SCENERY.radius;
    const pads = this.pads || [];

    for (const kind of this.sceneryKinds) {
      for (const mesh of kind.meshes) mesh.count = 0;
    }

    for (let gz = cz - reach; gz <= cz + reach; gz += 1) {
      for (let gx = cx - reach; gx <= cx + reach; gx += 1) {
        // Skip the corners of the square so the field reads as a disc.
        const dx = gx - cx;
        const dz = gz - cz;
        if (dx * dx + dz * dz > (reach + 0.5) * (reach + 0.5)) continue;

        for (const kind of this.sceneryKinds) {
          const cr = makeRng(this.seed, kind.key, gx, gz);
          const [lo, hi] = kind.range;
          const want = lo + cr.randrange(Math.max(1, hi - lo + 1));
          // Clumped kinds place `want` clumps and a handful of members in each.
          const members = kind.clump ? kind.clump : null;
          let clumpX = 0;
          let clumpZ = 0;
          let left = 0;
          const total = members ? want * members[1] : want;
          for (let i = 0; i < total; i += 1) {
            let x;
            let z;
            if (members) {
              if (left <= 0) {
                if (i / members[1] >= want) break;
                clumpX = (gx + cr.random()) * cell;
                clumpZ = (gz + cr.random()) * cell;
                left = members[0] + cr.randrange(Math.max(1, members[1] - members[0] + 1));
              }
              left -= 1;
              const a = cr.random() * TAU;
              const rr = Math.sqrt(cr.random()) * kind.clumpRadius;
              x = clumpX + Math.cos(a) * rr;
              z = clumpZ + Math.sin(a) * rr;
            } else {
              x = (gx + cr.random()) * cell;
              z = (gz + cr.random()) * cell;
            }
            const r = Math.sqrt(x * x + z * z);
            if (r > SEA.worldRadius) continue;

            const y = this.heightAt(x, z);
            const depth = -y;
            if (depth < kind.minDepth || depth > kind.maxDepth) continue;

            // Nothing grows on a wall, and nothing grows on the landing pads.
            this.normalAt(x, z, _v3);
            if (_v3.y < 0.62) continue;
            let onPad = false;
            for (let k = 0; k < pads.length; k += 1) {
              const px = x - pads[k][0];
              const pz = z - pads[k][1];
              if (px * px + pz * pz < pads[k][4] * pads[k][4]) { onPad = true; break; }
            }
            if (onPad) continue;

            const pick = cr.randrange(kind.meshes.length);
            const mesh = kind.meshes[pick];
            if (mesh.count >= mesh.instanceMatrix.count) continue;

            let sc;
            let lean;
            if (kind.key === "boulders") {
              sc = randRange(cr, 8, 30);
              lean = 0.45;
            } else if (kind.key === "towers") {
              sc = randRange(cr, 10, 30);
              lean = 0.06;
            } else if (kind.key === "kelp") {
              sc = randRange(cr, 14, 34);
              lean = 0.06;
            } else if (kind.key === "fans") {
              sc = randRange(cr, 1.4, 3.6);
              lean = 0.12;
            } else if (kind.key === "reef") {
              // Bigger on the sunny shelf, smaller as the light runs out.
              sc = randRange(cr, 1.6, 4.2) * lerp(1.2, 0.7, smoothstep(20, 180, depth));
              lean = 0.18;
            } else {
              sc = randRange(cr, 13, 30);
              lean = 0.14;
            }

            _e1.set(randRange(cr, -lean, lean), cr.random() * TAU, randRange(cr, -lean, lean));
            _q1.setFromEuler(_e1);
            const sink = kind.key === "boulders" ? sc * randRange(cr, 0.16, 0.4) : kind.key === "reef" || kind.key === "fans" ? 0.15 : kind.key === "kelp" ? 0.4 : 1.2;
            _v1.set(x, y - sink, z);
            const wobble = kind.key === "boulders" ? 0.14 : 0.3;
            _v2.set(
              sc * randRange(cr, 1 - wobble, 1 + wobble),
              sc * randRange(cr, 1 - wobble, 1 + wobble) * (kind.key === "boulders" ? 0.88 : 1),
              sc * randRange(cr, 1 - wobble, 1 + wobble),
            );
            _m1.compose(_v1, _q1, _v2);
            mesh.setMatrixAt(mesh.count, _m1);

            if (kind.key === "boulders") {
              rampColor(ROCK_RAMP, depth, _c1);
              _c1.multiplyScalar(randRange(cr, 1.4, 2.4));
            } else {
              _c1.setHex(0xffffff).multiplyScalar(randRange(cr, 0.6, 1.3));
            }
            mesh.setColorAt(mesh.count, _c1);
            mesh.count += 1;
          }
        }
      }
    }

    for (const kind of this.sceneryKinds) {
      for (const mesh of kind.meshes) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  _updateScenery(cam) {
    if (!this.sceneryKinds) return;
    const cell = SCENERY.cell;
    const cx = Math.floor(cam.x / cell);
    const cz = Math.floor(cam.z / cell);
    if (cx === this.sceneryCell.x && cz === this.sceneryCell.z) return;
    this.sceneryCell.x = cx;
    this.sceneryCell.z = cz;
    this._fillScenery(cx, cz);
  }

  _buildWreckField() {
    const rng = makeRng(this.seed, "wrecks");
    const root = new THREE.Group();
    root.name = "wrecks";
    const material = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.93,
      metalness: 0.12,
      side: THREE.DoubleSide,
      fog: true,
    }));
    const shapes = [this._geo(buildWreck(rng)), this._geo(buildWreck(rng))];
    const per = 6;
    for (const geo of shapes) {
      const mesh = new THREE.InstancedMesh(geo, material, per);
      mesh.frustumCulled = false;
      let i = 0;
      this._scatter(rng, per, 30, SEA.maxDepth, 0.88, 150, (x, y, z) => {
        const s = randRange(rng, 0.8, 1.9);
        _e1.set(randRange(rng, -0.22, 0.22), rng.random() * TAU, randRange(rng, -0.3, 0.3));
        _q1.setFromEuler(_e1);
        _v1.set(x, y - s * 0.9, z);
        _v2.set(s, s, s);
        _m1.compose(_v1, _q1, _v2);
        mesh.setMatrixAt(i, _m1);
        _c1.setHex(0xffffff).multiplyScalar(randRange(rng, 0.7, 1.1));
        mesh.setColorAt(i, _c1);
        i += 1;
      });
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      root.add(mesh);
    }
    this._addLayer(root, 0, SEA.maxDepth + 400);
  }

  /* ----------------------------------------------------------- marine snow */

  _buildSnow() {
    const rng = makeRng(this.seed, "snow");
    const positions = new Float32Array(SNOW_COUNT * 3);
    this.snowFall = new Float32Array(SNOW_COUNT);
    const half = SNOW_BOX / 2;
    const origin = this.stationPosition;
    for (let i = 0; i < SNOW_COUNT; i += 1) {
      positions[i * 3] = origin.x + randRange(rng, -half, half);
      positions[i * 3 + 1] = origin.y + randRange(rng, -half, half);
      positions[i * 3 + 2] = origin.z + randRange(rng, -half, half);
      this.snowFall[i] = randRange(rng, 0.16, 0.62);
    }
    const geo = this._geo(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SNOW_BOX);

    this.snowMaterial = this._mat(new THREE.PointsMaterial({
      color: 0xd8e6ee,
      size: 0.34,
      map: this.glowTexture,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true,
      fog: true,
    }));
    this.snow = new THREE.Points(geo, this.snowMaterial);
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 3;
    this.snowPositions = positions;
    this.group.add(this.snow);
  }

  /* ---------------------------------------------------------- the station */

  /* The Hull from outside: a seabed station, not a capsule.
   *
   * A painted central hub with a glass observation dome, three habitat
   * modules on short connecting tubes, lit portholes, a docking bay under the
   * hub with its door lit and guide lights running out to the ring, legs down
   * to footings on the floor, a beacon mast, running lights, and an umbilical
   * cable climbing to a buoy on the surface.
   *
   * Everything is painted rather than bare metal: metal under water has
   * nothing to reflect and renders black, which is what the old hull did.
   * Parts are merged per material, so the whole station is about fifteen
   * draw calls. Local y is up and the origin is SEA.stationPos. */
  _buildStation() {
    const root = new THREE.Group();
    root.name = "hull-station";
    root.position.copy(this.stationPosition);
    const S = this.stationPosition;
    const rng = makeRng(this.seed, "station");

    const paint = this._mat(new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 0.58, metalness: 0.08 }));
    const accent = this._mat(new THREE.MeshStandardMaterial({ color: 0xe0a02c, roughness: 0.5, metalness: 0.1 }));
    const trim = this._mat(new THREE.MeshStandardMaterial({ color: 0x4a545c, roughness: 0.62, metalness: 0.2 }));
    const warm = this._mat(new THREE.MeshStandardMaterial({
      color: 0x120d07, emissive: 0xffb765, emissiveIntensity: 2.2, roughness: 0.4, metalness: 0,
    }));
    const unlit = this._mat(new THREE.MeshStandardMaterial({ color: 0x0c1418, roughness: 0.2, metalness: 0.1 }));
    const glass = this._mat(new THREE.MeshStandardMaterial({
      color: 0x86cfdc, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.32,
      emissive: 0x1f5864, emissiveIntensity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    }));
    const lounge = this._mat(new THREE.MeshStandardMaterial({ color: 0x1a120a, emissive: 0xffcf8a, emissiveIntensity: 0.9, roughness: 0.8 }));
    const bayGlow = this._mat(new THREE.MeshStandardMaterial({ color: 0x0a1216, emissive: 0xb8e2ee, emissiveIntensity: 0.75, roughness: 0.6 }));

    const buckets = new Map([[paint, []], [accent, []], [trim, []], [warm, []], [unlit, []], [lounge, []], [bayGlow, []]]);
    const _m = new THREE.Matrix4();
    const _q = new THREE.Quaternion();
    const _e = new THREE.Euler();
    const _p = new THREE.Vector3();
    const _one = new THREE.Vector3(1, 1, 1);
    const put = (material, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      _e.set(rx, ry, rz);
      _q.setFromEuler(_e);
      _m.compose(_p.set(x, y, z), _q, _one);
      geo.applyMatrix4(_m);
      buckets.get(material).push(geo);
      return geo;
    };

    /* ---- hub, dome, mast ------------------------------------------------ */
    put(paint, new THREE.CylinderGeometry(7.5, 7.5, 11, 40), 0, 0, 0);
    put(accent, new THREE.CylinderGeometry(7.58, 7.58, 1.5, 40, 1, true), 0, 3.6, 0);
    for (const y of [-5.4, 5.45]) put(trim, new THREE.TorusGeometry(7.6, 0.34, 6, 40), 0, y, 0, Math.PI / 2);
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * TAU;
      put(rng.random() < 0.82 ? warm : unlit, new THREE.BoxGeometry(1.25, 1.7, 0.25), Math.sin(a) * 7.52, 0.2, Math.cos(a) * 7.52, 0, a);
    }
    // The dome, a lit lounge floor under it, and ribs over it.
    const dome = new THREE.Mesh(this._geo(new THREE.SphereGeometry(7.2, 32, 12, 0, TAU, 0, Math.PI / 2)), glass);
    dome.position.y = 5.5;
    dome.renderOrder = 3;
    root.add(dome);
    put(lounge, new THREE.CircleGeometry(7.1, 32), 0, 5.6, 0, -Math.PI / 2);
    for (let i = 0; i < 4; i += 1) put(trim, new THREE.TorusGeometry(7.25, 0.14, 4, 32, Math.PI), 0, 5.5, 0, 0, (i / 4) * Math.PI);
    put(trim, new THREE.CylinderGeometry(0.22, 0.3, 8, 8), 0, 16.7, 0);
    for (const y of [15, 18]) put(trim, new THREE.BoxGeometry(2.4, 0.12, 0.12), 0, y, 0, 0, y * 0.3);

    /* Name on the band, facing the bay side you arrive from. */
    const signTex = makeSignTexture();
    this._track(signTex, this._textures);
    const signMat = this._mat(new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.55, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.25 }));
    const sign = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(7.62, 7.62, 1.3, 24, 1, true, -0.75, 1.5)), signMat);
    sign.position.y = 3.6;
    root.add(sign);

    /* ---- habitat modules ---------------------------------------------- */
    const modules = [
      { a: Math.PI, dome: false },        // west
      { a: 0, dome: false },              // east
      { a: -Math.PI / 2, dome: true },    // north, ends in the observation dome
    ];
    this.stationColliders = [
      { kind: "capsule", ax: 0, ay: -5, az: 0, bx: 0, by: 5.5, bz: 0, r: 7.7 },
    ];
    const navSpots = [];
    for (const mod of modules) {
      const dx = Math.cos(mod.a);
      const dz = Math.sin(mod.a);
      const sx = -dz;                  // horizontal side normal
      const sz = dx;
      const yaw = Math.atan2(dx, dz);  // rotates +Z onto the module axis
      const cx = dx * 16;
      const cz = dz * 16;
      const cy = -1;
      const body = new THREE.CylinderGeometry(3.4, 3.4, 14, 28);
      body.rotateX(Math.PI / 2);
      put(paint, body, cx, cy, cz, 0, yaw);
      const tubeGeo = new THREE.CylinderGeometry(2, 2, 3.2, 20);
      tubeGeo.rotateX(Math.PI / 2);
      put(trim, tubeGeo, dx * 9, cy, dz * 9, 0, yaw);
      put(paint, new THREE.SphereGeometry(3.4, 20, 12), cx - dx * 7, cy, cz - dz * 7);
      if (mod.dome) {
        const obs = new THREE.Mesh(this._geo(new THREE.SphereGeometry(3.45, 24, 14, 0, TAU, 0, Math.PI / 2)), glass);
        obs.position.set(cx + dx * 7, cy, cz + dz * 7);
        obs.rotation.set(Math.PI / 2, 0, 0);
        obs.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, dz));
        obs.renderOrder = 3;
        root.add(obs);
        const floor = new THREE.CircleGeometry(3.3, 20);
        floor.rotateX(-Math.PI / 2);
        put(lounge, floor, cx + dx * 7.6, cy - 1.6, cz + dz * 7.6);
      } else {
        put(paint, new THREE.SphereGeometry(3.4, 20, 12), cx + dx * 7, cy, cz + dz * 7);
        navSpots.push({ x: cx + dx * 10.2, y: cy + 0.6, z: cz + dz * 10.2, colour: mod.a === 0 ? 0x5dff8a : 0xff4a3a });
      }
      // Frames round the module, a stripe along the top, and portholes.
      for (let k = -2; k <= 2; k += 1) {
        const f = new THREE.TorusGeometry(3.5, 0.17, 6, 28);
        put(trim, f, cx + dx * k * 3.2, cy, cz + dz * k * 3.2, 0, yaw);
      }
      const stripe = new THREE.BoxGeometry(0.5, 0.12, 13.4);
      put(accent, stripe, cx, cy + 3.41, cz, 0, yaw);
      for (let k = -2; k <= 2; k += 1) {
        for (const side of [-1, 1]) {
          const px = cx + dx * (k * 3.2 + 1.6) + sx * side * 3.42;
          const pz = cz + dz * (k * 3.2 + 1.6) + sz * side * 3.42;
          if (k === 2) continue;
          put(rng.random() < 0.78 ? warm : unlit, new THREE.CircleGeometry(0.55, 14), px, cy + 0.3, pz, 0, Math.atan2(sx * side, sz * side));
        }
      }
      this.stationColliders.push({
        kind: "capsule",
        ax: cx - dx * 7, ay: cy, az: cz - dz * 7,
        bx: cx + dx * 7, by: cy, bz: cz + dz * 7,
        r: 3.6,
      });
    }

    /* ---- the docking bay, under the hub, door facing +Z ----------------- */
    put(paint, new THREE.BoxGeometry(14, 7, 20), 0, -9, 4);
    put(accent, new THREE.BoxGeometry(14.1, 0.6, 20.1), 0, -5.7, 4);
    put(bayGlow, new THREE.PlaneGeometry(9, 4.6), 0, -9.3, 14.06);
    // Door frame: a dark lip, then hazard blocks round it.
    put(trim, new THREE.BoxGeometry(10, 0.5, 0.6), 0, -6.8, 14.2);
    put(trim, new THREE.BoxGeometry(10, 0.5, 0.6), 0, -11.8, 14.2);
    put(trim, new THREE.BoxGeometry(0.5, 5.4, 0.6), -4.75, -9.3, 14.2);
    put(trim, new THREE.BoxGeometry(0.5, 5.4, 0.6), 4.75, -9.3, 14.2);
    for (let i = 0; i < 10; i += 1) {
      const x = -5.4 + i * 1.2;
      put(i % 2 ? accent : trim, new THREE.BoxGeometry(1.2, 0.5, 0.3), x, -6.3, 14.25);
    }
    this.stationColliders.push({ kind: "box", minX: -7.2, maxX: 7.2, minY: -12.7, maxY: -5.3, minZ: -6.2, maxZ: 14.3 });

    // Guide rails out to the ring, with lights that chase inward.
    const guideA = this._mat(new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 1 }));
    const guideB = this._mat(new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 1 }));
    const guideGeosA = [];
    const guideGeosB = [];
    for (const x of [-5.6, 5.6]) {
      // Painted, not bare: from the boat these run along the bottom of the glass.
      put(accent, new THREE.BoxGeometry(0.45, 0.45, 26), x, -12.4, 27);
      for (let k = 0; k < 7; k += 1) {
        const g = new THREE.SphereGeometry(0.32, 8, 6);
        g.translate(x, -11.9, 16 + k * 4);
        (k % 2 ? guideGeosB : guideGeosA).push(g);
      }
    }
    root.add(new THREE.Mesh(this._geo(mergeGeos(guideGeosA)), guideA));
    root.add(new THREE.Mesh(this._geo(mergeGeos(guideGeosB)), guideB));
    this.guideMaterials = [guideA, guideB];

    /* Docking ring — the thing you aim at, in front of the bay door. */
    put(accent, new THREE.TorusGeometry(6.8, 0.75, 8, 36), 0, -9.3, 30);
    this.ringGlowMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0x7fe6ff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    const ringGlow = new THREE.Mesh(this._geo(new THREE.TorusGeometry(6.8, 1.05, 6, 36)), this.ringGlowMaterial);
    ringGlow.position.set(0, -9.3, 30);
    ringGlow.renderOrder = 2;
    root.add(ringGlow);
    this.ringGlow = ringGlow;

    /* ---- legs down to footings --------------------------------------- */
    const legTops = [
      [-6.2, -12.6, 12.5], [6.2, -12.6, 12.5], [-6.2, -12.6, -4.5], [6.2, -12.6, -4.5],
      [-20, -4.2, 0], [20, -4.2, 0], [0, -4.2, -20],
    ];
    for (const [lx, top, lz] of legTops) {
      const floorY = this.heightAt(S.x + lx, S.z + lz) - S.y;
      const len = top - floorY;
      if (len < 0.8) continue;
      put(trim, new THREE.CylinderGeometry(0.45, 0.6, len, 8), lx, floorY + len / 2, lz);
      put(trim, new THREE.CylinderGeometry(1.6, 1.9, 0.7, 12), lx, floorY + 0.3, lz);
      if (len > 6) put(accent, new THREE.CylinderGeometry(0.62, 0.62, 0.5, 8), lx, top - 1.2, lz);
    }

    /* ---- the umbilical to the surface, and its buoy -------------------- */
    const cable = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.6, 20, 0.4),
      new THREE.Vector3(3, 24, -1),
      new THREE.Vector3(7, 28, -3.5),
      new THREE.Vector3(9.5, 30.2, -5),
    ]), 40, 0.16, 5, false);
    put(trim, cable);
    put(accent, new THREE.SphereGeometry(1.1, 14, 10), 9.5, 30.1, -5);
    put(trim, new THREE.CylinderGeometry(0.08, 0.08, 1.6, 6), 9.5, 31.4, -5);

    /* One mesh per material. */
    for (const [material, list] of buckets) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(this._geo(mergeGeos(list)), material);
      root.add(mesh);
    }

    /* ---- lights you can see from far off ----------------------------- */
    this.beaconMaterial = this._mat(new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95 }));
    this.beacon = new THREE.Mesh(this._geo(new THREE.SphereGeometry(0.9, 10, 8)), this.beaconMaterial);
    this.beacon.position.y = 21.2;
    root.add(this.beacon);
    // The sprite ignores fog on purpose — the one light in this sea that is
    // supposed to find you before you find it.
    this.beaconSpriteMaterial = this._mat(new THREE.SpriteMaterial({
      map: this.glowTexture,
      color: 0xffc98a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      sizeAttenuation: true,
    }));
    this.beaconSprite = new THREE.Sprite(this.beaconSpriteMaterial);
    this.beaconSprite.position.y = 21.2;
    this.beaconSprite.scale.set(22, 22, 1);
    this.beaconSprite.renderOrder = 6;
    root.add(this.beaconSprite);

    // Running lights: red to the west, green to the east, white strobes on the bay.
    navSpots.push({ x: -7.1, y: -5.6, z: 14.3, colour: 0xffffff, strobe: true });
    navSpots.push({ x: 7.1, y: -5.6, z: 14.3, colour: 0xffffff, strobe: true });
    this.navLights = [];
    for (const spot of navSpots) {
      const mat = this._mat(new THREE.SpriteMaterial({
        map: this.glowTexture, color: spot.colour, transparent: true, opacity: 0.9,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      const glow = new THREE.Sprite(mat);
      glow.position.set(spot.x, spot.y, spot.z);
      glow.scale.setScalar(spot.strobe ? 3.2 : 4.5);
      glow.renderOrder = 5;
      root.add(glow);
      this.navLights.push({ sprite: glow, material: mat, strobe: !!spot.strobe, phase: rng.random() * TAU });
    }

    /* Real light: warm on the approach, so the paint reads as paint. */
    this.stationLight = new THREE.PointLight(0xffc98a, 600, 130, 1.8);
    this.stationLight.position.set(0, -4, 22);
    root.add(this.stationLight);

    /* Flood cones under the modules, the way work lights hang off a rig. */
    this.floodMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0xffd7a8,
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }));
    const floodGeo = this._geo(new THREE.ConeGeometry(9, 30, 10, 1, true));
    this.floods = [];
    for (const mod of modules) {
      const flood = new THREE.Mesh(floodGeo, this.floodMaterial);
      flood.position.set(Math.cos(mod.a) * 16, -4.4 - 15, Math.sin(mod.a) * 16);
      flood.renderOrder = 2;
      root.add(flood);
      this.floods.push(flood);
    }

    root.updateMatrix();
    root.matrixAutoUpdate = false;
    root.updateMatrixWorld(true);
    this.station = root;
    this.group.add(root);
  }

  /* Keep a body of radius r out of the station. Colliders are in station-local
     space. Returns true when it pushed, and bleeds the velocity going in. */
  collideStation(position, velocity, r) {
    if (!this.stationColliders) return false;
    const S = this.stationPosition;
    const px = position.x - S.x;
    const py = position.y - S.y;
    const pz = position.z - S.z;
    // Cheap reject: nothing of the station is more than ~40 m from its centre.
    if (px * px + py * py + pz * pz > 45 * 45) return false;
    let hit = false;
    for (const c of this.stationColliders) {
      const push = stationPush(c, position.x - S.x, position.y - S.y, position.z - S.z, r);
      if (!push) continue;
      hit = true;
      position.x += push[0] * push[3];
      position.y += push[1] * push[3];
      position.z += push[2] * push[3];
      if (velocity) {
        const into = velocity.x * push[0] + velocity.y * push[1] + velocity.z * push[2];
        if (into < 0) {
          velocity.x -= push[0] * into * 1.2;
          velocity.y -= push[1] * into * 1.2;
          velocity.z -= push[2] * into * 1.2;
        }
      }
    }
    return hit;
  }

  /* ----------------------------------------------------------------- flow */

  /* A precomputed vector field, bilinearly sampled. Doing the noise live would
     be honest and also eat the frame budget once four hundred fish ask at once. */
  _buildFlowField() {
    const n = 40;
    this.flowN = n;
    this.flowCell = SEA.terrainSize / (n - 1);
    const a = new Float32Array(n * n * 2);
    const b = new Float32Array(n * n * 2);
    const s = (this.seed ^ 0x5ea1f10) >>> 0;
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const x = (i / (n - 1)) * 2 - 1;
        const z = (j / (n - 1)) * 2 - 1;
        const k = (j * n + i) * 2;
        a[k] = fbm2D(s, x * 3.1, z * 3.1, 3);
        a[k + 1] = fbm2D((s + 613) >>> 0, x * 3.1, z * 3.1, 3);
        b[k] = fbm2D((s + 1229) >>> 0, x * 2.3 + 11, z * 2.3 - 7, 3);
        b[k + 1] = fbm2D((s + 1861) >>> 0, x * 2.3 + 11, z * 2.3 - 7, 3);
      }
    }
    this.flowA = a;
    this.flowB = b;
  }

  _flowSample(field, x, z, out) {
    const n = this.flowN;
    const fx = clamp((x + this.halfExtent) / this.flowCell, 0, n - 1.001);
    const fz = clamp((z + this.halfExtent) / this.flowCell, 0, n - 1.001);
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const k00 = (j * n + i) * 2;
    const k10 = (j * n + i + 1) * 2;
    const k01 = ((j + 1) * n + i) * 2;
    const k11 = ((j + 1) * n + i + 1) * 2;
    const top0 = field[k00] + (field[k10] - field[k00]) * tx;
    const bot0 = field[k01] + (field[k11] - field[k01]) * tx;
    const top1 = field[k00 + 1] + (field[k10 + 1] - field[k00 + 1]) * tx;
    const bot1 = field[k01 + 1] + (field[k11 + 1] - field[k01 + 1]) * tx;
    out.x = top0 + (bot0 - top0) * tz;
    out.y = top1 + (bot1 - top1) * tz;
    return out;
  }

  /* ------------------------------------------------------------ public api */

  zoneAt(depth) {
    return zoneForDepth(depth);
  }

  zoneAtPosition(vec3) {
    return zoneForDepth(-vec3.y);
  }

  distanceToStation(vec3) {
    return vec3.distanceTo(this.stationPosition);
  }

  /* Close enough to the clamps, and slow enough that the clamps would survive
     catching you. */
  isDockable(vec3) {
    if (this.distanceToStation(vec3) > SEA.dockRadius) return false;
    const sub = this.game.sub;
    const speed = sub && Number.isFinite(sub.speed) ? sub.speed : 0;
    return speed <= 8;
  }

  /* Past the rim there is nothing modelled and nothing to find, so the current
     leans on you instead of a wall appearing. Returns true when it pushed, and
     the caller decides whether to say something about it. */
  clampToBounds(position, velocity) {
    let pushed = false;
    const r = Math.sqrt(position.x * position.x + position.z * position.z);
    if (r > this.bounds.radius && r > 0.001) {
      const nx = position.x / r;
      const nz = position.z / r;
      const over = r - this.bounds.radius;
      const strength = clamp01(over / 130);
      if (velocity) {
        const outward = velocity.x * nx + velocity.z * nz;
        if (outward > 0) {
          velocity.x -= outward * nx * 0.4;
          velocity.z -= outward * nz * 0.4;
        }
        velocity.x -= nx * strength * 1.1;
        velocity.z -= nz * strength * 1.1;
      }
      if (over > 170) {
        const hard = this.bounds.radius + 170;
        position.x = nx * hard;
        position.z = nz * hard;
      }
      pushed = true;
    }
    /* No ceiling here any more: the surface is an exit now, and the boat
       floats on it (sub.js). This only ever reports the rim of the world. */
    return pushed;
  }

  /* A slow drift, faster and more sideways down in the trench where the water
     has somewhere to be. */
  sampleFlow(position, time, out) {
    const target = out || new THREE.Vector3();
    const blend = 0.5 + 0.5 * Math.sin(time * 0.041);
    this._flowSample(this.flowA, position.x, position.z, _v3);
    const ax = _v3.x;
    const az = _v3.y;
    this._flowSample(this.flowB, position.x, position.z, _v3);
    const bx = _v3.x;
    const bz = _v3.y;

    const depth = -position.y;
    const strength = lerp(0.32, 1.25, smoothstep(240, 1100, depth));
    const swirl = 0.22;

    target.x = lerp(ax, bx, blend) * strength
      + Math.sin(position.z * 0.009 + time * 0.13) * swirl;
    target.z = lerp(az, bz, blend) * strength
      + Math.cos(position.x * 0.008 - time * 0.11) * swirl;
    target.y = Math.sin(position.x * 0.006 + position.z * 0.007 + time * 0.07) * strength * 0.22;

    /* The rim pulls inward. Whatever the sea is doing out there, it is not
       inviting you further. */
    const r = Math.sqrt(position.x * position.x + position.z * position.z);
    if (r > this.bounds.radius * 0.82 && r > 0.001) {
      const pull = smoothstep(this.bounds.radius * 0.82, this.bounds.radius, r) * 0.9;
      target.x -= (position.x / r) * pull;
      target.z -= (position.z / r) * pull;
    }
    return target;
  }

  /* Cross-fade into a band. Never snaps unless asked: the light going out is
     most of what makes going down feel like going down. */
  setZone(zone, immediate = false) {
    const next = zone && typeof zone.fog === "number" ? zone : ZONES[0];
    if (next === this.zone && !immediate) return;
    copyPalette(this.paletteNow, this.paletteFrom);
    paletteFromZone(next, this.paletteTo);
    this.zone = next;
    this.fade = immediate ? 1 : 0;
    if (immediate) this.applyPalette(1);
  }

  applyPalette(t) {
    const p = lerpPalette(this.paletteFrom, this.paletteTo, t, this.paletteNow);
    const scene = this.game.scene;
    if (scene.fog && scene.fog.isFogExp2) {
      scene.fog.color.copy(p.fog);
      scene.fog.density = p.fogDensity;
    }
    this.skyColor.copy(p.fog);

    this.hemi.color.copy(p.ambient);
    this.hemi.groundColor.copy(p.water).multiplyScalar(0.55);
    this.hemi.intensity = p.ambientIntensity * 0.95;

    this.ambient.color.copy(p.ambient);
    this.ambient.intensity = p.ambientIntensity * 0.5;

    this.sun.intensity = p.sunIntensity;
    this.sun.color.copy(p.ambient).lerp(_c1.setHex(0xffffff), 0.55);

    /* The floor takes a little of the water's colour so nothing ever reads as
       a lit object floating in an unlit sea. */
    this.terrainMaterial.color.copy(_c1.setHex(0xffffff)).lerp(p.water, 0.22);

  }

  /* ---------------------------------------------------------------- update */

  update(dt, cameraPosition) {
    const cam = cameraPosition || this.game.camera.position;
    this.time += dt;
    const t = this.time;

    /* Follow the depth band even if nobody tells us to. */
    const zone = this.zoneAtPosition(cam);
    if (zone !== this.zone) this.setZone(zone, false);
    if (this.fade < 1) {
      this.fade = clamp01(this.fade + dt / ZONE_FADE);
      this.applyPalette(smootherstep(0, 1, this.fade));
    }

    const depth = Math.max(0, -cam.y);

    if (this.swayTime) this.swayTime.value += dt;
    this._updateNear(cam);
    this._updateScenery(cam);
    this._updateSnow(dt, cam, depth);
    this._updateStation(t, cam);
    this._updateLayers(depth);
  }

  _updateSnow(dt, cam, depth) {
    // Surfaced, there is no snow: it is a thing that happens in water.
    const sky = this.game.sky;
    if (this.snow) this.snow.visible = !(sky && sky.above);
    const snow = this.zone.snow;
    const positions = this.snowPositions;
    const fall = this.snowFall;
    const half = SNOW_BOX / 2;
    const box = SNOW_BOX;

    /* Density is a draw range, not a rebuild: the buffer never changes size. */
    const want = Math.round(SNOW_COUNT * (0.2 + 0.8 * clamp01(snow)));
    this.snow.geometry.setDrawRange(0, want);
    this.snowMaterial.opacity = lerp(0.28, 0.62, clamp01(snow));
    this.snowMaterial.size = lerp(0.26, 0.4, clamp01(snow));

    /* One shared drift so the whole field moves like one body of water. */
    _v1.set(cam.x, cam.y, cam.z);
    this.sampleFlow(_v1, this.time, _v2);
    const dx = _v2.x * dt * 0.6;
    const dz = _v2.z * dt * 0.6;

    for (let i = 0; i < want; i += 1) {
      const k = i * 3;
      positions[k] += dx;
      positions[k + 1] -= fall[i] * dt;
      positions[k + 2] += dz;

      let d = positions[k] - cam.x;
      if (d > half) positions[k] -= box;
      else if (d < -half) positions[k] += box;

      d = positions[k + 1] - cam.y;
      if (d > half) positions[k + 1] -= box;
      else if (d < -half) positions[k + 1] += box;

      d = positions[k + 2] - cam.z;
      if (d > half) positions[k + 2] -= box;
      else if (d < -half) positions[k + 2] += box;
    }
    this.snow.geometry.attributes.position.needsUpdate = true;
    this.snow.geometry.boundingSphere.center.set(cam.x, cam.y, cam.z);
  }




  _updateStation(t, cam) {
    /* Two-beat pulse: a slow breath with a sharper flash on top, so it reads
       as machinery keeping itself awake rather than a blinking dot. */
    const breath = 0.55 + 0.45 * Math.sin(t * 1.35);
    const flash = Math.pow(clamp01(Math.sin(t * 0.55)), 8);
    const level = clamp01(breath * 0.65 + flash);
    this.beaconMaterial.opacity = lerp(0.45, 1, level);
    this.beacon.scale.setScalar(lerp(0.86, 1.18, level));
    this.beaconSpriteMaterial.opacity = lerp(0.35, 1, level);

    const dist = this.distanceToStation(cam);
    /* Far away the beacon has to fight the fog, so it gets bigger, not brighter. */
    this.beaconSprite.scale.setScalar(lerp(14, 46, smoothstep(60, 900, dist)) * lerp(0.85, 1.15, level));

    // Dimmer up close, where it fills the glass, than out in the fog.
    const near = 1 - smoothstep(20, 60, this.distanceToStation(cam));
    this.ringGlowMaterial.opacity = lerp(0.22, 0.5, 0.5 + 0.5 * Math.sin(t * 0.9 + 1.1)) * (1 - near * 0.55);
    this.floodMaterial.opacity = 0.06 + 0.02 * Math.sin(t * 0.6);
    this.stationLight.intensity = lerp(520, 700, breath);

    // Guide lights chase in toward the bay; running lights breathe; strobes flash.
    if (this.guideMaterials) {
      const beat = Math.floor(t * 2.5) % 2;
      this.guideMaterials[0].opacity = beat ? 0.25 : 1;
      this.guideMaterials[1].opacity = beat ? 1 : 0.25;
    }
    if (this.navLights) {
      for (const n of this.navLights) {
        n.material.opacity = n.strobe
          ? (Math.sin(t * 3.1 + n.phase) > 0.93 ? 1 : 0.08)
          : 0.55 + 0.35 * Math.sin(t * 1.2 + n.phase);
      }
    }

    this.polypMaterial.opacity = lerp(0.5, 0.82, 0.5 + 0.5 * Math.sin(t * 0.7));
    this.wormGlowMaterial.opacity = lerp(0.6, 0.95, 0.5 + 0.5 * Math.sin(t * 0.43 + 2.2));
  }

  /* A flora band a kilometre above you is a kilometre of fog away. Do not pay
     for it. */
  _updateLayers(depth) {
    for (const layer of this.layers) {
      layer.root.visible = depth > layer.minDepth - LAYER_SLACK
        && depth < layer.maxDepth + LAYER_SLACK;
    }
  }

  /* --------------------------------------------------------------- dispose */

  dispose() {
    const scene = this.game.scene;
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.isInstancedMesh) {
        obj.dispose();
      }
    });
    if (this._ownsFog) {
      if (scene.fog && scene.fog.isFogExp2) scene.fog = null;
      if (scene.background === this.skyColor) scene.background = null;
    }
    for (const geo of this._geometries) geo.dispose();
    for (const mat of this._materials) mat.dispose();
    for (const tex of this._textures) tex.dispose();
    this._geometries.clear();
    this._materials.clear();
    this._textures.clear();
    this.group.clear();
    this.layers = [];
    this.heights = null;
    this.snowPositions = null;
    this.snowFall = null;
    this.flowA = null;
    this.flowB = null;
  }
}
