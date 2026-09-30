// 1.8 "The Living Deep": the parts of the release that run without a GPU —
// the colour grade's curve, the offline shell, and the rules added with them.
// Run with: node --test "web/tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

const { GRADE, gradeCurve, curveAmount, GRADE_GLSL } = await import("../src/grade.js");

test("the grade curve keeps black black and white white in every band", () => {
  for (const [id, g] of Object.entries(GRADE)) {
    assert.equal(gradeCurve(0, g.contrast), 0, `${id} lifts black without being asked`);
    assert.ok(Math.abs(gradeCurve(1, g.contrast) - 1) < 1e-12, `${id} dims white`);
  }
});

test("the grade curve never folds back on itself", () => {
  for (const [id, g] of Object.entries(GRADE)) {
    let prev = -Infinity;
    for (let i = 0; i <= 1000; i += 1) {
      const v = gradeCurve(i / 1000, g.contrast, g.lift, 1);
      assert.ok(v >= prev - 1e-12, `${id} is not monotonic at ${i / 1000}`);
      prev = v;
    }
  }
});

test("nothing faint is clipped to black any more", () => {
  // The old linear contrast zeroed everything below about sRGB 70. The
  // faintest light worth keeping must survive in every band, lift or not.
  for (const [id, g] of Object.entries(GRADE)) {
    assert.ok(gradeCurve(0.003, g.contrast) > 0, `${id} crushes a faint value to black`);
    assert.ok(gradeCurve(0.1, g.contrast) > 0.05, `${id} crushes the shadows`);
  }
});

test("the deep bands lift their blacks toward blue water, not grey", () => {
  for (const id of ["twilight", "midnight", "abyss"]) {
    const g = GRADE[id];
    assert.ok(g.lift > 0, `${id} has no lift`);
    const [r, gr, b] = g.tint.map((t) => gradeCurve(0, g.contrast, g.lift, t));
    assert.ok(b > r && b > gr, `${id} lifts toward ${r},${gr},${b}, which is not blue`);
  }
});

test("the deep is graded softer than the shelf, not harder", () => {
  assert.ok(GRADE.abyss.contrast < GRADE.shelf.contrast);
  assert.ok(GRADE.midnight.contrast < GRADE.kelp.contrast);
  for (const g of Object.values(GRADE)) assert.ok(curveAmount(g.contrast) <= 1);
});

test("the GLSL curve is the same curve as the JS one", () => {
  // Not a compiler, but it catches the two drifting apart by hand.
  assert.match(GRADE_GLSL, /2\.0 \* \(uContrast - 1\.0\)/);
  assert.match(GRADE_GLSL, /d \* d \* \(3\.0 - 2\.0 \* d\)/);
  assert.match(GRADE_GLSL, /uLift \* uLiftTint \* \(1\.0 - d\)/);
});

