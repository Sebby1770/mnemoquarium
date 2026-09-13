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
import { SEA, ZONES, zoneForDepth } from "./config.js";
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
const SWAY_RANGE = 190;         // only sway clumps this close to the eye
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
  [0, 0xd9c9a0],
  [70, 0xb6a276],
  [150, 0x7d8862],
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

/* Push a geometry's vertices around so no two boulders are the same boulder. */
function jitterGeometry(geo, rng, amount) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const k = 1 + randRange(rng, -amount, amount);
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.82, pos.getZ(i) * k);
  }
  geo.computeVertexNormals();
  return geo;
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

/* A branching coral head: tapered tubes splitting twice. Low segment counts,
   because there will be hundreds of these and they are mostly silhouette. */
function buildCoral(rng, lowHex, highHex) {
  const segs = [];
  const grow = (origin, dir, length, radius, level) => {
    const tube = new THREE.CylinderGeometry(radius * 0.6, radius, length, 5, 1, true);
    tube.translate(0, length / 2, 0);
    _q1.setFromUnitVectors(UP, dir);
    _m1.compose(origin, _q1, ONE);
    tube.applyMatrix4(_m1);
    segs.push(tube);
    if (level <= 0) return;
    const tip = origin.clone().addScaledVector(dir, length * 0.96);
    const forks = 2 + rng.randrange(2);
    for (let i = 0; i < forks; i += 1) {
      const axis = new THREE.Vector3(
        randRange(rng, -1, 1),
        randRange(rng, -0.3, 0.3),
        randRange(rng, -1, 1),
      ).normalize();
      const next = dir.clone().applyAxisAngle(axis, randRange(rng, 0.34, 0.86));
      next.y = Math.abs(next.y) * 0.65 + 0.35;
      next.normalize();
      grow(tip, next, length * randRange(rng, 0.56, 0.78), radius * 0.62, level - 1);
    }
  };
  grow(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(randRange(rng, -0.12, 0.12), 1, randRange(rng, -0.12, 0.12)).normalize(),
    randRange(rng, 1.05, 1.7),
    randRange(rng, 0.15, 0.23),
    2,
  );
  return paintByHeight(mergeGeos(segs), lowHex, highHex, 0.18);
}

/* A sea fan: one flat blade, waisted at the stalk, bowed out of plane so it
   catches the light edge-on instead of vanishing. */
function buildFan(rng, lowHex, highHex) {
  const geo = new THREE.PlaneGeometry(1.5, 1.9, 6, 7);
  geo.translate(0, 0.95, 0);
  const pos = geo.attributes.position;
  const bow = randRange(rng, 0.16, 0.34);
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    const t = clamp01(y / 1.9);
    // Narrow at the holdfast, widest around two thirds up, rounded at the top.
    const width = Math.sin(Math.pow(t, 0.62) * Math.PI * 0.92) * 1.05 + 0.08;
    pos.setX(i, pos.getX(i) * width);
    pos.setZ(i, Math.sin(t * 2.1) * bow);
  }
  geo.computeVertexNormals();
  return paintByHeight(geo, lowHex, highHex, 0.14);
}

/* A kelp blade: a ribbon that already leans, so a clump of them at slightly
   different yaws reads as a current even before anything moves. */
