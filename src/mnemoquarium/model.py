from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import random
import re
from typing import Iterable


DEFAULT_PHRASE = "forgotten kiosk under neon rain"
GLYPHS = "@%&*+=?ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
PREFIXES = [
    "glass",
    "hush",
    "paper",
    "static",
    "velvet",
    "clock",
    "mirror",
    "salt",
    "moth",
    "needle",
]
SUFFIXES = [
    "drifter",
    "grazer",
    "listener",
    "splicer",
    "lantern",
    "murmur",
    "collector",
    "echo",
    "sleeper",
    "oracle",
]
DIRECTIONS = [
    (-1, -1),
    (0, -1),
    (1, -1),
    (-1, 0),
    (1, 0),
    (-1, 1),
    (0, 1),
    (1, 1),
]
TOKEN_RE = re.compile(r"[A-Za-z0-9']+")


def stable_int(*parts: object, digest_size: int = 8) -> int:
    payload = "|".join(str(part) for part in parts).encode("utf-8")
    digest = hashlib.blake2b(payload, digest_size=digest_size).digest()
    return int.from_bytes(digest, "big")


def words_from_phrase(phrase: str) -> list[str]:
    seen: set[str] = set()
    words: list[str] = []
    for match in TOKEN_RE.finditer(phrase.lower()):
        word = match.group(0).strip("'")
        if word and word not in seen:
            seen.add(word)
            words.append(word)
    return words or ["silence"]


@dataclass(frozen=True)
class Species:
    name: str
    source_word: str
    glyph: str
    hue: int
    ansi_color: int
    appetite: int
    curiosity: int
    stubbornness: int
    split_threshold: int
    metabolism: int
    lifespan: int
    seed: int

    def as_dict(self, population: int = 0) -> dict[str, object]:
        return {
            "name": self.name,
            "source_word": self.source_word,
            "glyph": self.glyph,
            "hue": self.hue,
            "ansi_color": self.ansi_color,
            "seed": self.seed,
            "appetite": self.appetite,
            "curiosity": self.curiosity,
            "stubbornness": self.stubbornness,
            "split_threshold": self.split_threshold,
            "metabolism": self.metabolism,
            "lifespan": self.lifespan,
            "population": population,
        }


@dataclass(frozen=True)
class Traits:
    """What a genome adds on top of its species' baseline.

    The eight low bits of a genome are the expressed region. A point mutation
    flips exactly one of them, so a mutant's descendants inherit a visibly
    different appetite, curiosity, thrift, or hue until the lineage mutates again.

    Every advantage costs something, so selection has tension instead of a
    single winning genome: a bigger appetite burns an extra point of energy per
    tick, and thrift (immunity to crowding) delays breeding.
    """

    appetite: int
    curiosity: int
    thrift: bool
    hue_shift: int

    def as_dict(self) -> dict[str, object]:
        return {
            "appetite": self.appetite,
            "curiosity": self.curiosity,
            "thrift": self.thrift,
            "hue_shift": self.hue_shift,
        }

    def label(self) -> str:
        parts: list[str] = []
        if self.appetite:
            parts.append(f"appetite {self.appetite:+d}")
        if self.curiosity:
            parts.append(f"curiosity {self.curiosity:+d}")
        if self.thrift:
            parts.append("thrifty")
        if self.hue_shift:
            parts.append(f"hue {self.hue_shift:+d}")
        return ", ".join(parts) or "baseline"


def genome_traits(genome: int) -> Traits:
    g = int(genome)
    return Traits(
        appetite=((g & 3) % 3) - 1,
        curiosity=(((g >> 2) & 3) % 3) - 1,
        thrift=bool((g >> 4) & 1),
        hue_shift=((g >> 5) & 7) * 6 - 21,
    )


EXPRESSED_MASK = 0xFF
THRIFT_BREEDING_DELAY = 6


def inherit_genome(identity: int, parent_genome: int) -> int:
    """A child keeps its parent's expressed bits and gets a fresh identity above them."""
    return (int(identity) & ~EXPRESSED_MASK) | (int(parent_genome) & EXPRESSED_MASK)


def point_mutation(genome: int) -> int:
    """Flip one expressed bit, chosen by the genome's own upper bits."""
    g = int(genome)
    return g ^ (1 << ((g >> 20) % 8))


