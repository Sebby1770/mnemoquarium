/* Three ways to argue with the dark, and one quiet way to fill the hold.

   Everything that leaves the boat is pooled: harpoon bolts and torpedoes are
   allocated once at construction and recycled, so a long firefight never asks
   the collector for anything. Hit tests run against the *segment* travelled in
   a frame (creatures.raycast / fish.raycast) rather than the point the
   projectile happens to land on, because a 95 m/s bolt moves five metres
   between frames and would otherwise walk straight through a shark.

   The capture beam lives here too. It is not a weapon — it is the only thing in
   the game that makes money — but it hangs off the same trigger hand, so it
   shares the muzzle maths and the battery bookkeeping. */

import * as THREE from "three";
import { SEA, WEAPONS } from "./config.js";
import { clamp01, damp, lerp } from "./util.js";

/* 1 / 2 / 3 in the order sub.js sends them. */
const WEAPON_ORDER = ["harpoon", "torpedo", "pulse"];

const HARPOON_POOL = 28;
const TORPEDO_POOL = 8;
const TRAIL_POINTS = 12;

/* The bow tube sits a little below the window so the bolt is visible leaving
   the boat. It fires parallel to the aim line, never converging on it. */
const MUZZLE_FORWARD = 2.9;
const MUZZLE_DROP = 0.36;

/* Not in config.js because it is a feel number, not a balance number. */
const PULSE_HALF_ANGLE = 0.46;      // radians, ~26 degrees each side
const PULSE_FLASH_TIME = 0.45;

const TORPEDO_ARM_DISTANCE = 7;     // metres before the fuse wakes up
const TORPEDO_SPIN_UP = 3.2;        // how fast it reaches cruise speed
const TORPEDO_LAUNCH_FRACTION = 0.45;

const BEAM_DRAIN = 2.4;             // battery/sec while the beam is lit
const BEAM_CONE = Math.cos(0.34);   // ~20 degrees of forgiveness around centre
const BEAM_HOLD_CONE = Math.cos(0.52);  // wider, once a fish is already lit
const BEAM_HOLD_SLACK = 1.25;           // and a little further, too
const BEAM_FADE = 11;               // damp rate for the beam's visual envelope
const BEAM_DECAY = 2.4;             // how fast held progress bleeds off target
const SPARKLE_INTERVAL = 0.07;

const DENY_INTERVAL = 0.5;          // do not machine-gun the refusal noise
const TERRAIN_STEP = 2.0;           // seabed sampling stride along a step
const FISH_PIERCE_TIME = 0.12;      // ignore fish briefly after punching one

const FORWARD_Z = new THREE.Vector3(0, 0, 1);

/* Scratch. Nothing in the per-frame path may allocate. */
const _muzzle = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _next = new THREE.Vector3();
const _point = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _end = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _quatB = new THREE.Quaternion();
const _tint = new THREE.Color();
const _beamEye = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const _beamTo = new THREE.Vector3();

const CAPTURE_TINT = new THREE.Color(0xa8ecff);

export class Combat {
  constructor(game) {
    this.game = game;

    this.group = new THREE.Group();
    this.group.name = "combat";
    game.scene.add(this.group);

    /* Disposal ledgers — anything we make, we free. */
    this._geometries = [];
    this._materials = [];

    /* Live weapon rack. The HUD renders straight off this array, so the four
       contracted keys are kept honest every frame: `cooldown` is the seconds
       still to wait, `ready` is whether the trigger would do anything. */
    this.weapons = WEAPON_ORDER.map((id, i) => {
      const spec = WEAPONS[id];
      return {
        id,
        name: spec.name,
        ammo: Infinity,
        cooldown: 0,
        ready: true,
        cooldownMax: spec.cooldown,
        charge: 1,
        locked: false,
        selected: i === 0,
        key: String(i + 1),
        cost: spec.cost || 0,
        color: spec.color,
      };
    });
    this.currentIndex = 0;
    this.currentWeapon = this.weapons[0];

    this.beamTarget = null;
    this.beamProgress = 0;
    this.beamActive = false;

    this.time = 0;
    this._cooldowns = this.weapons.map(() => 0);
    this._lastDeny = -10;
    this._sparkTimer = 0;
    this._beamAmount = 0;
    this._beamEnd = new THREE.Vector3();
    this._pulseFlash = 0;
    this._taughtBolts = false;

    this._buildMaterials();
    this._buildProjectiles();
    this._buildBeam();
    this._buildPulseCone();
  }

  // --------------------------------------------------------------- building

