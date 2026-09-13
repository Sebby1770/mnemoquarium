/* Ecology — the phrase, read as a species list.

   This is the one module that has to stay honest with the 2D lab. The words
   become species through `makeSpecies()` in the engine, exactly as they do
   upstairs; everything here is a second layer of meaning painted onto those
   same numbers — which depth band a species keeps to, how big it grows, how
   hard it runs from a floodlight, what the market will pay for it.

   Nothing in this file may call Math.random(). A phrase is a place, and a
   place has to be the same twice or it is not a place. */

import { RARITY, SEA, ZONES, zoneIndex } from "./config.js";
import { clamp, clamp01, hslHex, lerp, makeRng, weightedPick } from "./util.js";
import {
  DEFAULT_PHRASE,
  fnv,
  genomeTraits,
  inheritGenome,
  makeSpecies,
  pointMutation,
} from "./mnemo.js";
import { fishValue } from "./progression.js";

/* Body plans, in the order tank.js declares them. `fishKindOf` below has to
   index this list with the same modulo or a species that is an eel in the
   glass tank turns into an angelfish down here, and that would be a lie. */
const KINDS = ["tetra", "guppy", "angel", "betta", "catfish", "eel"];

const RARITY_TIERS = ["common", "uncommon", "rare", "mythic"];

/* How each depth band leans on the rarity ladder. These multiply the base
   weights in config.RARITY, so a balance pass over there still lands here.
   The shelf has been fished for a century and has nothing legendary left in
   it; the Forgetting has never been fished at all. Rows are per zone index,
   columns per RARITY_TIERS entry. */
const RARITY_PRESSURE = [
  [1.60, 0.80, 0.25, 0.00],  // shelf
  [1.20, 1.10, 0.60, 0.05],  // kelp
  [0.80, 1.20, 1.20, 0.35],  // twilight
  [0.45, 1.00, 1.90, 1.10],  // midnight
  [0.20, 0.70, 2.20, 2.60],  // abyss
];

/* The highest tier a single fish may be promoted to in each band. A shelf
   species can throw an unusual individual; it cannot throw a myth. */
const ZONE_RARITY_CEILING = [1, 2, 3, 3, 3];

/* Bioluminescence is blue-green almost everywhere it occurs, because that is
   what carries through water. The violet is the Forgetting's own idea. */
const BIOLUM_HUES = [188, 172, 205, 160, 196, 286];

/* ------------------------------------------------------------------ flavour
   The species names come out of the engine (glass-kiosk-lantern and friends).
   These lines are the rest of the personality: one opener that remembers the
   word it grew from, one clause that says what the thing actually does. */

const WORD_OPENERS = [
  (w) => `the word "${w}", grown a spine.`,
  (w) => `"${w}" went into the water and came back with fins.`,
  (w) => `whatever "${w}" used to mean, it means this down here.`,
  (w) => `the sea's copy of "${w}". it copies badly, and on purpose.`,
  (w) => `"${w}", held at pressure until it set.`,
  (w) => `filed under "${w}" by something that cannot read.`,
  (w) => `"${w}" again — scaled, gilled, and unbothered.`,
  (w) => `what is left of "${w}" once the salt has had its share.`,
];

const ZONE_CLAUSES = {
  shelf: [
    "works the bright water, where everything has been counted twice.",
    "shelf-bred, and it shows: nothing up here has to be clever.",
  ],
  kelp: [
    "keeps to the green columns and does not care for open water.",
    "hunts the kelp aisles, never more than one stalk from cover.",
  ],
  twilight: [
    "hangs in the last of the light and spends it slowly.",
    "drifts the grey band, where the surface stops being a fact.",
  ],
  midnight: [
    "has never been above five hundred metres and has no plans to be.",
    "lives at a depth that has forgotten what noon was for.",
  ],
  abyss: [
    "belongs to the Forgetting, and the Forgetting does not lend.",
    "so far down that finding one is most of the work.",
  ],
};

const KIND_CLAUSES = {
  tetra: "thin, quick, and gone before the beam has warmed up.",
  guppy: "plain on the manifest. stranger than that in the light.",
  angel: "broad as a held page, and about as easy to steer.",
  betta: "trails fin like a torn flag and will fight its own reflection.",
  catfish: "keeps one fin on the floor at all times.",
  eel: "reads more like a rope than a fish.",
};

/* Clause pools that only apply when the trait actually stands out. Weights
   are relative: the rarer the observation, the louder it should be. */
