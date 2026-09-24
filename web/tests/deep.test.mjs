// Deep-sea game logic. Everything here is the part that runs without a GPU:
// the genetics-to-economy pipeline, the upgrade table, and the save file.
// Run with: node --test web/tests
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

// The modules read the aquarium engine off globalThis, exactly as the browser
// does after index.html loads ../engine.js as a classic script.
globalThis.MnemoEngine = require("../engine.js");

const { Ecology } = await import("../src/ecology.js");
const progression = await import("../src/progression.js");
const save = await import("../src/save.js");
const { ZONES, UPGRADES, CREATURES, RARITY, WEAPONS, HOTKEYS, zoneForDepth } = await import("../src/config.js");
const quality = await import("../src/quality.js");
const nav = await import("../src/nav.js");

const PHRASE = "forgotten kiosk under neon rain";

test("a phrase grows the same sea twice", () => {
  const a = new Ecology(PHRASE);
  const b = new Ecology(PHRASE);
  assert.equal(a.seed, b.seed);
  assert.deepEqual(
    a.species.map((s) => [s.name, s.zoneId, s.rarity, s.baseValue]),
    b.species.map((s) => [s.name, s.zoneId, s.rarity, s.baseValue]),
  );
});

test("different phrases grow different seas", () => {
  const a = new Ecology("neon rain");
  const b = new Ecology("static bloom");
  assert.notEqual(a.seed, b.seed);
  assert.notDeepEqual(a.species.map((s) => s.name), b.species.map((s) => s.name));
});

test("every species is a word of the phrase, wearing a body", () => {
  const eco = new Ecology(PHRASE);
  const words = ["forgotten", "kiosk", "under", "neon", "rain"];
  assert.deepEqual(eco.species.map((s) => s.word).sort(), words.slice().sort());
  for (const sp of eco.species) {
    assert.ok(sp.size > 0 && sp.size < 6, `${sp.name} has a plausible length`);
    assert.ok(sp.baseValue >= 1, `${sp.name} is worth something`);
    assert.ok(ZONES.some((z) => z.id === sp.zoneId), `${sp.name} lives in a real band`);
    assert.ok(RARITY[sp.rarity], `${sp.name} has a real rarity`);
    assert.ok(sp.description.length > 0, `${sp.name} has a line about it`);
  }
});

test("the water column is never empty", () => {
  // speciesInZone falls back to the nearest inhabited band, so a one-word
  // phrase still has something to catch at every depth.
  for (const phrase of [PHRASE, "silence", "a b"]) {
    const eco = new Ecology(phrase);
    for (const zone of ZONES) {
      const list = eco.speciesInZone(zone.id);
      assert.ok(list && list.length, `${phrase} has residents for ${zone.id}`);
    }
  }
});

test("depth is what makes a fish worth catching", () => {
  const eco = new Ecology(PHRASE);
  const sp = eco.species[0];
  const fish = eco.rollIndividual(sp, null);
  const shallow = eco.valueOf(sp, fish, 10);
  const deep = eco.valueOf(sp, fish, 900);
  assert.ok(deep > shallow, `${deep} deep beats ${shallow} shallow`);
});

test("an inherited mutation is worth money", () => {
  const eco = new Ecology(PHRASE);
  const sp = eco.species[0];
  const plain = { generation: 1, mutations: 0, rarity: "common" };
  const mutant = { generation: 1, mutations: 2, rarity: "common" };
  assert.ok(
    progression.fishValue(sp, mutant, 100) > progression.fishValue(sp, plain, 100),
    "the market pays for a specimen it has not seen before",
  );
});

test("upgrades move the stats they claim to move", () => {
  const profile = save.newProfile(PHRASE, 1);
  const stock = progression.computeStats(profile.upgrades);
  assert.equal(stock.pressureRating, UPGRADES.find((u) => u.id === "pressure").values[0]);
  assert.equal(stock.torpedoUnlocked, false);

  profile.credits = 1e9;
  for (const id of ["pressure", "hull", "torpedo", "capture"]) {
    const res = progression.applyUpgrade(profile, id);
    assert.equal(res.ok, true, `${id} was affordable`);
  }
  const after = progression.computeStats(profile.upgrades);
  assert.ok(after.pressureRating > stock.pressureRating);
  assert.ok(after.hullMax > stock.hullMax);
  assert.ok(after.captureRange > stock.captureRange);
  assert.equal(after.torpedoUnlocked, true);
  assert.ok(profile.ammo.torpedo > 0, "buying tubes puts torpedoes in them");
});

test("an upgrade you cannot afford changes nothing", () => {
  const profile = save.newProfile(PHRASE, 1);
  profile.credits = 0;
  const before = JSON.stringify(profile.upgrades);
  const res = progression.applyUpgrade(profile, "pressure");
  assert.equal(res.ok, false);
  assert.equal(profile.credits, 0, "credits never go negative");
  assert.equal(JSON.stringify(profile.upgrades), before);
});