function buildKelpBlade(rng) {
  const height = randRange(rng, 9, 17);
  const geo = new THREE.PlaneGeometry(0.52, height, 1, 8);
  geo.translate(0, height / 2, 0);
  const pos = geo.attributes.position;
  const lean = randRange(rng, 0.08, 0.2);
  for (let i = 0; i < pos.count; i += 1) {
    const t = clamp01(pos.getY(i) / height);
    pos.setX(i, pos.getX(i) * (0.45 + 1.15 * Math.sin(Math.pow(t, 0.7) * Math.PI * 0.85)));
    pos.setZ(i, pos.getZ(i) + t * t * height * lean);
  }
  geo.computeVertexNormals();
  return paintByHeight(geo, 0x16351f, 0x6f9a44, 0.22);
}

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
    this._buildSurface();
    this._buildGodRays();
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

    let depth = lerp(SEA.shelfDepth, SEA.trenchDepth, profileFraction(r));

    // Rolling relief. The floor gets more violent as it gets deeper.
    const relief = lerp(6, 78, smoothstep(120, 1200, r));
    depth += fbm2D(s, x * 0.00192, z * 0.00192, 4) * relief;

    // Reef spines near the top, rock ridges further out.
    const spine = lerp(9, 48, smoothstep(90, 900, r));
    depth -= (ridge2D((s ^ 0x9e3779b9) >>> 0, x * 0.0033, z * 0.0033, 3) - 0.45) * spine;

    // Coarse grain — deliberately no finer than the mesh can carry.
    depth += fbm2D((s + 4409) >>> 0, x * 0.0125, z * 0.0125, 2) * 3.4;

    // A winding canyon, rotated by the phrase, cut deeper the further out it
    // runs. It keeps its distance from the station so the approach stays flyable.
    const across = x * this.canyonCos - z * this.canyonSin;
    const along = x * this.canyonSin + z * this.canyonCos;
    const meander =
      Math.sin(along * 0.0028 + this.canyonPhaseA) * this.canyonAmpA +
      Math.sin(along * 0.0011 + this.canyonPhaseB) * this.canyonAmpB;
    const halfWidth = 130 + Math.sin(along * 0.0017 + this.canyonPhaseC) * 46;
    const across0 = Math.abs(across - meander);
    const cut = 1 - smootherstep(halfWidth * 0.22, halfWidth, across0);
    if (cut > 0) {
      const sx = x - this.stationPosition.x;
      const sz = z - this.stationPosition.z;
      const clearStation = smoothstep(190, 560, Math.sqrt(sx * sx + sz * sz));
      depth += cut * clearStation * (105 + 330 * smoothstep(300, 1300, r));
    }

    // Flatten a pad under the Hull. Applied last so the canyon cannot eat it.
    const dx = x - this.stationPosition.x;
    const dz = z - this.stationPosition.z;
    const pad = 1 - smootherstep(75, 265, Math.sqrt(dx * dx + dz * dz));
    if (pad > 0) depth = lerp(depth, SEA.shelfDepth, pad * 0.92);

    return -depth;
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
    this.terrain.matrixAutoUpdate = false;
    this.terrain.updateMatrix();
    this.terrain.receiveShadow = false;
    this.group.add(this.terrain);
  }

  /* Bilinear read of the grid the mesh was built from. Fast enough to call a
     few hundred times a frame, and exact against what you can see. */
  heightAt(x, z) {
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

  _buildSurface() {
    this.surfaceGroup = new THREE.Group();
    this.surfaceGroup.matrixAutoUpdate = false;

    const geo = this._geo(new THREE.PlaneGeometry(2800, 2800, 40, 40));
    geo.rotateX(Math.PI / 2);          // faces down, which is the only way we see it
    this.surfaceGeometry = geo;
    this.surfaceBase = Float32Array.from(geo.attributes.position.array);

    this.surfaceMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0x9fd9e8,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: true,
    }));
    this.surfaceMesh = new THREE.Mesh(geo, this.surfaceMaterial);
    this.surfaceMesh.renderOrder = -2;
    this.surfaceGroup.add(this.surfaceMesh);

    /* A second sheet just below, carrying the caustics, scrolling the other
       way. Two speeds is the whole trick: one is a texture, two is water. */
    const causticGeo = this._geo(new THREE.PlaneGeometry(2800, 2800, 1, 1));
    causticGeo.rotateX(Math.PI / 2);
    causticGeo.translate(0, -0.8, 0);
    const causticMap = this.causticTexture.clone();
    causticMap.wrapS = THREE.RepeatWrapping;
    causticMap.wrapT = THREE.RepeatWrapping;
    causticMap.repeat.set(26, 26);
    causticMap.needsUpdate = true;
    this.causticMap = this._track(causticMap, this._textures);
    this.causticMaterial = this._mat(new THREE.MeshBasicMaterial({
      map: causticMap,
      color: 0xcdf3ff,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }));
    this.causticMesh = new THREE.Mesh(causticGeo, this.causticMaterial);
    this.causticMesh.renderOrder = -1;
    this.surfaceGroup.add(this.causticMesh);

    this.group.add(this.surfaceGroup);
  }

  _buildGodRays() {
    this.rayRig = new THREE.Group();
    this.rayRig.position.set(0, -70, 0);

    const geo = this._geo(new THREE.ConeGeometry(30, 190, 6, 1, true));
    /* Bright where it enters the water, gone before it reaches the floor. */
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      const t = clamp01((pos.getY(i) + 95) / 190);
      const v = Math.pow(t, 2.1);
      colors[i * 3] = v;
      colors[i * 3 + 1] = v;
      colors[i * 3 + 2] = v;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    this.rayMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0xbfe6ff,
      vertexColors: true,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: true,
    }));

    this.rays = [];
    const rng = makeRng(this.seed, "godrays");
    for (let i = 0; i < 6; i += 1) {
      const mesh = new THREE.Mesh(geo, this.rayMaterial);
      const a = (i / 6) * TAU + rng.random() * 0.6;
      const rad = randRange(rng, 18, 62);
      mesh.position.set(Math.cos(a) * rad, randRange(rng, -12, 18), Math.sin(a) * rad);
      mesh.rotation.set(randRange(rng, -0.13, 0.13), rng.random() * TAU, randRange(rng, -0.13, 0.13));
      mesh.scale.set(randRange(rng, 0.6, 1.35), randRange(rng, 0.8, 1.25), randRange(rng, 0.6, 1.35));
      mesh.renderOrder = 2;
      this.rays.push({ mesh, spin: randRange(rng, -0.045, 0.045) });
      this.rayRig.add(mesh);
    }
    this.group.add(this.rayRig);
  }

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
    this.swayers = [];

    this._buildCoralField();
    this._buildFanField();
    this._buildKelpField();
    this._buildWormField();
    this._buildPolypField();
    this._buildRockField();
    this._buildWreckField();
  }

  _buildCoralField() {
    const rng = makeRng(this.seed, "coral");
    const root = new THREE.Group();
    root.name = "coral";
    const material = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      fog: true,
    }));
    const palettes = [
      [0x2d1c2a, 0xe08a7a],
      [0x1b2a2c, 0x7fd8c4],
      [0x2b2417, 0xe2c073],
    ];
    /* Three draw calls whatever the count, so density is nearly free here.
       At 150 each the shelf read as bare sand — a reef has to look like one. */
    const per = 620;
    for (let v = 0; v < palettes.length; v += 1) {
      const geo = this._geo(buildCoral(rng, palettes[v][0], palettes[v][1]));
      const mesh = new THREE.InstancedMesh(geo, material, per);
      mesh.frustumCulled = false;
      let i = 0;
      this._scatter(rng, per, 14, 140, 0.78, 34, (x, y, z, depth, normal) => {
        const s = randRange(rng, 0.7, 2.3) * lerp(1.15, 0.7, smoothstep(20, 140, depth));
        _e1.set(randRange(rng, -0.16, 0.16), rng.random() * TAU, randRange(rng, -0.16, 0.16));
        _q1.setFromEuler(_e1);
        _v1.set(x, y - 0.2, z);
        _v2.set(s, s * randRange(rng, 0.85, 1.3), s);
        _m1.compose(_v1, _q1, _v2);
        mesh.setMatrixAt(i, _m1);
        _c1.setHex(0xffffff).multiplyScalar(randRange(rng, 0.72, 1.2));
        mesh.setColorAt(i, _c1);
        i += 1;
      });
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      root.add(mesh);
    }
    this._addLayer(root, 0, 150);
  }

  _buildFanField() {
    const rng = makeRng(this.seed, "fans");
    const root = new THREE.Group();
    root.name = "fans";
    const material = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.7,
      metalness: 0,
      side: THREE.DoubleSide,
      fog: true,
    }));
    const geo = this._geo(buildFan(rng, 0x241a26, 0xd3708f));

    /* Fans live in clumps so a clump can sway as one object — twelve matrix
       writes a frame instead of three hundred. */
    /* One draw call per clump, and the layer only draws above 130 m, so this
       can afford to be a real field. Twelve clumps put the nearest fan most of
       a kilometre away, which is the same as having none. */
    const clumps = 130;
    const per = 26;
    const centres = [];
    this._scatter(rng, clumps, 16, 120, 0.8, 60, (x, y, z) => {
      centres.push([x, y, z]);
    });
    for (const [cx, cy, cz] of centres) {
      const pivot = new THREE.Group();
      pivot.position.set(cx, cy, cz);
      const mesh = new THREE.InstancedMesh(geo, material, per);
      mesh.frustumCulled = false;
      let i = 0;
      for (let k = 0; k < per; k += 1) {
        const a = rng.random() * TAU;
        const rad = Math.sqrt(rng.random()) * 11;
        const x = cx + Math.cos(a) * rad;
        const z = cz + Math.sin(a) * rad;
        const y = this.heightAt(x, z);
        if (-y < 8) continue;
        const s = randRange(rng, 0.8, 2.1);
        _e1.set(randRange(rng, -0.2, 0.2), rng.random() * TAU, randRange(rng, -0.2, 0.2));
        _q1.setFromEuler(_e1);
        _v1.set(x - cx, y - cy - 0.15, z - cz);
        _v2.set(s, s * randRange(rng, 0.9, 1.4), s);
        _m1.compose(_v1, _q1, _v2);
        mesh.setMatrixAt(i, _m1);
        _c1.setHex(0xffffff).multiplyScalar(randRange(rng, 0.7, 1.25));
        mesh.setColorAt(i, _c1);
        i += 1;
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      pivot.add(mesh);
      root.add(pivot);
      this.swayers.push({
        obj: pivot,
        phase: rng.random() * TAU,
        rate: randRange(rng, 0.35, 0.6),
        amp: randRange(rng, 0.02, 0.045),
        active: false,
      });
    }
    this._addLayer(root, 0, 130);
  }

  _buildKelpField() {
    const rng = makeRng(this.seed, "kelp");
    const root = new THREE.Group();
    root.name = "kelp";
    const material = this._mat(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0,
      side: THREE.DoubleSide,
      fog: true,
    }));

    /* Four blade shapes shared across every clump: enough variety to break the
       repeat, few enough that the GPU keeps them all resident. */
    const blades = [];
    for (let i = 0; i < 4; i += 1) blades.push(this._geo(buildKelpBlade(rng)));

    const centres = [];
    this._scatter(rng, 165, 70, 260, 0.78, 70, (x, y, z) => centres.push([x, y, z]));

    /* One blade shape per clump rather than all four: the variety moves from
       inside a clump to between clumps, and a stand of kelp costs one draw call
       instead of four. That is what pays for there being enough of them to
       deserve the name Kelp Cathedral. */
    for (const [cx, cy, cz] of centres) {
      const pivot = new THREE.Group();
      pivot.position.set(cx, cy, cz);
      {
        const b = rng.randrange(blades.length);
        const per = 40;
        const mesh = new THREE.InstancedMesh(blades[b], material, per);
        mesh.frustumCulled = false;
        let i = 0;
        for (let k = 0; k < per; k += 1) {
          const a = rng.random() * TAU;
          const rad = Math.sqrt(rng.random()) * 12;
          const x = cx + Math.cos(a) * rad;
          const z = cz + Math.sin(a) * rad;
          const y = this.heightAt(x, z);
          const s = randRange(rng, 0.72, 1.5);
          _e1.set(randRange(rng, -0.07, 0.07), rng.random() * TAU, randRange(rng, -0.07, 0.07));
          _q1.setFromEuler(_e1);
          _v1.set(x - cx, y - cy - 0.4, z - cz);
          _v2.set(s, s * randRange(rng, 0.8, 1.35), s);
          _m1.compose(_v1, _q1, _v2);
          mesh.setMatrixAt(i, _m1);
          _c1.setHex(0xffffff).multiplyScalar(randRange(rng, 0.6, 1.25));
          mesh.setColorAt(i, _c1);
          i += 1;
        }
        mesh.count = i;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        pivot.add(mesh);
      }
      root.add(pivot);
      this.swayers.push({
        obj: pivot,
        phase: rng.random() * TAU,
        rate: randRange(rng, 0.22, 0.4),
        amp: randRange(rng, 0.035, 0.075),
        active: false,
      });
    }
    this._addLayer(root, 60, 280);
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
    const shapes = [];
    for (let i = 0; i < 3; i += 1) {
      const geo = jitterGeometry(new THREE.IcosahedronGeometry(1, 1), rng, 0.34);
      shapes.push(this._geo(paintByHeight(geo, 0x0e1116, 0x6a6a63, 0.2)));
    }
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

  _buildStation() {
    const root = new THREE.Group();
    root.name = "hull-station";
    root.position.copy(this.stationPosition);

    const shell = this._mat(new THREE.MeshStandardMaterial({
      color: 0x4a5258,
      roughness: 0.62,
      metalness: 0.55,
      fog: true,
    }));
    const trim = this._mat(new THREE.MeshStandardMaterial({
      color: 0x2a3036,
      roughness: 0.8,
      metalness: 0.3,
      fog: true,
    }));
    const warm = this._mat(new THREE.MeshStandardMaterial({
      color: 0x120d07,
      emissive: 0xffb765,
      emissiveIntensity: 2.4,
      roughness: 0.4,
      metalness: 0,
      fog: true,
    }));

    /* Body: a pressure hull lying along Z, so the docking ring faces the way
       you naturally fly in from the shelf. */
    const body = new THREE.Mesh(this._geo(new THREE.CapsuleGeometry(7, 20, 6, 18)), shell);
    body.rotation.x = Math.PI / 2;
    root.add(body);

    const collarGeo = this._geo(new THREE.TorusGeometry(7.3, 0.7, 6, 22));
    for (const z of [-8, -2, 4]) {
      const collar = new THREE.Mesh(collarGeo, trim);
      collar.position.z = z;
      root.add(collar);
    }

    /* Docking ring — the thing you aim at. */
    const ring = new THREE.Mesh(this._geo(new THREE.TorusGeometry(12, 1.6, 8, 30)), shell);
    ring.position.z = 17;
    root.add(ring);

    this.ringGlowMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0x7fe6ff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    }));
    const ringGlow = new THREE.Mesh(this._geo(new THREE.TorusGeometry(12, 2.6, 6, 30)), this.ringGlowMaterial);
    ringGlow.position.z = 17;
    ringGlow.renderOrder = 2;
    root.add(ringGlow);
    this.ringGlow = ringGlow;

    /* Windows: two rows of warm portholes, merged into one draw. */
    const ports = [];
    for (let i = 0; i < 7; i += 1) {
      const z = -9 + i * 3.1;
      for (const side of [-1, 1]) {
        const disc = new THREE.CircleGeometry(0.78, 10);
        disc.rotateY(side * Math.PI * 0.5);
        disc.translate(side * 6.95, randRange(makeRng(this.seed, "port", i, side), -1.4, 1.4), z);
        ports.push(disc);
      }
    }
    const portGeo = this._geo(mergeGeos(ports));
    const windows = new THREE.Mesh(portGeo, warm);
    root.add(windows);

    /* Legs down to whatever floor is actually under us. */
    const legGeo = this._geo(new THREE.CylinderGeometry(0.5, 0.8, 1, 6, 1, true));
    for (let i = 0; i < 4; i += 1) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const lx = Math.cos(a) * 8.5;
      const lz = Math.sin(a) * 10.5;
      const floor = this.heightAt(this.stationPosition.x + lx, this.stationPosition.z + lz);
      const len = Math.max(2, this.stationPosition.y - 4 - floor);
      const leg = new THREE.Mesh(legGeo, trim);
      leg.position.set(lx, -4 - len / 2, lz);
      leg.scale.set(1, len, 1);
      leg.rotation.x = lz * 0.008;
      leg.rotation.z = -lx * 0.008;
      root.add(leg);
    }

    /* Beacon mast. The sprite ignores fog on purpose — it is the one light in
       this sea that is supposed to find you before you find it. */
    const mast = new THREE.Mesh(this._geo(new THREE.CylinderGeometry(0.4, 0.6, 14, 6, 1, true)), trim);
    mast.position.y = 11;
    root.add(mast);

    this.beaconMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.95,
      fog: true,
    }));
    this.beacon = new THREE.Mesh(this._geo(new THREE.SphereGeometry(1.1, 10, 8)), this.beaconMaterial);
    this.beacon.position.y = 18.4;
    root.add(this.beacon);

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
    this.beaconSprite.position.y = 18.4;
    this.beaconSprite.scale.set(22, 22, 1);
    this.beaconSprite.renderOrder = 6;
    root.add(this.beaconSprite);

    /* Floodlights: one real lamp for the warmth, three additive cones for the
       beams. Three spotlights would look the same and cost ten times as much. */
    this.stationLight = new THREE.PointLight(0xffc98a, 600, 130, 1.8);
    this.stationLight.position.set(0, 2, 6);
    root.add(this.stationLight);

    this.floodMaterial = this._mat(new THREE.MeshBasicMaterial({
      color: 0xffd7a8,
      transparent: true,
      opacity: 0.075,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: true,
    }));
    const floodGeo = this._geo(new THREE.ConeGeometry(11, 38, 8, 1, true));
    this.floods = [];
    for (let i = 0; i < 3; i += 1) {
      const a = (i / 3) * TAU + 0.6;
      const flood = new THREE.Mesh(floodGeo, this.floodMaterial);
      flood.position.set(Math.cos(a) * 5, -19, Math.sin(a) * 6);
      flood.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
      flood.renderOrder = 2;
      root.add(flood);
      this.floods.push(flood);
    }

    root.updateMatrix();
    root.matrixAutoUpdate = false;
    this.station = root;
    this.group.add(root);
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
    /* And the ceiling: the surface is not an exit. */
    const ceiling = SEA.surfaceY - 2.5;
    if (position.y > ceiling) {
      position.y = ceiling;
      if (velocity && velocity.y > 0) velocity.y *= -0.15;
      pushed = true;
    }
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

    this.surfaceMaterial.color.copy(p.water).lerp(_c1.setHex(0xffffff), 0.62);
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

    this._updateSnow(dt, cam, depth);
    this._updateSurface(dt, cam, depth);
    this._updateRays(dt, cam, depth);
    this._updateSway(t, cam);
    this._updateStation(t, cam);
    this._updateLayers(depth);
  }

  _updateSnow(dt, cam, depth) {
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

  _updateSurface(dt, cam, depth) {
    /* Below the twilight there is nothing up there worth drawing. */
    const visible = depth < 240;
    this.surfaceGroup.visible = visible;
    if (!visible) return;

    /* Light does not reach far. Caustics belong to the first few tens of
       metres; past that the tiled pattern reads as a ceiling texture, which is
       exactly the illusion the fog is supposed to be selling against. */
    const fade = 1 - smoothstep(60, 220, depth);
    const lit = 1 - smoothstep(18, 95, depth);
    this.surfaceMaterial.opacity = 0.5 * fade;
    this.causticMaterial.opacity = 0.34 * lit * lit;

    this.causticMap.offset.x = (this.time * 0.008) % 1;
    this.causticMap.offset.y = (this.time * 0.0054) % 1;

    /* Displace the low-res sheet. Three waves is enough to stop it reading as
       a ceiling; it is a basic material, so normals do not need redoing. */
    const pos = this.surfaceGeometry.attributes.position;
    const base = this.surfaceBase;
    const t = this.time;
    for (let i = 0; i < pos.count; i += 1) {
      const k = i * 3;
      const x = base[k];
      const z = base[k + 2];
      const y = Math.sin(x * 0.021 + t * 0.62) * 1.5
        + Math.sin(z * 0.029 - t * 0.48) * 1.1
        + Math.sin((x + z) * 0.012 + t * 0.31) * 1.9;
      pos.array[k + 1] = y;
    }
    pos.needsUpdate = true;
  }

  _updateRays(dt, cam, depth) {
    const fade = 1 - smoothstep(45, 120, depth);
    const visible = fade > 0.01;
    this.rayRig.visible = visible;
    if (!visible) return;
    this.rayMaterial.opacity = 0.085 * fade;
    /* Drift the whole rig toward the camera instead of snapping it — shafts of
       light that teleport are worse than no shafts at all. */
    this.rayRig.position.x = damp(this.rayRig.position.x, cam.x, 0.6, dt);
    this.rayRig.position.z = damp(this.rayRig.position.z, cam.z, 0.6, dt);
    for (const ray of this.rays) {
      ray.mesh.rotation.y += ray.spin * dt;
    }
  }

  _updateSway(t, cam) {
    for (const s of this.swayers) {
      const obj = s.obj;
      const dx = obj.position.x - cam.x;
      const dz = obj.position.z - cam.z;
      const near = dx * dx + dz * dz < SWAY_RANGE * SWAY_RANGE;
      if (!near) {
        if (s.active) {
          obj.rotation.set(0, 0, 0);
          s.active = false;
        }
        continue;
      }
      s.active = true;
      const a = t * s.rate + s.phase;
      obj.rotation.x = Math.sin(a) * s.amp;
      obj.rotation.z = Math.cos(a * 0.77 + 1.3) * s.amp * 0.8;
    }
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

    this.ringGlowMaterial.opacity = lerp(0.28, 0.62, 0.5 + 0.5 * Math.sin(t * 0.9 + 1.1));
    this.floodMaterial.opacity = 0.06 + 0.02 * Math.sin(t * 0.6);
    this.stationLight.intensity = lerp(520, 700, breath);

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
    this.swayers = [];
    this.rays = [];
    this.heights = null;
    this.snowPositions = null;
    this.snowFall = null;
    this.flowA = null;
    this.flowB = null;
  }
}
