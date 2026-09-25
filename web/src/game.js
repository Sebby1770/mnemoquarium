/* The orchestrator. It owns the renderer, the clock, the mode machine, and the
   only copy of the rules about money: everything else asks it. */

import * as THREE from "three";

import { Bus } from "./bus.js";
import { ECONOMY, SEA, SUB, ZONES, zoneForDepth, zoneIndex } from "./config.js";
import { clamp, clamp01, formatCredits, formatDepth, makeRng } from "./util.js";
import { fnv } from "./mnemo.js";
import { loadProfile, newProfile, saveProfile } from "./save.js";
import { applyUpgrade, computeStats } from "./progression.js";
import { Ecology } from "./ecology.js";
import { SeaWorld } from "./world.js";
import { VFX } from "./vfx.js";
import { Submarine } from "./sub.js";
import { FishManager } from "./fish.js";
import { CreatureManager } from "./creatures.js";
import { Combat } from "./combat.js";
import { Audio } from "./audio.js";
import { Water } from "./water.js";
import { Landmarks } from "./landmarks.js";
import { SkyAndSea } from "./sky.js";
import { PostFX } from "./post.js";
import { HUD } from "./hud.js";
import { Chart } from "./chart.js";
import { ResolutionGovernor, pixelRatioFor } from "./quality.js";
import { InputDevices } from "./input.js";
import { splitFrame } from "./frame.js";
import { AmbientLife } from "./ambient.js";
import { Base } from "./base.js";
import { PhotoMode } from "./photo.js";
import { attachAnalytics } from "./analytics.js";

const SAVE_INTERVAL = 4;       // seconds between debounced writes

const _worldEye = new THREE.Vector3();

export class Game {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.bus = new Bus();
    this.mode = "boot";
    this.elapsed = 0;
    this.dt = 0;
    this.paused = false;
    this.running = false;
    this.disposed = false;

    /* ---- identity ------------------------------------------------------- */
    const profile = opts.profile || null;
    this.phrase = String(opts.phrase || (profile && profile.phrase) || "").trim();
    if (!this.phrase) this.phrase = "forgotten kiosk under neon rain";
    this.seed = fnv(["mnemoquarium-deep", this.phrase]);
    this.rng = makeRng(this.seed, "game");

    // A different phrase is a different sea, so it gets a different logbook.
    this.profile = profile && profile.phrase === this.phrase
      ? profile
      : newProfile(this.phrase, this.seed);
    this.profile.phrase = this.phrase;
    this.profile.seed = this.seed;
    this.stats = computeStats(this.profile.upgrades);