test("the offline shell lists every module the game can import", () => {
  const sw = readFileSync(join(web, "sw.js"), "utf8");
  const listed = new Set([...sw.matchAll(/"\.\/([^"]+)"/g)].map((m) => m[1]));
  for (const file of readdirSync(join(web, "src"))) {
    if (!file.endsWith(".js")) continue;
    assert.ok(listed.has(`src/${file}`), `sw.js SHELL is missing src/${file} — an offline player would get a broken import`);
  }
  for (const file of ["index.html", "styles.css", "engine.js", "vendor/three.module.min.js"]) {
    assert.ok(listed.has(file), `sw.js SHELL is missing ${file}`);
  }
});

test("the service worker revalidates instead of trusting the HTTP cache", () => {
  const sw = readFileSync(join(web, "sw.js"), "utf8");
  assert.match(sw, /cache:\s*"no-cache"/, "a plain fetch() lets the HTTP cache hand back a stale module after a deploy");
});

// ---------------------------------------------------------------- the goals

globalThis.MnemoEngine = globalThis.MnemoEngine || (await import("node:module")).createRequire(import.meta.url)("../engine.js");
const goals = await import("../src/goals.js");
const save = await import("../src/save.js");
const { upgradeCost } = await import("../src/progression.js");

function freshProfile() {
  return save.newProfile("forgotten kiosk under neon rain", 7);
}

test("a new player's first goal is to catch a fish, worded for their hands", () => {
  const p = freshProfile();
  assert.equal(goals.currentStep(p).id, "beam");
  const ctx = { profile: p, sub: { x: 0, z: 0, depth: 20 }, station: { x: 0, z: 0 } };
  assert.match(goals.objectiveFor(goals.currentStep(p), { ...ctx, input: "mouse" }).text, /right mouse/);
  assert.match(goals.objectiveFor(goals.currentStep(p), { ...ctx, input: "pad" }).text, /LT/);
  assert.match(goals.objectiveFor(goals.currentStep(p), { ...ctx, input: "touch" }).text, /BEAM/);
});

test("the chain moves forward on persisted state alone", () => {
  const p = freshProfile();
  p.stats.discovered.push(0);
  assert.equal(goals.currentStep(p).id, "sell");
  p.stats.fishSold = 3;
  assert.equal(goals.currentStep(p).id, "casing");
  p.upgrades.pressure = 1;
  assert.equal(goals.currentStep(p).id, "kelp");
  p.stats.deepest = 95;
  assert.equal(goals.currentStep(p).id, "sight");
  p.stats.sighted.push("turtle");
  p.stats.landmarks.push("lm-3");
  p.upgrades.pressure = 2;
  p.stats.deepest = 260;
  assert.equal(goals.currentStep(p), null, "a veteran has no chain left to follow");
});

test("carrying fish points home; docked with fish points at the market", () => {
  const p = freshProfile();
  p.stats.discovered.push(0);
  p.cargo.push({ id: "x" });
  const step = goals.currentStep(p);
  const away = goals.objectiveFor(step, { profile: p, input: "mouse", sub: { x: 300, z: 0 }, station: { x: 0, z: 0 } });
  assert.match(away.text, /the Hull bears W · 300 m/);
  assert.deepEqual(away.target, { x: 0, z: 0 });
  const home = goals.objectiveFor(step, { profile: p, input: "mouse", docked: true, sub: { x: 0, z: 0 }, station: { x: 0, z: 0 } });
  assert.equal(home.terminal, "market");
});

test("the casing goal counts up toward the price, then sends you to the drydock", () => {
  const p = freshProfile();
  p.stats.discovered.push(0);
  p.stats.fishSold = 1;
  const cost = upgradeCost(p.upgrades, "pressure");
  p.credits = cost - 1;
  const step = goals.currentStep(p);
  const saving = goals.objectiveFor(step, { profile: p, input: "mouse", docked: true, casingCost: cost, station: { x: 0, z: 0 } });
  assert.match(saving.text, new RegExp(`${cost - 1} / ${cost} cr`));
  p.credits = cost;
  const buying = goals.objectiveFor(step, { profile: p, input: "mouse", docked: true, casingCost: cost, station: { x: 0, z: 0 } });
  assert.equal(buying.terminal, "drydock");
});

test("the drydock recommends the casing first, and never a maxed refit", () => {
  const p = freshProfile();
  const next = (id) => upgradeCost(p.upgrades, id);
  assert.equal(goals.recommendedRefit(p, { pressureRating: 140 }, next).id, "pressure");
  const maxed = goals.recommendedRefit(p, { pressureRating: 140 }, () => null);
  assert.equal(maxed, null);
});

test("starting credits buy one real refit at the first dock", () => {
  const p = freshProfile();
  const cheapest = Math.min(...Object.keys(p.upgrades).map((id) => upgradeCost(p.upgrades, id)).filter((c) => c != null));
  assert.ok(p.credits >= cheapest, `${p.credits} cr cannot buy anything; the cheapest refit is ${cheapest}`);
});

test("what the game has taught survives a save and junk is dropped", () => {
  const p = freshProfile();
  p.log.taught.push("drydock", "gate-kelp", "<script>", "x".repeat(40));
  p.log.chain = 3;
  const back = save.migrate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.log.taught, ["drydock", "gate-kelp"]);
  assert.equal(back.log.chain, 3);
  // A save from before the logbook existed still loads, with an empty one.
  const old = JSON.parse(JSON.stringify(p));
  delete old.log;
  assert.deepEqual(save.migrate(old).log, { taught: [], chain: 0, codex: {} });
});

