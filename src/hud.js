/* The instrument panel, and every screen the player reads instead of the sea.
   The HUD observes; it never decides. Economy rules live in progression.js and
   game.js — this module only asks them questions and draws the answers.

   Two rules keep it cheap enough to run at 60 fps next to a renderer:
   1. Element references are looked up once, in the constructor.
   2. Nothing is written to the DOM unless the value actually changed. Every
      readout keeps its last rendered string in `this.last`. */

import * as THREE from "three";
import {
  ZONES,
  RARITY,
  SUB,
  WEAPONS,
  UPGRADES,
  HOTKEYS,
  zoneIndex,
} from "./config.js";
import {
  clamp,
  clamp01,
  damp,
  formatCredits,
  formatDepth,
  smoothstep,
} from "./util.js";
import {
  upgradeLevel,
  upgradeCost,
  applyUpgrade,
  describeStats,
} from "./progression.js";

/* Scratch, hoisted so the per-frame loops never allocate. */
const _fwd = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _rel = new THREE.Vector3();

/* Crosshair ring geometry, straight out of index.html (r = 18). */
const RING_CIRCUMFERENCE = 2 * Math.PI * 18;

/* The compass tape. Three copies of a full turn sit side by side so the strip
   can be scrolled with one transform and never run out of tape at the seams. */
const COMPASS_STEP = 15;                 // degrees between ticks
const COMPASS_PX_PER_DEG = 3.4;
const COMPASS_TURN_PX = 360 * COMPASS_PX_PER_DEG;
const COMPASS_CARDINALS = {
  0: "N", 45: "NE", 90: "E", 135: "SE",
  180: "S", 225: "SW", 270: "W", 315: "NW",
};
const COMPASS_POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/* Warnings, in the order they stack. Each one owns a node that is created once
   and then only toggled. */
const WARNING_ORDER = ["hull", "pressure", "battery", "boundary", "hold"];

/* Units for the drydock readouts. The tuning table stores bare numbers. */
const UPGRADE_UNITS = {
  pressure: " m",
  lights: " m",
  sonar: " m",
  capture: " m",
  thrust: " m/s2",
  repair: " hp/s",
  reactor: " /s",
};

const CONTACT_POOL = 44;
const CONTACT_LIFE = 6.5;      // seconds a pinged contact lingers
const CONTACT_FADE = 2.0;      // last seconds of that life spent fading out
const LOG_LINES = 7;
const LOG_LIFE = 16;           // seconds before a line dissolves on its own

function pick(id) {
  const node = document.getElementById(id);
  if (node) return node;
  // The markup is fixed, but one missing id must never take the whole HUD down.
  return document.createElement("div");
}