    /* ---- three.js plumbing ---------------------------------------------- */
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.governor = new ResolutionGovernor(this.profile.settings && this.profile.settings.quality);
    this.renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio, this.governor.scale));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(78, window.innerWidth / Math.max(1, window.innerHeight), 0.1, 1400);
    this.clock = new THREE.Clock();

    /* ---- subsystems, in the order the contract fixes -------------------- */
    this.ecology = new Ecology(this.phrase, this.seed);
    // Water first: every lit material built after this asks it for the optics.
    this.water = new Water(this);
    // The surface and the sky borrow the water's optics, and the boat floats
    // on the surface, so this sits between the two.
    this.sky = new SkyAndSea(this);
    /* Bloom and grade. If the half-float targets are not available the game
       falls back to drawing straight to the canvas rather than not drawing. */
    try {
      this.post = new PostFX(this);
    } catch (err) {
      console.warn("post-processing unavailable, drawing direct", err);
      this.post = null;
    }
    this.world = new SeaWorld(this);
    this.vfx = new VFX(this);
    this.sub = new Submarine(this);
    this.fish = new FishManager(this);
    this.creatures = new CreatureManager(this);
    this.landmarks = new Landmarks(this);
    this.ambient = new AmbientLife(this);
    this.combat = new Combat(this);
    this.audio = new Audio(this);
    this.hud = new HUD(this);
    this.chart = new Chart(this);
    this.input = new InputDevices(this);
    // The inside of the Hull: its own scene, drawn while you are aboard.
    this.base = new Base(this);
    this.photo = new PhotoMode(this);
    this._captures = [];
    this.offAnalytics = attachAnalytics(this);

    /* Patch everything already in the scene, then keep patching as creatures
       arrive. register() is idempotent, so spawning is cheap. */
    this.water.adoptScene(this.scene);
    this.bus.on("creature:spawn", (e) => {
      if (e && e.creature) this.water.adopt(e.creature.object);
    });

    /* ---- bookkeeping ---------------------------------------------------- */
    this.dirty = false;
    this.saveTimer = 0;
    this.taught = Object.create(null);
    this.deadCause = null;

    this._bind();
  }

  /* ===================================================================== */
  /* wiring                                                                */
  /* ===================================================================== */

  _bind() {
    const bus = this.bus;
    this.offs = [
      bus.on("station:dock", () => this._onDocked()),
      bus.on("sub:destroyed", (e) => this._onDestroyed(e && e.cause)),
      bus.on("creature:killed", (e) => this._onKill(e)),
      bus.on("fish:captured", (e) => this._onCatch(e)),
      bus.on("sub:zone", (e) => this._onZone(e)),
      bus.on("profile:changed", () => { this.dirty = true; }),
    ];

    this._onResize = () => this.resize();
    this._onVisibility = () => {
      if (document.hidden && this.mode === "dive") this.setMode("paused");
    };
    this._onUnload = () => this.persist(true);

    window.addEventListener("resize", this._onResize);
    window.addEventListener("orientationchange", this._onResize);
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("pagehide", this._onUnload);
  }

  resize() {
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio, this.governor.scale));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // The cockpit window is cut to the frustum, so it is re-cut on resize.
    if (this.sub && this.sub.layoutCockpit) this.sub.layoutCockpit();
    if (this.post) this.post.setSize();
    if (this.base) this.base.resize();
    this.governor.reset();
  }

  /* Graphics setting from the pause panel: "auto" | "high" | "low". */
  setQuality(mode) {
    const before = this.governor.scale;
    this.governor.setMode(mode);
    if (this.governor.scale !== before) this.resize();
  }

  /* ===================================================================== */
  /* the loop                                                              */
  /* ===================================================================== */

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.clock.start();

    /* Straight into the water. The Hull is right behind you and the prompt to
       dock shows whenever you are near it, so the shop is never more than a few
       seconds away — but nobody should have to read a menu to start playing. */
    const zone = zoneForDepth(0);
    this.world.setZone(zone, true);
    this.sub.undock();
    this.profile.stats.dives = (this.profile.stats.dives || 0) + 1;
    this.setMode("dive");
    this._startSound();

    this.log(`the tanks flood. "${this.phrase}" is already down there, in ${this.ecology.species.length} shapes.`, "lore");
    this.log("hold the right mouse button on a fish to take it. the hold sells at the Hull behind you — dock, and walk aboard.", "info");
    this.log("click to look around.", "info");

    this._tick = (now) => {
      if (this.disposed) return;
      this._raf = requestAnimationFrame(this._tick);
      this.frame(now);
    };
    this._raf = requestAnimationFrame(this._tick);
  }

  /* The Dive click was a gesture, so most browsers let sound start here. Safari
     wants the start inside the gesture itself, so the first click or key after
     this tries again, once. */
  _startSound() {
    const audio = this.audio;
    if (!audio || !this.profile.settings || !this.profile.settings.sound) return;
    audio.start();
    const retry = () => {
      window.removeEventListener("pointerdown", retry, true);
      window.removeEventListener("keydown", retry, true);
      this._soundRetry = null;
      if (this.profile.settings.sound && !this.disposed) audio.start();
    };
    this._soundRetry = retry;
    window.addEventListener("pointerdown", retry, true);
    window.addEventListener("keydown", retry, true);
  }

  frame() {
    const raw = this.clock.getDelta();
    // Only a frame that draws the sea at full cost says anything about the GPU.
    if (this.mode === "dive" && this.governor.sample(raw) !== null) this.resize();

    // Photo mode holds the sea still: every system gets a zero step.
    const frozen = this.photo && this.photo.frozen();
    const { steps, dt: step } = frozen ? { steps: 1, dt: 0 } : splitFrame(raw);
    const dt = step * steps;
    this.dt = step;

    this.input.update(dt);
    for (let i = 0; i < steps; i += 1) this.simulate(step);
    // The world streams terrain and scenery around the eye; once a frame will do.
    this.world.update(dt, this.camera.getWorldPosition(_worldEye));
    this.sky.update(dt, _worldEye);
    this.landmarks.update(dt);
    this.ambient.update(dt);
    this.water.update(dt);
    this.vfx.update(dt);
    this.audio.update(dt);
    this.hud.update(dt);
    this.chart.update(dt);
    this.base.update(dt);

    this.saveTimer -= dt;
    if (this.dirty && this.saveTimer <= 0) this.persist(true);

    // A photo is taken at full resolution whatever the governor has chosen.
    const capturing = this._captures.length > 0;
    const sharpen = capturing && this.governor.scale < 1;
    if (sharpen) {
      this.renderer.setPixelRatio(pixelRatioFor(window.devicePixelRatio, 1));
      this.renderer.setSize(window.innerWidth, Math.max(1, window.innerHeight), false);
      if (this.post) this.post.setSize();
    }

    // Aboard, the room is drawn instead of the sea.
    const aboard = this.base.active;
    const scene = aboard ? this.base.scene : this.scene;
    const camera = aboard ? this.base.camera : this.camera;
    if (this.post) {
      try {
        this.post.render(scene, camera, dt);
      } catch (err) {
        console.warn("post-processing failed, drawing direct from now on", err);
        this.post = null;
        this.renderer.setRenderTarget(null);
        this.renderer.render(scene, camera);
      }
    } else {
      this.renderer.render(scene, camera);
    }

    /* Read the frame back now, in the same task as the draw: without
       preserveDrawingBuffer the canvas is only guaranteed to hold it here. */
    if (capturing) {
      const callbacks = this._captures.splice(0);
      for (const cb of callbacks) {
        try {
          cb(this.canvas);
        } catch (err) {
          console.warn("capture failed", err);
        }
      }
      if (sharpen) this.resize();
    }
  }

  /* Hand the next rendered frame to cb(canvas). */
  requestCapture(cb) {
    if (typeof cb === "function") this._captures.push(cb);
  }

  /* One fixed-ish step of everything that moves. */
  simulate(dt) {
    // Aboard counts as live: the clamps repair and recharge while you walk.
    const live = this.mode === "dive" || this.mode === "station" || this.mode === "base";
    if (live) this.elapsed += dt;

    // The world keeps breathing while a panel is open — a frozen sea behind
    // the drydock would make the station feel like a different program.
    this.sub.update(live ? dt : 0);
    if (this.mode === "dive") {
      this.fish.update(dt);
      this.creatures.update(dt);
      this.combat.update(dt);
    } else {
      this.fish.update(dt * 0.35);
      this.creatures.update(dt * 0.2);
      this.combat.update(dt);
    }
  }

  /* ===================================================================== */
  /* modes                                                                 */
  /* ===================================================================== */

  setMode(mode) {
    if (mode === this.mode) return;
    const prev = this.mode;
    this.mode = mode;

    this.sub.setInputEnabled(mode === "dive");
    if (mode !== "dive") this.sub.releaseLook();
    if (this.hud) this.hud.setMode(mode);
    if (this.audio && mode !== "dive") this.audio.setThreat(0);

    this.governor.reset();
    this.bus.emit("mode", { mode, prev });
    this.persist();
  }

  _onZone(e) {
    const zone = e && e.zone;
    if (!zone) return;
    this.world.setZone(zone);
    if (this.audio) this.audio.setDepth(this.sub.depth);

    // The band you cannot survive yet is the whole plot.
    const rating = this.stats.pressureRating;
    if (zone.bottom > rating && !this.taught[`gate-${zone.id}`]) {
      this.taught[`gate-${zone.id}`] = true;
      this.log(`${zone.name}: ${zone.blurb}. rated to ${formatDepth(rating)} — a deeper casing is the only way further down.`, "warn");
    }
  }

  /* ===================================================================== */
  /* docking and the station                                               */
  /* ===================================================================== */

  _onDocked() {
    if (this.mode === "station" || this.mode === "base") return;
    // Clamps on, and you climb out into the moon pool.
    this.setMode("base");
    const cargo = this.profile.cargo || [];
    if (cargo.length) {
      const worth = cargo.reduce((sum, it) => sum + (Number(it.value) || 0), 0);
      this.log(`clamps on. ${cargo.length} in the hold, ${formatCredits(worth)} credits of it.`, "good");
    } else {
      this.log("clamps on. nothing in the hold, but the repairs are free.", "info");
    }
    this.persist(true);
  }

  undock() {
    this.sub.undock();
    this.profile.stats.dives = (this.profile.stats.dives || 0) + 1;
    this.bus.emit("station:undock", {});
    this.setMode("dive");
    if (this.profile.stats.dives === 1) {
      this.log("hold the beam on a fish to take it. the lamps make you easier to find.", "info");
    }
    this.persist(true);
  }

  /* ===================================================================== */
  /* money                                                                 */
  /* ===================================================================== */

  addCredits(delta, reason) {
    const amount = Math.round(Number(delta) || 0);
    if (!amount) return this.profile.credits;
    this.profile.credits = Math.max(0, Math.round((this.profile.credits || 0) + amount));
    if (amount > 0) {
      const s = this.profile.stats;
      s.creditsEarned = (s.creditsEarned || 0) + amount;
    }
    this.bus.emit("economy:credits", { credits: this.profile.credits, delta: amount, reason });
    this.dirty = true;
    return this.profile.credits;
  }

  sellAll() {
    const cargo = this.profile.cargo || [];
    if (!cargo.length) {
      this.toast("the hold is empty");
      if (this.audio) this.audio.sfx("deny");
      return 0;
    }
    const items = cargo.length;
    const credits = cargo.reduce((sum, it) => sum + (Number(it.value) || 0), 0);
    const fish = cargo.reduce((n, it) => n + (it.kind === "trophy" ? 0 : 1), 0);
    const best = cargo.reduce((a, b) => ((Number(b.value) || 0) > (Number(a.value) || 0) ? b : a), cargo[0]);

    this.profile.cargo = [];
    this.sub.cargoFull = false;
    this.profile.stats.fishSold = (this.profile.stats.fishSold || 0) + fish;
    this.addCredits(credits, "market");

    this.bus.emit("economy:sold", { credits, items });
    this.bus.emit("profile:changed", {});
    if (this.audio) this.audio.sfx("sell");
    this.log(`the Hull takes all ${items} and pays ${formatCredits(credits)}. the best of it was ${best.name}.`, "good");
    this._teachDrydock();
    this.persist(true);
    if (this.hud) {
      this.hud.refreshStation();
      this.hud.refreshCargo();
    }
    return credits;
  }

  sellItem(id) {
    const cargo = this.profile.cargo || [];
    const at = cargo.findIndex((it) => it && it.id === id);
    if (at < 0) return 0;
    const item = cargo.splice(at, 1)[0];
    const credits = Number(item.value) || 0;
    this.sub.cargoFull = cargo.length >= this.stats.cargoSlots;
    if (item.kind !== "trophy") {
      this.profile.stats.fishSold = (this.profile.stats.fishSold || 0) + 1;
    }
    this.addCredits(credits, "market");
    this.bus.emit("economy:sold", { credits, items: 1 });
    this.bus.emit("profile:changed", {});
    if (this.audio) this.audio.sfx("sell");
    this._teachDrydock();
    this.persist(true);
    if (this.hud) {
      this.hud.refreshStation();
      this.hud.refreshCargo();
    }
    return credits;
  }

  _teachDrydock() {
    if (this.taught.drydock) return;
    this.taught.drydock = true;
    this.log("the drydock is the other tab. pressure casing first — everything worth money is below your rating.", "info");
  }

  buyUpgrade(id) {
    const res = applyUpgrade(this.profile, id) || { ok: false };
    if (!res.ok) {
      this.toast(res.reason || "not enough credits");
      if (this.audio) this.audio.sfx("deny");
      return res;
    }
    this.recomputeStats();
    if (this.audio) this.audio.sfx("upgrade");
    this.bus.emit("economy:upgrade", { id, level: res.level, cost: res.cost });
    this.bus.emit("profile:changed", {});

    if (id === "pressure") {
      this.log(`casing rated to ${formatDepth(this.stats.pressureRating)}. that is a new band open.`, "good");
    } else {
      this.log(`refit: ${id} to mark ${res.level}, ${formatCredits(res.cost)} credits.`, "good");
    }
    this.persist(true);
    if (this.hud) this.hud.refreshStation();
    return res;
  }

  recomputeStats() {
    this.stats = computeStats(this.profile.upgrades);
    if (this.sub) this.sub.applyStats();
    return this.stats;
  }

  /* ===================================================================== */
  /* catching and killing                                                  */
  /* ===================================================================== */

  _onCatch(e) {
    const item = e && e.item;
    if (!item) return;
    const seen = this.profile.stats.discovered || (this.profile.stats.discovered = []);
    if (item.speciesIndex >= 0 && !seen.includes(item.speciesIndex)) {
      seen.push(item.speciesIndex);
      const sp = this.ecology.species[item.speciesIndex];
      if (sp) this.log(this.ecology.describe(sp), "lore");
    }
    this.dirty = true;

    if (!this.taught.hold && this.sub.cargoFull) {
      this.taught.hold = true;
      this.log("the hold is full. it is only money once it is on the clamps.", "warn");
    }
  }

  /* A kill pays in salvage if there is room to carry it, and in a flat bounty
     from the Hull if there is not. Carrying it home is worth more, and costs
     you the slot — which is the trade the whole game is about. */
  _onKill(e) {
    const creature = e && e.creature;
    const item = e && e.item;
    const bounty = (e && e.bounty) || 0;
    if (!creature) return;

    const kills = this.profile.stats.kills || (this.profile.stats.kills = {});
    const id = creature.type.id;
    kills[id] = (kills[id] || 0) + 1;

    let stowed = false;
    if (item && this.sub && !this.sub.cargoFull) stowed = this.sub.addCargo(item);

    if (stowed) {
      this.log(`${creature.type.name} down. the ${item.label} goes in the hold, ${formatCredits(item.value)} credits of it.`, "good");
    } else {
      this.addCredits(Math.round(bounty * ECONOMY.trophyValueShare), "bounty");
      this.log(`${creature.type.name} down. no room for the ${item ? item.label : "salvage"}, so the Hull wires ${formatCredits(bounty)} for the bounty.`, "good");
    }
    if (creature.type.boss) {
      this.toast(`${creature.type.name} killed`);
      this.log("the static goes out of the water. whatever that was, it is not any more.", "lore");
    }
    this.dirty = true;
    this.persist();
  }

  /* ===================================================================== */
  /* dying                                                                 */
  /* ===================================================================== */

  _onDestroyed(cause) {
    if (this.mode === "dead") return;
    this.deadCause = cause || null;
    // The panel reads the loss off the profile, so it paints before we settle.
    this.setMode("dead");

    const cargo = this.profile.cargo || [];
    const lost = Math.round((this.profile.credits || 0) * SUB.respawnPenalty);
    this.profile.cargo = [];
    this.profile.credits = Math.max(0, (this.profile.credits || 0) - lost);
    this.profile.stats.deaths = (this.profile.stats.deaths || 0) + 1;
    this.sub.cargoFull = false;

    this.bus.emit("profile:changed", {});
    if (this.audio) this.audio.sfx("alarm");
    this.log(`the hull goes. ${cargo.length} specimens back into the dark, ${formatCredits(lost)} credits for the tow.`, "bad");
    this.persist(true);
  }

  revive() {
    this.sub.respawn();
    this.deadCause = null;
    this.setMode("base");
    this.log("you wake up on the clamps with the lamps already on. the sea keeps the same shape.", "info");
    this.persist(true);
  }

  /* Surfacing on purpose: you keep your credits and lose the hold. */
  abandonDive() {
    const cargo = this.profile.cargo || [];
    if (cargo.length) {
      this.log(`you blow the hold to get up fast. ${cargo.length} back into the dark.`, "warn");
    }
    this.profile.cargo = [];
    this.sub.cargoFull = false;
    this.sub.respawn();
    this.bus.emit("profile:changed", {});
    this.setMode("base");
    this.persist(true);
  }

  /* ===================================================================== */
  /* small services                                                        */
  /* ===================================================================== */

  log(text, kind) {
    if (!text) return;
    this.bus.emit("log", { text: String(text), kind: kind || "info" });
  }

  toast(text) {
    if (!text) return;
    this.bus.emit("toast", { text: String(text) });
  }

  persist(now) {
    this.dirty = true;
    if (!now && this.saveTimer > 0) return;
    this.saveTimer = SAVE_INTERVAL;
    this.profile.updated = Date.now();
    saveProfile(this.profile);
    this.dirty = false;
  }

  dispose() {
    this.disposed = true;
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const off of this.offs || []) off();
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("orientationchange", this._onResize);
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("pagehide", this._onUnload);
    if (this._soundRetry) {
      window.removeEventListener("pointerdown", this._soundRetry, true);
      window.removeEventListener("keydown", this._soundRetry, true);
    }

    if (this.offAnalytics) this.offAnalytics();
    for (const system of [this.photo, this.base, this.input, this.chart, this.hud, this.audio, this.combat, this.ambient, this.landmarks, this.creatures, this.fish, this.sub, this.vfx, this.world, this.sky, this.water, this.post, this.ecology]) {
      try {
        if (system && system.dispose) system.dispose();
      } catch (err) {
        console.error("dispose failed", err);
      }
    }
    this.bus.clear();
    this.renderer.dispose();
  }
}