// ------------------------------------------------------------- effects tier

const { effectsTier, SCALE } = await import("../src/quality.js");

test("effects follow the graphics setting, and auto follows the resolution governor", () => {
  assert.equal(effectsTier("high", SCALE.min), 2, "Sharp pins full effects even at low resolution");
  assert.equal(effectsTier("low", SCALE.max), 0, "Fast pins the fewest effects");
  assert.equal(effectsTier("auto", SCALE.max), 2);
  assert.equal(effectsTier("auto", SCALE.low + 0.1), 1);
  assert.equal(effectsTier("auto", SCALE.min), 0);
  assert.equal(effectsTier("auto", undefined), 2, "no governor yet means no reason to hold back");
});

// ---------------------------------------------------------------- logbook

const { Logbook } = await import("../src/logbook.js");

function logbookRig(profile) {
  const said = [];
  const credits = [];
  const game = {
    profile,
    bus: { emit: (name, e) => said.push([name, e.id]) },
    toast: () => {},
    log: () => {},
    addCredits: (n, why) => credits.push([n, why]),
    persist: () => {},
    mode: "dive",
  };
  return { book: new Logbook(game), said, credits };
}

test("a step is announced when it happens, even ahead of the chain", () => {
  const p = freshProfile();
  const { book, said, credits } = logbookRig(p);
  p.stats.deepest = 96;   // into the kelp before the first fish, let alone the casing
  book.update(1);
  assert.deepEqual(said, [["goal:done", "kelp"]]);
  assert.equal(credits.length, 1, "the first descent should pay once");
  book.update(1);
  assert.equal(said.length, 1, "announced twice");
  p.stats.discovered.push(0);
  book.update(1);
  assert.deepEqual(said.at(-1), ["goal:done", "beam"]);
});

test("a veteran opening an old save hears nothing and is paid nothing", () => {
  const p = freshProfile();
  p.stats.discovered.push(0, 1);
  p.stats.fishSold = 40;
  p.upgrades.pressure = 3;
  p.stats.deepest = 700;
  const { book, said, credits } = logbookRig(p);
  book.update(1);
  assert.deepEqual(said, []);
  assert.deepEqual(credits, []);
});

// ------------------------------------------------------------------ codex

const { Ecology } = await import("../src/ecology.js");

test("codex stamps cannot be ground out on the shelf", () => {
  const eco = new Ecology("forgotten kiosk under neon rain");
  const sp = eco.species[0];
  let entry = goals.recordCatch(null, { rarity: sp.rarity, mutations: 0, generation: 1, depth: sp.zone.top + 1 });
  assert.deepEqual(goals.stampsFor(entry, sp), { caught: true, rarer: false, mutant: false, deep: false });
  entry = goals.recordCatch(entry, { rarity: "mythic", mutations: 2, generation: 4, depth: goals.deepMark(sp.zone) + 1 });
  assert.deepEqual(goals.stampsFor(entry, sp), { caught: true, rarer: sp.rarity !== "mythic", mutant: true, deep: true });
  const progress = goals.codexProgress({ [sp.index]: entry }, eco.species);
  assert.equal(progress.total, eco.species.length * 4);
  assert.ok(progress.have >= 3);
});