test("every upgrade runs out at the top of its table", () => {
  const profile = save.newProfile(PHRASE, 1);
  profile.credits = 1e9;
  for (const up of UPGRADES) {
    for (let i = 0; i < up.values.length + 2; i += 1) progression.applyUpgrade(profile, up.id);
    assert.equal(profile.upgrades[up.id], up.values.length - 1, `${up.id} caps out`);
    assert.equal(progression.upgradeCost(profile.upgrades, up.id), null, `${up.id} is unpriced when maxed`);
  }
});

test("computeStats survives a junk upgrade block", () => {
  for (const junk of [null, undefined, {}, { hull: "banana" }, { nope: 99 }]) {
    const stats = progression.computeStats(junk);
    assert.ok(Number.isFinite(stats.hullMax) && stats.hullMax > 0);
    assert.ok(Number.isFinite(stats.pressureRating) && stats.pressureRating > 0);
  }
});

test("a kill leaves something sellable behind", () => {
  for (const type of Object.values(CREATURES)) {
    const item = progression.trophyItem(type, 800);
    assert.equal(item.kind, "trophy");
    assert.ok(item.value > 0, `${type.id} trophy is worth something`);
    assert.ok(item.label.length > 0, `${type.id} trophy has a name`);
  }
});

test("the depth bands tile the whole water column without a gap", () => {
  assert.equal(ZONES[0].top, 0);
  for (let i = 1; i < ZONES.length; i += 1) {
    assert.equal(ZONES[i].top, ZONES[i - 1].bottom, `${ZONES[i].id} starts where the band above ends`);
  }
  assert.equal(zoneForDepth(0).id, "shelf");
  assert.equal(zoneForDepth(99999).id, ZONES[ZONES.length - 1].id);
  // Deeper is always worth more, which is the entire reason to go down.
  for (let i = 1; i < ZONES.length; i += 1) {
    assert.ok(ZONES[i].valueMultiplier > ZONES[i - 1].valueMultiplier);
  }
});

test("a corrupt or absent save degrades instead of throwing", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  assert.equal(save.loadProfile(), null, "no save is not an error");

  const profile = save.newProfile(PHRASE, 7);
  save.saveProfile(profile);
  const back = save.loadProfile();
  assert.equal(back.phrase, PHRASE);
  assert.equal(back.credits, profile.credits);

  /* A mangled file must never cost you the run: save.js keeps the last good
     profile in memory and hands that back rather than returning nothing. What
     matters is that it always returns something structurally sound. */
  const sound = (p, why) => {
    assert.ok(p && typeof p === "object", why);
    assert.ok(Number.isFinite(p.credits) && p.credits >= 0, `${why}: credits are a number`);
    assert.ok(p.upgrades && typeof p.upgrades === "object", `${why}: upgrades survive`);
    assert.ok(Array.isArray(p.cargo), `${why}: cargo survives`);
    assert.ok(p.stats && typeof p.stats === "object", `${why}: stats survive`);
  };

  store.set(save.SAVE_KEY, "{not json at all");
  sound(save.loadProfile(), "a mangled save");

  store.set(save.SAVE_KEY, JSON.stringify({ phrase: PHRASE, credits: "lots" }));
  sound(save.loadProfile(), "a save with the wrong types in it");

  store.set(save.SAVE_KEY, JSON.stringify({ phrase: PHRASE, credits: -50, cargo: "no", upgrades: 7 }));
  sound(save.loadProfile(), "a hostile save");

  delete globalThis.localStorage;
});

test("saving without any storage at all is a no-op, not a crash", () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error("disabled"); },
    setItem() { throw new Error("quota"); },
    removeItem() { throw new Error("disabled"); },
  };
  assert.doesNotThrow(() => save.saveProfile(save.newProfile(PHRASE, 1)));
  assert.doesNotThrow(() => save.loadProfile());
  assert.doesNotThrow(() => save.clearProfile());
  if (previous === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previous;
});

test("surveyed landmarks survive a save, so their fees are only paid once", () => {
  const profile = save.newProfile(PHRASE, 3);
  profile.stats.landmarks = ["lm-0", "lm-7", "lm-7", "lm-12"];
  const back = save.migrate(JSON.parse(JSON.stringify(profile)));
  assert.deepEqual(back.stats.landmarks, ["lm-0", "lm-7", "lm-12"]);

  const junk = save.migrate({ phrase: PHRASE, stats: { landmarks: ["lm-1", 4, "<b>", "lm-99999", null] } });
  assert.deepEqual(junk.stats.landmarks, ["lm-1"], "only well-formed ids are kept");
  assert.deepEqual(save.migrate({ phrase: PHRASE }).stats.landmarks, [], "an old save has none");
});

