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
const stick = await import("../src/stick.js");
const frame = await import("../src/frame.js");
const walk = await import("../src/walk.js");

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

test("a stick has a radial deadzone and no jump at its edge", () => {
  assert.deepEqual(stick.shapeStick(0.1, 0.1), [0, 0], "resting drift is ignored");
  const [x0] = stick.shapeStick(stick.DEADZONE + 0.001, 0);
  assert.ok(x0 > 0 && x0 < 0.01, "just past the deadzone is just past zero");
  const [x1, y1] = stick.shapeStick(1, 0);
  assert.ok(Math.abs(x1 - 1) < 1e-9 && y1 === 0, "full throw is full");
  const [dx, dy] = stick.shapeStick(0.5, 0.5);
  assert.ok(Math.abs(dx - dy) < 1e-12, "a diagonal stays a diagonal");
  const [hx] = stick.shapeStick(0.55, 0);
  assert.ok(hx < 0.45, "the first half of the throw is for aiming");
  assert.equal(stick.shapeAxis(0.05), 0);
  assert.equal(stick.shapeAxis(-1), -1);
});

test("the touch joystick caps at the rim and boosts past it", () => {
  const rest = stick.thumbVector(2, 3, 56);
  assert.deepEqual([rest.x, rest.y], [0, 0]);
  const full = stick.thumbVector(0, -56, 56);
  assert.ok(Math.abs(full.y + 1) < 1e-9 && !full.boost);
  const past = stick.thumbVector(0, -200, 56);
  assert.ok(Math.abs(past.y + 1) < 1e-9, "past the rim is still full, not more");
  assert.ok(past.boost, "and asks for boost");
});

test("button edges see presses and releases, not holds", () => {
  assert.deepEqual(stick.edges([false, true, true], [true, true, false]), { down: [0], up: [2] });
  assert.deepEqual(stick.edges([], [false, true]), { down: [1], up: [] });
});

test("a slow frame is cut into steps instead of slowing the sea down", () => {
  assert.deepEqual(frame.splitFrame(1 / 60), { steps: 1, dt: 1 / 60 });
  const twelve = frame.splitFrame(1 / 12);
  assert.equal(twelve.steps, 2);
  assert.ok(Math.abs(twelve.steps * twelve.dt - 1 / 12) < 1e-12, "all of the frame is simulated");
  assert.ok(twelve.dt <= frame.MAX_DT + 1e-12, "and no step is longer than the limit");
  const hitch = frame.splitFrame(3);
  assert.equal(hitch.steps, frame.MAX_STEPS, "a hitch is capped, not replayed");
  assert.ok(Math.abs(hitch.dt - frame.MAX_DT) < 1e-12);
  assert.deepEqual(frame.splitFrame(0), { steps: 1, dt: 0 });
  assert.deepEqual(frame.splitFrame(NaN), { steps: 1, dt: 0 });
  assert.equal(frame.splitFrame(frame.MAX_DT).steps, 1, "exactly the limit is one step");
});

test("walking slides along a wall instead of sticking to it", () => {
  const wall = [{ minX: -1, maxX: 1, minZ: -10, maxZ: 10 }];
  // Walking diagonally into the wall's face keeps the along-wall motion.
  const [x, z] = walk.resolveCircle(1.2, 3, 0.35, wall);
  assert.ok(Math.abs(x - 1.35) < 1e-9, "pushed out to exactly the radius");
  assert.equal(z, 3, "the motion along the wall survives");
  // Nowhere near it: untouched.
  assert.deepEqual(walk.resolveCircle(5, 5, 0.35, wall), [5, 5]);
  // Somehow inside it: out by the nearest face.
  const [ix] = walk.resolveCircle(0.8, 0, 0.35, wall);
  assert.ok(Math.abs(ix - 1.35) < 1e-9);
  // A corner between two boxes settles clear of both.
  const corner = [{ minX: 0, maxX: 1, minZ: -5, maxZ: 5 }, { minX: -5, maxX: 5, minZ: 0, maxZ: 1 }];
  const [cx, cz] = walk.resolveCircle(-0.1, -0.1, 0.35, corner);
  for (const b of corner) {
    const nx = Math.max(b.minX, Math.min(cx, b.maxX));
    const nz = Math.max(b.minZ, Math.min(cz, b.maxZ));
    assert.ok(Math.hypot(cx - nx, cz - nz) >= 0.35 - 1e-6, "clear of every box");
  }
});

