/* The shoals. Every fish down here is one word of the phrase, grown through a
   short lineage by the aquarium's own genetics, and priced by how far from the
   light you were willing to go to net it. */

import * as THREE from "three";

import { ZONES, zoneForDepth, zoneIndex } from "./config.js";
import { clamp, clamp01, damp, lerp, makeRng } from "./util.js";
import { blade, disposeTree, mergeGeometries, spindle } from "./geo.js";

const MAX_FISH = 360;
const SHOAL_MIN = 4;
const SHOAL_MAX = 22;
const SPAWN_MIN = 12;          // metres from the sub — close enough to matter
const SPAWN_MAX = 72;
const DESPAWN = 165;
const SPAWN_INTERVAL = 0.45;   // seconds between spawn attempts
const NEIGHBOUR_CAP = 10;      // separation checks per fish, for O(n) sanity
const FLOOR_CLEARANCE = 1.6;

// Scratch. Nothing in the per-frame path may allocate.
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _flow = new THREE.Vector3();
const _colour = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3(0, 0, 1);

let nextFishId = 1;

/* ------------------------------------------------------------- body plans --
   One geometry per kind, built once and shared by every species that wears it.
   Bodies point down +Z, are one metre nose to tail, and are centred on the
   origin so an instance matrix is just position + rotation + scale. */

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