test("the graphics setting is saved, and nonsense falls back to auto", () => {
  assert.equal(save.newProfile(PHRASE, 1).settings.quality, "auto");
  assert.equal(save.migrate({ phrase: PHRASE, settings: { quality: "low" } }).settings.quality, "low");
  assert.equal(save.migrate({ phrase: PHRASE, settings: { quality: "ultra" } }).settings.quality, "auto");
  assert.equal(save.migrate({ phrase: PHRASE }).settings.quality, "auto");
});

test("every weapon on the rack has a number key", () => {
  const count = Object.keys(WEAPONS).length;
  for (let i = 1; i <= count; i += 1) {
    assert.ok(Array.isArray(HOTKEYS[`weapon${i}`]) && HOTKEYS[`weapon${i}`].length,
      `weapon ${i} of ${count} has no key`);
  }
  const codes = Object.values(HOTKEYS).flat();
  assert.equal(new Set(codes).size, codes.length, "no key is bound to two actions");
});

/* Feed the governor a steady frame time for a number of seconds. */
function run(gov, frameTime, seconds) {
  const changes = [];
  for (let t = 0; t < seconds; t += frameTime) {
    const next = gov.sample(frameTime);
    if (next !== null) changes.push(next);
  }
  return changes;
}

test("the resolution governor gives up pixels when frames are slow", () => {
  const gov = new quality.ResolutionGovernor("auto");
  assert.equal(gov.scale, 1);
  assert.deepEqual(run(gov, 1 / 60, 10), [], "a steady 60 costs nothing");
  const drops = run(gov, 1 / 25, 20);
  assert.ok(drops.length >= 3, "a slideshow keeps stepping down");
  assert.equal(gov.scale, quality.SCALE.min, "down to the floor and no further");
  for (let i = 1; i < drops.length; i += 1) assert.ok(drops[i] < drops[i - 1]);
});

test("the resolution governor climbs back slowly and not into a scale that failed", () => {
  const gov = new quality.ResolutionGovernor("auto");
  run(gov, 1 / 30, 3);
  const failed = gov.scale;
  assert.ok(failed < 1, "it dropped");
  const rises = run(gov, 1 / 120, 15);
  assert.ok(rises.length > 0, "fast frames earn resolution back");
  assert.ok(rises.every((s) => s < failed + 0.1), "but not the scale that was too slow, while it remembers");
  run(gov, 1 / 120, 90);
  assert.equal(gov.scale, 1, "and once it has forgotten, all the way home");
});

test("the resolution governor ignores hitches, and the fixed modes ignore everything", () => {
  const gov = new quality.ResolutionGovernor("auto");
  assert.deepEqual(run(gov, 0.5, 30), [], "a tab switch is not a slow GPU");
  const high = new quality.ResolutionGovernor("high");
  assert.deepEqual(run(high, 1 / 20, 20), []);
  assert.equal(high.scale, 1);
  const low = new quality.ResolutionGovernor("low");
  assert.equal(low.scale, quality.SCALE.low);
  assert.equal(new quality.ResolutionGovernor("nonsense").mode, "auto");
});

test("pixel ratio is capped at 2 and floored at a half", () => {
  assert.equal(quality.pixelRatioFor(3, 1), 2);
  assert.equal(quality.pixelRatioFor(2, 0.5), 1);
  assert.equal(quality.pixelRatioFor(1, 0.3), 0.5);
  assert.equal(quality.pixelRatioFor(undefined, 1), 1);
});

test("bearings call -Z north and go clockwise", () => {
  assert.equal(nav.bearingOf(0, -1), 0);
  assert.equal(nav.bearingOf(1, 0), 90);
  assert.equal(nav.bearingOf(0, 1), 180);
  assert.equal(nav.bearingOf(-1, 0), 270);
  assert.equal(nav.compassPoint(0), "N");
  assert.equal(nav.compassPoint(359), "N");
  assert.equal(nav.compassPoint(135), "SE");
  assert.equal(nav.formatRange(420.4), "420 m");
  assert.equal(nav.formatRange(1250), "1.3 km");
});

test("a rumour is fixed, vague, and always contains the place", () => {
  for (let seed = 1; seed < 4e9; seed += 97531247) {
    const lm = { seed, position: { x: 1200, y: -400, z: -800 } };
    const a = nav.rumourCentre(lm);
    const b = nav.rumourCentre(lm);
    assert.deepEqual(a, b, "the same landmark draws the same circle");
    const off = Math.hypot(a.x - lm.position.x, a.z - lm.position.z);
    assert.ok(off < a.radius, "the truth is inside the circle");
    assert.ok(off > 20, "but not at its centre");
  }
});