const TRAIT_CLAUSES = [
  { weight: 3.0, when: (s) => s.schooling >= 0.72, text: "shoals so tight the sonar paints it as one animal." },
  { weight: 3.0, when: (s) => s.schooling <= 0.30, text: "travels alone. two of them in one beam is an accident." },
  { weight: 3.0, when: (s) => s.skittish >= 0.70, text: "leaves before your lamp has finished arriving." },
  { weight: 3.0, when: (s) => s.skittish <= 0.25, text: "comes to the floodlights unasked, which is its own problem." },
  { weight: 3.2, when: (s) => s.glow >= 0.60, text: "lights itself. down here that is advertising, not comfort." },
  { weight: 2.4, when: (s) => s.glow > 0.18 && s.glow < 0.60, text: "carries a dim line along the flank, on and off, like a thought." },
  { weight: 3.0, when: (s) => s.size >= 1.90, text: "long enough to fill the window and then some." },
  { weight: 2.2, when: (s) => s.size <= 0.45, text: "small enough to lose in the marine snow." },
  { weight: 2.2, when: (s) => s.speed >= 5.0, text: "outswims the beam more often than it does not." },
  { weight: 2.0, when: (s) => s.speed <= 1.6, text: "moves at the speed of cold, and knows it can afford to." },
  { weight: 4.0, when: (s) => s.rarity === "mythic", text: "the manifest keeps a line for it. the line is usually empty." },
  { weight: 2.0, when: (s) => s.rarity === "rare", text: "worth the fuel, if you can hold it still long enough." },
  { weight: 2.0, when: (s) => s.lifespan >= 85, text: "older than the phrase that made it, if you ask it directly." },
  { weight: 2.0, when: (s) => s.appetite >= 3, text: "eats whatever holds still long enough to count as food." },
  { weight: 2.0, when: (s) => s.curiosity >= 6, text: "follows the sub for reasons it declines to give." },
  { weight: 1.8, when: (s) => s.stubbornness >= 6, text: "picks a heading at birth and argues with the current about it." },
];

/* ------------------------------------------------------------------ helpers */

/* The exact rule from web/tank.js. Do not soften it: the two views of the
   same phrase have to agree on what shape a word is. */
function fishKindOf(sp) {
  if (sp.appetite >= 3 && sp.curiosity <= 2) return "catfish";
  if (sp.stubbornness >= 6) return "angel";
  if (sp.curiosity >= 6 && sp.appetite <= 2) return "tetra";
  return KINDS[sp.seed % KINDS.length];
}

function rarityTier(id) {
  const i = RARITY_TIERS.indexOf(id);
  return i < 0 ? 0 : i;
}

/* Shortest way round the colour wheel, so a red fish's glow does not swing
   through the whole spectrum on its way to cyan. */