@dataclass
class Organism:
    species_index: int
    x: int
    y: int
    energy: int
    age: int
    genome: int
    generation: int = 0
    parent: int = 0
    born: int = 0
    lineage_mutations: int = 0

    @property
    def traits(self) -> Traits:
        return genome_traits(self.genome)

    def as_tuple(self) -> tuple[int, int, int, int, int, int, int, int, int, int]:
        return (
            self.species_index,
            self.x,
            self.y,
            self.energy,
            self.age,
            self.genome,
            self.generation,
            self.parent,
            self.born,
            self.lineage_mutations,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "species_index": self.species_index,
            "x": self.x,
            "y": self.y,
            "energy": self.energy,
            "age": self.age,
            "genome": self.genome,
            "generation": self.generation,
            "parent": self.parent,
            "born": self.born,
            "lineage_mutations": self.lineage_mutations,
            "traits": self.traits.as_dict(),
        }


@dataclass
class World:
    width: int
    height: int
    phrase: str
    seed: int
    species: list[Species]
    nutrients: list[list[int]]
    organisms: list[Organism]
    tick_count: int = 0
    events: list[str] = field(default_factory=list)
    extinctions: list[str] = field(default_factory=list)
    mutations: int = 0
    predations: int = 0

    @classmethod
    def from_phrase(
        cls,
        phrase: str = DEFAULT_PHRASE,
        *,
        width: int = 64,
        height: int = 24,
        population: int = 32,
        max_species: int = 8,
        seed: int | None = None,
    ) -> "World":
        if width < 12 or height < 8:
            raise ValueError("mnemoquarium needs at least a 12x8 habitat")
        phrase = phrase.strip() or DEFAULT_PHRASE
        seed = int(seed) if seed is not None else stable_int("mnemoquarium", phrase)
        rng = random.Random(seed)
        species = make_species(phrase, max_species=max_species)
        nutrients = [
            [initial_nutrient(seed, x, y, rng) for x in range(width)]
            for y in range(height)
        ]
        organisms: list[Organism] = []
        spawn_count = max(population, len(species))
        for index in range(spawn_count):
            species_index = index % len(species)
            sp = species[species_index]
            organisms.append(
                Organism(
                    species_index=species_index,
                    x=rng.randrange(width),
                    y=rng.randrange(height),
                    energy=12 + rng.randrange(sp.split_threshold // 2),
                    age=rng.randrange(5),
                    genome=stable_int(seed, "genome", index, sp.source_word),
                )
            )
        return cls(
            width=width,
            height=height,
            phrase=phrase,
            seed=seed,
            species=species,
            nutrients=nutrients,
            organisms=organisms,
        )

    def run(self, steps: int) -> "World":
        for _ in range(max(0, steps)):
            self.step()
        return self

    def step(self) -> None:
        self.tick_count += 1
        self.events = []
        self._weather()

        rng = random.Random(stable_int(self.seed, "tick", self.tick_count))
        before = self.population_by_species()
        order = list(self.organisms)
        rng.shuffle(order)

        survivors: list[Organism] = []
        newborns: list[Organism] = []
        occupancy = self._occupancy()

        for organism in order:
            sp = self.species[organism.species_index]
            occupancy[(organism.x, organism.y)] = max(
                0, occupancy.get((organism.x, organism.y), 1) - 1
            )

            dx, dy = self._choose_direction(organism, sp, occupancy)
            organism.x = (organism.x + dx) % self.width
            organism.y = (organism.y + dy) % self.height
            organism.age += 1

            traits = organism.traits
            crowd = occupancy.get((organism.x, organism.y), 0)
            crowd_tax = 0 if traits.thrift else (1 if crowd > 2 else 0)
            tax = sp.metabolism + crowd_tax + max(0, traits.appetite)
            organism.energy -= tax

            appetite = max(1, sp.appetite + traits.appetite)
            meal = min(self.nutrients[organism.y][organism.x], appetite)
            self.nutrients[organism.y][organism.x] -= meal
            organism.energy += meal * 3

            if organism.energy <= 0 or organism.age > sp.lifespan:
                self._compost(organism.x, organism.y, amount=2 + sp.metabolism)
                if len(self.events) < 4:
                    self.events.append(f"{sp.name} left a bright fossil")
                continue

            prey = self._maybe_prey(organism, sp, occupancy, rng)
            if prey is not None:
                organism.energy += max(2, prey.energy // 3)
                prey.energy = 0
                self.predations += 1
                if len(self.events) < 4:
                    self.events.append(f"{sp.name} absorbed a quieter neighbour")

            split_threshold = sp.split_threshold + (THRIFT_BREEDING_DELAY if traits.thrift else 0)
            if organism.energy >= split_threshold and rng.random() < 0.42:
                child_energy = max(6, organism.energy // 2)
                organism.energy -= child_energy
                child_dx, child_dy = rng.choice(DIRECTIONS)
                child_index = organism.species_index
                child_genome = inherit_genome(
                    stable_int(
                        self.seed,
                        "child",
                        self.tick_count,
                        organism.genome,
                        len(newborns),
                    ),
                    organism.genome,
                )
                mutated = rng.random() < 0.12
                if mutated:
                    child_genome = point_mutation(child_genome)
                    self.mutations += 1
                    if rng.random() < 0.25 and len(self.species) > 1:
                        child_index = (child_index + 1) % len(self.species)
                    if len(self.events) < 4:
                        self.events.append(f"{sp.name} flickered into a new genome")
                child = Organism(
                    species_index=child_index,
                    x=(organism.x + child_dx) % self.width,
                    y=(organism.y + child_dy) % self.height,
                    energy=child_energy,
                    age=0,
                    genome=child_genome,
                    generation=organism.generation + 1,
                    parent=organism.genome,
                    born=self.tick_count,
                    lineage_mutations=organism.lineage_mutations + (1 if mutated else 0),
                )
                newborns.append(child)
                if len(self.events) < 4:
                    self.events.append(f"{sp.name} split in the memory brine")

            survivors.append(organism)
            occupancy[(organism.x, organism.y)] = (
                occupancy.get((organism.x, organism.y), 0) + 1
            )

        self.organisms = survivors + newborns
        self._note_extinctions(before)
        self._trim_population()
        if not self.organisms:
            self._seed_rescue_population()

    def population_by_species(self) -> dict[int, int]:
        counts = {index: 0 for index in range(len(self.species))}
        for organism in self.organisms:
            counts[organism.species_index] = counts.get(organism.species_index, 0) + 1
        return counts

    def fossil_hash(self) -> str:
        state = {
            "phrase": self.phrase,
            "tick": self.tick_count,
            "organisms": sorted(organism.as_tuple() for organism in self.organisms),
            "nutrients": self.nutrients,
        }
        payload = json.dumps(state, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
        return hashlib.blake2b(payload, digest_size=6).hexdigest()

    def snapshot(self) -> dict[str, object]:
        populations = self.population_by_species()
        return {
            "phrase": self.phrase,
            "seed": self.seed,
            "width": self.width,
            "height": self.height,
            "tick": self.tick_count,
            "fossil_hash": self.fossil_hash(),
            "population": len(self.organisms),
            "nutrient_total": sum(sum(row) for row in self.nutrients),
            "mutations": self.mutations,
            "predations": self.predations,
            "extinctions": list(self.extinctions),
            "events": list(self.events),
            "species": [
                sp.as_dict(population=populations.get(index, 0))
                for index, sp in enumerate(self.species)
            ],
        }

    def _choose_direction(
        self,
        organism: Organism,
        sp: Species,
        occupancy: dict[tuple[int, int], int],
    ) -> tuple[int, int]:
        best_score = float("-inf")
        best_direction = (0, 0)
        traits = organism.traits
        appetite = max(1, sp.appetite + traits.appetite)
        curiosity = max(0, sp.curiosity + traits.curiosity)
        for dx, dy in [(0, 0), *DIRECTIONS]:
            tx = (organism.x + dx) % self.width
            ty = (organism.y + dy) % self.height
            nutrient = self.nutrients[ty][tx]
            crowd = occupancy.get((tx, ty), 0)
            pulse = stable_int(
                self.seed,
                self.tick_count,
                organism.genome,
                dx,
                dy,
                digest_size=4,
            )
            jitter = (pulse % 100) / 100
            stubborn_pull = 1 if (tx * 3 + ty * 5 + sp.seed) % sp.stubbornness == 0 else 0
            score = (
                nutrient * appetite
                + jitter * curiosity
                + stubborn_pull
                - crowd * 2.75
            )
            if score > best_score:
                best_score = score
                best_direction = (dx, dy)
        return best_direction

    def _weather(self) -> None:
        if self.tick_count % 11 == 0:
            self._static_bloom()
        if self.tick_count % 17 == 0:
            self._remembering_tide()
        if self.tick_count % 29 == 0:
            self._forgetting_fog()
        if self.tick_count % 41 == 0:
            self._drought()
        season = self.season()
        if season == "spring" and self.tick_count % 7 == 0:
            self._static_bloom()
        if season == "winter" and self.tick_count % 19 == 0:
            self._drought()

    def _static_bloom(self) -> None:
        for y in range(self.height):
            for x in range(self.width):
                pulse = stable_int(self.seed, "static", self.tick_count, x, y)
                if pulse % 37 == 0:
                    self.nutrients[y][x] = min(9, self.nutrients[y][x] + 3)
        self.events.append("static bloom fed the quiet corners")

    def _remembering_tide(self) -> None:
        shift = (self.tick_count // 17) % self.width
        for y, row in enumerate(self.nutrients):
            if y % 2 == 0:
                self.nutrients[y] = row[-shift:] + row[:-shift]
        self.events.append("remembering tide dragged the nutrients sideways")

    def _forgetting_fog(self) -> None:
        for y in range(self.height):
            for x in range(self.width):
                if (x + y + self.tick_count) % 3 == 0:
                    self.nutrients[y][x] = max(0, self.nutrients[y][x] - 1)
        for organism in self.organisms:
            organism.energy = max(1, organism.energy - 1)
        self.events.append("forgetting fog dimmed the habitat")

    def _drought(self) -> None:
        for y in range(self.height):
            for x in range(self.width):
                self.nutrients[y][x] = max(0, self.nutrients[y][x] - 2)
        self.events.append("drought cracked the brine")

    def _maybe_prey(
        self,
        organism: Organism,
        sp: Species,
        occupancy: dict[tuple[int, int], int],
        rng: random.Random,
    ) -> Organism | None:
        if occupancy.get((organism.x, organism.y), 0) < 1:
            return None
        appetite = max(1, sp.appetite + organism.traits.appetite)
        if appetite + sp.stubbornness < 9:
            return None
        if rng.random() > 0.35:
            return None
        for other in self.organisms:
            if other is organism or other.energy <= 0:
                continue
            if other.x != organism.x or other.y != organism.y:
                continue
            other_sp = self.species[other.species_index]
            other_appetite = max(1, other_sp.appetite + other.traits.appetite)
            if other_appetite >= appetite:
                continue
            if other.energy >= organism.energy:
                continue
            return other
        return None

    def _note_extinctions(self, before: dict[int, int]) -> None:
        after = self.population_by_species()
        for index, count in before.items():
            if count > 0 and after.get(index, 0) == 0:
                name = self.species[index].name
                if name not in self.extinctions:
                    self.extinctions.append(name)
                    if len(self.events) < 6:
                        self.events.append(f"{name} went extinct")

    def season(self) -> str:
        return ("spring", "summer", "autumn", "winter")[(max(0, self.tick_count - 1) // 13) % 4]

    def census(self) -> dict[str, object]:
        populations = self.population_by_species()
        genealogy = self.genealogy()
        return {
            "tick": self.tick_count,
            "season": self.season(),
            "population": len(self.organisms),
            "mutations": self.mutations,
            "predations": self.predations,
            "extinctions": list(self.extinctions),
            "max_generation": genealogy["max_generation"],
            "mean_generation": genealogy["mean_generation"],
            "mutant_population": genealogy["mutant_population"],
            "species": [
                {
                    "name": sp.name,
                    "glyph": sp.glyph,
                    "population": populations.get(index, 0),
                    "max_generation": genealogy["species"][index]["max_generation"],
                    "mutants": genealogy["species"][index]["mutants"],
                }
                for index, sp in enumerate(self.species)
            ],
        }

    def genealogy(self) -> dict[str, object]:
        """Who descends from whom: generation depth and inherited mutations."""
        per_species: list[dict[str, object]] = []
        for index, sp in enumerate(self.species):
            members = [org for org in self.organisms if org.species_index == index]
            generations = [org.generation for org in members]
            mutants = sum(1 for org in members if org.lineage_mutations > 0)
            founders = sum(1 for org in members if org.generation == 0)
            per_species.append(
                {
                    "name": sp.name,
                    "population": len(members),
                    "max_generation": max(generations, default=0),
                    "mean_generation": (
                        round(sum(generations) / len(generations), 2) if generations else 0.0
                    ),
                    "founders_alive": founders,
                    "mutants": mutants,
                    "trait_variants": len({org.genome & EXPRESSED_MASK for org in members}),
                }
            )
        generations = [org.generation for org in self.organisms]
        return {
            "tick": self.tick_count,
            "population": len(self.organisms),
            "max_generation": max(generations, default=0),
            "mean_generation": (
                round(sum(generations) / len(generations), 2) if generations else 0.0
            ),
            "mutant_population": sum(1 for org in self.organisms if org.lineage_mutations > 0),
            "species": per_species,
        }

    def lineage_of(self, genome: int) -> list[Organism]:
        """Walk parent links through the living population (nearest first)."""
        by_genome = {org.genome: org for org in self.organisms}
        chain: list[Organism] = []
        current = by_genome.get(int(genome))
        seen: set[int] = set()
        while current is not None and current.genome not in seen:
            chain.append(current)
            seen.add(current.genome)
            current = by_genome.get(current.parent) if current.parent else None
        return chain

    def _compost(self, x: int, y: int, *, amount: int) -> None:
        for dx, dy in [(0, 0), *DIRECTIONS[:4]]:
            tx = (x + dx) % self.width
            ty = (y + dy) % self.height
            self.nutrients[ty][tx] = min(9, self.nutrients[ty][tx] + amount)

    def _occupancy(self) -> dict[tuple[int, int], int]:
        occupancy: dict[tuple[int, int], int] = {}
        for organism in self.organisms:
            key = (organism.x, organism.y)
            occupancy[key] = occupancy.get(key, 0) + 1
        return occupancy

    def _trim_population(self) -> None:
        max_population = self.width * self.height
        if len(self.organisms) <= max_population:
            return
        self.organisms.sort(key=lambda organism: organism.energy, reverse=True)
        for organism in self.organisms[max_population:]:
            self._compost(organism.x, organism.y, amount=1)
        self.organisms = self.organisms[:max_population]
        self.events.append("the glass walls refused further multiplication")

    def _seed_rescue_population(self) -> None:
        rng = random.Random(stable_int(self.seed, "rescue", self.tick_count))
        for index, sp in enumerate(self.species):
            self.organisms.append(
                Organism(
                    species_index=index,
                    x=rng.randrange(self.width),
                    y=rng.randrange(self.height),
                    energy=max(10, sp.split_threshold // 2),
                    age=0,
                    genome=stable_int(self.seed, "rescue-genome", self.tick_count, index),
                    born=self.tick_count,
                )
            )
        self.events.append("the archive reseeded itself from a cold backup")


def make_species(phrase: str, *, max_species: int = 8) -> list[Species]:
    words = words_from_phrase(phrase)[:max_species]
    used_glyphs: set[str] = set()
    species: list[Species] = []
    for index, word in enumerate(words):
        seed = stable_int("species", phrase, word, index)
        prefix = PREFIXES[seed % len(PREFIXES)]
        suffix = SUFFIXES[(seed >> 8) % len(SUFFIXES)]
        root = re.sub(r"[^a-z0-9]", "", word)[:10] or "word"
        glyph = choose_glyph(word, index, used_glyphs)
        species.append(
            Species(
                name=f"{prefix}-{root}-{suffix}",
                source_word=word,
                glyph=glyph,
                hue=seed % 360,
                ansi_color=31 + (seed % 6),
                appetite=1 + ((seed >> 9) % 3),
                curiosity=1 + ((seed >> 13) % 7),
                stubbornness=2 + ((seed >> 17) % 6),
                split_threshold=24 + ((seed >> 21) % 22),
                metabolism=1 + ((seed >> 25) % 3),
                lifespan=35 + ((seed >> 29) % 70),
                seed=seed,
            )
        )
    return species


def choose_glyph(word: str, index: int, used_glyphs: set[str]) -> str:
    candidates = []
    if word and word[0].isalnum():
        candidates.append(word[0].upper())
    candidates.extend(GLYPHS[(index + offset) % len(GLYPHS)] for offset in range(len(GLYPHS)))
    for glyph in candidates:
        if glyph not in used_glyphs:
            used_glyphs.add(glyph)
            return glyph
    fallback = f"{GLYPHS[index % len(GLYPHS)]}{index + 1}"
    used_glyphs.add(fallback)
    return fallback


def initial_nutrient(seed: int, x: int, y: int, rng: random.Random) -> int:
    vein = stable_int(seed, "vein", x // 3, y // 2, digest_size=4) % 10
    dust = rng.randrange(4)
    return min(9, max(0, vein // 2 + dust - 1))


def ranked_species(world: World) -> Iterable[tuple[Species, int]]:
    counts = world.population_by_species()
    ranked = sorted(
        enumerate(world.species),
        key=lambda pair: (-counts.get(pair[0], 0), pair[1].name),
    )
    for index, sp in ranked:
        yield sp, counts.get(index, 0)
