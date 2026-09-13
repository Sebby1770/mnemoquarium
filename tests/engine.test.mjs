// Browser engine tests. Run with: node --test web/tests
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const engine = require("../engine.js");
const { World, EXPRESSED_MASK, genomeTraits, inheritGenome, pointMutation, compareWorlds, wordsFromPhrase, traitsLabel } = engine;

test("phrase tokenisation keeps unique words in order", () => {
  assert.deepEqual(wordsFromPhrase("Neon rain, neon RAIN's echo"), ["neon", "rain", "rain's", "echo"]);
  assert.deepEqual(wordsFromPhrase("   "), ["silence"]);
});

test("worlds are deterministic from a phrase", () => {
  const a = World.fromPhrase("library dust", { population: 20 });
  const b = World.fromPhrase("library dust", { population: 20 });
  for (let i = 0; i < 40; i += 1) {
    a.step();
    b.step();
  }
  assert.deepEqual(a.census(), b.census());
  assert.deepEqual(a.organisms, b.organisms);
});

test("an explicit seed changes the world", () => {
  const a = World.fromPhrase("same phrase").run?.(10) ?? World.fromPhrase("same phrase");
  const b = World.fromPhrase("same phrase", { seed: 42 });
  assert.notEqual(a.seed, b.seed);
});

test("traits are bounded and derived from the expressed bits only", () => {
  for (const genome of [0, 1, 0xff, 0xa5a5, 123456789, 4294967295]) {
    const t = genomeTraits(genome);
    assert.ok([-1, 0, 1].includes(t.appetite));
    assert.ok([-1, 0, 1].includes(t.curiosity));
    assert.equal(typeof t.thrift, "boolean");
    assert.ok(t.hue_shift >= -21 && t.hue_shift <= 21);
    assert.deepEqual(genomeTraits(genome), genomeTraits((genome & EXPRESSED_MASK) | 0xdead0000));
  }
  assert.equal(traitsLabel(genomeTraits(0)), "appetite -1, curiosity -1, hue -21");
});

test("point mutation flips exactly one expressed bit", () => {
  for (const genome of [0, 0xffff, 0x12345678, 987654321]) {
    const diff = (genome ^ pointMutation(genome)) >>> 0;
    assert.equal(diff.toString(2).split("1").length - 1, 1);
    assert.equal(diff & ~EXPRESSED_MASK, 0);
  }
});

test("children inherit their parent's expressed bits", () => {
  const child = inheritGenome(0xabcdef00, 0x12345642);
  assert.equal(child & EXPRESSED_MASK, 0x42);
  assert.equal((child & ~EXPRESSED_MASK) >>> 0, 0xabcdef00);
});

test("offspring carry generation, parent, and birth tick", () => {
  const world = World.fromPhrase("heredity test", { width: 24, height: 12, population: 16 });
  for (let i = 0; i < 60; i += 1) world.step();
  const children = world.organisms.filter((org) => org.generation > 0);
  assert.ok(children.length > 0, "a 60-tick run should produce offspring");
  for (const child of children) {
    assert.ok(child.born > 0);
    assert.notEqual(child.parent, 0);
  }
  const chain = world.lineageOf(children[0].genome);
  assert.equal(chain[0].genome, children[0].genome);
  for (let i = 1; i < chain.length; i += 1) {
    assert.equal(chain[i - 1].parent, chain[i].genome);
    assert.equal(chain[i].generation + 1, chain[i - 1].generation);
  }
});

test("genealogy and census agree with the population", () => {
  const world = World.fromPhrase("family tree", { width: 24, height: 12, population: 12 });
  for (let i = 0; i < 40; i += 1) world.step();
  const genealogy = world.genealogy();
  const census = world.census();
  assert.equal(genealogy.population, world.organisms.length);
  assert.equal(genealogy.species.reduce((n, s) => n + s.population, 0), world.organisms.length);
  assert.equal(census.max_generation, genealogy.max_generation);
  assert.ok("mutants" in census.species[0]);
  assert.ok(census.mutant_population <= world.organisms.length);
});

test("weather fires on schedule and extinction rescues the tank", () => {
  const world = World.fromPhrase("weather", { width: 16, height: 8, population: 4 });
  for (let i = 0; i < 11; i += 1) world.step();
  assert.ok(world.events.some((e) => /static bloom/.test(e)));
  world.organisms = [];
  world.step();
  assert.ok(world.organisms.length >= world.species.length);
  assert.ok(world.events.some((e) => /reseeded/.test(e)));
});

test("compare reports generation deltas", () => {
  const a = World.fromPhrase("neon rain");
  const b = World.fromPhrase("static bloom");
  for (let i = 0; i < 20; i += 1) {
    a.step();
    b.step();
  }
  const text = compareWorlds(a, b);
  assert.match(text, /Δ deepest generation/);
  assert.match(text, /gen \d+/);
});