function mixHue(a, b, t) {
  const delta = (((b - a) % 360) + 540) % 360 - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

function zoneRow(table, idx) {
  return table[Math.min(Math.max(0, idx), table.length - 1)];
}

/* ------------------------------------------------------------------ Ecology */

export class Ecology {
  constructor(phrase, seed) {
    // Normalise the way the engine's World does, so a stray space in the URL
    // does not quietly grow a different sea.
    this.phrase = String(phrase == null ? "" : phrase).trim() || DEFAULT_PHRASE;
    this.seed = (Number(seed) >>> 0) || fnv(["mnemoquarium-deep", this.phrase]);

    this.species = this._buildSpecies();

    // Zone lookups happen every spawn tick, so bucket once and cache the
    // nearest-band fallbacks as they are asked for.
    this._byZone = new Map();
    for (const zone of ZONES) this._byZone.set(zone.id, []);
    for (const sp of this.species) {
      const bucket = this._byZone.get(sp.zoneId);
      if (bucket) bucket.push(sp);
    }
    this._zoneCache = new Map();

    // Fallback ticket source for `rollIndividual` when a caller forgets its
    // rng. Deterministic on purpose — a counter, never Math.random().
    this._ticket = 0;
  }

  /* ---------------------------------------------------------- construction */

  _buildSpecies() {
    const engine = makeSpecies(this.phrase, 8);
    const bands = this._assignZones(engine);
    // Flavour is drawn without replacement across the roster; see
    // `_writeDescription`. These live only for the length of the build.
    this._usedOpeners = new Set();
    this._usedClauses = new Set();
    const built = engine.map((sp, index) => this._makeSpec(sp, index, bands[index]));
    this._usedOpeners = null;
    this._usedClauses = null;
    return built;
  }

  /* Spread the words down the water column. The even slot keeps a one-word
     phrase off the shelf floor and an eight-word phrase from bunching, the
     seed nudge keeps it from reading as a neat ladder, and the repair pass
     guarantees every band has somebody living in it whenever there are enough
     species to go round. */
  _assignZones(engine) {
    const n = Math.max(1, engine.length);
    const last = ZONES.length - 1;
    const slots = engine.map((sp, i) => {
      const base = Math.floor((i * ZONES.length) / n);
      const roll = makeRng(this.seed, "band", sp.seed, i).random();
      const drift = roll < 0.22 ? -1 : roll > 0.80 ? 1 : 0;
      return clamp(base + drift, 0, last);
    });

    if (n >= ZONES.length) {
      for (let z = 0; z <= last; z += 1) {
        const counts = new Array(ZONES.length).fill(0);
        for (const s of slots) counts[s] += 1;
        if (counts[z] > 0) continue;

        // Move in the nearest resident of the most crowded band. Ties resolve
        // to the lowest species index, which keeps the repair deterministic.
        let best = -1;
        let bestScore = Infinity;
        for (let i = 0; i < slots.length; i += 1) {
          if (counts[slots[i]] < 2) continue;   // never empty a band to fill one
          const score = Math.abs(slots[i] - z) * 10 - counts[slots[i]];
          if (score < bestScore) {
            bestScore = score;
            best = i;
          }
        }
        if (best >= 0) slots[best] = z;
      }
    }

    return slots;
  }

  /* One engine species, read as a game species. Every number below traces
     back to a trait the 2D lab already decided. */
  _makeSpec(sp, index, zoneIdx) {
    const zone = ZONES[clamp(zoneIdx, 0, ZONES.length - 1)] || ZONES[0];
    const zi = zoneIndex(zone.id);
    const rng = makeRng(this.seed, "spec", sp.seed, index);
    // 0 on the shelf, 1 in the Forgetting. Most of the personality hangs here.
    const deep = ZONES.length > 1 ? zi / (ZONES.length - 1) : 0;

    const kind = fishKindOf(sp);

    // Appetite is mass. Depth adds to it as well: cold water grows long, slow
    // animals, and the trench should feel like it is full of them.
    const size = clamp(
      0.30 + (sp.appetite - 1) * 0.44 + rng.random() * 0.40 + deep * 0.85,
      0.25,
      2.60,
    );

    // Curiosity is throttle; bulk is drag; the cold band is a tax on both.
    const speed = clamp(
      ((1.45 + sp.curiosity * 0.48 + rng.random() * 0.70) * (1 - deep * 0.22)) /
        (0.86 + size * 0.20),
      0.70,
      7.50,
    );

    // Stubbornness in the engine is a fish that keeps its heading. A hundred
    // fish all keeping the same heading is a shoal. Bottom-huggers opt out.
    let schooling = clamp01(
      ((sp.stubbornness - 2) / 5) * 0.72 + 0.16 + (rng.random() - 0.5) * 0.18,
    );
    if (kind === "catfish" || kind === "eel") schooling *= 0.45;

    // Curious and hungry fish hold their ground; incurious, well-fed ones bolt.
    // Deep species have met fewer lamps and are correspondingly less impressed.
    const skittish = clamp01(
      0.72 - sp.curiosity * 0.07 + (3 - sp.appetite) * 0.07 - deep * 0.18 +
        (rng.random() - 0.5) * 0.16,
    );

    // Light is not a gradient in the sea, it is a threshold. Nothing on the
    // shelf bothers; past the twilight almost everything does.
    const glow = clamp01(Math.pow(deep, 1.9) * (0.80 + rng.random() * 0.45));

    const hue = ((sp.hue % 360) + 360) % 360;
    const sat = clamp(52 + sp.curiosity * 3 - deep * 14 + rng.random() * 10, 25, 92);
    const light = clamp(58 - deep * 26 + (1 - size / 2.6) * 6, 14, 72);
    const colorHex = hslHex(hue, sat, light);

    // The belly offset is lifted straight from morph() in tank.js, so a fish
    // you learned to recognise through the glass reads the same through a
    // porthole: same hue, same warmer underside, same distance between them.
    const bellyHue = (hue + 28 + (sp.seed % 18)) % 360;
    const bellyHex = hslHex(
      bellyHue,
      clamp(sat - 14, 18, 80),
      clamp(light + 20, 24, 88),
    );

    const anchor = BIOLUM_HUES[sp.seed % BIOLUM_HUES.length];
    const glowHex = hslHex(
      mixHue(hue, anchor, 0.40 + glow * 0.35),
      clamp(70 + glow * 20, 40, 100),
      clamp(56 + glow * 16, 44, 84),
    );

    const rarity = this._rollRarity(rng, zi);
    const tier = rarityTier(rarity);

    // Base price, before progression.fishValue applies the rarity and band
    // multipliers. Size, solitude and light are what a buyer is actually
    // paying for; the depth lean here stays gentle so the big multipliers in
    // config.RARITY / ZONES do the real work.
    const body = 5 + size * 4.6 + glow * 3.2 + (1 - schooling) * 2.6 + speed * 0.25;
    const baseValue = Math.round(
      clamp(body * (1 + zi * 0.19) * (1 + tier * 0.11), 8, 52),
    );

    const spec = {
      index,
      name: sp.name,
      word: sp.source_word,
      glyph: sp.glyph,
      hue,
      seed: sp.seed >>> 0,
      appetite: sp.appetite,
      curiosity: sp.curiosity,
      stubbornness: sp.stubbornness,
      lifespan: sp.lifespan,
      kind,
      zoneId: zone.id,
      zone,
      size,
      speed,
      schooling,
      skittish,
      glow,
      rarity,
      baseValue,
      colorHex,
      bellyHex,
      glowHex,
      description: "",
    };

    // Written last, from a stream of its own, so retuning the numbers above
    // does not rewrite every line of flavour in the game.
    spec.description = this._writeDescription(spec);
    return spec;
  }

  _rollRarity(rng, zoneIdx) {
    const pressure = zoneRow(RARITY_PRESSURE, zoneIdx);
    const pairs = [];
    for (let t = 0; t < RARITY_TIERS.length; t += 1) {
      const id = RARITY_TIERS[t];
      const base = RARITY[id] ? RARITY[id].weight : 1;
      const weight = base * (pressure[t] == null ? 0 : pressure[t]);
      if (weight > 0) pairs.push([id, weight]);
    }
    if (!pairs.length) return "common";
    return weightedPick(rng, pairs) || "common";
  }

  _writeDescription(spec) {
    const rng = makeRng(this.seed, "line", spec.seed, spec.index);
    const opener = WORD_OPENERS[rng.randrange(WORD_OPENERS.length)](spec.word);

    const pool = [];
    for (const clause of TRAIT_CLAUSES) {
      if (clause.when(spec)) pool.push([clause.text, clause.weight]);
    }
    const zoneLines = ZONE_CLAUSES[spec.zoneId] || ZONE_CLAUSES.shelf;
    pool.push([zoneLines[rng.randrange(zoneLines.length)], 2.4]);
    const kindLine = KIND_CLAUSES[spec.kind];
    if (kindLine) pool.push([kindLine, 1.6]);

    const tail = weightedPick(rng, pool) || zoneLines[0];
    return `${opener} ${tail}`;
  }

  _founderGenome(sp) {
    // Every fish of a species descends from one founder, so the eight
    // expressed bits of a shoal start out identical and drift from there.
    return fnv([this.seed, "founder", sp.seed]) >>> 0;
  }

  /* Middle of the species' home band — the depth the market assumes when it
     prices a fish nobody has caught yet. Clamped to the sea's real floor so
     the abyss band (which overhangs maxDepth) does not quote thin air. */
  _homeDepth(sp) {
    const zone = (sp && sp.zone) || ZONES[0];
    const bottom = Math.min(zone.bottom, SEA.maxDepth);
    return (zone.top + bottom) * 0.5;
  }

  /* ------------------------------------------------------------------ API */

  /* Everyone living in a band. Never empty: a four-word phrase leaves gaps in
     the column, and a diver in an empty band should still meet something, so
     the nearest populated band lends its residents. */
  speciesInZone(zoneId) {
    const id = typeof zoneId === "string" ? zoneId : (zoneId && zoneId.id) || "";
    const cached = this._zoneCache.get(id);
    if (cached) return cached;

    const direct = this._byZone.get(id);
    if (direct && direct.length) {
      this._zoneCache.set(id, direct);
      return direct;
    }

    const home = zoneIndex(id);
    let best = null;
    let bestDistance = Infinity;
    for (let i = 0; i < ZONES.length; i += 1) {
      const list = this._byZone.get(ZONES[i].id);
      if (!list || !list.length) continue;
      // Ties break downward: if a band is equidistant from a lit one and a
      // dark one, the dark one wins. The sea is not generous.
      const distance = Math.abs(i - home) * 2 - (i > home ? 1 : 0);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = list;
      }
    }

    const result = best || this.species;
    this._zoneCache.set(id, result);
    return result;
  }

  /* One fish, grown the way the engine grows them: a founder genome carried
     down a short lineage, inheriting its expressed bits at every step and
     occasionally flipping one. Deeper bands run longer, stranger lines. */
  rollIndividual(species, rng) {
    const sp = species || this.species[0];
    if (!sp) {
      return { genome: 0, generation: 1, mutations: 0, traits: genomeTraits(0), value: 1, rarity: "common", scale: 1 };
    }

    // Draw one ticket off the caller's stream so two fish rolled in the same
    // frame differ, then run everything else from a seeded stream: the fish is
    // a pure function of (species, ticket).
    let ticket;
    if (rng && typeof rng.next === "function") {
      ticket = rng.next() >>> 0;
    } else {
      this._ticket = (this._ticket + 1) >>> 0;
      ticket = this._ticket;
    }

    const ir = makeRng(this.seed, "individual", sp.seed, ticket);
    const zi = zoneIndex(sp.zoneId);
    const deep = ZONES.length > 1 ? zi / (ZONES.length - 1) : 0;

    // Shallow water is churned and young. The trench keeps its families.
    const maxGen = 1 + Math.round(lerp(3, 11, deep));
    const generation = 1 + Math.floor(Math.pow(ir.random(), 1.6) * maxGen);
    const mutationChance = lerp(0.06, 0.20, deep);

    let genome = this._founderGenome(sp);
    let mutations = 0;
    for (let gen = 1; gen <= generation; gen += 1) {
      // A fresh identity each step: pointMutation reads the high bits to pick
      // which expressed bit to flip, so without new identity bits a lineage
      // would just toggle the same bit back and forth forever.
      const identity = fnv([this.seed, "org", sp.seed, ticket, gen]);
      genome = inheritGenome(identity, genome);
      if (ir.random() < mutationChance) {
        genome = pointMutation(genome);
        mutations += 1;
      }
    }

    const traits = genomeTraits(genome);

    // Length varies the way it does in any shoal, plus whatever appetite the
    // expressed region is carrying, plus a little swagger for mutants.
    const scale = clamp(
      0.80 + ir.random() * 0.40 + traits.appetite * 0.08 + Math.min(3, mutations) * 0.035,
      0.60,
      1.55,
    );

    // A long mutant line is worth more than the species average: the market
    // pays for a specimen it has not seen before.
    let rarity = sp.rarity;
    const ceiling = Math.max(
      rarityTier(sp.rarity),
      zoneRow(ZONE_RARITY_CEILING, zi),
    );
    const promote = clamp01(0.03 + mutations * 0.06 + (generation - 1) * 0.012);
    if (ir.random() < promote) {
      const next = Math.min(rarityTier(sp.rarity) + 1, ceiling, RARITY_TIERS.length - 1);
      rarity = RARITY_TIERS[next];
    }

    const individual = { genome, generation, mutations, traits, value: 0, rarity, scale };
    individual.value = this.valueOf(sp, individual, this._homeDepth(sp));
    return individual;
  }

  /* The price of one fish at one depth. progression.js owns the formula —
     rarity multipliers, band multipliers, the per-kilometre bonus — and this
     is only the doorway, so the two can never drift apart. */
  valueOf(species, individual, depth) {
    const sp = species || (individual && individual.species) || this.species[0];
    if (!sp) return 1;
    const d = Math.max(0, Number(depth) || 0);
    const raw = fishValue(sp, individual, d);
    return Number.isFinite(raw) ? Math.max(1, Math.round(raw)) : 1;
  }

  /* One line for the manifest, the roster, and the reticle label. */
  describe(species) {
    const sp = species;
    if (!sp) return "no record of that one.";
    const metres = sp.size < 1 ? sp.size.toFixed(2) : sp.size.toFixed(1);
    const lit = sp.glow >= 0.45 ? ", lit from inside" : "";
    return `${sp.name} — ${sp.rarity} ${sp.kind}, ${metres} m${lit}, ${sp.zone.name}. ${sp.description}`;
  }

  /* What the start screen prints before you have seen any of them. Sorted by
     depth so the list reads as a dive plan: this is what is waiting, in the
     order the sea will hand it to you. */
  roster() {
    return this.species
      .map((sp) => ({
        index: sp.index,
        name: sp.name,
        word: sp.word,
        glyph: sp.glyph,
        zoneId: sp.zoneId,
        rarity: sp.rarity,
        baseValue: sp.baseValue,
        colorHex: sp.colorHex,
      }))
      .sort((a, b) => {
        const za = zoneIndex(a.zoneId);
        const zb = zoneIndex(b.zoneId);
        return za === zb ? a.index - b.index : za - zb;
      });
  }

  /* No scene objects, no GPU resources — only the caches. The species list
     survives teardown on purpose: the HUD may still be painting a last
     manifest while the rest of the game is being taken apart. */
  dispose() {
    this._zoneCache.clear();
    this._byZone.clear();
  }
}
