/* The logbook: keeps the goal chain moving and says so when a step is done.
 *
 * goals.js decides what the steps are and what to say about them; this is
 * the part that lives in the running game. It re-reads the chain a few times
 * a second rather than trusting the order bus listeners happen to fire in —
 * the fish:captured that finishes the first step is the same event game.js
 * uses to record the discovery, and there is no promise about who hears it
 * first. Checking the chain costs nothing, so polling is the honest choice.
 *
 * It also answers objective() for the HUD's line, the compass marker and the
 * Hull's choice of which terminal to face you toward. */

import { upgradeCost } from "./progression.js";
import { rumourCentre } from "./nav.js";
import { CHAIN, DONE_LINES, FIRST_DESCENT_FEE, currentStep, objectiveFor, stepIndex } from "./goals.js";

const CHECK_EVERY = 0.25;         // seconds between chain checks
const KELP_DEPTH = 100;           // a little past the band's top, so you arrive in it
const KELP_BEARINGS = 32;
const KELP_STEP = 20;             // metres between samples along each bearing
const KELP_REACH = 1600;
const RUMOUR_SLACK = 80;          // how far past the rating a landmark may lie and still be a goal

export class Logbook {
  constructor(game) {
    this.game = game;
    this.timer = 0;
    this.kelp = undefined;        // lazily found: the nearest floor deep enough to count
    this.index = stepIndex(game.profile);
    this._target = { x: 0, z: 0 };
    this._sub = { x: 0, z: 0, depth: 0 };
    this._station = { x: 0, z: 0 };
    this._rumour = { x: 0, z: 0, name: "", depth: 0 };
    if (game.profile && game.profile.log) game.profile.log.chain = this.index;
  }

  update(dt) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = CHECK_EVERY;
    const next = stepIndex(this.game.profile);
    if (next === this.index) return;
    const was = this.index;
    this.index = next;
    // Steps can finish together (a veteran's first sale can also be past 90 m);
    // announce each one, in order, but only ever forward.
    for (let i = was; i < next && i < CHAIN.length; i += 1) this.complete(CHAIN[i]);
    const profile = this.game.profile;
    if (profile && profile.log) profile.log.chain = next;
    if (this.game.persist) this.game.persist();
  }

  complete(step) {
    const game = this.game;
    const line = DONE_LINES[step.id];
    if (line) {
      game.toast(line);
      game.log(line, "lore");
    }
    const fee = FIRST_DESCENT_FEE[step.id];
    if (fee && game.addCredits) game.addCredits(fee, `first descent · ${step.id}`);
    game.bus.emit("goal:done", { id: step.id });
  }

  /* The current goal, worded for the current input, or null once the chain
     is done (the HUD then falls back to pointing home). */
  objective() {
    const game = this.game;
    const profile = game.profile;
    const step = currentStep(profile);
    if (!step) return null;
    const sub = game.sub;
    const station = game.world && game.world.stationPosition;
    if (sub) {
      this._sub.x = sub.position.x;
      this._sub.z = sub.position.z;
      this._sub.depth = sub.depth;
    }
    if (station) {
      this._station.x = station.x;
      this._station.z = station.z;
    }
    const upgrades = profile ? profile.upgrades : {};
    const pressure = Number(upgrades && upgrades.pressure) || 0;
    const ctx = {
      profile,
      input: currentInput(),
      sub: this._sub,
      docked: game.mode === "base" || game.mode === "station",
      station: this._station,
      kelp: step.id === "kelp" ? this.kelpEdge() : null,
      rumour: step.id === "survey" ? this.nearestRumour() : null,
      casingCost: pressure === 0 ? upgradeCost(upgrades, "pressure") : null,
      casing2Cost: pressure === 1 ? upgradeCost(upgrades, "pressure") : null,
    };
    return objectiveFor(step, ctx);
  }

  /* The nearest floor at KELP_DEPTH or deeper, scanned outward from the Hull
     on a fixed set of bearings. Deterministic from the seed because the floor
     is; found once, on the first time anybody asks. */
  kelpEdge() {
    if (this.kelp !== undefined) return this.kelp;
    const world = this.game.world;
    this.kelp = null;
    if (!world) return null;
    const height = typeof world.sampleHeight === "function"
      ? (x, z) => world.sampleHeight(x, z)
      : (x, z) => world.heightAt(x, z);
    const origin = world.stationPosition;
    let best = Infinity;
    for (let b = 0; b < KELP_BEARINGS; b += 1) {
      const a = (b / KELP_BEARINGS) * Math.PI * 2;
      const cx = Math.cos(a);
      const cz = Math.sin(a);
      for (let r = 40; r < Math.min(best, KELP_REACH); r += KELP_STEP) {
        const x = origin.x + cx * r;
        const z = origin.z + cz * r;
        if (height(x, z) <= -KELP_DEPTH) {
          best = r;
          this.kelp = { x, z };
          break;
        }
      }
    }
    return this.kelp;
  }

  /* The closest landmark you have not found that your casing can reach, as
     its rumour rather than its truth, so the survey fee is still for going. */
  nearestRumour() {
    const game = this.game;
    const lms = game.landmarks && game.landmarks.all;
    const sub = game.sub;
    if (!lms || !sub) return null;
    const rating = Number(game.stats && game.stats.pressureRating) || 140;
    let best = null;
    let bestD = Infinity;
    for (const lm of lms) {
      if (lm.found || lm.depth > rating + RUMOUR_SLACK) continue;
      const r = rumourCentre(lm);
      const d = Math.hypot(r.x - sub.position.x, r.z - sub.position.z);
      if (d < bestD) {
        bestD = d;
        best = lm;
        this._rumour.x = r.x;
        this._rumour.z = r.z;
      }
    }
    if (!best) return null;
    this._rumour.name = best.name;
    this._rumour.depth = best.depth;
    return this._rumour;
  }

  dispose() {
    this.kelp = undefined;
  }
}

function currentInput() {
  const body = typeof document !== "undefined" ? document.body : null;
  const input = body && body.dataset ? body.dataset.input : "";
  return input === "pad" || input === "touch" ? input : "mouse";
}
