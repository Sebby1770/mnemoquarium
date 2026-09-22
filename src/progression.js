/* Progression: the upgrade table in config.js turned into the numbers the boat
   actually flies by, the price of the next plate, and what a thing is worth
   once it is in the hold.

   Pure logic on purpose — nothing here imports three.js, so the balance of the
   game can be read, argued with, and tested without a GPU. Every function is
   total: hand it a half-written profile, an unknown upgrade id, or a species
   that lost its baseValue and it answers with the stock boat instead of
   throwing in the middle of a dive. */

import {
  CREATURES,
  ECONOMY,
  RARITY,
  SUB,
  UPGRADES,
  WEAPONS,
  zoneForDepth,
} from "./config.js";
import { clamp, formatCredits, formatDepth } from "./util.js";

const UPGRADE_BY_ID = new Map(UPGRADES.map((spec) => [spec.id, spec]));

/* The stock boat, straight off the clamps. computeStats seeds itself from this
   so every stat named in the contract exists even if the upgrade table were to
   lose a row — a missing number is a soft landing, never an undefined. */
const BASE_STATS = Object.freeze({
  hullMax: SUB.hullBase,
  pressureRating: SUB.pressureBase,
  thrust: SUB.thrustBase,
  cargoSlots: SUB.cargoSlotsBase,
  batteryMax: SUB.batteryBase,
  lightRange: SUB.lightRangeBase,
  sonarRange: SUB.sonarRangeBase,
  captureRange: SUB.captureRangeBase,
  harpoonDamage: WEAPONS.harpoon.damage,
  torpedoAmmo: WEAPONS.torpedo.ammoBase,
  repairRate: 0,
  batteryTrickle: SUB.batteryTrickle,
});

/* Derived-stat shaping. The contract fixes these three formulas; the floors are
   ours, so a future table cannot hand the beam a negative hold time. */
const CAPTURE_TIME_PER_LEVEL = 0.12;
const CAPTURE_TIME_FLOOR = 0.35;
const SONAR_COOLDOWN_PER_LEVEL = 0.15;
const SONAR_COOLDOWN_FLOOR = 0.8;

/* A line that has bred this deep reads as pedigree, and an inherited mutation
   makes a specimen a collector's item — the tank kept something it should not
   have. Both stay small multipliers: depth and the rarity roll are the real
   money, and a lineage bonus should never outrun a trip to the next band. */
const GENERATION_BONUS = 0.035;
const GENERATION_CAP = 12;
const MUTATION_BONUS = 0.22;
const MUTATION_CAP = 4;

/* What an unnamed fish is worth if its species forgot to price itself. */
const FALLBACK_BASE_VALUE = 12;

/* Something died and left nothing the market recognises. Still sells. */
const UNKNOWN_CREATURE = Object.freeze({
  id: "remains",
  name: "Unlisted Thing",
  bounty: 60,
  color: 0x8899aa,
  trophy: "a piece of something",
  glow: 0,
});

/* Trophy glyphs mirror the engine's glyph alphabet so the manifest reads in one
   typeface with the fish. */
const TROPHY_GLYPHS = {
  shark: "&",
  squid: "@",
  angler: "*",
  leviathan: "=",
  wraith: "?",
  kraken: "%",
};

let trophySerial = 0;

// ---------------------------------------------------------------- internals

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* The highest level the table can actually reach: bounded by the stat list and
   by the price list, whichever runs out first. */
function maxLevelFor(spec) {
  return Math.max(0, Math.min(spec.values.length - 1, spec.costs.length));
}

/* Callers pass either the bare `upgrades` map or a whole profile. Accepting
   both costs one property check and removes a whole class of integration bug. */
function levelsOf(source) {
  if (!source || typeof source !== "object") return null;
  if (source.upgrades && typeof source.upgrades === "object") return source.upgrades;
  return source;
}

function mutationCount(individual) {
  if (!individual) return 0;
  const raw = individual.mutations;
  if (Array.isArray(raw)) return raw.length;
  if (raw instanceof Set) return raw.size;
  return Math.max(0, num(raw, 0));
}

function rarityOf(species, individual) {
  const id = (individual && individual.rarity) || (species && species.rarity) || "common";
  return RARITY[id] || RARITY.common;
}

