/* The boat.

   Everything the player actually feels lives here: the look, the thrust, the
   weight of a full hold, the moment the hull starts arguing with the water.
   Because feel is input latency plus inertia, this module owns the keyboard and
   the mouse for the length of a dive and hands the rest of the game nothing but
   readouts and events. Nothing here reaches into a DOM panel; UI-ish keys go out
   on the bus or through a documented `game` method and somebody else decides
   what a panel is. */

import * as THREE from "three";
import { SEA, SUB, HOTKEYS, zoneForDepth } from "./config.js";
import { clamp, clamp01, damp, lerp, smoothstep, wrapAngle, TAU } from "./util.js";

/* Scratch. The per-frame path allocates nothing, so every vector it needs is
   hoisted here and reused. Treat them as write-then-read-immediately. */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _flow = new THREE.Vector3();
const _station = new THREE.Vector3();
const _lampA = new THREE.Color();
const _lampB = new THREE.Color();

/* Feel constants that are genuinely about this module and nothing else. Balance
   numbers live in config.js; these are the ones that only mean something inside
   the flight model. */
const SURFACE_CEILING = -1.4;      // you may not breach: the hatch is not rated for air
const DRAG_QUADRATIC = 0.014;      // v^2 term — light enough that the clamp still bites
const BUOYANCY = 0.55;             // m/s^2 of "the sea would rather you came up"
const VERT_SETTLE = 1.5;           // extra damping on Y with no vertical input
const BOOST_SPEED_CAP = 1 + (SUB.boostMultiplier - 1) * 0.55;
const TURN_ROLL = 0.075;           // radians of bank per rad/s of yaw, before rollAssist
const ROLL_MAX = 0.48;
const TERRAIN_BOUNCE = 0.22;
const TERRAIN_FRICTION = 0.68;
const BUMP_THRESHOLD = 2.2;        // m/s under which a scrape is only a scrape
const BUMP_COOLDOWN = 0.34;
const PRESSURE_WARN = 0.88;        // fraction of the rating where the casing starts talking
const PRESSURE_CLEAR = 0.80;       // hysteresis, so the warning does not stutter
const COCKPIT_Z = 0.5;   // how far the window sits in front of the eye

const DOCK_HOLD = 0.55;            // seconds of held E on the clamps
const CARGO_TONS_PER_ITEM = 0.35;  // a netted thing plus its water
const FOV_SPEED_GAIN = 7;
const FOV_BOOST_GAIN = 4.5;

/* Probe ring for terrain contact: centre plus four points at the hull radius.
   Unit offsets in world XZ — the sub is close enough to a sphere that rotating
   them buys nothing. */
const PROBES = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]];

/* Code -> action, built once from the hotkey table so rebinding is a config
   edit rather than a switch statement edit. */
const ACTION_BY_CODE = new Map();
for (const action of Object.keys(HOTKEYS)) {
  for (const code of HOTKEYS[action]) ACTION_BY_CODE.set(code, action);
}

/* Keys the browser would rather use for something else. */
const SWALLOW = new Set(["Space", "Tab", "KeyC", "ControlLeft", "ShiftLeft"]);

const CREAK_LINES = [
  "something in the frame gives, a little.",
  "the hull talks. it is not saying anything good.",
  "a seam complains, then goes quiet, which is worse.",
  "the water leans on the glass and waits.",
  "a rivet somewhere behind you decides it has had enough.",
];

const BUMP_LINES = [
  "you find the floor with the front of the boat.",
  "rock. the whole cabin rings once.",
  "the seabed takes a bite out of the plating.",
];

/* Used only if the sub is somehow built before progression has run. The real
   boot order hands us game.stats, so this is a guard, not a code path. */
const FALLBACK_STATS = {
  hullMax: SUB.hullBase,
  pressureRating: SUB.pressureBase,
  thrust: SUB.thrustBase,
  maxSpeed: SUB.maxSpeedBase,
  cargoSlots: SUB.cargoSlotsBase,
  batteryMax: SUB.batteryBase,
  lightRange: SUB.lightRangeBase,
  sonarRange: SUB.sonarRangeBase,
  captureRange: SUB.captureRangeBase,
  captureTime: SUB.captureTimeBase,
  harpoonDamage: 14,
  torpedoAmmo: 0,
  torpedoUnlocked: false,
  repairRate: 0,
  batteryTrickle: SUB.batteryTrickle,
  sonarCooldown: SUB.sonarCooldownBase,
};

export class Submarine {
  constructor(game) {
    this.game = game;
    this.canvas = game.canvas;
    this.bus = game.bus;
    this.stats = game.stats || FALLBACK_STATS;

    /* ---- transform ------------------------------------------------------ */
    this.object = new THREE.Object3D();
    this.object.name = "submarine";
    this.object.rotation.order = "YXZ";   // yaw, then pitch, then bank
    this.position = this.object.position; // alias: moving one moves the other
    this.velocity = new THREE.Vector3();
    game.scene.add(this.object);

    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;

    /* ---- live readouts, read-only from outside -------------------------- */
    this.depth = 0;
    this.speed = 0;
    this.heading = 0;
    this.altitude = 999;          // metres of water under the keel
    this.hullMax = this.stats.hullMax;
    this.hull = this.hullMax;
    this.batteryMax = this.stats.batteryMax;
    this.battery = this.batteryMax;
    this.lightsOn = true;
    this.docked = true;           // you always start on the clamps
    this.cargoFull = false;
    this.boosting = false;
    this.grounded = false;
    this.destroyed = false;
    this.zone = zoneForDepth(0);

    /* ---- internal timers and latches ------------------------------------ */
    this.time = 0;
    this.sonarCooldown = 0;
    this.bumpTimer = 0;
    this.creakTimer = 2;
    this.dockHold = 0;
    this.boundsTimer = 0;
    this.deepestTimer = 0;
    this.pressureWarned = false;
    this.pressureCritical = false;
    this.batteryFlat = false;
    this.lineIndex = 0;

    /* ---- input ---------------------------------------------------------- */
    this.inputEnabled = true;
    this.pointerLocked = false;
    this.intentionalUnlock = false;
    this.lookDX = 0;
    this.lookDY = 0;
    this.firing = false;
    this.beaming = false;
    this.keys = Object.create(null);
    for (const action of Object.keys(HOTKEYS)) this.keys[action] = false;

    this.disposables = [];
    this.buildLights();
    this.buildCockpit();
    this.attachCamera();
    this.layoutCockpit();
    this.bindInput();

    this.applyStats();
    this.hull = this.hullMax;
    this.battery = this.batteryMax;
    this.parkAtRing();
  }