test("the codex survives a save and junk is dropped", () => {
  const p = freshProfile();
  p.log.codex = { 0: { r: 3, m: 1, g: 2, d: 120, p: 1 }, x: { r: 1 }, 400: { r: 1 }, 2: "nonsense" };
  const back = save.migrate(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(back.log.codex, { 0: { r: 3, m: 1, g: 2, d: 120, p: 1 } });
});

test("a full plate pays once, and only when the last stamp lands", () => {
  const eco = new Ecology("forgotten kiosk under neon rain");
  const sp = eco.species.find((s) => s.rarity !== "mythic");
  const p = freshProfile();
  const handlers = {};
  const credits = [];
  const game = {
    profile: p, ecology: eco, mode: "dive",
    bus: { on: (n, fn) => { handlers[n] = fn; return () => {}; }, emit: () => {} },
    toast: () => {}, log: () => {}, persist: () => {},
    addCredits: (n, why) => credits.push([n, why]),
  };
  new Logbook(game);
  const deep = goals.deepMark(sp.zone) + 5;
  handlers["fish:captured"]({ item: { kind: "fish", speciesIndex: sp.index, rarity: sp.rarity, mutations: 0, generation: 1, depth: deep } });
  handlers["fish:captured"]({ item: { kind: "fish", speciesIndex: sp.index, rarity: "mythic", mutations: 0, generation: 2, depth: 10 } });
  assert.equal(credits.length, 0, "paid before the plate was full");
  handlers["fish:captured"]({ item: { kind: "fish", speciesIndex: sp.index, rarity: sp.rarity, mutations: 1, generation: 3, depth: 10 } });
  assert.deepEqual(credits, [[goals.plateBonus(sp), "full plate"]]);
  handlers["fish:captured"]({ item: { kind: "fish", speciesIndex: sp.index, rarity: "mythic", mutations: 3, generation: 5, depth: deep } });
  assert.equal(credits.length, 1, "paid for the same plate twice");
});

test("naturally mythic species have a completable plate", () => {
  const sp = { index: 0, rarity: "mythic", zone: { top: 0, bottom: 90 } };
  const e = goals.recordCatch(null, { rarity: "mythic", mutations: 1, generation: 2, depth: 60 });
  assert.equal(goals.stampCount(e, sp), 4);
});

test("research prioritizes nearly complete reachable plates without revealing unlogged names", () => {
  const p = freshProfile();
  const species = [
    { index: 0, name: "secret fish", rarity: "common", zone: { top: 0, bottom: 90, name: "Shelf" } },
    { index: 1, name: "kelp fish", rarity: "common", zone: { top: 90, bottom: 240, name: "Kelp" } },
  ];
  p.log.codex[1] = { r: 3, m: 1, d: 100 };
  const shallow = goals.researchGoal(p, species, 140);
  assert.equal(shallow.speciesIndex, 0);
  assert.doesNotMatch(shallow.text, /secret fish/);
  const deeper = goals.researchGoal(p, species, 240);
  assert.equal(deeper.speciesIndex, 1);
  assert.equal(deeper.depth, 180);
  assert.equal(deeper.stamp, "deep");
  p.log.codex[0] = { r: 3, m: 1, d: 70 };
  p.log.codex[1].d = 200;
  assert.equal(goals.researchGoal(p, species, 240), null);
});

test("the logbook offers research after the tutorial and recognizes a complete collection", () => {
  const p = freshProfile();
  p.stats.discovered = [0];
  p.stats.fishSold = 1;
  p.stats.sighted = ["turtle"];
  p.stats.landmarks = ["lm-0"];
  p.stats.deepest = 250;
  p.upgrades.pressure = 2;
  const species = [{ index: 0, name: "test fish", rarity: "common", zone: { top: 0, bottom: 90, name: "Shelf" } }];
  const book = new Logbook({ profile: p, ecology: { species }, stats: { pressureRating: 240 } });
  assert.match(book.objective().text, /research · catch test fish/);
  p.log.codex[0] = { r: 3, m: 1, d: 60 };
  assert.match(book.objective().text, /codex complete/);
});