/* Lineage premium: generations of depth plus inherited mutations, both capped
   so a very old bloodline cannot out-earn the trench itself. */
function lineageMultiplier(individual) {
  const generation = clamp(Math.floor(num(individual && individual.generation, 0)), 0, GENERATION_CAP);
  const mutations = clamp(Math.floor(mutationCount(individual)), 0, MUTATION_CAP);
  return 1 + generation * GENERATION_BONUS + mutations * MUTATION_BONUS;
}

/* Value the sea adds for having been reached at all. */
function depthMultiplier(depth) {
  const d = Math.max(0, num(depth, 0));
  return 1 + num(ECONOMY.depthBonusPerKm, 0) * (d / 1000);
}

function zoneMultiplier(depth) {
  const zone = zoneForDepth(Math.max(0, num(depth, 0)));
  const mul = num(zone && zone.valueMultiplier, 1);
  return mul > 0 ? mul : 1;
}

/* Creature colours are stored as packed ints; the manifest wants a hue so the
   trophy chip can be tinted like a species chip. */
function hueFromHex(color) {
  const c = num(color, 0) >>> 0;
  const r = ((c >> 16) & 0xff) / 255;
  const g = ((c >> 8) & 0xff) / 255;
  const b = (c & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta <= 0) return 0;
  let h;
  if (max === r) h = ((g - b) / delta) % 6;
  else if (max === g) h = (b - r) / delta + 2;
  else h = (r - g) / delta + 4;
  h *= 60;
  return (h + 360) % 360;
}

/* Cargo ids only have to be unique within a save, so a counter plus the clock
   is enough — nothing about the world is derived from them. */