  /* ====================================================================== */
  /* construction                                                           */
  /* ====================================================================== */

  attachCamera() {
    const cam = this.game.camera;
    if (!cam) return;
    /* The cockpit sits forward of the hull's centre of mass and a little high,
       which is why the nose swings under you in a hard turn. */
    this.cockpitOffset = new THREE.Vector3(0, 0.65, -1.7);
    cam.position.copy(this.cockpitOffset);
    cam.rotation.set(0, 0, 0);
    this.baseFov = cam.isPerspectiveCamera ? cam.fov : 62;
    this.object.add(cam);
  }

  buildLights() {
    const range = this.stats.lightRange || SUB.lightRangeBase;

    /* r160 lights are physical: intensity is candela and decay is an exponent.
       decay 1 rather than 2 keeps a lamp readable across a whole beam length
       without the intensity number running away from us. */
    this.floods = [];
    this.floodTargets = [];
    for (let i = 0; i < 2; i += 1) {
      const side = i === 0 ? -1 : 1;
      const spot = new THREE.SpotLight(0xd8f2ff, range * 0.85, range, 0.52, 0.45, 1);
      spot.position.set(side * 1.15, -0.1, -1.9);
      spot.castShadow = false;
      const target = new THREE.Object3D();
      target.position.set(side * 3.2, -1.8, -range);
      this.object.add(spot);
      this.object.add(target);
      spot.target = target;
      this.floods.push(spot);
      this.floodTargets.push(target);
    }

    /* Always on, cheap, and the only reason you can see your own bow with the
       floods cut. The dark is meant to cost something, not everything. */
    this.hullGlow = new THREE.PointLight(0x6fd4e8, 5.5, 20, 1);
    this.hullGlow.position.set(0, 0.2, -2.4);
    this.object.add(this.hullGlow);

    /* Warm instrument spill so the cockpit frame reads in the abyss, where the
       zone ambient is effectively zero. Short range: it must not light water. */
    this.cabinGlow = new THREE.PointLight(0xffb066, 1.5, 3.2, 1.4);
    this.cabinGlow.position.set(0, 0.1, 0.45);

    this.setLights(this.lightsOn);
  }