function bodyForKind(kind) {
  const parts = [];

  if (kind === "eel") {
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
  } else if (kind === "catfish") {
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
  } else if (kind === "angel") {
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
  } else if (kind === "betta") {
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
  } else if (kind === "guppy") {
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
  } else {
    // tetra — a quick little wedge, the default
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

  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

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

    this.perSpecies = Math.max(24, Math.ceil(MAX_FISH / Math.max(1, this.species.length)) + 16);
    this.meshes = this.species.map((sp) => this._buildMesh(sp));
    this._counts = new Array(this.species.length).fill(0);

    this.glow = this._buildGlowLayer();
  }

  /* ------------------------------------------------------------- building */

  _geometryFor(kind) {
    if (!this.geometries.has(kind)) this.geometries.set(kind, bodyForKind(kind));
    return this.geometries.get(kind);
  }

  _buildMesh(sp) {
    const geometry = this._geometryFor(sp.kind);
    const material = new THREE.MeshStandardMaterial({
      color: sp.colorHex,
      roughness: 0.44,
      metalness: 0.12,
      emissive: sp.glowHex,
      // Deep species carry their own light; shelf species only borrow yours.
      emissiveIntensity: lerp(0.04, 1.25, clamp01(sp.glow)),
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, this.perSpecies);
    mesh.count = 0;
    mesh.frustumCulled = false;   // instances roam; the bounding sphere lies
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `shoal-${sp.name}`;
    // Seed instanceColor so setColorAt has somewhere to write later.
    _colour.setHex(sp.colorHex);
    for (let i = 0; i < this.perSpecies; i += 1) mesh.setColorAt(i, _colour);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.group.add(mesh);
    return mesh;
  }

  /* One additive sprite per glowing fish, so a lantern species reads as a
     smear of light long before its body resolves out of the fog. */
  _buildGlowLayer() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_FISH * 3), 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_FISH * 3), 3));
    geometry.setDrawRange(0, 0);
    const material = new THREE.PointsMaterial({
      size: 1.1,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
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
    const rng = this.rng;

    // A ring around the player, at a bearing we are not currently looking at
    // hard, so shoals do not materialise in the middle of the viewport.
    const angle = rng.random() * Math.PI * 2;
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
      centre: new THREE.Vector3(cx, cy, cz),
      target: new THREE.Vector3(cx, cy, cz),
      fish: [],
      phase: rng.random() * Math.PI * 2,
      wanderTimer: 0,
    };

    const spread = lerp(1.4, 5.5, 1 - sp.schooling) + size * 0.12;
    for (let i = 0; i < room; i += 1) {
      const individual = this.game.ecology.rollIndividual(sp, rng);
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
        heading: rng.random() * Math.PI * 2,
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
        beat: rng.random() * Math.PI * 2,
        bank: 0,
        panic: 0,
      };
      shoal.fish.push(fish);
      this.all.push(fish);
    }

    if (shoal.fish.length) this.shoals.push(shoal);
  }

  _countSpecies(index) {
    let n = 0;
    for (const f of this.all) if (f.species.index === index) n += 1;
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
        const at = this.all.indexOf(fish);
        if (at >= 0) this.all.splice(at, 1);
      }
      this.shoals.splice(i, 1);
    }
  }

  /* ------------------------------------------------------------ behaviour */

  update(dt) {
    this.time += dt;
    const sub = this.game.sub;
    if (!sub) return;

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = SPAWN_INTERVAL;
      this._despawn();
      if (this.all.length < this._targetCount() && this.shoals.length < 26) this._spawnShoal();
    }

    for (const shoal of this.shoals) this._updateShoal(shoal, dt, sub);
    this._writeInstances();
  }

  _updateShoal(shoal, dt, sub) {
    const sp = shoal.species;
    const list = shoal.fish;
    if (!list.length) return;

    // Centroid and mean heading, computed once and shared by the whole shoal.
    _v.set(0, 0, 0);
    _v2.set(0, 0, 0);
    for (const f of list) {
      _v.add(f.position);
      _v2.add(f.velocity);
    }
    shoal.centre.copy(_v).divideScalar(list.length);
    _v2.divideScalar(list.length);

    // The shoal itself wanders, so a school drifts as a body rather than
    // hovering around its spawn point forever.
    shoal.wanderTimer -= dt;
    if (shoal.wanderTimer <= 0) {
      shoal.wanderTimer = 4 + this.rng.random() * 7;
      const angle = this.rng.random() * Math.PI * 2;
      const reach = 8 + this.rng.random() * 22;
      shoal.target.set(
        shoal.centre.x + Math.cos(angle) * reach,
        shoal.centre.y + (this.rng.random() - 0.5) * 9,
        shoal.centre.z + Math.sin(angle) * reach,
      );
    }

    const world = this.game.world;
    /* Fear has to stay inside the beam's reach or the game is unfishable: the
       stock capture beam is 14 m, so a skittish fish must only bolt at about
       that, and creeping up with the lamps off must actually work. */
    const lit = sub.lightsOn ? 1.35 : 1;
    const rush = 1 + Math.min(1.1, sub.speed * 0.045);
    const fearRange = lerp(5.5, 15, sp.skittish) * lit * rush;
    const fear2 = fearRange * fearRange;
    const cohesion = 0.45 + sp.schooling * 1.5;
    const alignment = 0.25 + sp.schooling * 1.1;
    const separation = 2.6;
    const cruise = sp.speed;

    world.sampleFlow(shoal.centre, this.time, _flow);

    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      _v3.set(0, 0, 0);

      // Cohesion toward the shoal, and the shoal toward its wander target.
      _v.copy(shoal.centre).sub(f.position);
      const spread = _v.length();
      if (spread > 0.001) _v3.addScaledVector(_v.divideScalar(spread), cohesion * clamp01(spread / 6));
      _v.copy(shoal.target).sub(f.position);
      if (_v.lengthSq() > 0.001) _v3.addScaledVector(_v.normalize(), 0.55);

      // Alignment with the mean heading.
      _v3.addScaledVector(_v2, alignment * 0.12);

      // Separation — only against a handful of neighbours, striding the list
      // so every fish still eventually checks every other one.
      let checked = 0;
      for (let j = (i + 1) % list.length; checked < NEIGHBOUR_CAP && j !== i; j = (j + 1) % list.length) {
        checked += 1;
        const other = list[j];
        _v.copy(f.position).sub(other.position);
        const d2 = _v.lengthSq();
        const want = 0.9 + f.scale * 0.8;
        if (d2 > 0.0001 && d2 < want * want) {
          _v3.addScaledVector(_v.normalize(), separation * (1 - Math.sqrt(d2) / want));
        }
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
      // A fish being netted stops fighting the beam and is drawn in.
      if (f.capturing > 0) {
        _v.copy(sub.position).sub(f.position);
        const d = _v.length() || 0.001;
        _v3.addScaledVector(_v.divideScalar(d), f.capturing * 6);
      }
      f.panic = Math.max(0, f.panic - dt * 0.7);

      // Never swim into the floor, and never break the surface.
      const floor = world.heightAt(f.position.x, f.position.z);
      const clearance = f.position.y - floor;
      if (clearance < FLOOR_CLEARANCE * 2) {
        _v3.y += (FLOOR_CLEARANCE * 2 - clearance) * 1.8;
      }
      if (f.position.y > -1.2) _v3.y -= (f.position.y + 1.2) * 2.2;

      // Drift with the current, plus a private wander so no two fish in a
      // shoal ever trace quite the same line.
      f.beat += dt * (3.4 + cruise * 0.5);
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
    }
  }

  /* Rebuild the instance matrices. Every fish moves every frame, so there is
     nothing to be gained from tracking dirty ranges. */
  _writeInstances() {
    const counts = this._counts;
    counts.fill(0);

    const glowPos = this.glow.geometry.attributes.position;
    const glowCol = this.glow.geometry.attributes.color;
    let glowCount = 0;

    for (const f of this.all) {
      if (!f.alive) continue;
      const index = f.species.index;
      const mesh = this.meshes[index];
      if (!mesh) continue;
      const slot = counts[index];
      if (slot >= this.perSpecies) continue;
      counts[index] = slot + 1;

      // Face the direction of travel, wag the body, and roll into the turn.
      const speed = f.velocity.length();
      if (speed > 0.02) {
        _v.copy(f.velocity).divideScalar(speed);
        _q.setFromUnitVectors(_forward, _v);
      } else {
        _q.identity();
      }
      const wag = Math.sin(f.beat * (2.4 + speed * 0.6)) * (0.12 + Math.min(0.22, speed * 0.05));
      _q2.setFromAxisAngle(_up, wag);
      _q.multiply(_q2);
      _q2.setFromAxisAngle(_forward, f.bank);
      _q.multiply(_q2);

      const s = f.scale * (1 + f.capturing * 0.12);
      _scale.set(s, s, s);
      _m.compose(f.position, _q, _scale);
      mesh.setMatrixAt(slot, _m);

      // Mutants shimmer: lift the tint by how far the line has drifted.
      const shimmer = Math.min(0.42, f.mutations * 0.14);
      _colour.setHex(f.species.colorHex);
      if (shimmer > 0) _colour.lerp(_colour.clone().offsetHSL(0.08, 0.1, 0.22), shimmer);
      if (f.capturing > 0) _colour.lerp(_colour.clone().offsetHSL(0, -0.2, 0.35), f.capturing * 0.7);
      mesh.setColorAt(slot, _colour);

      if (f.species.glow > 0.25 && glowCount < MAX_FISH) {
        glowPos.setXYZ(glowCount, f.position.x, f.position.y, f.position.z);
        _colour.setHex(f.species.glowHex).multiplyScalar(0.35 + f.species.glow * 0.65);
        glowCol.setXYZ(glowCount, _colour.r, _colour.g, _colour.b);
        glowCount += 1;
      }
    }

    for (let i = 0; i < this.meshes.length; i += 1) {
      const mesh = this.meshes[i];
      mesh.count = counts[i];
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.glow.geometry.setDrawRange(0, glowCount);
    glowPos.needsUpdate = true;
    glowCol.needsUpdate = true;
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
     on whether the hold had room — combat.js defers to it. */
  capture(fish) {
    if (!fish || !fish.alive) return null;
    const sub = this.game.sub;
    const depth = sub ? sub.depth : 0;
    const species = fish.species;
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
      label: species.kind,
    };

    if (!sub || !sub.addCargo(item)) {
      this.game.bus.emit("fish:cargo-full", {});
      return null;
    }

    this._remove(fish);
    this.game.bus.emit("fish:captured", { item, fish });
    return item;
  }

  /* A harpooned fish is worth a fraction of a netted one: you get the meat,
     not the specimen. Called by combat.js through the bus, and by nothing else. */
  kill(fish) {
    if (!fish || !fish.alive) return 0;
    const worth = Math.max(1, Math.round(fish.value * 0.2));
    if (this.game.vfx) this.game.vfx.bloodCloud(fish.position, fish.species.colorHex);
    this._remove(fish);
    return worth;
  }

  _remove(fish) {
    fish.alive = false;
    fish.capturing = 0;
    const at = this.all.indexOf(fish);
    if (at >= 0) this.all.splice(at, 1);
    const shoal = fish.shoal;
    if (shoal) {
      const si = shoal.fish.indexOf(fish);
      if (si >= 0) shoal.fish.splice(si, 1);
    }
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
    }
  }

  countInZone(zoneId) {
    let n = 0;
    for (const f of this.all) if (f.alive && f.species.zoneId === zoneId) n += 1;
    return n;
  }

  dispose() {
    this.all.length = 0;
    this.shoals.length = 0;
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    disposeTree(this.group);
    if (this.game.scene) this.game.scene.remove(this.group);
  }
}