  _track(thing) {
    if (thing && thing.isBufferGeometry) this._geometries.push(thing);
    else if (thing && thing.isMaterial) this._materials.push(thing);
    return thing;
  }

  _buildMaterials() {
    /* Bolts read as hot metal, so they are opaque and unlit; the trail behind
       them is additive so it glows through the fog instead of smearing it. */
    this.matBolt = this._track(new THREE.MeshBasicMaterial({
      color: WEAPONS.harpoon.color,
      toneMapped: false,
    }));
    this.matBoltTrail = this._track(new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.matTorpedoBody = this._track(new THREE.MeshBasicMaterial({
      color: 0x39424f,
    }));
    this.matTorpedoGlow = this._track(new THREE.MeshBasicMaterial({
      color: WEAPONS.torpedo.color,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }));
    this.matTorpedoTrail = this._track(new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.matBeam = this._track(new THREE.MeshBasicMaterial({
      color: CAPTURE_TINT.getHex(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    this.matBeamRing = this._track(new THREE.MeshBasicMaterial({
      color: CAPTURE_TINT.getHex(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
    this.matPulse = this._track(new THREE.MeshBasicMaterial({
      color: WEAPONS.pulse.color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    }));
  }

  /* A line of TRAIL_POINTS world-space samples, darkest at the tail. Additive
     blending turns a black vertex into nothing, so the ramp is the fade. */
  _makeTrail(colorHex, material) {
    const geo = this._track(new THREE.BufferGeometry());
    const positions = new Float32Array(TRAIL_POINTS * 3);
    const colors = new Float32Array(TRAIL_POINTS * 3);
    _tint.setHex(colorHex);
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      const t = i / (TRAIL_POINTS - 1);
      const k = t * t;   // the head carries almost all of the brightness
      colors[i * 3 + 0] = _tint.r * k;
      colors[i * 3 + 1] = _tint.g * k;
      colors[i * 3 + 2] = _tint.b * k;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const line = new THREE.Line(geo, material);
    line.frustumCulled = false;   // the bounding sphere is never recomputed
    line.visible = false;
    line.renderOrder = 2;
    this.group.add(line);
    return { line, positions, attribute: geo.getAttribute("position") };
  }

  _buildProjectiles() {
    /* Nose at +Z for both bodies, so a single setFromUnitVectors aims them. */
    this.geoBolt = this._track(
      new THREE.CylinderGeometry(0.09, 0.02, 1.5, 6).rotateX(-Math.PI / 2),
    );
    this.geoTorpedoBody = this._track(
      new THREE.CylinderGeometry(0.22, 0.15, 1.6, 10).rotateX(-Math.PI / 2),
    );
    this.geoTorpedoGlow = this._track(new THREE.SphereGeometry(0.26, 8, 6));

    this.projectiles = [];

    for (let i = 0; i < HARPOON_POOL; i += 1) {
      const mesh = new THREE.Mesh(this.geoBolt, this.matBolt);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      const trail = this._makeTrail(WEAPONS.harpoon.color, this.matBoltTrail);
      this.projectiles.push(this._blankProjectile("harpoon", mesh, trail));
    }

    for (let i = 0; i < TORPEDO_POOL; i += 1) {
      const body = new THREE.Mesh(this.geoTorpedoBody, this.matTorpedoBody);
      const glow = new THREE.Mesh(this.geoTorpedoGlow, this.matTorpedoGlow);
      glow.position.z = -0.95;
      const obj = new THREE.Group();
      obj.add(body);
      obj.add(glow);
      obj.visible = false;
      obj.frustumCulled = false;
      this.group.add(obj);
      const trail = this._makeTrail(WEAPONS.torpedo.color, this.matTorpedoTrail);
      this.projectiles.push(this._blankProjectile("torpedo", obj, trail));
    }
  }

  _blankProjectile(kind, object, trail) {
    return {
      kind,
      object,
      trail,
      active: false,
      position: new THREE.Vector3(),
      dir: new THREE.Vector3(0, 0, 1),
      speed: 0,
      life: 0,
      age: 0,
      travelled: 0,
      damage: 0,
      armed: true,
      pierce: 0,
      bubbleTimer: 0,
    };
  }

  _buildBeam() {
    /* A cone of light that is wide at the glass and narrow at the fish, so it
       reads as reaching out rather than spraying. Apex maths: wide end at the
       local origin, narrow end one unit down +Z, then scaled to the range. */
    this.geoBeam = this._track(
      new THREE.CylinderGeometry(0.52, 0.1, 1, 12, 1, true)
        .translate(0, -0.5, 0)
        .rotateX(-Math.PI / 2),
    );
    this.beam = new THREE.Mesh(this.geoBeam, this.matBeam);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 3;
    this.group.add(this.beam);

    this.geoBeamRing = this._track(new THREE.RingGeometry(0.52, 0.76, 26));
    this.beamRing = new THREE.Mesh(this.geoBeamRing, this.matBeamRing);
    this.beamRing.visible = false;
    this.beamRing.frustumCulled = false;
    this.beamRing.renderOrder = 4;
    this.group.add(this.beamRing);
  }

  _buildPulseCone() {
    /* Unit height with a base radius of tan(halfAngle), so scaling the mesh
       uniformly by the range keeps the drawn cone honest about what it hit. */
    this.geoPulse = this._track(
      new THREE.ConeGeometry(Math.tan(PULSE_HALF_ANGLE), 1, 22, 1, true)
        .translate(0, -0.5, 0)
        .rotateX(-Math.PI / 2),
    );
    this.pulseCone = new THREE.Mesh(this.geoPulse, this.matPulse);
    this.pulseCone.visible = false;
    this.pulseCone.frustumCulled = false;
    this.pulseCone.renderOrder = 3;
    this.group.add(this.pulseCone);
  }

  // ------------------------------------------------------------ small tools

  _sfx(name, opts) {
    const audio = this.game.audio;
    if (audio && audio.sfx) audio.sfx(name, opts);
  }

  _deny(text) {
    if (this.time - this._lastDeny < DENY_INTERVAL) return;
    this._lastDeny = this.time;
    this._sfx("deny");
    if (text && this.game.log) this.game.log(text, "warn");
  }

  /* Fills `outPos` with the bow tube and `outDir` with the aim line. */
  _muzzlePose(outPos, outDir) {
    const sub = this.game.sub;
    if (!sub) {
      outPos.set(0, 0, 0);
      outDir.set(0, 0, -1);
      return;
    }
    sub.forward(outDir);
    if (outDir.lengthSq() < 1e-8) outDir.set(0, 0, -1);
    outDir.normalize();
    outPos.copy(sub.position).addScaledVector(outDir, MUZZLE_FORWARD);
    if (sub.object) {
      sub.object.getWorldQuaternion(_quatB);
      _offset.set(0, -MUZZLE_DROP, 0).applyQuaternion(_quatB);
      outPos.add(_offset);
    }
  }

  // ---------------------------------------------------------------- weapons

  selectWeapon(i) {
    const index = Math.trunc(Number(i));
    if (!Number.isFinite(index) || index < 0 || index >= this.weapons.length) return;
    const weapon = this.weapons[index];
    if (this._lockedFor(weapon.id)) {
      this._deny("no tubes fitted. the drydock sells them.");
      return;
    }
    if (index === this.currentIndex) return;
    for (const w of this.weapons) w.selected = false;
    weapon.selected = true;
    this.currentIndex = index;
    this.currentWeapon = weapon;
    this._sfx("click");
  }

  _lockedFor(id) {
    if (id !== "torpedo") return false;
    const stats = this.game.stats;
    return !(stats && stats.torpedoUnlocked);
  }

  _ammoFor(id) {
    if (id !== "torpedo") return Infinity;
    const profile = this.game.profile;
    if (!profile || !profile.ammo) return 0;
    return Math.max(0, Number(profile.ammo.torpedo) || 0);
  }

  _syncWeapons() {
    for (let i = 0; i < this.weapons.length; i += 1) {
      const w = this.weapons[i];
      const cd = this._cooldowns[i];
      w.cooldown = cd;
      w.charge = w.cooldownMax > 0 ? clamp01(1 - cd / w.cooldownMax) : 1;
      w.ammo = this._ammoFor(w.id);
      w.locked = this._lockedFor(w.id);
      w.selected = i === this.currentIndex;
      w.ready = cd <= 0 && !w.locked && w.ammo > 0;
    }
    this.currentWeapon = this.weapons[this.currentIndex];
  }

  firePrimary() {
    const game = this.game;
    if (game.mode !== "dive" || !game.sub) return false;
    const index = this.currentIndex;
    const weapon = this.weapons[index];
    const spec = WEAPONS[weapon.id];
    if (!spec) return false;

    /* A hot barrel is not a failure, so it stays silent. Everything else that
       stops the shot says so out loud — a trigger that does nothing at all is
       the worst thing a submarine can do to you. */
    if (this._cooldowns[index] > 0) return false;

    if (this._lockedFor(weapon.id)) {
      this._deny("no tubes fitted. the drydock sells them.");
      return false;
    }
    if (this._ammoFor(weapon.id) <= 0) {
      this._deny("the tubes are empty.");
      return false;
    }

    const cost = spec.cost || 0;
    if (cost > 0 && !game.sub.drawBattery(cost)) {
      this._deny("the cell has nothing left to spend on that.");
      return false;
    }

    this._muzzlePose(_muzzle, _aim);

    let fired = false;
    if (weapon.id === "harpoon") fired = this._fireHarpoon(_muzzle, _aim);
    else if (weapon.id === "torpedo") fired = this._fireTorpedo(_muzzle, _aim);
    else if (weapon.id === "pulse") fired = this._firePulse(_muzzle, _aim);

    if (!fired) return false;

    this._cooldowns[index] = spec.cooldown;
    this._syncWeapons();
    game.bus.emit("combat:fire", {
      weapon: weapon.id,
      name: spec.name,
      cost,
      point: _muzzle.clone(),
    });
    return true;
  }

  _fireHarpoon(origin, dir) {
    const spec = WEAPONS.harpoon;
    const stats = this.game.stats;
    const p = this._acquire("harpoon");
    if (!p) return false;
    this._launch(p, origin, dir, spec.speed, spec.life);
    p.damage = (stats && stats.harpoonDamage) || spec.damage;
    p.armed = true;
    this._sfx("harpoon");
    if (this.game.vfx) this.game.vfx.bubbles(origin, 4, { spread: 0.5, rise: 0.7, size: 0.2, life: 0.8 });
    return true;
  }

  _fireTorpedo(origin, dir) {
    const spec = WEAPONS.torpedo;
    const profile = this.game.profile;
    const p = this._acquire("torpedo");
    if (!p) return false;
    this._launch(p, origin, dir, spec.speed * TORPEDO_LAUNCH_FRACTION, spec.life);
    p.damage = spec.damage;
    p.armed = false;   // the fuse wakes at TORPEDO_ARM_DISTANCE, not before
    if (profile && profile.ammo) {
      profile.ammo.torpedo = Math.max(0, (Number(profile.ammo.torpedo) || 0) - 1);
      if (this.game.persist) this.game.persist();
    }
    this._sfx("torpedo");
    if (this.game.vfx) this.game.vfx.bubbles(origin, 12, { spread: 0.9, rise: 1.1, size: 0.3, life: 1.4 });
    return true;
  }

  /* The Sonar Lance is hitscan: a single loud cone, resolved the instant the
     trigger falls. There is nothing to dodge, which is the point of paying
     nine percent of the cell for it. */
  _firePulse(origin, dir) {
    const spec = WEAPONS.pulse;
    const game = this.game;
    const creatures = game.creatures;
    const cos = Math.cos(PULSE_HALF_ANGLE);

    this.pulseCone.position.copy(origin);
    _quat.setFromUnitVectors(FORWARD_Z, dir);
    this.pulseCone.quaternion.copy(_quat);
    this.pulseCone.scale.setScalar(spec.range);
    this.pulseCone.visible = true;
    this._pulseFlash = 1;

    if (game.vfx) {
      game.vfx.sonarWave(origin, spec.range);
      game.vfx.screenShake(0.12);
    }
    this._sfx("sonar");

    if (game.fish) {
      _point.copy(origin).addScaledVector(dir, spec.range * 0.55);
      game.fish.scatter(_point, spec.range * 0.6, 16);
    }

    if (!creatures) return true;
    let struck = 0;
    for (const c of creatures.all) {
      if (!c || !c.alive) continue;
      _delta.subVectors(c.position, origin);
      const dist = _delta.length();
      const radius = c.radius || 2;
      if (dist > spec.range + radius) continue;
      const along = _delta.dot(dir);
      if (along < -radius) continue;
      /* Widen the cone by the body's own radius, so a leviathan filling the
         window is never "just outside" the lance. */
      const cosHit = dist > 1e-4 ? along / dist : 1;
      const slack = Math.min(0.45, radius / Math.max(1, dist) * 0.8);
      if (cosHit < cos - slack) continue;

      const fall = clamp01(1 - dist / (spec.range * 1.2));
      const amount = spec.damage * (0.55 + 0.45 * fall);
      _point.copy(c.position).addScaledVector(_delta.normalize(), -radius * 0.7);
      const killed = this._damageCreature(c, amount, "pulse", _point);
      if (!killed) {
        /* Stun is the lance's whole argument — make sure it lands even if the
           creature module keeps its own ideas about the opts bag. */
        c.stun = Math.max(Number(c.stun) || 0, spec.stun);
      }
      struck += 1;
    }
    if (struck > 0) this._sfx("hit");
    return true;
  }

  // ------------------------------------------------------------ projectiles

  _acquire(kind) {
    let oldest = null;
    for (const p of this.projectiles) {
      if (p.kind !== kind) continue;
      if (!p.active) return p;
      if (!oldest || p.age > oldest.age) oldest = p;
    }
    /* Pool exhausted: steal the one that has been in the water longest rather
       than dropping the shot the player paid for. */
    if (oldest) this._retire(oldest);
    return oldest;
  }

  _launch(p, origin, dir, speed, life) {
    p.active = true;
    p.position.copy(origin);
    p.dir.copy(dir).normalize();
    p.speed = speed;
    p.life = life;
    p.age = 0;
    p.travelled = 0;
    p.pierce = 0;
    p.bubbleTimer = 0;
    p.object.position.copy(origin);
    _quat.setFromUnitVectors(FORWARD_Z, p.dir);
    p.object.quaternion.copy(_quat);
    p.object.visible = true;

    const pos = p.trail.positions;
    for (let i = 0; i < TRAIL_POINTS; i += 1) {
      pos[i * 3 + 0] = origin.x;
      pos[i * 3 + 1] = origin.y;
      pos[i * 3 + 2] = origin.z;
    }
    p.trail.attribute.needsUpdate = true;
    p.trail.line.visible = true;
  }

  _retire(p) {
    p.active = false;
    p.object.visible = false;
    p.trail.line.visible = false;
  }

  _pushTrail(p) {
    const pos = p.trail.positions;
    pos.copyWithin(0, 3);          // drop the oldest sample
    const last = (TRAIL_POINTS - 1) * 3;
    pos[last + 0] = p.position.x;
    pos[last + 1] = p.position.y;
    pos[last + 2] = p.position.z;
    p.trail.attribute.needsUpdate = true;
  }

  _stepProjectiles(dt) {
    for (const p of this.projectiles) {
      if (!p.active) continue;
      p.age += dt;
      p.life -= dt;
      if (p.pierce > 0) p.pierce -= dt;

      if (p.kind === "torpedo") {
        /* It leaves the tube on compressed air and only then lights up. */
        p.speed = damp(p.speed, WEAPONS.torpedo.speed, TORPEDO_SPIN_UP, dt);
        p.bubbleTimer -= dt;
        if (p.bubbleTimer <= 0 && this.game.vfx) {
          p.bubbleTimer = 0.06;
          this.game.vfx.bubbles(p.position, 2, { spread: 0.25, rise: 0.6, size: 0.16, life: 1.1 });
        }
      }

      const stepLen = p.speed * dt;
      if (stepLen <= 0) continue;
      _prev.copy(p.position);
      _next.copy(_prev).addScaledVector(p.dir, stepLen);

      if (!this._resolveStep(p, stepLen)) continue;   // it hit something

      p.position.copy(_next);
      p.travelled += stepLen;
      if (!p.armed && p.travelled >= TORPEDO_ARM_DISTANCE) p.armed = true;

      p.object.position.copy(p.position);
      this._pushTrail(p);

      /* Out of time, out of the world, or through the roof of the sea. */
      if (p.life <= 0) {
        if (p.kind === "torpedo" && p.armed) this._detonate(p, p.position, null);
        else this._expire(p);
        continue;
      }
      if (p.position.y > SEA.surfaceY ||
          p.position.x * p.position.x + p.position.z * p.position.z > SEA.worldRadius * SEA.worldRadius * 1.44) {
        this._expire(p);
      }
    }
  }

  /* Returns true when the projectile survived the whole step. `_prev` holds
     where it started and `_next` where it wanted to end up. */
  _resolveStep(p, stepLen) {
    const game = this.game;
    let stopDist = Infinity;
    let stopCreature = null;

    if (game.creatures) {
      const hit = game.creatures.raycast(_prev, p.dir, stepLen);
      if (hit && hit.creature && hit.creature.alive && hit.distance <= stepLen) {
        stopDist = hit.distance;
        stopCreature = hit.creature;
        if (hit.point) _point.copy(hit.point);
        else _point.copy(_prev).addScaledVector(p.dir, hit.distance);
      }
    }

    const floor = this._terrainDistance(_prev, p.dir, Math.min(stepLen, stopDist));
    let stopTerrain = false;
    if (floor >= 0 && floor < stopDist) {
      stopDist = floor;
      stopCreature = null;
      stopTerrain = true;
      _point.copy(_prev).addScaledVector(p.dir, floor);
    }

    /* Bolts pass through fish — a shoal is not cover, and a bolt stopped by a
       tetra would make the harpoon useless in the only water worth fishing. */
    if (p.kind === "harpoon" && p.pierce <= 0 && game.fish) {
      const fishHit = game.fish.raycast(_prev, p.dir, Math.min(stepLen, stopDist));
      if (fishHit && fishHit.fish) {
        _probe.copy(fishHit.point || fishHit.fish.position);
        p.pierce = FISH_PIERCE_TIME;
        game.fish.scatter(_probe, 9, 12);
        if (game.vfx) {
          game.vfx.hitSpark(_probe, fishHit.fish.species ? fishHit.fish.species.colorHex : 0xffffff);
        }
        game.bus.emit("combat:hit", {
          kind: "fish",
          amount: 0,
          point: _probe.clone(),
          weapon: p.kind,
        });
        if (!this._taughtBolts && game.log) {
          this._taughtBolts = true;
          game.log("bolts do not fill the hold. the beam does.", "info");
        }
      }
    }

    if (stopDist === Infinity) return true;

    p.position.copy(_point);
    p.object.position.copy(_point);
    this._pushTrail(p);

    if (p.kind === "torpedo") {
      if (!p.armed) {
        /* A dud: it has not travelled far enough to be dangerous to anyone. */
        if (game.vfx) game.vfx.bubbles(_point, 8, { spread: 0.8, rise: 1.2, size: 0.25, life: 1.2 });
        this._expire(p);
        return false;
      }
      this._detonate(p, _point, stopCreature);
      return false;
    }

    if (stopCreature) {
      this._damageCreature(stopCreature, p.damage, p.kind, _point);
    } else if (stopTerrain) {
      if (game.vfx) {
        game.vfx.hitSpark(_point, 0xb9a78a);
        game.vfx.bubbles(_point, 3, { spread: 0.4, rise: 0.5, size: 0.18, life: 0.9 });
      }
      game.bus.emit("combat:hit", {
        kind: "terrain",
        amount: 0,
        point: _point.clone(),
        weapon: p.kind,
      });
    }
    this._expire(p);
    return false;
  }

  _expire(p) {
    this._retire(p);
  }

  /* Distance along the ray at which it meets the seabed, or -1. Marching then
     bisecting keeps the impact point on the surface instead of somewhere
     inside the hill. */
  _terrainDistance(origin, dir, maxDist) {
    const world = this.game.world;
    if (!world || !(maxDist > 0)) return -1;
    if (origin.y <= world.heightAt(origin.x, origin.z)) return 0;

    const steps = Math.min(10, Math.max(1, Math.ceil(maxDist / TERRAIN_STEP)));
    let lo = 0;
    for (let s = 1; s <= steps; s += 1) {
      const t = (maxDist * s) / steps;
      _probe.copy(origin).addScaledVector(dir, t);
      if (_probe.y <= world.heightAt(_probe.x, _probe.z)) {
        let hi = t;
        for (let k = 0; k < 5; k += 1) {
          const mid = (lo + hi) * 0.5;
          _probe.copy(origin).addScaledVector(dir, mid);
          if (_probe.y <= world.heightAt(_probe.x, _probe.z)) hi = mid;
          else lo = mid;
        }
        return hi;
      }
      lo = t;
    }
    return -1;
  }

  _damageCreature(creature, amount, weaponId, point) {
    const game = this.game;
    if (!creature || !creature.alive || !game.creatures) return false;
    const spot = point.clone();   // handed to other modules; never a scratch
    const killed = game.creatures.damage(creature, amount, {
      source: weaponId,
      point: spot,
      weapon: weaponId,
    });
    if (game.vfx) {
      const colour = weaponId === "pulse" ? WEAPONS.pulse.color : WEAPONS.harpoon.color;
      game.vfx.hitSpark(spot, colour);
      if (killed && creature.type) game.vfx.bloodCloud(spot, creature.type.bellyColor);
    }
    if (killed) this._sfx("kill");
    else if (weaponId !== "pulse") this._sfx("hit");
    game.bus.emit("combat:hit", {
      kind: "creature",
      amount,
      point: spot,
      weapon: weaponId,
      creature,
      killed,
    });
    return killed;
  }

  _detonate(p, point, directCreature) {
    const game = this.game;
    const spec = WEAPONS.torpedo;
    _end.copy(point);

    if (game.vfx) {
      game.vfx.explosion(_end, 1, spec.color);
      game.vfx.bubbles(_end, 22, { spread: 2.4, rise: 2.6, size: 0.5, life: 2.2 });
    }
    this._sfx("explode");

    if (game.fish) game.fish.scatter(_end, spec.splash * 2.4, 30);

    if (game.creatures) {
      const caught = game.creatures.sphereHit(_end, spec.splash);
      if (caught) {
        for (const c of caught) {
          if (!c || !c.alive) continue;
          const dist = c.position.distanceTo(_end) - (c.radius || 0);
          const fall = clamp01(1 - Math.max(0, dist) / spec.splash);
          const direct = c === directCreature;
          const amount = direct
            ? spec.damage + spec.splashDamage * 0.5
            : spec.splashDamage * (0.3 + 0.7 * fall);
          _probe.copy(c.position).lerp(_end, 0.5);
          this._damageCreature(c, amount, "torpedo", _probe);
        }
      }
      if (directCreature && directCreature.alive && !(game.creatures.sphereHit(_end, spec.splash) || []).includes(directCreature)) {
        /* Belt and braces: a body whose centre sits outside the splash ball
           still ate the warhead nose-first. */
        this._damageCreature(directCreature, spec.damage, "torpedo", _end);
      }
    }

    if (game.sub && game.vfx) {
      const away = game.sub.position.distanceTo(_end);
      game.vfx.screenShake(clamp01(1 - away / 70) * 0.85);
    }

    game.bus.emit("combat:hit", {
      kind: "splash",
      amount: spec.splashDamage,
      point: _end.clone(),
      weapon: "torpedo",
    });

    this._retire(p);
  }

  // ------------------------------------------------------------ capture beam

  setBeam(active) {
    const on = !!active;
    if (on === this.beamActive) return;
    this.beamActive = on;
    if (!on) this._releaseTarget();
  }

  _releaseTarget() {
    if (this.beamTarget) this.beamTarget.capturing = 0;
    this.beamTarget = null;
    this.beamProgress = 0;
  }

  /* Is this particular fish still lit? Same cone test beamTarget() runs, but
     against one fish we have already committed to. */
  _holds(fish, range, coneCos) {
    if (!fish || !fish.alive) return false;
    const camera = this.game.camera;
    if (!camera) return false;
    camera.getWorldPosition(_beamEye);
    camera.getWorldDirection(_beamDir);
    _beamTo.copy(fish.position).sub(_beamEye);
    const d2 = _beamTo.lengthSq();
    if (d2 > range * range || d2 < 1e-6) return false;
    return _beamTo.divideScalar(Math.sqrt(d2)).dot(_beamDir) >= coneCos;
  }

  _updateBeam(dt) {
    const game = this.game;
    const sub = game.sub;
    let wanted = null;

    const usable = this.beamActive && game.mode === "dive" && sub && !sub.docked;
    if (usable) {
      if (sub.battery <= 0.5) {
        this._deny("the cell is too thin to hold anything.");
      } else if (sub.cargoFull) {
        this._deny("the hold is full. something has to go.");
      } else {
        sub.drainBattery(BEAM_DRAIN * dt);
        const range = (game.stats && game.stats.captureRange) || 14;
        /* Stickiness matters more than accuracy here. A beam that re-picks
           whichever fish is momentarily nearest the crosshair can never finish
           a capture inside a shoal — the progress resets on every swap — so a
           fish that is already lit keeps the beam on a looser cone until it
           genuinely gets away. */
        if (this._holds(this.beamTarget, range * BEAM_HOLD_SLACK, BEAM_HOLD_CONE)) {
          wanted = this.beamTarget;
        } else {
          wanted = (game.fish && game.fish.beamTarget(range, BEAM_CONE)) || null;
        }
      }
    }

    if (wanted !== this.beamTarget) {
      /* Losing the cone loses the fish. The beam has no memory, which is the
         only cruelty in it. */
      if (this.beamTarget) this.beamTarget.capturing = 0;
      this.beamTarget = wanted;
      this.beamProgress = 0;
      this._sparkTimer = 0;
    }

    if (this.beamTarget) {
      const hold = Math.max(0.2, (game.stats && game.stats.captureTime) || 1.15);
      this.beamProgress = clamp01(this.beamProgress + dt / hold);
      this.beamTarget.capturing = this.beamProgress;
      this._beamEnd.copy(this.beamTarget.position);

      this._sparkTimer -= dt;
      if (this._sparkTimer <= 0 && game.vfx) {
        this._sparkTimer = SPARKLE_INTERVAL;
        const species = this.beamTarget.species;
        game.vfx.captureSparkle(
          this.beamTarget.position,
          species ? species.glowHex : CAPTURE_TINT.getHex(),
        );
      }

      if (this.beamProgress >= 1) this._completeCapture(this.beamTarget);
    } else if (this.beamProgress > 0) {
      this.beamProgress = Math.max(0, this.beamProgress - dt * BEAM_DECAY);
    }
  }

  _completeCapture(fish) {
    const game = this.game;
    this.beamTarget = null;
    this.beamProgress = 0;
    if (!game.fish) return;

    const species = fish.species;
    const glow = species ? species.glowHex : CAPTURE_TINT.getHex();
    const item = game.fish.capture(fish);
    if (!item) {
      /* The hold refused it — fish.capture is the only authority on that. */
      this._deny("the hold is full. something has to go.");
      return;
    }
    this._sfx("capture");
    if (game.vfx) {
      game.vfx.captureSparkle(fish.position, glow);
      game.vfx.bubbles(fish.position, 6, { spread: 0.6, rise: 0.9, size: 0.18, life: 1.1 });
    }
  }

  _updateBeamMesh(dt) {
    const game = this.game;
    const lit = !!this.beamTarget;
    this._beamAmount = damp(this._beamAmount, lit ? 1 : 0, BEAM_FADE, dt);

    if (this._beamAmount < 0.015) {
      this.beam.visible = false;
      this.beamRing.visible = false;
      return;
    }

    if (lit) this._beamEnd.copy(this.beamTarget.position);
    this._muzzlePose(_muzzle, _aim);
    _delta.subVectors(this._beamEnd, _muzzle);
    const dist = _delta.length();
    if (dist < 0.05) {
      this.beam.visible = false;
      this.beamRing.visible = false;
      return;
    }
    _delta.divideScalar(dist);

    _quat.setFromUnitVectors(FORWARD_Z, _delta);
    this.beam.position.copy(_muzzle);
    this.beam.quaternion.copy(_quat);
    /* A slow breath in the width so it never looks like a decal. */
    const breath = 0.85 + 0.15 * Math.sin(this.time * 9);
    const width = this._beamAmount * breath * lerp(1, 0.72, this.beamProgress);
    this.beam.scale.set(width, width, dist);
    this.beam.visible = true;
    this.matBeam.opacity = 0.09 + 0.26 * this._beamAmount + 0.16 * this.beamProgress;

    const species = this.beamTarget ? this.beamTarget.species : null;
    _tint.setHex(species ? species.glowHex : CAPTURE_TINT.getHex());
    _tint.lerp(CAPTURE_TINT, 0.45);
    this.matBeam.color.copy(_tint);
    this.matBeamRing.color.copy(_tint);

    /* The ring closes on the fish as the hold takes hold of it. */
    this.beamRing.position.copy(this._beamEnd);
    if (game.camera) {
      game.camera.getWorldQuaternion(_quatB);
      this.beamRing.quaternion.copy(_quatB);
    }
    const ringScale = lerp(2.1, 0.65, this.beamProgress) * (1 + 0.05 * Math.sin(this.time * 14));
    this.beamRing.scale.setScalar(ringScale);
    this.beamRing.visible = true;
    this.matBeamRing.opacity = this._beamAmount * (0.25 + 0.6 * this.beamProgress);
  }

  _updatePulseFlash(dt) {
    if (this._pulseFlash <= 0) return;
    this._pulseFlash = Math.max(0, this._pulseFlash - dt / PULSE_FLASH_TIME);
    const k = this._pulseFlash;
    this.matPulse.opacity = k * k * 0.32;
    /* It blooms outward a little as it dies, like a held note. */
    const spread = WEAPONS.pulse.range * (1 + (1 - k) * 0.12);
    this.pulseCone.scale.setScalar(spread);
    this.pulseCone.visible = this._pulseFlash > 0.01;
  }

  // ------------------------------------------------------------------ frame

  update(dt) {
    const step = Math.min(Math.max(dt, 0), 1 / 20);
    this.time += step;

    for (let i = 0; i < this._cooldowns.length; i += 1) {
      if (this._cooldowns[i] > 0) {
        this._cooldowns[i] = Math.max(0, this._cooldowns[i] - step);
      }
    }

    /* Projectiles keep flying whatever the mode is doing, so nothing is left
       frozen in the water when a panel opens; the trigger and the beam are the
       parts that go quiet. */
    this._stepProjectiles(step);

    if (this.game.mode !== "dive" && this.beamActive) this.setBeam(false);
    this._updateBeam(step);
    this._updateBeamMesh(step);
    this._updatePulseFlash(step);
    this._syncWeapons();
  }

  dispose() {
    this._releaseTarget();
    this.beamActive = false;

    for (const p of this.projectiles) this._retire(p);
    this.projectiles.length = 0;

    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();

    for (const geo of this._geometries) geo.dispose();
    for (const mat of this._materials) mat.dispose();
    this._geometries.length = 0;
    this._materials.length = 0;
  }
}