function hexColor(value) {
  const n = Number(value) || 0;
  return `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

function hueColor(hue, sat = 72, light = 62) {
  return `hsl(${((Number(hue) || 0) % 360 + 360) % 360} ${sat}% ${light}%)`;
}

/* three.js looks down -Z, so we simply call -Z north and the compass, the map
   in the player's head, and the station bearing all agree. */
function bearingOf(x, z) {
  return (Math.atan2(x, -z) * 180 / Math.PI + 360) % 360;
}

function compassPoint(deg) {
  const i = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return COMPASS_POINTS[i];
}

function shortDeg(delta) {
  let d = ((delta % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function formatRange(metres) {
  const m = Math.max(0, Number(metres) || 0);
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function zoneById(id) {
  return ZONES.find((z) => z.id === id) || ZONES[0];
}

function elem(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class HUD {
  constructor(game) {
    this.game = game;
    this.bus = game.bus;
    this.mode = null;
    this.time = 0;

    // Subsystems. Construction order guarantees these exist by now.
    this.sub = game.sub;
    this.world = game.world;
    this.fish = game.fish;
    this.creatures = game.creatures;
    this.combat = game.combat;
    this.ecology = game.ecology;
    this.camera = game.camera;

    this.last = Object.create(null);
    this.offs = [];
    this.timers = [];
    this.made = [];        // nodes this module created, for dispose()

    this.cacheElements();
    this.buildCompass();
    this.buildReticle();
    this.buildWarnings();
    this.buildContacts();
    this.buildCreditDelta();

    // Rolling state the panels read back.
    this.logLines = [];
    this.toastQueue = [];
    this.toastTimer = 0;
    this.contacts = [];
    this.weaponRows = [];
    this.shopRows = new Map();
    this.creditsShown = Number(game.profile?.credits) || 0;
    this.damage = 0;
    this.threat = 0;
    this.zoneId = null;
    this.sonarReady = 0;
    this.sonarSpan = 0;
    this.aimTimer = 0;
    this.slowTimer = 0;
    this.aim = null;       // { kind, name, meta, hp }
    this.cargoOpen = false;
    this.deadCause = null;
    this.lastLogText = "";
    this.lastLogAt = -1;
    this.lastToastText = "";
    this.lastToastAt = -1;

    this.viewW = window.innerWidth || 1280;
    this.viewH = window.innerHeight || 720;
    this.compassWidth = 0;

    this.onResize = () => this.measure();
    this.onKeyDown = (ev) => this.handleKey(ev, true);
    this.onKeyUp = (ev) => this.handleKey(ev, false);
    this.onBlur = () => this.setCargoOpen(false);
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);

    this.bindPanels();
    this.bindBus();
    this.measure();

    this.loadingText.textContent = game.phrase
      ? `growing a sea from "${game.phrase}"`
      : "growing the sea";
    this.refreshRoster();
    this.refreshCargo();
    this.setMode(game.mode || "boot");
  }

  // ---------------------------------------------------------------- setup --

  cacheElements() {
    this.root = pick("hud");
    this.vignette = pick("vignette");
    this.damageFlash = pick("damage-flash");

    this.crosshair = pick("crosshair");
    this.crosshairProgress = pick("crosshair-progress");
    this.reticleLabel = pick("reticle-label");
    this.contactsLayer = pick("contacts");

    this.compass = pick("compass");
    this.compassStrip = pick("compass-strip");
    this.compassNeedle = pick("compass-needle");

    this.zonePlate = pick("zone-plate");
    this.readoutZone = pick("readout-zone");
    this.readoutZoneBlurb = pick("readout-zone-blurb");
    this.creditPlate = pick("credit-plate");
    this.readoutCredits = pick("readout-credits");

    this.warnings = pick("warnings");

    this.gauges = {
      hull: this.gaugeParts("gauge-hull"),
      battery: this.gaugeParts("gauge-battery"),
      cargo: this.gaugeParts("gauge-cargo"),
    };

    this.readoutDepth = pick("readout-depth");
    this.readoutSpeed = pick("readout-speed");
    this.readoutRating = pick("readout-rating");
    this.readoutFloor = pick("readout-floor");

    this.weaponRack = pick("weapon-rack");
    this.sonarNote = pick("sonar-note");
    this.logList = pick("log");
    this.toastNode = pick("toast");
    this.objective = pick("objective");
    this.hintDock = pick("hint-dock");

    this.panels = {
      start: pick("panel-start"),
      station: pick("panel-station"),
      cargo: pick("panel-cargo"),
      pause: pick("panel-pause"),
      dead: pick("panel-dead"),
      loading: pick("loading"),
    };

    this.startRoster = pick("start-roster");
    this.stationCredits = pick("station-credits");
    this.stationTabs = pick("station-tabs");
    this.marketSummary = pick("market-summary");
    this.sellAllBtn = pick("btn-sell-all");
    this.marketList = pick("market-list");
    this.shopList = pick("shop-list");
    this.stationStats = pick("station-stats");
    this.stationSpecies = pick("station-species");
    this.undockBtn = pick("btn-undock");
    this.cargoList = pick("cargo-list");
    this.pauseStats = pick("pause-stats");
    this.resumeBtn = pick("btn-resume");
    this.abandonBtn = pick("btn-abandon");
    this.toggleSound = pick("toggle-sound");
    this.toggleInvert = pick("toggle-invert");
    this.rangeSens = pick("range-sens");
    this.deadHeadline = pick("dead-headline");
    this.deadDetail = pick("dead-detail");
    this.reviveBtn = pick("btn-revive");
    this.loadingText = pick("loading-text");
    this.loadingBar = pick("loading-bar");

    this.tabBodies = {
      market: pick("station-market"),
      drydock: pick("station-drydock"),
      log: pick("station-log"),
    };
  }

  gaugeParts(id) {
    const root = pick(id);
    return {
      root,
      fill: root.querySelector(".gauge-fill") || elem("div"),
      value: root.querySelector(".gauge-value") || elem("span"),
    };
  }

  /* Three turns of tape, so scrolling never reaches an end. */
  buildCompass() {
    const frag = document.createDocumentFragment();
    for (let copy = 0; copy < 3; copy += 1) {
      for (let deg = 0; deg < 360; deg += COMPASS_STEP) {
        const label = COMPASS_CARDINALS[deg];
        const mark = elem("span", label ? "cmark cmark-major" : "cmark");
        if (label) mark.textContent = label;
        mark.style.left = `${(copy * 360 + deg) * COMPASS_PX_PER_DEG}px`;
        frag.appendChild(mark);
      }
    }
    this.compassStrip.replaceChildren(frag);
    this.compassStrip.style.width = `${COMPASS_TURN_PX * 3}px`;
  }

  buildReticle() {
    this.reticleName = elem("span", "rl-name");
    this.reticleMeta = elem("span", "rl-meta");
    this.reticleBar = elem("span", "rl-bar");
    this.reticleBarFill = elem("i");
    this.reticleBar.appendChild(this.reticleBarFill);
    this.reticleLabel.replaceChildren(this.reticleName, this.reticleMeta, this.reticleBar);
    this.crosshairProgress.style.strokeDasharray = `${RING_CIRCUMFERENCE.toFixed(2)}`;
    this.crosshairProgress.style.strokeDashoffset = `${RING_CIRCUMFERENCE.toFixed(2)}`;
  }

  buildWarnings() {
    this.warnNodes = new Map();
    const frag = document.createDocumentFragment();
    for (const id of WARNING_ORDER) {
      const node = elem("p", "warn");
      node.dataset.id = id;
      node.hidden = true;
      const mark = elem("span", "warn-mark", "!");
      const text = elem("span", "warn-text");
      node.append(mark, text);
      this.warnNodes.set(id, { node, text, shown: false, message: "" });
      frag.appendChild(node);
    }
    this.warnings.replaceChildren(frag);
  }

  buildContacts() {
    this.contactPool = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < CONTACT_POOL; i += 1) {
      const node = elem("div", "contact");
      node.hidden = true;
      const tag = elem("span", "contact-tag");
      node.appendChild(tag);
      this.contactPool.push({ node, tag, tagText: "", kind: "", off: null, alpha: -1 });
      frag.appendChild(node);
    }
    this.contactsLayer.replaceChildren(frag);
  }

  /* A transient "+1,240" that rides up out of the credit plate. */
  buildCreditDelta() {
    this.creditDelta = elem("span", "credit-delta");
    this.creditDelta.hidden = true;
    this.creditPlate.appendChild(this.creditDelta);
    this.made.push(this.creditDelta);
  }

  measure() {
    this.viewW = window.innerWidth || 1280;
    this.viewH = window.innerHeight || 720;
    this.compassWidth = this.compass.clientWidth || 280;
  }

  // -------------------------------------------------------------- wiring --

  bindBus() {
    const on = (name, fn) => this.offs.push(this.bus.on(name, fn));

    on("log", (p) => this.log(p && p.text, p && p.kind));
    on("toast", (p) => this.toast(p && p.text));
    on("mode", (p) => this.setMode(p && p.mode));

    on("sub:zone", (p) => this.onZone(p && p.zone));
    on("sub:damage", (p) => this.onDamage(p));
    on("sub:destroyed", (p) => this.onDestroyed(p));
    on("sub:collide", (p) => {
      this.damage = clamp01(this.damage + Math.min(0.5, (p && p.speed ? p.speed : 4) / 40));
    });
    on("sub:battery-empty", () => {
      this.setWarning("battery", "cell dead — lights and boost are gone");
    });

    on("fish:captured", () => {
      this.refreshCargo();
      this.pulse(this.gauges.cargo.root);
    });
    on("fish:cargo-full", () => this.pulse(this.gauges.cargo.root));

    on("creature:aggro", (p) => this.onAggro(p && p.creature));
    on("creature:killed", () => this.refreshCargo());

    on("sonar:ping", (p) => this.onPing(p && p.range));

    on("station:dock", () => this.refreshStation());
    on("station:undock", () => this.setCargoOpen(false));

    on("economy:sold", () => {
      this.refreshCargo();
      this.refreshStation();
    });
    on("economy:credits", (p) => this.onCredits(p));
    on("economy:upgrade", () => {
      this.refreshStation();
      this.syncSettings();
    });
    on("profile:changed", () => {
      this.refreshCargo();
      if (this.mode === "station") this.refreshStation();
    });
  }

  bindPanels() {
    const click = (node, fn) => {
      const handler = (ev) => {
        ev.preventDefault();
        fn(ev);
      };
      node.addEventListener("click", handler);
      this.timers.push(() => node.removeEventListener("click", handler));
    };

    // Station tabs are pure presentation, so the HUD owns them outright.
    const tabHandler = (ev) => {
      const btn = ev.target.closest("button[data-tab]");
      if (!btn) return;
      ev.preventDefault();
      this.selectTab(btn.dataset.tab);
    };
    this.stationTabs.addEventListener("click", tabHandler);
    this.timers.push(() => this.stationTabs.removeEventListener("click", tabHandler));

    const shopHandler = (ev) => {
      const btn = ev.target.closest("button[data-upgrade]");
      if (!btn || btn.disabled) return;
      ev.preventDefault();
      this.buyUpgrade(btn.dataset.upgrade);
    };
    this.shopList.addEventListener("click", shopHandler);
    this.timers.push(() => this.shopList.removeEventListener("click", shopHandler));

    click(this.sellAllBtn, () => this.sellAll());
    click(this.undockBtn, () => this.undock());
    click(this.resumeBtn, () => this.game.setMode("dive"));
    click(this.abandonBtn, () => this.abandonDive());
    click(this.reviveBtn, () => this.revive());

    const settings = () => this.applySettings();
    this.toggleSound.addEventListener("change", settings);
    this.toggleInvert.addEventListener("change", settings);
    this.rangeSens.addEventListener("input", settings);
    this.timers.push(() => {
      this.toggleSound.removeEventListener("change", settings);
      this.toggleInvert.removeEventListener("change", settings);
      this.rangeSens.removeEventListener("input", settings);
    });

    this.syncSettings();
  }

  handleKey(ev, down) {
    if (ev.repeat) return;
    // The hold drawer is the HUD's own; nothing else in the game owns it.
    if (HOTKEYS.cargo.includes(ev.code)) {
      if (this.mode !== "dive" && down) return;
      ev.preventDefault();
      this.setCargoOpen(down && this.mode === "dive");
    }
  }

  // -------------------------------------------------------------- events --

  onZone(zone) {
    if (!zone) return;
    this.applyZone(zone);
    // The plate takes a beat to resettle whenever the band changes.
    this.zonePlate.classList.remove("shift");
    void this.zonePlate.offsetWidth;
    this.zonePlate.classList.add("shift");
  }

  applyZone(zone) {
    if (!zone || zone.id === this.zoneId) return;
    this.zoneId = zone.id;
    document.body.dataset.zone = zone.id;
    this.readoutZone.textContent = zone.name;
    this.readoutZoneBlurb.textContent = zone.blurb || "";
  }

  onDamage(payload) {
    const amount = Number(payload && payload.amount) || 0;
    const max = Math.max(1, this.sub.hullMax || 100);
    this.damage = clamp01(this.damage + clamp(amount / (max * 0.28), 0.08, 1));
    this.pulse(this.gauges.hull.root);
  }

  onDestroyed(payload) {
    const cause = payload && payload.cause;
    this.deadCause = typeof cause === "string"
      ? cause
      : (cause && (cause.name || (cause.type && cause.type.name))) || null;
    this.damage = 1;
    this.writeDeath();
  }

  onAggro(creature) {
    if (!creature) return;
    this.addContact(creature, "hostile", true);
  }

  onPing(range) {
    const reach = Number(range) || (this.game.stats && this.game.stats.sonarRange) || SUB.sonarRangeBase;
    this.sonarSpan = Math.max(0.5, (this.game.stats && this.game.stats.sonarCooldown) || SUB.sonarCooldownBase);
    this.sonarReady = this.sonarSpan;
    this.paintContacts(reach);
  }

  onCredits(payload) {
    const delta = Math.round(Number(payload && payload.delta) || 0);
    if (!delta) return;
    this.creditDelta.textContent = `${delta > 0 ? "+" : ""}${formatCredits(delta)}`;
    this.creditDelta.dataset.sign = delta > 0 ? "up" : "down";
    this.creditDelta.hidden = false;
    this.creditDelta.classList.remove("rise");
    void this.creditDelta.offsetWidth;
    this.creditDelta.classList.add("rise");
    if (this.mode === "station") this.refreshStation();
  }

  pulse(node) {
    if (!node) return;
    node.classList.remove("pulse");
    void node.offsetWidth;
    node.classList.add("pulse");
  }

  // ---------------------------------------------------------------- frame --

  update(dt) {
    const step = Math.min(0.1, Math.max(0, dt || 0));
    this.time += step;

    this.updateCredits(step);
    this.updateToast(step);
    this.updateOverlays(step);

    if (this.sonarReady > 0) {
      this.sonarReady = Math.max(0, this.sonarReady - step);
      this.updateSonarNote();
    }

    const diving = this.mode === "dive" || this.mode === "paused";
    if (!diving) {
      this.setText(this.objective, "obj", "");
      return;
    }

    this.updateGauges();
    this.updateInstruments();
    this.updateCompass();
    this.updateWeapons();
    this.updateCrosshair(step);
    this.updateContacts(step);

    this.slowTimer -= step;
    if (this.slowTimer <= 0) {
      this.slowTimer = 0.2;
      this.updateSlow();
    }

    this.aimTimer -= step;
    if (this.aimTimer <= 0) {
      this.aimTimer = 0.1;
      this.sampleAim();
    }

    this.pruneLog();
  }

  /* Writes that only matter a few times a second: terrain samples, warnings,
     the dock prompt, the objective line. */
  updateSlow() {
    const sub = this.sub;
    const stats = this.game.stats || {};
    const pos = sub.position;

    const floorDepth = -this.world.heightAt(pos.x, pos.z);
    const rating = Number(stats.pressureRating) || SUB.pressureBase;
    this.setText(this.readoutFloor, "floor", formatDepth(floorDepth));
    // A floor deeper than your casing is the whole difficulty curve in one number.
    this.setAttr(this.readoutFloor, "floorState", floorDepth > rating ? "over" : "ok");

    const dockable = !sub.docked && this.world.isDockable(pos);
    if (this.hintDock.hidden === dockable) this.hintDock.hidden = !dockable;

    const zone = this.world.zoneAtPosition(pos);
    this.applyZone(zone);

    this.updateWarnings(floorDepth);
    this.updateObjective();
  }

  updateGauges() {
    const sub = this.sub;
    const profile = this.game.profile || { cargo: [] };
    const stats = this.game.stats || {};

    const hullMax = Math.max(1, sub.hullMax || SUB.hullBase);
    const hullT = clamp01(sub.hull / hullMax);
    this.writeGauge("hull", hullT, String(Math.max(0, Math.round(sub.hull))),
      hullT < 0.25 ? "crit" : hullT < 0.5 ? "warn" : "ok");

    const cellMax = Math.max(1, sub.batteryMax || SUB.batteryBase);
    const cellT = clamp01(sub.battery / cellMax);
    this.writeGauge("battery", cellT, String(Math.max(0, Math.round(sub.battery))),
      cellT < 0.12 ? "crit" : cellT < 0.3 ? "warn" : "ok");

    const slots = Math.max(1, Math.round(Number(stats.cargoSlots) || SUB.cargoSlotsBase));
    const held = profile.cargo ? profile.cargo.length : 0;
    const holdT = clamp01(held / slots);
    this.writeGauge("cargo", holdT, `${held}/${slots}`,
      held >= slots ? "full" : holdT > 0.75 ? "warn" : "ok");
  }

  writeGauge(key, t, value, level) {
    const g = this.gauges[key];
    if (!g) return;
    const q = Math.round(t * 200) / 200;   // half-percent resolution is plenty
    if (this.last[`${key}T`] !== q) {
      this.last[`${key}T`] = q;
      g.fill.style.transform = `scaleX(${q.toFixed(3)})`;
    }
    this.setText(g.value, `${key}V`, value);
    this.setAttr(g.root, `${key}L`, level, "level");
  }

  updateInstruments() {
    const sub = this.sub;
    const stats = this.game.stats || {};
    this.setText(this.readoutDepth, "depth", formatDepth(sub.depth));
    this.setText(this.readoutSpeed, "speed", (Number(sub.speed) || 0).toFixed(1));
    this.setText(this.readoutRating, "rating",
      formatDepth(Number(stats.pressureRating) || SUB.pressureBase));
    const over = sub.depth > (Number(stats.pressureRating) || SUB.pressureBase);
    this.setAttr(this.readoutDepth, "depthState", over ? "over" : "ok");
  }

  updateCompass() {
    const sub = this.sub;
    sub.forward(_fwd);
    const heading = bearingOf(_fwd.x, _fwd.z);
    const q = Math.round(heading * 4) / 4;
    if (this.last.heading !== q) {
      this.last.heading = q;
      const shift = -(q * COMPASS_PX_PER_DEG + COMPASS_TURN_PX);
      this.compassStrip.style.transform = `translate3d(${shift.toFixed(1)}px, 0, 0)`;
    }

    // The needle is the way home. It is the only thing on the tape that moves
    // independently, and it is the reason you can leave the light behind.
    const station = this.world.stationPosition;
    _rel.set(station.x - sub.position.x, 0, station.z - sub.position.z);
    const home = bearingOf(_rel.x, _rel.z);
    const rel = shortDeg(home - heading);
    const width = this.compassWidth || this.compass.clientWidth || 280;
    let pct = 50 + (rel * COMPASS_PX_PER_DEG) / width * 100;
    const edge = pct < 3 || pct > 97;
    pct = clamp(pct, 3, 97);
    const pq = Math.round(pct * 2) / 2;
    if (this.last.needle !== pq) {
      this.last.needle = pq;
      this.compassNeedle.style.left = `${pq}%`;
    }
    this.setAttr(this.compassNeedle, "needleEdge",
      edge ? (rel < 0 ? "left" : "right") : "on", "edge");
    const range = _rel.length();
    this.setText(this.compassNeedle, "needleText", formatRange(range));
  }

  updateWeapons() {
    const combat = this.combat;
    const list = combat.weapons || [];
    if (this.weaponRows.length !== list.length) this.buildWeaponRack(list);

    for (let i = 0; i < this.weaponRows.length; i += 1) {
      const row = this.weaponRows[i];
      const w = list[i];
      if (!w) continue;
      const active = i === combat.currentIndex;
      if (row.active !== active) {
        row.active = active;
        row.node.dataset.active = active ? "1" : "0";
      }
      const ammo = w.ammo;
      const ammoText = ammo === Infinity || ammo == null
        ? "∞"
        : String(Math.max(0, Math.floor(ammo)));
      if (row.ammoText !== ammoText) {
        row.ammoText = ammoText;
        row.ammo.textContent = ammoText;
      }
      const empty = ammo !== Infinity && ammo != null && ammo <= 0;
      if (row.empty !== empty) {
        row.empty = empty;
        row.node.dataset.empty = empty ? "1" : "0";
      }
      const span = (WEAPONS[w.id] && WEAPONS[w.id].cooldown) || 1;
      const cool = clamp01((Number(w.cooldown) || 0) / span);
      const cq = Math.round(cool * 50) / 50;
      if (row.cool !== cq) {
        row.cool = cq;
        row.node.style.setProperty("--cool", cq.toFixed(2));
      }
    }
  }

  buildWeaponRack(list) {
    const frag = document.createDocumentFragment();
    this.weaponRows = list.map((w, i) => {
      const node = elem("div", "weapon");
      node.dataset.id = w.id;
      node.dataset.active = "0";
      const key = elem("span", "wpn-key", String(i + 1));
      const name = elem("span", "wpn-name", w.name || w.id);
      const ammo = elem("span", "wpn-ammo", "∞");
      const sweep = elem("span", "wpn-cool");
      node.append(key, name, ammo, sweep);
      frag.appendChild(node);
      return { node, ammo, ammoText: "", active: null, cool: -1, empty: null };
    });
    this.weaponRack.replaceChildren(frag);
  }

  updateCrosshair(dt) {
    const combat = this.combat;
    const progress = clamp01(Number(combat.beamProgress) || 0);
    const q = Math.round(progress * 100) / 100;
    if (this.last.beam !== q) {
      this.last.beam = q;
      this.crosshairProgress.style.strokeDashoffset =
        (RING_CIRCUMFERENCE * (1 - q)).toFixed(2);
    }

    let state = "idle";
    if (progress > 0.001 || combat.beamTarget) state = "capture";
    else if (this.aim && this.aim.kind === "creature") state = "hostile";
    else if (this.aim && this.aim.kind === "fish") state = "target";
    this.setAttr(this.crosshair, "chState", state, "state");

    // Label copy is refreshed by sampleAim(); here we only keep the bar honest.
    if (this.aim && this.aim.hp != null) {
      const hp = Math.round(clamp01(this.aim.hp) * 100) / 100;
      if (this.last.aimHp !== hp) {
        this.last.aimHp = hp;
        this.reticleBarFill.style.transform = `scaleX(${hp.toFixed(2)})`;
      }
    }
    void dt;
  }

  /* What is under the crosshair, sampled at 10 Hz — raycasts are not free. */
  sampleAim() {
    const combat = this.combat;
    const stats = this.game.stats || {};
    const depth = this.sub.depth;

    let aim = null;
    const beam = combat.beamTarget;
    if (beam && beam.species) {
      aim = {
        kind: "fish",
        name: beam.species.name,
        meta: this.fishMeta(beam, depth),
        hp: null,
      };
    } else {
      this.camera.getWorldPosition(_eye);
      this.camera.getWorldDirection(_dir);
      const reach = Math.max(90, (Number(stats.captureRange) || SUB.captureRangeBase) * 2.5);
      const hit = this.creatures.raycast(_eye, _dir, reach);
      if (hit && hit.creature) {
        const c = hit.creature;
        aim = {
          kind: "creature",
          name: (c.type && c.type.name) || "something",
          meta: `${Math.max(0, Math.ceil(c.hp))} / ${Math.round(c.hpMax)} · ${formatRange(hit.distance)}`,
          hp: clamp01(c.hp / Math.max(1, c.hpMax)),
        };
      } else {
        const range = Number(stats.captureRange) || SUB.captureRangeBase;
        const f = this.fish.raycast(_eye, _dir, range * 1.4);
        if (f && f.fish) {
          aim = {
            kind: "fish",
            name: f.fish.species.name,
            meta: this.fishMeta(f.fish, depth),
            hp: null,
          };
        }
      }
    }

    this.aim = aim;
    if (!aim) {
      this.setText(this.reticleName, "aimName", "");
      this.setText(this.reticleMeta, "aimMeta", "");
      if (!this.reticleBar.hidden) this.reticleBar.hidden = true;
      this.setAttr(this.reticleLabel, "aimKind", "none", "kind");
      return;
    }
    this.setText(this.reticleName, "aimName", aim.name);
    this.setText(this.reticleMeta, "aimMeta", aim.meta);
    this.setAttr(this.reticleLabel, "aimKind", aim.kind, "kind");
    const wantBar = aim.hp != null;
    if (this.reticleBar.hidden === wantBar) this.reticleBar.hidden = !wantBar;
  }

  fishMeta(fish, depth) {
    const value = this.ecology.valueOf(fish.species, fish, depth);
    const rarity = RARITY[fish.rarity] || RARITY.common;
    return `${rarity.label} · ${formatCredits(value)} cr`;
  }

  // ------------------------------------------------------------- contacts --

  /* A ping paints a snapshot. Those contacts then fade on their own, which is
     why the layer is cheap: we only ever project what the sonar already found. */
  paintContacts(range) {
    const reach = Math.max(20, Number(range) || SUB.sonarRangeBase);
    const reach2 = reach * reach;
    const origin = this.sub.position;

    for (const c of this.creatures.all) {
      if (!c.alive) continue;
      if (c.position.distanceToSquared(origin) > reach2) continue;
      this.addContact(c, c.type && c.type.boss ? "boss" : "beast", false);
    }

    // Fish are numerous; take the nearest handful so the screen stays readable.
    const all = this.fish.all;
    const picks = [];
    for (let i = 0; i < all.length; i += 1) {
      const f = all[i];
      if (!f.alive) continue;
      const d2 = f.position.distanceToSquared(origin);
      if (d2 > reach2) continue;
      picks.push({ f, d2 });
    }
    picks.sort((a, b) => a.d2 - b.d2);
    const limit = Math.min(picks.length, CONTACT_POOL - this.contacts.length - 4);
    for (let i = 0; i < limit; i += 1) this.addContact(picks[i].f, "fish", false);
  }

  addContact(ref, kind, sticky) {
    if (!ref) return;
    for (const c of this.contacts) {
      if (c.ref === ref) {
        c.born = this.time;
        c.sticky = c.sticky || sticky;
        return;
      }
    }
    if (this.contacts.length >= CONTACT_POOL) return;
    const label = kind === "fish"
      ? (ref.species && ref.species.glyph) || ""
      : (ref.type && ref.type.name) || "";
    this.contacts.push({ ref, kind, sticky: !!sticky, born: this.time, label });
  }

  updateContacts(dt) {
    void dt;
    const list = this.contacts;
    if (!list.length) {
      if (this.last.contactCount !== 0) {
        this.last.contactCount = 0;
        for (const slot of this.contactPool) {
          if (!slot.node.hidden) slot.node.hidden = true;
        }
      }
      return;
    }

    const camera = this.camera;
    const vw = this.viewW;
    const vh = this.viewH;
    const margin = 26;
    let used = 0;

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const c = list[i];
      const ref = c.ref;
      const dead = ref.alive === false;
      const age = this.time - c.born;
      const sticky = c.sticky && ref.aggro;
      if (dead || (!sticky && age > CONTACT_LIFE)) {
        list.splice(i, 1);
        continue;
      }
      if (used >= this.contactPool.length) continue;

      let alpha = sticky ? 0.55 : clamp01((CONTACT_LIFE - age) / CONTACT_FADE);
      alpha *= 0.35 + 0.65 * (1 - smoothstep(0, 0.35, Math.min(0.35, age)) * 0);

      _proj.copy(ref.position).project(camera);
      let x = _proj.x;
      let y = _proj.y;
      const behind = _proj.z > 1;
      if (behind) { x = -x; y = -y; }
      let off = behind || Math.abs(x) > 1 || Math.abs(y) > 1;
      if (off) {
        const m = Math.max(Math.abs(x), Math.abs(y)) || 1;
        x /= m;
        y /= m;
      }
      const px = clamp((x * 0.5 + 0.5) * vw, margin, vw - margin);
      const py = clamp((-y * 0.5 + 0.5) * vh, margin, vh - margin);

      const slot = this.contactPool[used];
      used += 1;
      if (slot.node.hidden) slot.node.hidden = false;
      slot.node.style.transform =
        `translate3d(${px.toFixed(0)}px, ${py.toFixed(0)}px, 0)`;
      const a = Math.round(alpha * 20) / 20;
      if (slot.alpha !== a) {
        slot.alpha = a;
        slot.node.style.setProperty("--a", a.toFixed(2));
      }
      if (slot.kind !== c.kind) {
        slot.kind = c.kind;
        slot.node.dataset.kind = c.kind;
      }
      const offState = off ? (behind ? "behind" : "edge") : "";
      if (slot.off !== offState) {
        slot.off = offState;
        if (offState) slot.node.dataset.off = offState;
        else delete slot.node.dataset.off;
      }
      if (off) {
        const rot = Math.atan2(-y, x) * 180 / Math.PI;
        slot.node.style.setProperty("--rot", `${rot.toFixed(0)}deg`);
      }
      const tagText = off || c.kind === "fish" ? "" : c.label;
      if (slot.tagText !== tagText) {
        slot.tagText = tagText;
        slot.tag.textContent = tagText;
      }
    }

    for (let i = used; i < this.contactPool.length; i += 1) {
      const slot = this.contactPool[i];
      if (!slot.node.hidden) slot.node.hidden = true;
    }
    this.last.contactCount = used;
  }

  // ------------------------------------------------------------- warnings --

  updateWarnings(floorDepth) {
    const sub = this.sub;
    const stats = this.game.stats || {};
    const profile = this.game.profile || { cargo: [] };

    const hullMax = Math.max(1, sub.hullMax || SUB.hullBase);
    const hullT = sub.hull / hullMax;
    this.setWarning("hull", hullT < 0.3
      ? `hull at ${Math.round(hullT * 100)} percent`
      : null);

    const rating = Number(stats.pressureRating) || SUB.pressureBase;
    if (sub.depth > rating) {
      this.setWarning("pressure", `${Math.round(sub.depth - rating)} m past your rating`);
    } else if (sub.depth > rating * 0.9) {
      this.setWarning("pressure", "approaching rated depth");
    } else {
      this.setWarning("pressure", null);
    }

    const cellMax = Math.max(1, sub.batteryMax || SUB.batteryBase);
    const cellT = sub.battery / cellMax;
    this.setWarning("battery", cellT <= 0.005
      ? "cell dead"
      : cellT < 0.2 ? `cell at ${Math.round(cellT * 100)} percent` : null);

    const radius = (this.world.bounds && this.world.bounds.radius) || 1500;
    const out = Math.hypot(sub.position.x, sub.position.z) / radius;
    this.setWarning("boundary", out > 0.86 ? "the current is turning you back" : null);

    const slots = Math.max(1, Math.round(Number(stats.cargoSlots) || SUB.cargoSlotsBase));
    const held = profile.cargo ? profile.cargo.length : 0;
    this.setWarning("hold", held >= slots ? "hold full — nothing else fits" : null);

    void floorDepth;
  }

  setWarning(id, message) {
    const w = this.warnNodes.get(id);
    if (!w) return;
    const show = !!message;
    if (show && w.message !== message) {
      w.message = message;
      w.text.textContent = message;
    }
    if (w.shown !== show) {
      w.shown = show;
      w.node.hidden = !show;
    }
  }

  // ------------------------------------------------------------ overlays --

  updateOverlays(dt) {
    const sub = this.sub;
    const stats = this.game.stats || {};

    this.damage = damp(this.damage, 0, 3.2, dt);
    const d = Math.round(this.damage * 100) / 100;
    if (this.last.damageVal !== d) {
      this.last.damageVal = d;
      document.body.style.setProperty("--damage", d.toFixed(2));
    }

    const hullMax = Math.max(1, sub.hullMax || SUB.hullBase);
    const rating = Number(stats.pressureRating) || SUB.pressureBase;
    const over = clamp01((sub.depth - rating * 0.85) / Math.max(60, rating * 0.5));
    const wounded = clamp01(1 - sub.hull / hullMax);
    const beasts = clamp01(Number(this.creatures.threatLevel) || 0);
    const target = clamp01(Math.max(beasts, over * 0.85, wounded * 0.7));
    this.threat = damp(this.threat, target, 2.4, dt);
    const t = Math.round(this.threat * 50) / 50;
    if (this.last.threatVal !== t) {
      this.last.threatVal = t;
      document.body.style.setProperty("--threat", t.toFixed(2));
    }
  }

  updateCredits(dt) {
    const target = Number(this.game.profile && this.game.profile.credits) || 0;
    if (Math.abs(target - this.creditsShown) < 1) this.creditsShown = target;
    else this.creditsShown = damp(this.creditsShown, target, 7, dt);
    const text = formatCredits(this.creditsShown);
    this.setText(this.readoutCredits, "credits", text);
    if (this.mode === "station") this.setText(this.stationCredits, "stationCredits", text);
  }

  updateSonarNote() {
    if (this.sonarSpan <= 0) return;
    const left = this.sonarReady;
    const text = left > 0 ? `sonar · ${left.toFixed(1)}` : "sonar · ready";
    this.setText(this.sonarNote, "sonar", text);
    const t = Math.round(clamp01(1 - left / this.sonarSpan) * 40) / 40;
    if (this.last.sonarT !== t) {
      this.last.sonarT = t;
      this.sonarNote.style.setProperty("--charge", t.toFixed(2));
    }
    this.setAttr(this.sonarNote, "sonarState", left > 0 ? "charging" : "ready", "state");
  }

  updateObjective() {
    const sub = this.sub;
    const stats = this.game.stats || {};
    const profile = this.game.profile || { cargo: [] };
    const slots = Math.max(1, Math.round(Number(stats.cargoSlots) || SUB.cargoSlotsBase));
    const held = profile.cargo ? profile.cargo.length : 0;
    const rating = Number(stats.pressureRating) || SUB.pressureBase;
    const hullT = sub.hull / Math.max(1, sub.hullMax || SUB.hullBase);

    let text = "";
    if (held >= slots) text = "the hold is full — take it back to the Hull";
    else if (hullT < 0.28) text = "the hull is failing — get to the clamps";
    else if (sub.depth > rating) text = "past your rating — climb, or buy casing";
    else {
      sub.forward(_fwd);
      _rel.set(
        this.world.stationPosition.x - sub.position.x,
        0,
        this.world.stationPosition.z - sub.position.z,
      );
      const dist = _rel.length();
      if (dist > 90) {
        text = `the Hull bears ${compassPoint(bearingOf(_rel.x, _rel.z))} · ${formatRange(dist)}`;
      }
    }
    this.setText(this.objective, "obj", text);
  }

  // ------------------------------------------------------------ log/toast --

  log(text, kind) {
    const body = String(text == null ? "" : text).trim();
    if (!body) return;
    // game.log() emits on the bus and may also call here; swallow the echo.
    if (body === this.lastLogText && this.time - this.lastLogAt < 0.02) return;
    this.lastLogText = body;
    this.lastLogAt = this.time;

    /* A squid on the housing says the same sentence every two seconds. Six
       identical lines is noise; one line wearing a count is information. */
    const last = this.logLines[this.logLines.length - 1];
    if (last && last.text === body) {
      last.repeats = (last.repeats || 1) + 1;
      last.born = this.time;
      last.node.textContent = `${body} \u00d7${last.repeats}`;
      last.node.classList.remove("pulse");
      void last.node.offsetWidth;   // restart the flash
      last.node.classList.add("pulse");
      return;
    }

    const li = elem("li", "log-line", body);
    li.dataset.kind = kind || "info";
    this.logList.appendChild(li);
    this.logLines.push({ node: li, born: this.time, text: body, repeats: 1 });
    while (this.logLines.length > LOG_LINES) {
      const old = this.logLines.shift();
      old.node.remove();
    }
  }

  pruneLog() {
    while (this.logLines.length && this.time - this.logLines[0].born > LOG_LIFE) {
      const old = this.logLines.shift();
      old.node.remove();
    }
  }

  toast(text) {
    const body = String(text == null ? "" : text).trim();
    if (!body) return;
    if (body === this.lastToastText && this.time - this.lastToastAt < 0.08) return;
    this.lastToastText = body;
    this.lastToastAt = this.time;
    this.toastQueue.push(body);
    if (this.toastTimer <= 0) this.showNextToast();
  }

  showNextToast() {
    const next = this.toastQueue.shift();
    if (next == null) {
      this.toastNode.textContent = "";
      this.toastNode.dataset.show = "0";
      return;
    }
    this.toastNode.textContent = next;
    this.toastNode.dataset.show = "1";
    this.toastTimer = 2.4;
  }

  updateToast(dt) {
    if (this.toastTimer <= 0) return;
    this.toastTimer -= dt;
    if (this.toastTimer <= 0) {
      this.toastTimer = 0;
      this.showNextToast();
    }
  }

  // --------------------------------------------------------------- panels --

  setMode(mode) {
    if (!mode || mode === this.mode) return;
    this.mode = mode;
    document.body.dataset.mode = mode;

    this.panels.start.hidden = mode !== "start";
    this.panels.station.hidden = mode !== "station";
    this.panels.pause.hidden = mode !== "paused";
    this.panels.dead.hidden = mode !== "dead";
    this.panels.loading.hidden = mode !== "boot";

    if (mode !== "dive") this.setCargoOpen(false);
    if (mode === "start") this.refreshRoster();
    if (mode === "station") {
      this.refreshStation();
      this.selectTab(this.activeTab || "market");
    }
    if (mode === "paused") {
      this.syncSettings();
      this.refreshPause();
    }
    if (mode === "dead") this.writeDeath();
    if (mode === "dive") this.measure();
  }

  setCargoOpen(open) {
    const want = !!open;
    if (want === this.cargoOpen) return;
    this.cargoOpen = want;
    if (want) this.refreshCargo();
    this.panels.cargo.hidden = !want;
    document.body.dataset.hold = want ? "open" : "shut";
  }

  selectTab(name) {
    const tab = this.tabBodies[name] ? name : "market";
    this.activeTab = tab;
    for (const btn of this.stationTabs.querySelectorAll("button[data-tab]")) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
    for (const key of Object.keys(this.tabBodies)) {
      this.tabBodies[key].hidden = key !== tab;
    }
  }

  refreshStation() {
    this.refreshMarket();
    this.refreshDrydock();
    this.refreshManifest();
    this.setText(this.stationCredits, "stationCredits",
      formatCredits(this.game.profile ? this.game.profile.credits : 0));
  }

  refreshMarket() {
    const cargo = (this.game.profile && this.game.profile.cargo) || [];
    const frag = document.createDocumentFragment();
    let total = 0;
    for (const item of cargo) {
      total += Number(item.value) || 0;
      frag.appendChild(this.cargoRow(item, true));
    }
    this.marketList.replaceChildren(frag);

    this.marketSummary.textContent = cargo.length
      ? `${cargo.length} ${cargo.length === 1 ? "specimen" : "specimens"} on the manifest · ${formatCredits(total)} credits`
      : "Nothing in the hold.";
    this.sellAllBtn.disabled = cargo.length === 0;
    this.sellAllBtn.textContent = cargo.length
      ? `Sell everything · ${formatCredits(total)}`
      : "Sell everything";
  }

  cargoRow(item, withValue) {
    const row = elem("div", "row market-row");
    row.dataset.rarity = item.rarity || "common";

    const glyph = elem("span", "row-glyph", item.glyph || "●");
    glyph.style.color = hueColor(item.hue);

    const main = elem("div", "row-main");
    main.appendChild(elem("strong", null, item.name || item.word || "specimen"));
    const bits = [];
    if (item.kind === "trophy") bits.push("trophy");
    else if (item.label) bits.push(item.label);
    if (item.generation) bits.push(`gen ${item.generation}`);
    if (item.mutations) bits.push(`${item.mutations} inherited`);
    bits.push(formatDepth(item.depth || 0));
    main.appendChild(elem("span", "row-sub", bits.join(" · ")));

    const tail = elem("div", "row-tail");
    tail.appendChild(elem("span", "row-rarity", (RARITY[item.rarity] || RARITY.common).label));
    if (withValue) {
      tail.appendChild(elem("span", "money", formatCredits(item.value || 0)));
    }

    row.append(glyph, main, tail);
    return row;
  }

  refreshDrydock() {
    const profile = this.game.profile;
    if (!profile) return;
    const frag = document.createDocumentFragment();
    this.shopRows.clear();

    /* Twelve cards, each carrying an icon, pips, a sentence, a two-column stat
       table and a button, is a lot to read when all you want to know is what
       you can afford. One row each, and the ones you can actually buy float to
       the top. */
    const rows = UPGRADES.map((up) => {
      const level = upgradeLevel(profile.upgrades, up.id);
      const maxLevel = up.values.length - 1;
      const cost = upgradeCost(profile.upgrades, up.id);
      const maxed = cost == null || level >= maxLevel;
      const affordable = !maxed && profile.credits >= cost;
      return { up, level, maxLevel, cost, maxed, affordable };
    });
    rows.sort((a, b) => {
      const rank = (r) => (r.maxed ? 2 : r.affordable ? 0 : 1);
      const d = rank(a) - rank(b);
      if (d) return d;
      // Within a group, cheapest first: that is the next thing you will buy.
      return (a.cost || 0) - (b.cost || 0);
    });

    const unitFor = (id) => UPGRADE_UNITS[id] || "";

    for (const r of rows) {
      const { up, level, maxLevel, cost, maxed, affordable } = r;
      const unit = unitFor(up.id);

      const row = elem("article", "shop-row");
      row.dataset.id = up.id;
      row.dataset.state = maxed ? "maxed" : affordable ? "ready" : "poor";

      row.appendChild(elem("span", "shop-icon", up.icon));

      const main = elem("div", "shop-main");
      main.appendChild(elem("strong", null, up.name));
      const fitted = level === 0 && up.values[0] === 0 ? "not fitted" : `mark ${level} of ${maxLevel}`;
      main.appendChild(elem("span", "shop-sub", fitted));
      row.appendChild(main);

      const change = elem("div", "shop-change");
      change.appendChild(elem("span", "from", `${up.values[level]}${unit}`));
      if (!maxed) {
        change.appendChild(elem("span", "arrow", "\u2192"));
        change.appendChild(elem("span", "to", `${up.values[level + 1]}${unit}`));
      }
      row.appendChild(change);

      const btn = elem("button", "buy");
      btn.type = "button";
      btn.dataset.upgrade = up.id;
      if (maxed) {
        btn.textContent = "done";
        btn.disabled = true;
      } else {
        btn.textContent = `${formatCredits(cost)} cr`;
        btn.disabled = !affordable;
        btn.title = up.blurb;
      }
      row.appendChild(btn);

      this.shopRows.set(up.id, row);
      frag.appendChild(row);
    }
    this.shopList.replaceChildren(frag);
  }

  refreshManifest() {
    const profile = this.game.profile;
    if (!profile) return;
    const record = profile.stats || {};
    const frag = document.createDocumentFragment();

    const boat = describeStats(this.game.stats || {}) || [];
    frag.appendChild(this.statGroup("the boat", boat));

    const killPairs = Object.entries(record.kills || {});
    const kills = killPairs.length
      ? killPairs.map(([k, n]) => `${k} x${n}`).join(", ")
      : "nothing yet";
    frag.appendChild(this.statGroup("the record", [
      { label: "dives", value: String(record.dives || 0) },
      { label: "specimens sold", value: formatCredits(record.fishSold || 0) },
      { label: "credits earned", value: formatCredits(record.creditsEarned || 0) },
      { label: "deepest", value: formatDepth(record.deepest || 0) },
      { label: "hulls lost", value: String(record.deaths || 0) },
      { label: "killed", value: kills },
    ]));
    this.stationStats.replaceChildren(frag);

    // The manifest doubles as a collection: everything the phrase grew, and
    // which of it you have actually had in your hands.
    const seen = new Set(record.discovered || []);
    const roster = this.ecology.roster();
    const list = document.createDocumentFragment();
    for (const entry of roster) {
      const zone = zoneById(entry.zoneId);
      const row = elem("div", "row species-row");
      row.dataset.rarity = entry.rarity;
      row.dataset.known = seen.has(entry.index) ? "1" : "0";

      const glyph = elem("span", "row-glyph", seen.has(entry.index) ? entry.glyph : "?");
      glyph.style.color = seen.has(entry.index) ? hexColor(entry.colorHex) : "";

      const main = elem("div", "row-main");
      main.appendChild(elem("strong", null, seen.has(entry.index) ? entry.name : "unlogged"));
      main.appendChild(elem("span", "row-sub", seen.has(entry.index)
        ? `"${entry.word}" · ${zone.name}`
        : `${zone.name} · never in the hold`));

      const tail = elem("div", "row-tail");
      tail.appendChild(elem("span", "row-rarity", (RARITY[entry.rarity] || RARITY.common).label));
      tail.appendChild(elem("span", "money", `${formatCredits(entry.baseValue)} base`));

      row.append(glyph, main, tail);
      list.appendChild(row);
    }
    this.stationSpecies.replaceChildren(list);
  }

  statGroup(title, rows) {
    const group = elem("div", "stat-group");
    group.appendChild(elem("h3", null, title));
    const dl = elem("dl", "stat-rows");
    for (const row of rows) {
      const line = elem("div", "stat");
      line.append(elem("dt", null, row.label), elem("dd", null, String(row.value)));
      dl.appendChild(line);
    }
    group.appendChild(dl);
    return group;
  }

  refreshCargo() {
    const cargo = (this.game.profile && this.game.profile.cargo) || [];
    const frag = document.createDocumentFragment();
    let total = 0;
    for (const item of cargo) {
      total += Number(item.value) || 0;
      frag.appendChild(this.cargoRow(item, true));
    }
    if (!cargo.length) {
      frag.appendChild(elem("p", "hint", "Empty. The sea is still holding onto everything."));
    } else {
      const head = elem("p", "hint",
        `${cargo.length} aboard · ${formatCredits(total)} credits if you live to sell it`);
      frag.insertBefore(head, frag.firstChild);
    }
    this.cargoList.replaceChildren(frag);
    if (this.mode === "station") this.refreshMarket();
  }

  refreshRoster() {
    if (!this.ecology) return;
    const roster = this.ecology.roster();
    const frag = document.createDocumentFragment();
    const sorted = roster.slice().sort((a, b) => zoneIndex(a.zoneId) - zoneIndex(b.zoneId));
    for (const entry of sorted) {
      const zone = zoneById(entry.zoneId);
      const card = elem("article", "roster-card");
      card.dataset.rarity = entry.rarity;
      card.style.setProperty("--swatch", hexColor(entry.colorHex));

      const top = elem("div", "roster-top");
      top.appendChild(elem("span", "roster-swatch", entry.glyph || "●"));
      const names = elem("div", "roster-names");
      names.appendChild(elem("strong", null, entry.name));
      names.appendChild(elem("span", "roster-word", `from "${entry.word}"`));
      top.appendChild(names);
      card.appendChild(top);

      const meta = elem("div", "roster-meta");
      meta.appendChild(elem("span", "roster-zone", zone.name));
      meta.appendChild(elem("span", "roster-rarity", (RARITY[entry.rarity] || RARITY.common).label));
      meta.appendChild(elem("span", "money", `${formatCredits(entry.baseValue)} cr`));
      card.appendChild(meta);

      frag.appendChild(card);
    }
    this.startRoster.replaceChildren(frag);
  }

  refreshPause() {
    const profile = this.game.profile || { cargo: [], stats: {} };
    const cargo = profile.cargo || [];
    const worth = cargo.reduce((sum, it) => sum + (Number(it.value) || 0), 0);
    const frag = document.createDocumentFragment();
    frag.appendChild(this.statGroup("this dive", [
      { label: "under for", value: formatClock(this.game.elapsed || 0) },
      { label: "depth", value: formatDepth(this.sub.depth) },
      { label: "in the hold", value: `${cargo.length}` },
      { label: "worth", value: `${formatCredits(worth)} cr` },
      { label: "on the books", value: `${formatCredits(profile.credits || 0)} cr` },
    ]));
    this.pauseStats.replaceChildren(frag);
  }

  writeDeath() {
    const profile = this.game.profile || { cargo: [], credits: 0 };
    const cargo = profile.cargo || [];
    const worth = cargo.reduce((sum, it) => sum + (Number(it.value) || 0), 0);
    const cause = this.deadCause;

    let headline = "The sea gets the hold";
    if (cause === "pressure") headline = "The casing folded shut";
    else if (cause === "terrain" || cause === "collision") headline = "You found the floor";
    else if (cause) headline = `${cause} took the rest of it`;
    this.setText(this.deadHeadline, "deadHead", headline);

    const lost = Math.round((profile.credits || 0) * SUB.respawnPenalty);
    const parts = [];
    if (cargo.length) {
      parts.push(`${cargo.length} ${cargo.length === 1 ? "specimen" : "specimens"} went back into the dark, ${formatCredits(worth)} credits of it`);
    } else {
      parts.push("the hold was empty, at least");
    }
    parts.push(`the Hull takes ${formatCredits(lost)} credits for the tow`);
    parts.push("the sea keeps the same shape. go back down.");
    this.setText(this.deadDetail, "deadDetail", `${parts.join(" · ")}`);
  }

  // -------------------------------------------------------------- actions --

  /* game.js owns the economy. Where it exposes a verb we defer to it; where it
     does not, we settle up through the documented primitives so the buttons
     always do something, and always do the same thing. */

  sellAll() {
    const game = this.game;
    if (typeof game.sellAll === "function") {
      game.sellAll();
      return;
    }
    const profile = game.profile;
    const cargo = (profile && profile.cargo) || [];
    if (!cargo.length) {
      this.toast("the hold is empty");
      return;
    }
    const items = cargo.length;
    const credits = cargo.reduce((sum, it) => sum + (Number(it.value) || 0), 0);
    const fish = cargo.reduce((n, it) => n + (it.kind === "trophy" ? 0 : 1), 0);
    profile.cargo = [];
    if (profile.stats) profile.stats.fishSold = (profile.stats.fishSold || 0) + fish;
    game.addCredits(credits, "market");
    this.bus.emit("economy:sold", { credits, items });
    this.bus.emit("profile:changed", {});
    game.persist();
    this.refreshStation();
    this.refreshCargo();
  }

  buyUpgrade(id) {
    const game = this.game;
    if (typeof game.buyUpgrade === "function") {
      game.buyUpgrade(id);
      this.refreshStation();
      return;
    }
    const res = applyUpgrade(game.profile, id) || { ok: false };
    if (!res.ok) {
      this.toast(res.reason || "not enough credits");
      if (game.audio) game.audio.sfx("deny");
      const card = this.shopRows.get(id);
      if (card) this.pulse(card);
      return;
    }
    game.recomputeStats();
    this.bus.emit("economy:upgrade", { id, level: res.level, cost: res.cost });
    this.bus.emit("profile:changed", {});
    game.persist();
    this.refreshStation();
  }

  undock() {
    const game = this.game;
    if (typeof game.undock === "function") {
      game.undock();
      return;
    }
    this.sub.undock();
    this.bus.emit("station:undock", {});
    game.setMode("dive");
  }

  abandonDive() {
    const game = this.game;
    if (typeof game.abandonDive === "function") {
      game.abandonDive();
      return;
    }
    const profile = game.profile;
    if (profile) profile.cargo = [];
    this.sub.respawn();
    this.bus.emit("profile:changed", {});
    game.persist();
    game.setMode("station");
  }

  revive() {
    const game = this.game;
    if (typeof game.revive === "function") {
      game.revive();
      return;
    }
    this.sub.respawn();
    game.setMode("station");
  }

  syncSettings() {
    const settings = (this.game.profile && this.game.profile.settings) || {};
    this.toggleSound.checked = !!settings.sound;
    this.toggleInvert.checked = !!settings.invertY;
    this.rangeSens.value = String(Math.round((Number(settings.sensitivity) || 1) * 100));
  }

  applySettings() {
    const profile = this.game.profile;
    if (!profile) return;
    if (!profile.settings) profile.settings = {};
    const settings = profile.settings;
    settings.sound = !!this.toggleSound.checked;
    settings.invertY = !!this.toggleInvert.checked;
    settings.sensitivity = clamp(Number(this.rangeSens.value) / 100, 0.2, 3);
    if (this.game.audio) this.game.audio.toggle(settings.sound);
    this.bus.emit("profile:changed", {});
    this.game.persist();
  }

  // -------------------------------------------------------------- writers --

  setText(node, key, value) {
    if (this.last[key] === value) return;
    this.last[key] = value;
    node.textContent = value;
  }

  setAttr(node, key, value, name = "state") {
    if (this.last[key] === value) return;
    this.last[key] = value;
    if (value == null || value === "") node.removeAttribute(`data-${name}`);
    else node.setAttribute(`data-${name}`, value);
  }

  // -------------------------------------------------------------- teardown --

  dispose() {
    for (const off of this.offs) {
      try { off(); } catch (err) { void err; }
    }
    this.offs.length = 0;
    for (const undo of this.timers) {
      try { undo(); } catch (err) { void err; }
    }
    this.timers.length = 0;

    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);

    for (const node of this.made) node.remove();
    this.made.length = 0;

    this.compassStrip.replaceChildren();
    this.contactsLayer.replaceChildren();
    this.warnings.replaceChildren();
    this.weaponRack.replaceChildren();
    this.logList.replaceChildren();
    this.reticleLabel.replaceChildren();
    this.startRoster.replaceChildren();
    this.marketList.replaceChildren();
    this.shopList.replaceChildren();
    this.stationStats.replaceChildren();
    this.stationSpecies.replaceChildren();
    this.cargoList.replaceChildren();
    this.pauseStats.replaceChildren();

    this.contacts.length = 0;
    this.contactPool.length = 0;
    this.weaponRows.length = 0;
    this.logLines.length = 0;
    this.toastQueue.length = 0;
    this.shopRows.clear();
    this.warnNodes.clear();

    document.body.style.removeProperty("--damage");
    document.body.style.removeProperty("--threat");
  }
}