  buildCockpit() {
    /* A few dark shapes hung off the camera. The point is not detail, it is the
       feeling of looking out of something. Everything stays clear of the middle
       of the screen where the crosshair and the capture reticle live. */
    const cam = this.game.camera;
    this.cockpit = new THREE.Group();
    this.cockpit.name = "cockpit";
    this.cockpit.renderOrder = 8;

    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x0a1017,
      roughness: 0.62,
      metalness: 0.42,
      fog: false,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x18242e,
      roughness: 0.45,
      metalness: 0.6,
      fog: false,
    });
    this.disposables.push(frameMat, trimMat);

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(box);

    const slab = (mat, sx, sy, sz, px, py, pz, rz) => {
      const mesh = new THREE.Mesh(box, mat);
      mesh.scale.set(sx, sy, sz);
      mesh.position.set(px, py, pz);
      if (rz) mesh.rotation.z = rz;
      mesh.frustumCulled = false;
      this.cockpit.add(mesh);
      return mesh;
    };

    /* Window rim: top brow, two cheeks, a sill. These are laid out against the
       actual frustum in layoutCockpit() rather than pinned to fixed numbers,
       so the window frames whatever aspect the player's screen is instead of
       eating a chunk of it on a wide monitor. */
    this.frame = {
      brow: slab(frameMat, 1, 0.12, 0.10, 0, 0, -COCKPIT_Z),
      left: slab(frameMat, 0.13, 1, 0.10, 0, 0, -COCKPIT_Z),
      right: slab(frameMat, 0.13, 1, 0.10, 0, 0, -COCKPIT_Z),
      sill: slab(frameMat, 1, 0.09, 0.13, 0, 0, -COCKPIT_Z),
      strutL: slab(trimMat, 0.03, 0.22, 0.03, 0, 0, -COCKPIT_Z + 0.03, 0.72),
      strutR: slab(trimMat, 0.03, 0.22, 0.03, 0, 0, -COCKPIT_Z + 0.03, -0.72),
      lip: slab(trimMat, 1.1, 0.08, 0.26, 0, 0, -0.36, 0),
    };
    const lipMat = new THREE.MeshBasicMaterial({
      color: 0x2a6c7f,
      transparent: true,
      opacity: 0.5,
      fog: false,
    });
    this.disposables.push(lipMat);
    this.frame.lipEdge = slab(lipMat, 1.0, 0.011, 0.011, 0, 0, -COCKPIT_Z + 0.03, 0);

    /* Two lamps on the lip. They are the only piece of HUD that is actually in
       the world, and they are the first thing you notice going wrong. */
    this.hullLampMat = new THREE.MeshBasicMaterial({ color: 0x6fe3a0, fog: false });
    this.cellLampMat = new THREE.MeshBasicMaterial({ color: 0x63b6ff, fog: false });
    this.disposables.push(this.hullLampMat, this.cellLampMat);
    this.frame.hullLamp = slab(this.hullLampMat, 0.032, 0.014, 0.01, 0, 0, -COCKPIT_Z + 0.06, 0);
    this.frame.cellLamp = slab(this.cellLampMat, 0.032, 0.014, 0.01, 0, 0, -COCKPIT_Z + 0.06, 0);

    /* Glass. Two long additive smears rather than a full pane, so the view does
       not wash out but the window still has a surface. */
    const glassGeom = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(glassGeom);
    const glassMat = new THREE.MeshBasicMaterial({
      color: 0x9fd8e6,
      transparent: true,
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.disposables.push(glassMat);
    /* Held so updateCockpit() can fade it: an additive smear is invisible over
       a bright shelf and reads as a grey bar in the abyss, because there is no
       daylight down there for the glass to catch. */
    this.glassMat = glassMat;
    for (const [w, h, x, y, r] of [[1.0, 0.028, -0.28, 0.26, 0.42], [0.42, 0.014, 0.30, 0.13, 0.42]]) {
      const streak = new THREE.Mesh(glassGeom, glassMat);
      streak.scale.set(w, h, 1);
      streak.position.set(x, y, -0.46);
      streak.rotation.z = r;
      streak.frustumCulled = false;
      this.cockpit.add(streak);
    }

    if (cam) {
      cam.add(this.cockpit);
      cam.add(this.cabinGlow);
    } else {
      this.object.add(this.cockpit);
      this.object.add(this.cabinGlow);
    }
  }

  /* ====================================================================== */
  /* input                                                                  */
  /* ====================================================================== */

  /* Fit the window to the frustum. Everything sits just outside the visible
     edge, so the frame reads as a window rather than as a letterbox, and a
     wider screen genuinely shows more sea instead of more cockpit. */
  layoutCockpit() {
    const cam = this.game.camera;
    const f = this.frame;
    if (!cam || !cam.isPerspectiveCamera || !f) return;

    const halfH = Math.tan((cam.fov * Math.PI) / 360) * COCKPIT_Z;
    const halfW = halfH * Math.max(0.5, cam.aspect);

    // A hair of overlap so no sliver of scene leaks past the frame edge.
    const bite = 0.015;
    const spanW = halfW * 2 + 0.6;
    const spanH = halfH * 2 + 0.6;

    f.brow.scale.x = spanW;
    f.brow.position.set(0, halfH + f.brow.scale.y / 2 - bite, -COCKPIT_Z);
    f.sill.scale.x = spanW;
    f.sill.position.set(0, -halfH - f.sill.scale.y / 2 + bite, -COCKPIT_Z);
    f.left.scale.y = spanH;
    f.left.position.set(-halfW - f.left.scale.x / 2 + bite, 0, -COCKPIT_Z);
    f.right.scale.y = spanH;
    f.right.position.set(halfW + f.right.scale.x / 2 - bite, 0, -COCKPIT_Z);

    // Struts clip only the extreme corners now, well clear of the reticle.
    f.strutL.position.set(-halfW + 0.10, halfH - 0.07, -COCKPIT_Z + 0.03);
    f.strutR.position.set(halfW - 0.10, halfH - 0.07, -COCKPIT_Z + 0.03);

    const lipW = Math.min(spanW * 0.72, halfW * 1.5);
    f.lip.scale.x = lipW;
    f.lip.position.set(0, -halfH - 0.035, -0.36);
    f.lipEdge.scale.x = lipW * 0.9;
    f.lipEdge.position.set(0, -halfH + 0.008, -COCKPIT_Z + 0.03);
    f.hullLamp.position.set(-lipW * 0.17, -halfH - 0.028, -COCKPIT_Z + 0.06);
    f.cellLamp.position.set(-lipW * 0.11, -halfH - 0.028, -COCKPIT_Z + 0.06);
  }

  bindInput() {
    this.onKeyDown = (e) => this.handleKeyDown(e);
    this.onKeyUp = (e) => this.handleKeyUp(e);
    this.onMouseMove = (e) => this.handleMouseMove(e);
    this.onMouseDown = (e) => this.handleMouseDown(e);
    this.onMouseUp = (e) => this.handleMouseUp(e);
    this.onCanvasClick = () => this.requestLook();
    this.onContextMenu = (e) => e.preventDefault();
    this.onLockChange = () => this.handleLockChange();
    this.onBlur = () => this.zeroInput();

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("pointerlockchange", this.onLockChange);
    if (this.canvas) {
      this.canvas.addEventListener("mousedown", this.onMouseDown);
      this.canvas.addEventListener("click", this.onCanvasClick);
      this.canvas.addEventListener("contextmenu", this.onContextMenu);
    }
  }

  /* Escape has to work even with input disabled, because the browser eats the
     keydown that leaves pointer lock and the player still needs a way out. */
  handleKeyDown(e) {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.metaKey) return;

    const action = ACTION_BY_CODE.get(e.code);
    if (action === "pause") {
      const mode = this.game.mode;
      if (mode === "dive") this.game.setMode("paused");
      else if (mode === "paused") this.game.setMode("dive");
      e.preventDefault();
      return;
    }

    if (!this.inputEnabled || !action) return;
    if (SWALLOW.has(e.code)) e.preventDefault();

    switch (action) {
      case "forward": case "back": case "left": case "right":
      case "up": case "down": case "boost":
        this.keys[action] = true;
        break;
      case "dock":
        this.keys.dock = true;
        break;
      case "lights":
        if (!e.repeat) this.setLights(!this.lightsOn);
        break;
      case "sonar":
        if (!e.repeat) this.ping();
        break;
      case "cargo":
        if (!e.repeat) {
          this.keys.cargo = true;
          this.bus.emit("ui:cargo", { open: true });
        }
        break;
      case "weapon1": case "weapon2": case "weapon3":
        if (!e.repeat) this.selectWeapon(Number(action.slice(-1)) - 1);
        break;
      case "map":
        if (!e.repeat) this.bus.emit("ui:map", {});
        break;
      default:
        break;
    }
  }

  handleKeyUp(e) {
    const action = ACTION_BY_CODE.get(e.code);
    if (!action) return;
    if (SWALLOW.has(e.code)) e.preventDefault();
    if (action === "dock") {
      this.keys.dock = false;
      this.dockHold = 0;
      return;
    }
    if (action === "cargo") {
      this.keys.cargo = false;
      this.bus.emit("ui:cargo", { open: false });
      return;
    }
    if (action in this.keys) this.keys[action] = false;
  }

  handleMouseMove(e) {
    if (!this.inputEnabled || !this.pointerLocked) return;
    this.lookDX += e.movementX || 0;
    this.lookDY += e.movementY || 0;
  }

  handleMouseDown(e) {
    if (!this.inputEnabled || this.game.mode !== "dive") return;
    if (e.button === 0) {
      this.firing = true;
      this.fire();
    } else if (e.button === 2) {
      e.preventDefault();
      this.setBeam(true);
    }
  }

  handleMouseUp(e) {
    if (e.button === 0) this.firing = false;
    else if (e.button === 2) this.setBeam(false);
  }

  handleLockChange() {
    const locked = document.pointerLockElement === this.canvas;
    this.pointerLocked = locked;
    this.lookDX = 0;
    this.lookDY = 0;
    if (locked) {
      this.intentionalUnlock = false;
      return;
    }
    /* Escape while flying arrives here and nowhere else, so this is the real
       pause hook. An unlock we asked for (a panel opening) is left alone. */
    if (this.intentionalUnlock) {
      this.intentionalUnlock = false;
      return;
    }
    if (this.inputEnabled && this.game.mode === "dive") this.game.setMode("paused");
  }

  requestLook() {
    if (!this.inputEnabled || this.game.mode !== "dive") return;
    if (!this.canvas || this.pointerLocked) return;
    if (typeof this.canvas.requestPointerLock !== "function") return;
    try {
      const result = this.canvas.requestPointerLock();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (err) {
      /* Some browsers refuse outside a gesture. The next click will do. */
    }
  }

  releaseLook() {
    if (document.pointerLockElement !== this.canvas) return;
    this.intentionalUnlock = true;
    if (typeof document.exitPointerLock === "function") document.exitPointerLock();
  }

  setInputEnabled(enabled) {
    const on = !!enabled;
    if (on === this.inputEnabled && !on) return;
    this.inputEnabled = on;
    if (on) {
      this.requestLook();
      return;
    }
    /* Zeroing matters more than the flag: a key held when a panel opens must
       not still be held when it closes. */
    this.zeroInput();
    this.releaseLook();
  }

  zeroInput() {
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
    this.lookDX = 0;
    this.lookDY = 0;
    this.dockHold = 0;
    this.boosting = false;
    if (this.firing) this.firing = false;
    if (this.beaming) this.setBeam(false);
  }

  fire() {
    const combat = this.game.combat;
    if (combat) combat.firePrimary();
  }

  setBeam(active) {
    const on = !!active;
    this.beaming = on;
    const combat = this.game.combat;
    if (combat) combat.setBeam(on);
  }

  selectWeapon(index) {
    const combat = this.game.combat;
    if (combat) combat.selectWeapon(index);
  }

  /* ====================================================================== */
  /* systems                                                                */
  /* ====================================================================== */

  applyStats() {
    this.stats = this.game.stats || this.stats || FALLBACK_STATS;
    const s = this.stats;

    this.hullMax = s.hullMax;
    this.batteryMax = s.batteryMax;
    this.hull = clamp(this.hull, 0, this.hullMax);
    this.battery = clamp(this.battery, 0, this.batteryMax);

    const range = s.lightRange || SUB.lightRangeBase;
    for (let i = 0; i < this.floods.length; i += 1) {
      const spot = this.floods[i];
      spot.distance = range;
      spot.intensity = this.lightsOn ? range * 0.85 : 0;
      this.floodTargets[i].position.z = -range;
    }
    this.hullGlow.distance = clamp(range * 0.5, 14, 40);

    this.cargoFull = this.cargoCount() >= s.cargoSlots;
  }

  setLights(on) {
    this.lightsOn = !!on && this.battery > 0;
    const range = this.stats.lightRange || SUB.lightRangeBase;
    for (const spot of this.floods) spot.intensity = this.lightsOn ? range * 0.85 : 0;
    this.hullGlow.intensity = this.lightsOn ? 5.5 : 3.0;
    if (this.game.audio) this.game.audio.sfx("click");
  }

  damage(amount, source) {
    const amt = Number(amount) || 0;
    if (amt <= 0 || this.destroyed) return;
    if (this.docked) return;   // the clamps take the load

    this.hull = Math.max(0, this.hull - amt);
    this.bus.emit("sub:damage", { amount: amt, source, hull: this.hull });

    if (amt >= 1.2) {
      if (this.game.vfx) this.game.vfx.screenShake(clamp01(amt / 26));
      if (this.game.audio) this.game.audio.sfx("damage");
    }

    if (this.hull <= 0) {
      this.destroyed = true;
      this.hull = 0;
      this.setBeam(false);
      this.firing = false;
      if (this.game.vfx) {
        this.game.vfx.explosion(this.position, 2.4, 0xffb066);
        this.game.vfx.screenShake(1);
      }
      if (this.game.audio) this.game.audio.sfx("explode");
      this.bus.emit("sub:destroyed", { cause: causeOf(source) });
    }
  }

  repair(amount) {
    const amt = Number(amount) || 0;
    if (amt <= 0) return;
    this.hull = Math.min(this.hullMax, this.hull + amt);
  }

  drainBattery(amount) {
    const amt = Number(amount) || 0;
    if (amt <= 0) return;
    this.battery = Math.max(0, this.battery - amt);
  }

  /* The polite version: returns false and spends nothing when the cell is short,
     so a weapon can refuse cleanly. */
  drawBattery(amount) {
    const amt = Number(amount) || 0;
    if (amt <= 0) return true;
    if (this.battery < amt) return false;
    this.battery -= amt;
    return true;
  }

  cargoCount() {
    const cargo = this.game.profile && this.game.profile.cargo;
    return cargo ? cargo.length : 0;
  }

  addCargo(item) {
    if (!item) return false;
    const profile = this.game.profile;
    if (!profile || !Array.isArray(profile.cargo)) return false;
    if (profile.cargo.length >= this.stats.cargoSlots) {
      this.cargoFull = true;
      this.bus.emit("fish:cargo-full", {});
      return false;
    }
    profile.cargo.push(item);
    this.cargoFull = profile.cargo.length >= this.stats.cargoSlots;
    this.bus.emit("profile:changed", {});
    this.game.persist();
    return true;
  }

  ping() {
    if (this.sonarCooldown > 0) {
      if (this.game.audio) this.game.audio.sfx("deny");
      return;
    }
    if (!this.drawBattery(SUB.sonarCost)) {
      if (this.game.audio) this.game.audio.sfx("deny");
      this.game.log("not enough charge in the cell to ping.", "warn");
      return;
    }
    const range = this.stats.sonarRange;
    this.sonarCooldown = this.stats.sonarCooldown;
    this.bus.emit("sonar:ping", { range });
    if (this.game.creatures) this.game.creatures.pingReveal(range);
    if (this.game.vfx) this.game.vfx.sonarWave(this.position, range);
    if (this.game.audio) this.game.audio.sfx("sonar");
  }

  forward(out) {
    const v = out || new THREE.Vector3();
    return v.set(0, 0, -1).applyQuaternion(this.object.quaternion);
  }

  nudge(impulse) {
    if (!impulse) return;
    this.velocity.add(impulse);
    if (this.game.vfx) this.game.vfx.screenShake(clamp01(impulse.length() / 22));
  }

  /* ====================================================================== */
  /* docking                                                                */
  /* ====================================================================== */

  stationPos(out) {
    const world = this.game.world;
    if (world && world.stationPosition) return out.copy(world.stationPosition);
    return out.fromArray(SEA.stationPos);
  }

  /* Park on the ring on whichever side we came from, nose pointed at the Hull. */
  parkAtRing() {
    this.stationPos(_station);
    _v1.set(this.position.x - _station.x, 0, this.position.z - _station.z);
    if (_v1.lengthSq() < 1e-4) _v1.set(0, 0, 1);
    _v1.normalize();
    const ring = SEA.stationRadius + 7;
    this.position.set(_station.x + _v1.x * ring, _station.y + 1.5, _station.z + _v1.z * ring);
    this.velocity.set(0, 0, 0);
    // _v1 points outward from the Hull, and the boat's nose is -Z, so facing
    // the station means yawing toward -_v1.
    this.yaw = Math.atan2(_v1.x, _v1.z);
    this.pitch = 0;
    this.roll = 0;
    this.yawRate = 0;
    this.dockAnchorY = this.position.y;
    this.object.rotation.set(this.pitch, this.yaw, this.roll);
  }

  dock() {
    if (this.docked) return;
    this.docked = true;
    this.destroyed = false;
    this.dockHold = 0;
    this.grounded = false;
    this.pressureWarned = false;
    this.pressureCritical = false;
    this.batteryFlat = false;
    this.setBeam(false);
    this.firing = false;
    this.parkAtRing();
    if (this.game.audio) this.game.audio.sfx("dock");
  }

  undock() {
    if (!this.docked) {
      this.dockHold = 0;
      return;
    }
    this.docked = false;
    this.dockHold = 0;
    this.stationPos(_station);
    _v1.set(this.position.x - _station.x, 0, this.position.z - _station.z);
    if (_v1.lengthSq() < 1e-4) _v1.set(0, 0, 1);
    _v1.normalize();
    /* Point away from the Hull and give the boat a shove, so the dive starts
       with the station behind you instead of in your face. */
    this.yaw = Math.atan2(-_v1.x, -_v1.z);
    this.pitch = 0;
    this.position.addScaledVector(_v1, 4);
    this.velocity.set(_v1.x * 4.5, -0.6, _v1.z * 4.5);
    this.object.rotation.set(this.pitch, this.yaw, this.roll);
    if (this.game.vfx) this.game.vfx.bubbles(this.position, 18, { spread: 2.6, rise: 1.4, life: 2.2 });
    if (this.game.audio) this.game.audio.sfx("undock");
  }

  respawn() {
    this.docked = false;          // so dock() does the full reset below
    this.destroyed = false;
    this.hull = this.hullMax;
    this.battery = this.batteryMax;
    this.velocity.set(0, 0, 0);
    this.setLights(true);
    this.sonarCooldown = 0;
    this.bumpTimer = 0;
    this.creakTimer = 2;
    this.zeroInput();
    this.dock();
  }

  /* ====================================================================== */
  /* the frame                                                              */
  /* ====================================================================== */

  update(dt) {
    if (!(dt > 0)) dt = 0;
    this.time += dt;
    if (this.stats !== this.game.stats && this.game.stats) this.applyStats();

    this.sonarCooldown = Math.max(0, this.sonarCooldown - dt);
    this.bumpTimer = Math.max(0, this.bumpTimer - dt);
    this.boundsTimer = Math.max(0, this.boundsTimer - dt);

    const mode = this.game.mode;
    const flying = mode === "dive" && !this.docked && !this.destroyed;

    /* The game says we are diving, so we are not on the clamps. Cheap safety
       valve: never leave the player parked with the throttle live. */
    if (this.docked && mode === "dive") this.undock();

    if (flying) {
      this.applyLook(dt);
      this.applyThrust(dt);
      this.integrate(dt);
      this.resolveTerrain(dt);
      this.updateDockPrompt(dt);
    } else {
      this.velocity.multiplyScalar(Math.pow(0.06, dt));
      if (this.docked) this.updateDocked(dt);
    }

    this.updatePower(dt, flying);
    if (flying) this.updatePressure(dt);
    this.updateReadouts(dt);
    this.updateCockpit();
    this.updateCamera(dt);

    if (flying && this.firing) this.fire();
  }

  applyLook(dt) {
    const settings = (this.game.profile && this.game.profile.settings) || null;
    const sens = SUB.lookSensitivity * (settings && settings.sensitivity ? settings.sensitivity : 1);
    const invert = settings ? !!settings.invertY : false;

    const prevYaw = this.yaw;
    this.yaw = wrapAngle(this.yaw - this.lookDX * sens);
    const dp = this.lookDY * sens * (invert ? 1 : -1);
    this.pitch = clamp(this.pitch + dp, -SUB.pitchClamp, SUB.pitchClamp);
    this.lookDX = 0;
    this.lookDY = 0;

    /* Bank into the turn. Measured from the yaw we actually took rather than the
       mouse delta, so a smoothed rate never fights the pointer. */
    const instant = dt > 0 ? wrapAngle(this.yaw - prevYaw) / dt : 0;
    this.yawRate = damp(this.yawRate, instant, 9, dt);
    const strafe = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const rollTarget = clamp(
      -this.yawRate * TURN_ROLL * SUB.rollAssist - strafe * 0.1,
      -ROLL_MAX,
      ROLL_MAX,
    );
    this.roll = damp(this.roll, rollTarget, 3.4, dt);
    this.object.rotation.set(this.pitch, this.yaw, this.roll);
  }

  applyThrust(dt) {
    const s = this.stats;
    const fwdIn = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
    const strafeIn = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const vertIn = (this.keys.up ? 1 : 0) - (this.keys.down ? 1 : 0);

    /* Boost only while the cell can pay for it. */
    const wantsBoost = this.keys.boost && (fwdIn !== 0 || strafeIn !== 0 || vertIn !== 0);
    this.boosting = wantsBoost && this.battery > 0.5;

    const q = this.object.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _right.set(1, 0, 0).applyQuaternion(q);

    _v1.set(0, 0, 0);
    if (fwdIn !== 0) _v1.addScaledVector(_fwd, fwdIn);
    if (strafeIn !== 0) _v1.addScaledVector(_right, strafeIn * 0.78);
    if (_v1.lengthSq() > 1) _v1.normalize();

    const power = s.thrust * (this.boosting ? SUB.boostMultiplier : 1);
    this.velocity.addScaledVector(_v1, power * dt);

    /* Vertical thrust is world-up: a sub climbs by blowing ballast, not by
       pointing the nose at the surface. */
    if (vertIn !== 0) {
      this.velocity.y += SUB.vertThrust * vertIn * (this.boosting ? 1.35 : 1) * dt;
    } else {
      /* Slightly positive buoyancy, then settle, so an idle boat drifts up a
         hair and never hangs in the water like a sprite. */
      this.velocity.y += BUOYANCY * dt;
      this.velocity.y = damp(this.velocity.y, 0, VERT_SETTLE, dt);
    }
  }

  integrate(dt) {
    const s = this.stats;
    const v = this.velocity;

    /* Quadratic drag first: it is what makes a heavy boat coast instead of
       stopping dead when you let go. */
    const speed = v.length();
    if (speed > 0.0001) {
      const cargoDrag = 1 + this.cargoCount() * CARGO_TONS_PER_ITEM * SUB.cargoDragPerTon;
      const quad = DRAG_QUADRATIC * speed * cargoDrag;
      const keep = Math.max(0, 1 - quad * dt);
      v.multiplyScalar(keep);
      v.multiplyScalar(Math.pow(SUB.linearDrag, dt * cargoDrag));
    }

    const cap = s.maxSpeed * (this.boosting ? BOOST_SPEED_CAP : 1);
    const now = v.length();
    if (now > cap) v.multiplyScalar(cap / now);

    /* Drift is added at the position, not the velocity: the current carries the
       boat without ever showing up on the speed readout as thrust you did not
       ask for. */
    const world = this.game.world;
    if (world) {
      world.sampleFlow(this.position, this.time, _flow);
      _v2.copy(v).addScaledVector(_flow, 1);
    } else {
      _v2.copy(v);
    }
    this.position.addScaledVector(_v2, dt);

    if (this.position.y > SURFACE_CEILING) {
      this.position.y = SURFACE_CEILING;
      if (v.y > 0) v.y *= -0.08;
      if (this.time - (this.surfaceNoteAt || -99) > 12) {
        this.surfaceNoteAt = this.time;
        this.game.log("the hull bumps the underside of the sky. no further up than this.", "info");
      }
    }

    if (world && world.clampToBounds(this.position, v) && this.boundsTimer <= 0) {
      this.boundsTimer = 9;
      this.game.log("the current leans on you and turns the boat back inward.", "warn");
    }
  }

  resolveTerrain(dt) {
    const world = this.game.world;
    if (!world) return;
    const r = SUB.collisionRadius;
    const pos = this.position;

    let floor = -Infinity;
    let fx = pos.x;
    let fz = pos.z;
    for (let i = 0; i < PROBES.length; i += 1) {
      const px = pos.x + PROBES[i][0] * r * 0.85;
      const pz = pos.z + PROBES[i][1] * r * 0.85;
      const h = world.heightAt(px, pz);
      if (h > floor) {
        floor = h;
        fx = px;
        fz = pz;
      }
    }
    this.altitude = pos.y - floor;

    const bite = floor + r - pos.y;
    if (bite <= 0) {
      this.grounded = false;
      return;
    }

    const n = world.normalAt(fx, fz, _normal) || _normal;
    if (!(n.lengthSq() > 0.0001)) n.set(0, 1, 0);
    pos.addScaledVector(n, bite);

    const into = this.velocity.dot(n);
    if (into < 0) {
      const impact = -into;
      this.velocity.addScaledVector(n, impact * (1 + TERRAIN_BOUNCE));
      if (impact > BUMP_THRESHOLD && this.bumpTimer <= 0) {
        this.bumpTimer = BUMP_COOLDOWN;
        this.bus.emit("sub:collide", { speed: impact });
        this.damage(impact * SUB.terrainBumpDamage, "the seabed");
        if (this.game.vfx) {
          this.game.vfx.bubbles(pos, 10, { spread: 2.2, rise: 1.1, life: 1.8 });
          this.game.vfx.screenShake(clamp01(impact / 16));
        }
        if (this.game.audio) this.game.audio.sfx("hit");
        if (impact > 7) this.game.log(this.nextLine(BUMP_LINES), "bad");
      } else if (impact > 0.6 && this.game.vfx) {
        this.game.vfx.screenShake(clamp01(impact / 40));
      }
    }

    // Scrape: the floor eats sideways speed too, or you skate along it.
    this.velocity.multiplyScalar(lerp(1, TERRAIN_FRICTION, clamp01(dt * 6)));
    this.grounded = true;
  }

  updateDockPrompt(dt) {
    const world = this.game.world;
    if (!world || !this.keys.dock) {
      this.dockHold = 0;
      return;
    }
    if (!world.isDockable(this.position)) {
      this.dockHold = 0;
      return;
    }
    this.dockHold += dt;
    if (this.dockHold < DOCK_HOLD) return;
    this.dockHold = 0;
    this.dock();
    /* The sub puts itself on the clamps; the game decides what a station is. */
    this.bus.emit("station:dock", {});
  }

  updateDocked(dt) {
    const s = this.stats;
    this.hull = Math.min(this.hullMax, this.hull + SUB.hullRepairDocked * dt);
    this.battery = Math.min(this.batteryMax, this.battery + SUB.batteryRechargeDocked * dt);
    this.batteryFlat = false;
    this.pressureWarned = false;
    this.pressureCritical = false;
    this.grounded = false;
    this.cargoFull = this.cargoCount() >= s.cargoSlots;
    /* A little swell on the clamps, so the Hull never reads as a static image. */
    if (this.dockAnchorY == null) this.dockAnchorY = this.position.y;
    this.position.y = this.dockAnchorY + Math.sin(this.time * 0.7) * 0.12;
    this.roll = damp(this.roll, Math.sin(this.time * 0.5) * 0.02, 2, dt);
    this.object.rotation.set(this.pitch, this.yaw, this.roll);
  }

  updatePower(dt, flying) {
    if (this.docked) return;
    const s = this.stats;

    let drain = SUB.idleDrain;
    if (this.lightsOn) drain += SUB.lightDrain;
    if (this.boosting && flying) drain += SUB.boostDrain;
    this.battery = Math.max(0, this.battery - drain * dt);

    if (s.batteryTrickle > 0) {
      this.battery = Math.min(this.batteryMax, this.battery + s.batteryTrickle * dt);
    }
    if (s.repairRate > 0 && this.hull > 0 && this.hull < this.hullMax) {
      this.hull = Math.min(this.hullMax, this.hull + s.repairRate * dt);
    }

    if (this.battery <= 0 && !this.batteryFlat) {
      this.batteryFlat = true;
      this.boosting = false;
      if (this.lightsOn) {
        this.lightsOn = false;
        for (const spot of this.floods) spot.intensity = 0;
        this.hullGlow.intensity = 3.0;
      }
      this.bus.emit("sub:battery-empty", {});
      this.game.log("the cell goes flat. the lamps die and the dark closes the distance.", "bad");
      if (this.game.audio) this.game.audio.sfx("alarm");
    } else if (this.batteryFlat && this.battery > 4) {
      this.batteryFlat = false;
    }
  }

  updatePressure(dt) {
    const rating = this.stats.pressureRating;
    const depth = this.depth;
    const warnAt = rating * PRESSURE_WARN;

    if (!this.pressureWarned && depth > warnAt) {
      this.pressureWarned = true;
      this.bus.emit("sub:pressure", { over: depth - rating, depth, rating });
      this.game.log("casing at rated depth. the numbers start meaning something.", "warn");
      if (this.game.audio) this.game.audio.sfx("alarm");
    } else if (this.pressureWarned && depth < rating * PRESSURE_CLEAR) {
      this.pressureWarned = false;
      this.pressureCritical = false;
    }

    if (depth <= rating) {
      this.creakTimer = Math.max(this.creakTimer, 1.2);
      return;
    }

    if (!this.pressureCritical) {
      this.pressureCritical = true;
      this.bus.emit("sub:pressure", { over: depth - rating, depth, rating });
      this.game.log("past the rating. the sea starts folding the boat shut.", "bad");
    }

    const over = depth - rating;
    const severity = clamp01(over / 240);
    this.damage(SUB.pressureDamage * (over / 100) * dt, "the pressure");

    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.creakTimer = lerp(3.4, 0.85, severity);
      if (this.game.vfx) this.game.vfx.screenShake(0.18 + severity * 0.55);
      if (this.game.audio) this.game.audio.sfx("depth", { severity });
      if (Math.random() < 0.45) this.game.log(this.nextLine(CREAK_LINES), "lore");
    }
  }

  updateReadouts(dt) {
    this.depth = Math.max(0, -this.position.y);
    this.speed = this.velocity.length();
    this.forward(_fwd);
    /* Compass bearing in radians, 0 = -Z, increasing clockwise from above. */
    let bearing = Math.atan2(_fwd.x, -_fwd.z);
    if (bearing < 0) bearing += TAU;
    this.heading = bearing;
    this.cargoFull = this.cargoCount() >= this.stats.cargoSlots;

    const zone = zoneForDepth(this.depth);
    if (zone !== this.zone) {
      const prev = this.zone;
      this.zone = zone;
      if (this.game.world) this.game.world.setZone(zone, false);
      this.bus.emit("sub:zone", { zone, prev });
    }

    /* Deepest is a max, so writing it from here is idempotent and costs one
       comparison. game.js still owns when it hits disk. */
    this.deepestTimer -= dt;
    if (this.deepestTimer <= 0) {
      this.deepestTimer = 0.5;
      const st = this.game.profile && this.game.profile.stats;
      if (st && this.depth > (st.deepest || 0)) st.deepest = Math.round(this.depth);
    }

    if (this.game.audio) {
      this.game.audio.setDepth(this.depth);
      this.game.audio.setThrust(clamp01(this.speed / Math.max(1, this.stats.maxSpeed)));
    }
  }

  updateCockpit() {
    if (this.glassMat) {
      // Sunlight is gone by the twilight, and so is the reflection.
      const daylight = 1 - clamp01(this.depth / 240);
      this.glassMat.opacity = 0.006 + 0.055 * daylight * daylight;
    }
    // Two lamps on the lip: green, amber, red. Read them out of the corner of
    // your eye and you will know before the gauges tell you.
    const hullFrac = clamp01(this.hull / Math.max(1, this.hullMax));
    const cellFrac = clamp01(this.battery / Math.max(1, this.batteryMax));
    lampColor(hullFrac, this.hullLampMat.color);
    lampColor(cellFrac, this.cellLampMat.color);
    /* Under real load the lamps flicker rather than sit. */
    if (hullFrac < 0.3) {
      this.hullLampMat.color.multiplyScalar(0.55 + Math.random() * 0.45);
    }
    if (cellFrac < 0.15) {
      this.cellLampMat.color.multiplyScalar(0.4 + Math.random() * 0.6);
    }
  }

  updateCamera(dt) {
    const cam = this.game.camera;
    if (!cam || !this.cockpitOffset) return;

    const shake = clamp01((this.game.vfx && this.game.vfx.shake) || 0);
    if (shake > 0.001) {
      /* Sines beat pure noise here: the cabin rings, it does not buzz. */
      const t = this.time;
      const amp = shake * 0.075;
      cam.position.set(
        this.cockpitOffset.x + Math.sin(t * 47.3) * amp,
        this.cockpitOffset.y + Math.sin(t * 38.1 + 1.7) * amp,
        this.cockpitOffset.z + Math.sin(t * 29.7 + 0.4) * amp * 0.4,
      );
      cam.rotation.set(
        Math.sin(t * 41.9 + 2.1) * shake * 0.022,
        Math.sin(t * 33.3 + 0.9) * shake * 0.022,
        Math.sin(t * 26.1 + 1.3) * shake * 0.05,
      );
    } else if (cam.position.x !== this.cockpitOffset.x || cam.rotation.z !== 0) {
      cam.position.copy(this.cockpitOffset);
      cam.rotation.set(0, 0, 0);
    }

    if (cam.isPerspectiveCamera) {
      const ratio = clamp01(this.speed / Math.max(1, this.stats.maxSpeed));
      const target = this.baseFov + ratio * FOV_SPEED_GAIN + (this.boosting ? FOV_BOOST_GAIN : 0);
      const next = damp(cam.fov, target, 3.6, dt);
      if (Math.abs(next - cam.fov) > 0.01) {
        cam.fov = next;
        // The window is fitted to the frustum, so a boost that widens the view
        // has to widen the window with it.
        this.layoutCockpit();
        cam.updateProjectionMatrix();
      }
    }
  }

  /* Cycles the flavour lines so a bad minute does not repeat one sentence. */
  nextLine(lines) {
    this.lineIndex = (this.lineIndex + 1) % lines.length;
    return lines[this.lineIndex];
  }

  /* ====================================================================== */

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("pointerlockchange", this.onLockChange);
    if (this.canvas) {
      this.canvas.removeEventListener("mousedown", this.onMouseDown);
      this.canvas.removeEventListener("click", this.onCanvasClick);
      this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    }
    this.releaseLook();

    /* Hand the camera back before the hull leaves the graph, or it goes with it. */
    const cam = this.game.camera;
    if (cam) {
      if (this.cockpit && this.cockpit.parent === cam) cam.remove(this.cockpit);
      if (this.cabinGlow && this.cabinGlow.parent === cam) cam.remove(this.cabinGlow);
      if (cam.parent === this.object) {
        this.object.remove(cam);
        this.game.scene.add(cam);
      }
    }

    if (this.object.parent) this.object.parent.remove(this.object);
    for (const item of this.disposables) {
      if (item && typeof item.dispose === "function") item.dispose();
    }
    this.disposables.length = 0;
    for (const spot of this.floods) spot.dispose();
    this.hullGlow.dispose();
    this.cabinGlow.dispose();
    this.floods.length = 0;
    this.floodTargets.length = 0;
  }
}

/* A damage source can be a creature, a string, or nothing. The player only ever
   sees a name, so flatten it here rather than in five call sites. */
function causeOf(source) {
  if (!source) return "the sea";
  if (typeof source === "string") return source;
  if (source.type && source.type.name) return source.type.name;
  if (source.name) return source.name;
  return "the sea";
}

/* Green -> amber -> red across a 0..1 gauge, in one lerp pair. */
function lampColor(frac, out) {
  if (frac > 0.5) {
    _lampA.setHex(0xffb066);
    _lampB.setHex(0x6fe3a0);
    return out.copy(_lampA).lerp(_lampB, clamp01((frac - 0.5) * 2));
  }
  _lampA.setHex(0xff4d4d);
  _lampB.setHex(0xffb066);
  return out.copy(_lampA).lerp(_lampB, clamp01(frac * 2));
}