test("you use what you are looking at, not what is behind you", () => {
  const items = [{ id: "front", x: 0, z: -2 }, { id: "behind", x: 0, z: 1.5 }, { id: "far", x: 0, z: -9 }];
  assert.equal(walk.pickInteractable(0, 0, 0, -1, items).id, "front");
  assert.equal(walk.pickInteractable(0, 0, 0, 1, items).id, "behind");
  assert.equal(walk.pickInteractable(0, 0, 1, 0, items), null, "nothing off to the side");
  assert.equal(walk.pickInteractable(0, -8, 0, -1, items).id, "far", "and only in reach");
});

test("sightings are saved once each, and junk is dropped", () => {
  const back = save.migrate({ phrase: PHRASE, stats: { sighted: ["octopus", "ray", "octopus", "<x>", 3, "jelly"] } });
  assert.deepEqual(back.stats.sighted, ["octopus", "ray", "jelly"]);
  assert.deepEqual(save.newProfile(PHRASE, 1).stats.sighted, []);
});

test("every creature a band can spawn exists, and the new ones are placed", () => {
  for (const zone of ZONES) {
    for (const [id] of zone.hostiles) assert.ok(CREATURES[id], `${zone.id} spawns unknown ${id}`);
  }
  const spawned = new Set(ZONES.flatMap((z) => z.hostiles.map(([id]) => id)));
  for (const id of ["inkwidow", "razorfin", "choir"]) assert.ok(spawned.has(id), `${id} lives somewhere`);
  assert.ok(CREATURES.inkwidow.grabs && CREATURES.inkwidow.inks);
});

test("the scrubbers and the lattice are real upgrades with sane stock values", () => {
  const stock = progression.computeStats({});
  assert.equal(stock.inkKept, 100, "stock glass keeps all of the ink");
  assert.equal(stock.shockDamage, 0, "and there is no lattice");
  const fitted = progression.computeStats({ scrubber: 3, lattice: 2 });
  assert.ok(fitted.inkKept < stock.inkKept);
  assert.ok(fitted.shockDamage > 0);
  for (const id of ["scrubber", "lattice"]) {
    const up = UPGRADES.find((u) => u.id === id);
    assert.ok(up, id);
    assert.equal(up.costs.length, up.values.length - 1, `${id} has a price for every mark`);
  }
});

/* A fresh copy of save.js with its own storage, so slot tests do not share
   the cached store the earlier tests left behind. */
async function freshSave() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const mod = await import(`../src/save.js?fresh=${Math.random()}`);
  return { mod, store };
}

test("every sea keeps its own save, and a shared link never touches yours", async () => {
  const { mod } = await freshSave();
  const mine = mod.newProfile("salt and static", 1);
  mine.credits = 999;
  mod.saveProfile(mine);
  const theirs = mod.newProfile("a friend's sea", 2);
  theirs.credits = 5;
  mod.saveProfile(theirs);

  assert.equal(mod.loadSea("salt and static").credits, 999, "mine is still there");
  assert.equal(mod.loadSea("a friend's sea").credits, 5);
  assert.equal(mod.loadProfile().phrase, "a friend's sea", "continue means the last one played");
  assert.deepEqual(mod.listSeas().map((e) => e.phrase).sort(), ["a friend's sea", "salt and static"]);
  assert.equal(mod.loadSea("never dived"), null);

  mod.clearProfile("a friend's sea");
  assert.equal(mod.loadSea("a friend's sea"), null, "erasing one sea");
  assert.equal(mod.loadSea("salt and static").credits, 999, "leaves the others alone");
  delete globalThis.localStorage;
});

test("a save from before slots is adopted, not overwritten", async () => {
  const { mod, store } = await freshSave();
  store.set(mod.SAVE_KEY, JSON.stringify({ phrase: "old sea", credits: 777, settings: { sound: false } }));
  mod.saveProfile(mod.newProfile("new sea", 3));
  assert.equal(mod.loadSea("old sea").credits, 777);
  assert.ok(mod.listSeas().some((e) => e.phrase === "old sea"));
  delete globalThis.localStorage;
});