function nextCargoId(prefix) {
  trophySerial += 1;
  return `${prefix}-${Date.now().toString(36)}-${trophySerial.toString(36)}`;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ------------------------------------------------------------------- levels

/* Current level of one upgrade, clamped into the table. Unknown id, missing
   map, a string where a number should be: all of it reads as stock. */
export function upgradeLevel(upgrades, id) {
  const spec = UPGRADE_BY_ID.get(id);
  if (!spec) return 0;
  const levels = levelsOf(upgrades);
  if (!levels) return 0;
  const level = Math.floor(num(levels[id], 0));
  if (level <= 0) return 0;
  return Math.min(level, spec.values.length - 1);
}

/* Price of the next plate, or null when there is nothing left to buy. */
export function upgradeCost(upgrades, id) {
  const spec = UPGRADE_BY_ID.get(id);
  if (!spec) return null;
  const level = upgradeLevel(upgrades, id);
  if (level >= maxLevelFor(spec)) return null;
  const cost = num(spec.costs[level], NaN);
  if (!Number.isFinite(cost)) return null;
  return Math.max(0, Math.round(cost));
}

export function canAfford(profile, id) {
  const cost = upgradeCost(profile, id);
  if (cost === null) return false;
  const credits = Math.max(0, num(profile && profile.credits, 0));
  return credits >= cost;
}

// -------------------------------------------------------------------- stats

/* The live stat block the whole boat reads. Every id in the table writes its
   `stat` key; the rest are derived here, by the formulas in the contract. */
export function computeStats(upgrades) {
  const levels = levelsOf(upgrades);
  const stats = Object.assign({}, BASE_STATS);

  for (const spec of UPGRADES) {
    const level = upgradeLevel(levels, spec.id);
    const value = num(spec.values[level], NaN);
    if (Number.isFinite(value)) {
      stats[spec.stat] = value;
    } else {
      // A hole in the table falls back to the stock number, not to undefined.
      stats[spec.stat] = num(spec.values[0], num(BASE_STATS[spec.stat], 0));
    }
  }

  // Thrust buys acceleration and top speed together, so the impeller always
  // feels like it did something even in a straight line.
  const thrustBase = num(SUB.thrustBase, 1) || 1;
  stats.maxSpeed = num(SUB.maxSpeedBase, 0) * (num(stats.thrust, thrustBase) / thrustBase);

  // A better beam holds the fish for less time and reaches further.
  const captureLevel = upgradeLevel(levels, "capture");
  stats.captureTime = Math.max(
    CAPTURE_TIME_FLOOR,
    num(SUB.captureTimeBase, 1) * (1 - CAPTURE_TIME_PER_LEVEL * captureLevel),
  );

  // A better array recharges its ping faster, which is the real reason to buy
  // sonar past the first plate.
  const sonarLevel = upgradeLevel(levels, "sonar");
  stats.sonarCooldown = Math.max(
    SONAR_COOLDOWN_FLOOR,
    num(SUB.sonarCooldownBase, 1) * (1 - SONAR_COOLDOWN_PER_LEVEL * sonarLevel),
  );

  // Level 0 of the torpedo tube carries zero fish of ordnance: the tubes are
  // there, they are simply empty until someone pays for them.
  stats.torpedoAmmo = Math.max(0, Math.floor(num(stats.torpedoAmmo, 0)));
  stats.torpedoUnlocked = stats.torpedoAmmo > 0;

  /* Same shape for the net: mark 0 is no net at all, and every mark after that
     both catches more and opens wider, because a net that holds more but lands
     on the same patch of water would not feel like anything. */
  stats.netCapacity = Math.max(0, Math.floor(num(stats.netCapacity, 0)));
  stats.netUnlocked = stats.netCapacity > 0;
  const netLevel = upgradeLevel(levels, "net");
  stats.netRadius = stats.netUnlocked
    ? num(WEAPONS.net.radius, 9) * (1 + 0.18 * Math.max(0, netLevel - 1))
    : 0;

  // Keep the rest honest — nothing downstream should ever divide by a NaN.
  stats.hullMax = Math.max(1, num(stats.hullMax, SUB.hullBase));
  stats.batteryMax = Math.max(1, num(stats.batteryMax, SUB.batteryBase));
  stats.pressureRating = Math.max(0, num(stats.pressureRating, SUB.pressureBase));
  stats.cargoSlots = Math.max(1, Math.floor(num(stats.cargoSlots, SUB.cargoSlotsBase)));
  stats.lightRange = Math.max(0, num(stats.lightRange, SUB.lightRangeBase));
  stats.sonarRange = Math.max(0, num(stats.sonarRange, SUB.sonarRangeBase));
  stats.captureRange = Math.max(0, num(stats.captureRange, SUB.captureRangeBase));
  stats.harpoonDamage = Math.max(0, num(stats.harpoonDamage, WEAPONS.harpoon.damage));
  stats.repairRate = Math.max(0, num(stats.repairRate, 0));
  stats.batteryTrickle = Math.max(0, num(stats.batteryTrickle, 0));

  return stats;
}

// ------------------------------------------------------------------ buying

/* Buy the next level of one upgrade. Mutates the profile in place — credits
   down, level up, torpedo rack topped off — and never lets the ledger go
   negative. The refusals carry a line the station can print as-is. */
export function applyUpgrade(profile, id) {
  if (!profile || typeof profile !== "object") {
    return { ok: false, cost: null, level: 0, reason: "no logbook to refit against" };
  }

  const spec = UPGRADE_BY_ID.get(id);
  if (!spec) {
    return { ok: false, cost: null, level: 0, reason: "the drydock has never heard of that part" };
  }

  if (!profile.upgrades || typeof profile.upgrades !== "object") profile.upgrades = {};
  const level = upgradeLevel(profile.upgrades, id);
  // Normalise on the way past: a level of "3" or 99 becomes a real one.
  profile.upgrades[id] = level;

  const cost = upgradeCost(profile.upgrades, id);
  if (cost === null) {
    return { ok: false, cost: null, level, reason: `${spec.name.toLowerCase()} is as far as it goes` };
  }

  const credits = Math.max(0, Math.floor(num(profile.credits, 0)));
  if (credits < cost) {
    return {
      ok: false,
      cost,
      level,
      reason: `${formatCredits(cost - credits)} credits short`,
    };
  }

  profile.credits = Math.max(0, credits - cost);
  const next = Math.min(level + 1, spec.values.length - 1);
  profile.upgrades[id] = next;

  // Buying tubes fills them. Nobody bolts on a rack and leaves the dock empty.
  if (spec.id === "torpedo") {
    if (!profile.ammo || typeof profile.ammo !== "object") profile.ammo = { torpedo: 0 };
    const capacity = Math.max(0, Math.floor(num(spec.values[next], 0)));
    const carried = Math.max(0, Math.floor(num(profile.ammo.torpedo, 0)));
    profile.ammo.torpedo = Math.max(carried, capacity);
  }

  return { ok: true, cost, level: next, reason: null };
}

// ------------------------------------------------------------------- value

/* What one netted fish is worth: its species' base price, the rarity it rolled,
   the band it was taken from, a little more for every kilometre down, and a
   premium for a deep, mutated bloodline. */
export function fishValue(species, individual, depth) {
  const base = Math.max(0, num(species && species.baseValue, FALLBACK_BASE_VALUE));
  const rarity = rarityOf(species, individual);
  const rarityMul = Math.max(0, num(rarity.multiplier, 1));
  const value = base
    * rarityMul
    * zoneMultiplier(depth)
    * depthMultiplier(depth)
    * lineageMultiplier(individual);
  if (!Number.isFinite(value)) return 1;
  // Credits are whole. Nothing is ever worth nothing once it is in the hold.
  return Math.max(1, Math.round(value));
}

/* A killed creature leaves one thing behind worth carrying home. Trophies are
   priced off the bounty rather than the rarity table — a leviathan is not rare,
   it is simply large and very much in the way. */
export function trophyItem(creatureType, depth) {
  const looked = typeof creatureType === "string" ? CREATURES[creatureType] : creatureType;
  const type = looked && typeof looked === "object" ? looked : UNKNOWN_CREATURE;

  const bounty = Math.max(0, num(type.bounty, UNKNOWN_CREATURE.bounty));
  const share = Math.max(0, num(ECONOMY.trophyValueShare, 1));
  const d = Math.max(0, num(depth, 0));
  const value = Math.max(1, Math.round(bounty * share * depthMultiplier(d)));

  const boss = type.boss === true;
  const mythic = boss || type.mythic === true;
  let rarity = "common";
  if (mythic) rarity = "mythic";
  else if (bounty >= 300) rarity = "rare";
  else if (bounty >= 120) rarity = "uncommon";

  const id = String(type.id || "remains");
  return {
    id: nextCargoId("trophy"),
    kind: "trophy",
    speciesIndex: -1,
    name: String(type.name || UNKNOWN_CREATURE.name),
    word: id,
    glyph: TROPHY_GLYPHS[id] || "+",
    hue: Math.round(hueFromHex(num(type.color, UNKNOWN_CREATURE.color))),
    rarity,
    value,
    depth: Math.round(d),
    genome: 0,
    generation: 0,
    mutations: 0,
    label: String(type.trophy || UNKNOWN_CREATURE.trophy),
  };
}

// --------------------------------------------------------------- drydock UI

/* Rows for the drydock plate. Labels stay lowercase and thin, the way the rest
   of the instrument panel talks. */
export function describeStats(stats) {
  const s = stats && typeof stats === "object" ? stats : computeStats(null);
  const rows = [];
  const push = (label, value) => rows.push({ label, value: String(value) });

  push("hull", `${Math.round(num(s.hullMax, 0))}`);
  push("rated depth", formatDepth(num(s.pressureRating, 0)));
  push("impeller", `${round1(num(s.thrust, 0))} m/s2`);
  push("top speed", `${round1(num(s.maxSpeed, 0))} m/s`);
  push("hold", `${Math.max(0, Math.floor(num(s.cargoSlots, 0)))} slots`);
  push("cell", `${Math.round(num(s.batteryMax, 0))}`);
  push("lamps", formatDepth(num(s.lightRange, 0)));
  push("sonar", formatDepth(num(s.sonarRange, 0)));
  push("ping cycle", `${round1(num(s.sonarCooldown, 0))} s`);
  push("beam reach", formatDepth(num(s.captureRange, 0)));
  push("beam hold", `${(num(s.captureTime, 0)).toFixed(2)} s`);
  push("harpoon", `${Math.round(num(s.harpoonDamage, 0))} dmg`);
  push(
    "torpedoes",
    s.torpedoUnlocked ? `${Math.max(0, Math.floor(num(s.torpedoAmmo, 0)))} carried` : "tubes dry",
  );
  const repair = num(s.repairRate, 0);
  push("repair drone", repair > 0 ? `${round1(repair)} hull/s` : "not fitted");
  const trickle = num(s.batteryTrickle, 0);
  push("trickle", trickle > 0 ? `${round1(trickle)} cell/s` : "not fitted");

  return rows;
}
