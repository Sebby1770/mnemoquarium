const DEFAULT_PHRASE = "forgotten kiosk under neon rain";
const GLYPHS = "@%&*+=?ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PREFIXES = ["glass","hush","paper","static","velvet","clock","mirror","salt","moth","needle"];
const SUFFIXES = ["drifter","grazer","listener","splicer","lantern","murmur","collector","echo","sleeper","oracle"];
const DIRECTIONS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

function fnv(parts) {
  let h = 2166136261;
  const payload = parts.map(String).join("|");
  for (let i = 0; i < payload.length; i += 1) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Rng {
  constructor(seed) {
    this.state = (Number(seed) >>> 0) || 1;
  }
  next() {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }
  random() { return this.next() / 4294967296; }
  randrange(n) { return this.next() % n; }
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = this.randrange(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  choice(list) { return list[this.randrange(list.length)]; }
}

function wordsFromPhrase(phrase) {
  const seen = new Set();
  const words = [];
  const matches = String(phrase || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  for (const raw of matches) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word && !seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words.length ? words : ["silence"];
}

function chooseGlyph(word, index, used) {
  const candidates = [];
  if (word && /[a-z0-9]/i.test(word[0])) candidates.push(word[0].toUpperCase());
  for (let offset = 0; offset < GLYPHS.length; offset += 1) {
    candidates.push(GLYPHS[(index + offset) % GLYPHS.length]);
  }
  for (const glyph of candidates) {
    if (!used.has(glyph)) {
      used.add(glyph);
      return glyph;
    }
  }
  const fallback = `${GLYPHS[index % GLYPHS.length]}${index + 1}`;
  used.add(fallback);
  return fallback;
}

function makeSpecies(phrase, maxSpecies = 8) {
  const words = wordsFromPhrase(phrase).slice(0, maxSpecies);
  const used = new Set();
  return words.map((word, index) => {
    const seed = fnv(["species", phrase, word, index]);
    const prefix = PREFIXES[seed % PREFIXES.length];
    const suffix = SUFFIXES[(seed >>> 8) % SUFFIXES.length];
    const root = word.replace(/[^a-z0-9]/g, "").slice(0, 10) || "word";
    return {
      name: `${prefix}-${root}-${suffix}`,
      source_word: word,
      glyph: chooseGlyph(word, index, used),
      hue: seed % 360,
      appetite: 1 + ((seed >>> 9) % 3),
      curiosity: 1 + ((seed >>> 13) % 7),
      stubbornness: 2 + ((seed >>> 17) % 6),
      split_threshold: 24 + ((seed >>> 21) % 22),
      metabolism: 1 + ((seed >>> 25) % 3),
      lifespan: 35 + ((seed >>> 29) % 70),
      seed,
    };
  });
}

// Heredity. The eight low bits of a genome are the expressed region: a child
// inherits them from its parent, and a point mutation flips exactly one, so a
// mutant's descendants carry a visibly different appetite, curiosity, thrift,
// or hue until the lineage mutates again. Mirrors src/mnemoquarium/model.py.
const EXPRESSED_MASK = 0xff;
const THRIFT_BREEDING_DELAY = 6;

function genomeTraits(genome) {
  const g = Number(genome) >>> 0;
  return {
    appetite: ((g & 3) % 3) - 1,
    curiosity: (((g >>> 2) & 3) % 3) - 1,
    thrift: ((g >>> 4) & 1) === 1,
    hue_shift: ((g >>> 5) & 7) * 6 - 21,
  };
}

function traitsLabel(traits) {
  const parts = [];
  if (traits.appetite) parts.push(`appetite ${traits.appetite > 0 ? "+" : ""}${traits.appetite}`);
  if (traits.curiosity) parts.push(`curiosity ${traits.curiosity > 0 ? "+" : ""}${traits.curiosity}`);
  if (traits.thrift) parts.push("thrifty");
  if (traits.hue_shift) parts.push(`hue ${traits.hue_shift > 0 ? "+" : ""}${traits.hue_shift}`);
  return parts.join(", ") || "baseline";
}

function inheritGenome(identity, parentGenome) {
  return (((Number(identity) >>> 0) & ~EXPRESSED_MASK) | ((Number(parentGenome) >>> 0) & EXPRESSED_MASK)) >>> 0;
}

function pointMutation(genome) {
  const g = Number(genome) >>> 0;
  return (g ^ (1 << ((g >>> 20) % 8))) >>> 0;
}

function initialNutrient(seed, x, y, rng) {
  const vein = fnv([seed, "vein", Math.floor(x / 3), Math.floor(y / 2)]) % 10;
  const dust = rng.randrange(4);
  return Math.min(9, Math.max(0, Math.floor(vein / 2) + dust - 1));
}

class World {
  static fromPhrase(phrase, opts = {}) {
    const width = opts.width || 48;
    const height = opts.height || 22;
    if (width < 12 || height < 8) throw new Error("habitat too small");
    const clean = (phrase || "").trim() || DEFAULT_PHRASE;
    const seed = opts.seed != null && opts.seed !== "" ? Number(opts.seed) : fnv(["mnemoquarium", clean]);
    const maxSpecies = opts.maxSpecies || 8;
    const population = opts.population || 28;
    const rng = new Rng(seed);
    const species = makeSpecies(clean, maxSpecies);
    const nutrients = [];
    for (let y = 0; y < height; y += 1) {
      const row = [];
      for (let x = 0; x < width; x += 1) row.push(initialNutrient(seed, x, y, rng));
      nutrients.push(row);
    }
    const organisms = [];
    const spawn = Math.max(population, species.length);
    for (let i = 0; i < spawn; i += 1) {
      const speciesIndex = i % species.length;
      const sp = species[speciesIndex];
      organisms.push({
        species_index: speciesIndex,
        x: rng.randrange(width),
        y: rng.randrange(height),
        energy: 12 + rng.randrange(Math.max(1, Math.floor(sp.split_threshold / 2))),
        age: rng.randrange(5),
        genome: fnv([seed, "genome", i, sp.source_word]),
        generation: 0,
        parent: 0,
        born: 0,
        lineage_mutations: 0,
      });
    }
    return new World({ width, height, phrase: clean, seed, species, nutrients, organisms });
  }

  constructor(state) {
    Object.assign(this, {
      tick_count: 0,
      events: [],
      extinctions: [],
      mutations: 0,
      predations: 0,
    }, state);
  }

  season() {
    return ["spring", "summer", "autumn", "winter"][Math.floor(Math.max(0, this.tick_count - 1) / 13) % 4];
  }

  populationBySpecies() {
    const counts = this.species.map(() => 0);
    for (const org of this.organisms) counts[org.species_index] += 1;
    return counts;
  }

  census() {
    const pops = this.populationBySpecies();
    const genealogy = this.genealogy();
    return {
      tick: this.tick_count,
      season: this.season(),
      population: this.organisms.length,
      mutations: this.mutations,
      predations: this.predations,
      extinctions: [...this.extinctions],
      nutrient_total: this.nutrients.flat().reduce((a, b) => a + b, 0),
      max_generation: genealogy.max_generation,
      mean_generation: genealogy.mean_generation,
      mutant_population: genealogy.mutant_population,
      species: this.species.map((sp, i) => ({
        name: sp.name,
        glyph: sp.glyph,
        hue: sp.hue,
        population: pops[i],
        appetite: sp.appetite,
        curiosity: sp.curiosity,
        stubbornness: sp.stubbornness,
        seed: sp.seed,
        source_word: sp.source_word,
        max_generation: genealogy.species[i].max_generation,
        mutants: genealogy.species[i].mutants,
        trait_variants: genealogy.species[i].trait_variants,
      })),
    };
  }

  genealogy() {
    const perSpecies = this.species.map((sp, index) => {
      const members = this.organisms.filter((org) => org.species_index === index);
      const generations = members.map((org) => org.generation || 0);
      const maxGen = generations.length ? Math.max(...generations) : 0;
      const meanGen = generations.length
        ? Math.round((generations.reduce((a, b) => a + b, 0) / generations.length) * 100) / 100
        : 0;
      return {
        name: sp.name,
        population: members.length,
        max_generation: maxGen,
        mean_generation: meanGen,
        founders_alive: members.filter((org) => !org.generation).length,
        mutants: members.filter((org) => (org.lineage_mutations || 0) > 0).length,
        trait_variants: new Set(members.map((org) => (org.genome >>> 0) & EXPRESSED_MASK)).size,
      };
    });
    const generations = this.organisms.map((org) => org.generation || 0);
    return {
      tick: this.tick_count,
      population: this.organisms.length,
      max_generation: generations.length ? Math.max(...generations) : 0,
      mean_generation: generations.length
        ? Math.round((generations.reduce((a, b) => a + b, 0) / generations.length) * 100) / 100
        : 0,
      mutant_population: this.organisms.filter((org) => (org.lineage_mutations || 0) > 0).length,
      species: perSpecies,
    };
  }

  lineageOf(genome) {
    const byGenome = new Map(this.organisms.map((org) => [org.genome, org]));
    const chain = [];
    const seen = new Set();
    let current = byGenome.get(Number(genome));
    while (current && !seen.has(current.genome)) {
      chain.push(current);
      seen.add(current.genome);
      current = current.parent ? byGenome.get(current.parent) : null;
    }
    return chain;
  }

  occupancy() {
    const map = new Map();
    for (const org of this.organisms) {
      const key = `${org.x},${org.y}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }

  compost(x, y, amount) {
    const dirs = [[0, 0], [-1, -1], [0, -1], [1, -1], [-1, 0]];
    for (const [dx, dy] of dirs) {
      const tx = (x + dx + this.width) % this.width;
      const ty = (y + dy + this.height) % this.height;
      this.nutrients[ty][tx] = Math.min(9, this.nutrients[ty][tx] + amount);
    }
  }

  step() {
    this.tick_count += 1;
    this.events = [];
    this.weather();
    const rng = new Rng(fnv([this.seed, "tick", this.tick_count]));
    const before = this.populationBySpecies();
    const order = rng.shuffle(this.organisms.slice());
    const survivors = [];
    const newborns = [];
    const occupancy = this.occupancy();

    for (const organism of order) {
      const sp = this.species[organism.species_index];
      const here = `${organism.x},${organism.y}`;
      occupancy.set(here, Math.max(0, (occupancy.get(here) || 1) - 1));

      const [dx, dy] = this.chooseDirection(organism, sp, occupancy);
      organism.x = (organism.x + dx + this.width) % this.width;
      organism.y = (organism.y + dy + this.height) % this.height;
      organism.age += 1;

      const traits = genomeTraits(organism.genome);
      const crowd = occupancy.get(`${organism.x},${organism.y}`) || 0;
      const crowdTax = traits.thrift ? 0 : (crowd > 2 ? 1 : 0);
      organism.energy -= sp.metabolism + crowdTax + Math.max(0, traits.appetite);
      const appetite = Math.max(1, sp.appetite + traits.appetite);
      const meal = Math.min(this.nutrients[organism.y][organism.x], appetite);
      this.nutrients[organism.y][organism.x] -= meal;
      organism.energy += meal * 3;

      if (organism.energy <= 0 || organism.age > sp.lifespan) {
        this.compost(organism.x, organism.y, 2 + sp.metabolism);
        if (this.events.length < 4) this.events.push(`${sp.name} left a bright fossil`);
        continue;
      }

      const prey = this.maybePrey(organism, sp, occupancy, rng);
      if (prey) {
        organism.energy += Math.max(2, Math.floor(prey.energy / 3));
        prey.energy = 0;
        this.predations += 1;
        if (this.events.length < 4) this.events.push(`${sp.name} absorbed a quieter neighbour`);
      }

      const splitThreshold = sp.split_threshold + (traits.thrift ? THRIFT_BREEDING_DELAY : 0);
      if (organism.energy >= splitThreshold && rng.random() < 0.42) {
        const childEnergy = Math.max(6, Math.floor(organism.energy / 2));
        organism.energy -= childEnergy;
        const [cdx, cdy] = rng.choice(DIRECTIONS);
        let childIndex = organism.species_index;
        let childGenome = inheritGenome(
          fnv([this.seed, "child", this.tick_count, organism.genome, newborns.length]),
          organism.genome,
        );
        const mutated = rng.random() < 0.12;
        if (mutated) {
          childGenome = pointMutation(childGenome);
          this.mutations += 1;
          if (rng.random() < 0.25 && this.species.length > 1) {
            childIndex = (childIndex + 1) % this.species.length;
          }
          if (this.events.length < 4) this.events.push(`${sp.name} flickered into a new genome`);
        }
        newborns.push({
          species_index: childIndex,
          x: (organism.x + cdx + this.width) % this.width,
          y: (organism.y + cdy + this.height) % this.height,
          energy: childEnergy,
          age: 0,
          genome: childGenome,
          generation: (organism.generation || 0) + 1,
          parent: organism.genome,
          born: this.tick_count,
          lineage_mutations: (organism.lineage_mutations || 0) + (mutated ? 1 : 0),
        });
        if (this.events.length < 4) this.events.push(`${sp.name} split in the memory brine`);
      }

      survivors.push(organism);
      const key = `${organism.x},${organism.y}`;
      occupancy.set(key, (occupancy.get(key) || 0) + 1);
    }

    this.organisms = survivors.concat(newborns);
    this.noteExtinctions(before);
    this.trimPopulation();
    if (!this.organisms.length) this.rescue();
  }

  chooseDirection(organism, sp, occupancy) {
    let best = -Infinity;
    let pick = [0, 0];
    const traits = genomeTraits(organism.genome);
    const appetite = Math.max(1, sp.appetite + traits.appetite);
    const curiosity = Math.max(0, sp.curiosity + traits.curiosity);
    for (const [dx, dy] of [[0, 0], ...DIRECTIONS]) {
      const tx = (organism.x + dx + this.width) % this.width;
      const ty = (organism.y + dy + this.height) % this.height;
      const nutrient = this.nutrients[ty][tx];
      const crowd = occupancy.get(`${tx},${ty}`) || 0;
      const pulse = fnv([this.seed, this.tick_count, organism.genome, dx, dy]);
      const jitter = (pulse % 100) / 100;
      const stubborn = ((tx * 3 + ty * 5 + sp.seed) % sp.stubbornness === 0) ? 1 : 0;
      const score = nutrient * appetite + jitter * curiosity + stubborn - crowd * 2.75;
      if (score > best) {
        best = score;
        pick = [dx, dy];
      }
    }
    return pick;
  }

  weather() {
    if (this.tick_count % 11 === 0) this.staticBloom();
    if (this.tick_count % 17 === 0) this.rememberingTide();
    if (this.tick_count % 29 === 0) this.forgettingFog();
    if (this.tick_count % 41 === 0) this.drought();
    const season = this.season();
    if (season === "spring" && this.tick_count % 7 === 0) this.staticBloom();
    if (season === "winter" && this.tick_count % 19 === 0) this.drought();
  }

  staticBloom() {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (fnv([this.seed, "static", this.tick_count, x, y]) % 37 === 0) {
          this.nutrients[y][x] = Math.min(9, this.nutrients[y][x] + 3);
        }
      }
    }
    this.events.push("static bloom fed the quiet corners");
  }

  rememberingTide() {
    const shift = Math.floor(this.tick_count / 17) % this.width;
    this.nutrients = this.nutrients.map((row, y) => {
      if (y % 2 !== 0) return row;
      return row.slice(-shift).concat(row.slice(0, -shift || row.length));
    });
    this.events.push("remembering tide dragged the nutrients sideways");
  }

  forgettingFog() {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if ((x + y + this.tick_count) % 3 === 0) {
          this.nutrients[y][x] = Math.max(0, this.nutrients[y][x] - 1);
        }
      }
    }
    for (const org of this.organisms) org.energy = Math.max(1, org.energy - 1);
    this.events.push("forgetting fog dimmed the habitat");
  }

  drought() {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        this.nutrients[y][x] = Math.max(0, this.nutrients[y][x] - 2);
      }
    }
    this.events.push("drought cracked the brine");
  }

  maybePrey(organism, sp, occupancy, rng) {
    if ((occupancy.get(`${organism.x},${organism.y}`) || 0) < 1) return null;
    const appetite = Math.max(1, sp.appetite + genomeTraits(organism.genome).appetite);
    if (appetite + sp.stubbornness < 9) return null;
    if (rng.random() > 0.35) return null;
    for (const other of this.organisms) {
      if (other === organism || other.energy <= 0) continue;
      if (other.x !== organism.x || other.y !== organism.y) continue;
      const otherSp = this.species[other.species_index];
      const otherAppetite = Math.max(1, otherSp.appetite + genomeTraits(other.genome).appetite);
      if (otherAppetite >= appetite || other.energy >= organism.energy) continue;
      return other;
    }
    return null;
  }

  noteExtinctions(before) {
    const after = this.populationBySpecies();
    before.forEach((count, index) => {
      if (count > 0 && after[index] === 0) {
        const name = this.species[index].name;
        if (!this.extinctions.includes(name)) {
          this.extinctions.push(name);
          if (this.events.length < 6) this.events.push(`${name} went extinct`);
        }
      }
    });
  }

  trimPopulation() {
    const max = this.width * this.height;
    if (this.organisms.length <= max) return;
    this.organisms.sort((a, b) => b.energy - a.energy);
    for (const org of this.organisms.slice(max)) this.compost(org.x, org.y, 1);
    this.organisms = this.organisms.slice(0, max);
    this.events.push("the glass walls refused further multiplication");
  }

  rescue() {
    const rng = new Rng(fnv([this.seed, "rescue", this.tick_count]));
    this.species.forEach((sp, index) => {
      this.organisms.push({
        species_index: index,
        x: rng.randrange(this.width),
        y: rng.randrange(this.height),
        energy: Math.max(10, Math.floor(sp.split_threshold / 2)),
        age: 0,
        genome: fnv([this.seed, "rescue-genome", this.tick_count, index]),
        generation: 0,
        parent: 0,
        born: this.tick_count,
        lineage_mutations: 0,
      });
    });
    this.events.push("the archive reseeded itself from a cold backup");
  }
}

function compareWorlds(a, b) {
  const ca = a.census();
  const cb = b.census();
  return [
    `A "${a.phrase}"  pop ${ca.population}  season ${ca.season}  mut ${ca.mutations}  gen ${ca.max_generation}`,
    `B "${b.phrase}"  pop ${cb.population}  season ${cb.season}  mut ${cb.mutations}  gen ${cb.max_generation}`,
    `Δ population ${cb.population - ca.population}`,
    `Δ deepest generation ${cb.max_generation - ca.max_generation}`,
    `A extinctions: ${ca.extinctions.join(", ") || "none"}`,
    `B extinctions: ${cb.extinctions.join(", ") || "none"}`,
  ].join("\n");
}

// The deep-sea game loads this file as a classic script and reads the bundle
// off globalThis, so its ES modules share one source of truth for the genetics.
if (typeof globalThis !== "undefined") {
  globalThis.MnemoEngine = {
    DEFAULT_PHRASE,
    EXPRESSED_MASK,
    Rng,
    World,
    compareWorlds,
    fnv,
    genomeTraits,
    inheritGenome,
    makeSpecies,
    pointMutation,
    traitsLabel,
    wordsFromPhrase,
  };
}

// Node (tests) sees CommonJS; the browser reads the globals directly.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_PHRASE,
    EXPRESSED_MASK,
    Rng,
    World,
    compareWorlds,
    fnv,
    genomeTraits,
    inheritGenome,
    makeSpecies,
    pointMutation,
    traitsLabel,
    wordsFromPhrase,
  };
}