test("only the most recent seas are kept", async () => {
  const { mod } = await freshSave();
  for (let i = 0; i < mod.MAX_SEAS + 4; i += 1) {
    const p = mod.newProfile(`sea ${i}`, i);
    mod.saveProfile(p);
  }
  assert.equal(mod.listSeas().length, mod.MAX_SEAS);
  delete globalThis.localStorage;
});

test("sound is on unless the player turned it off", () => {
  assert.equal(save.newProfile(PHRASE, 1).settings.sound, true);
  assert.equal(save.migrate({ phrase: PHRASE, settings: { sound: false } }).settings.sound, true, "an old default is not a choice");
  assert.equal(save.migrate({ phrase: PHRASE, settings: { sound: false, soundSet: true } }).settings.sound, false, "a choice is kept");
});

test("today's sea is the same all day, different tomorrow, and reads as words", async () => {
  const daily = await import("../src/daily.js");
  const morning = new Date(Date.UTC(2026, 8, 25, 1));
  const night = new Date(Date.UTC(2026, 8, 25, 23));
  const tomorrow = new Date(Date.UTC(2026, 8, 26, 1));
  assert.equal(daily.dayKey(morning), "2026-09-25");
  assert.equal(daily.dailyPhrase(morning), daily.dailyPhrase(night));
  assert.notEqual(daily.dailyPhrase(morning), daily.dailyPhrase(tomorrow));
  assert.match(daily.dailyPhrase(morning), /^[a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]+$/);
  const seen = new Set();
  for (let d = 0; d < 30; d += 1) seen.add(daily.dailyPhrase(new Date(Date.UTC(2026, 0, 1 + d))));
  assert.ok(seen.size >= 28, "a month of seas barely repeats");
});

test("a sea link carries the phrase and nothing else", async () => {
  const share = await import("../src/share.js");
  const link = share.seaLink("my cat & the sea", "https://example.org/game/?old=1#x");
  assert.equal(link, "https://example.org/game/?phrase=my+cat+%26+the+sea");
  assert.equal(new URL(link).searchParams.get("phrase"), "my cat & the sea");
  assert.match(share.shareText("salt", "120 m down"), /salt.*120 m down/);
});

test("analytics stay off unless configured, and respect Do Not Track", async () => {
  const a = await import("../src/analytics.js");
  const on = { endpoint: "https://x.goatcounter.com/count", dnt: null, host: "sebby1770.github.io" };
  assert.equal(a.shouldTrack(on), true);
  assert.equal(a.shouldTrack({ ...on, endpoint: "" }), false, "off by default");
  assert.equal(a.shouldTrack({ ...on, dnt: "1" }), false);
  assert.equal(a.shouldTrack({ ...on, host: "localhost" }), false);
  const url = new URL(a.eventUrl(on.endpoint, "dive"));
  assert.equal(url.searchParams.get("p"), "dive");
  assert.equal(url.searchParams.get("e"), "true");
});

test("a photo is captioned with its phrase and where to grow your own", async () => {
  const photo = await import("../src/photo.js");
  const cap = photo.captionFor({ phrase: "salt", depth: 312.4, zone: "Twilight Drift" });
  assert.equal(cap.title, "“salt”");
  assert.match(cap.detail, /312 m · Twilight Drift/);
  assert.match(cap.invite, /sebby1770\.github\.io\/mnemoquarium/);
  assert.match(photo.captionFor({ phrase: "salt", aboard: true }).detail, /aboard the Hull/);
});

test("the boat is pushed out of the station, not through it", () => {
  const capsule = { kind: "capsule", ax: 0, ay: 0, az: 0, bx: 10, by: 0, bz: 0, r: 3 };
  assert.equal(walk.stationPush(capsule, 5, 8, 0, 1), null, "clear of it");
  const [nx, ny, , depth] = walk.stationPush(capsule, 5, 3.5, 0, 1);
  assert.ok(Math.abs(ny - 1) < 1e-9 && Math.abs(nx) < 1e-9, "straight out, sideways to the axis");
  assert.ok(Math.abs(depth - 0.5) < 1e-9);
  const box = { kind: "box", minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 };
  const inside = walk.stationPush(box, 0.9, 0, 0, 0.5);
  assert.deepEqual(inside.slice(0, 3), [1, 0, 0], "from inside, out the nearest face");
  assert.ok(Math.abs(inside[3] - 0.6) < 1e-9);
});
