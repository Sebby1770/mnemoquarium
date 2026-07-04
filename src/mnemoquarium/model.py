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


@dataclass
class Organism:
    species_index: int
    x: int
    y: int
    energy: int
    age: int
    genome: int

    def as_tuple(self) -> tuple[int, int, int, int, int, int]:
        return (
            self.species_index,
            self.x,
            self.y,
            self.energy,
            self.age,
            self.genome,
        )


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

    @classmethod
    def from_phrase(
        cls,
        phrase: str = DEFAULT_PHRASE,
        *,
        width: int = 64,
        height: int = 24,
        population: int = 32,
        max_species: int = 8,
    ) -> "World":
        if width < 12 or height < 8:
            raise ValueError("mnemoquarium needs at least a 12x8 habitat")
        phrase = phrase.strip() or DEFAULT_PHRASE
        seed = stable_int("mnemoquarium", phrase)
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

            crowd = occupancy.get((organism.x, organism.y), 0)
            tax = sp.metabolism + (1 if crowd > 2 else 0)
            organism.energy -= tax

            meal = min(self.nutrients[organism.y][organism.x], sp.appetite)
            self.nutrients[organism.y][organism.x] -= meal
            organism.energy += meal * 3

            if organism.energy <= 0 or organism.age > sp.lifespan:
                self._compost(organism.x, organism.y, amount=2 + sp.metabolism)
                if len(self.events) < 4:
                    self.events.append(f"{sp.name} left a bright fossil")
                continue

            if organism.energy >= sp.split_threshold and rng.random() < 0.42:
                child_energy = max(6, organism.energy // 2)
                organism.energy -= child_energy
                child_dx, child_dy = rng.choice(DIRECTIONS)
                child = Organism(
                    species_index=organism.species_index,
                    x=(organism.x + child_dx) % self.width,
                    y=(organism.y + child_dy) % self.height,
                    energy=child_energy,
                    age=0,
                    genome=stable_int(
                        self.seed,
                        "child",
                        self.tick_count,
                        organism.genome,
                        len(newborns),
                    ),
                )
                newborns.append(child)
                if len(self.events) < 4:
                    self.events.append(f"{sp.name} split in the memory brine")

            survivors.append(organism)
            occupancy[(organism.x, organism.y)] = (
                occupancy.get((organism.x, organism.y), 0) + 1
            )

        self.organisms = survivors + newborns
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
                nutrient * sp.appetite
                + jitter * sp.curiosity
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
