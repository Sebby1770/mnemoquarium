from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .model import Organism, Species, World, make_species


def detailed_snapshot(world: World) -> dict[str, Any]:
    base = world.snapshot()
    base["organisms"] = [organism.as_dict() for organism in world.organisms]
    base["nutrients"] = world.nutrients
    base["species_catalog"] = [sp.as_dict() for sp in world.species]
    base["genealogy"] = world.genealogy()
    return base


def load_snapshot(data: dict[str, Any]) -> World:
    phrase = str(data.get("phrase", "")).strip()
    width = int(data["width"])
    height = int(data["height"])
    seed = int(data["seed"])
    tick = int(data.get("tick", 0))
    nutrients = data.get("nutrients")
    if nutrients is None:
        raise ValueError("snapshot is missing nutrients grid")

    species_data = data.get("species_catalog")
    if species_data:
        species = [
            Species(
                name=item["name"],
                source_word=item["source_word"],
                glyph=item["glyph"],
                hue=int(item["hue"]),
                ansi_color=int(item.get("ansi_color", 31)),
                appetite=int(item["appetite"]),
                curiosity=int(item["curiosity"]),
                stubbornness=int(item["stubbornness"]),
                split_threshold=int(item["split_threshold"]),
                metabolism=int(item["metabolism"]),
                lifespan=int(item["lifespan"]),
                seed=int(item.get("seed", 0)),
            )
            for item in species_data
        ]
    else:
        species = make_species(phrase)

    organisms = [
        Organism(
            species_index=int(item["species_index"]),
            x=int(item["x"]),
            y=int(item["y"]),
            energy=int(item["energy"]),
            age=int(item["age"]),
            genome=int(item["genome"]),
            generation=int(item.get("generation", 0)),
            parent=int(item.get("parent", 0)),
            born=int(item.get("born", 0)),
            lineage_mutations=int(item.get("lineage_mutations", 0)),
        )
        for item in data.get("organisms", [])
    ]

    return World(
        width=width,
        height=height,
        phrase=phrase,
        seed=seed,
        species=species,
        nutrients=nutrients,
        organisms=organisms,
        tick_count=tick,
        events=list(data.get("events", [])),
        extinctions=[str(name) for name in data.get("extinctions", [])],
        mutations=int(data.get("mutations", 0)),
        predations=int(data.get("predations", 0)),
    )


def lineage_document(world: World) -> str:
    """JSON: genealogy summary plus every living organism's ancestry pointers."""
    payload = {
        "phrase": world.phrase,
        "seed": world.seed,
        "tick": world.tick_count,
        "fossil_hash": world.fossil_hash(),
        "genealogy": world.genealogy(),
        "organisms": [
            {
                **organism.as_dict(),
                "species": world.species[organism.species_index].name,
                "ancestors_alive": len(world.lineage_of(organism.genome)) - 1,
            }
            for organism in sorted(
                world.organisms, key=lambda org: (-org.generation, -org.lineage_mutations, org.genome)
            )
        ],
    }
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def read_snapshot_file(path: Path) -> World:
    data = json.loads(path.read_text(encoding="utf-8"))
    return load_snapshot(data)


class HistoryRecorder:
    def __init__(self, *, interval: int = 1) -> None:
        self.interval = max(1, interval)
        self.entries: list[dict[str, Any]] = []

    def maybe_record(self, world: World) -> None:
        if world.tick_count % self.interval != 0 and world.tick_count != 0:
            return
        populations = world.population_by_species()
        self.entries.append(
            {
                "tick": world.tick_count,
                "population": len(world.organisms),
                "nutrient_total": sum(sum(row) for row in world.nutrients),
                "fossil_hash": world.fossil_hash(),
                "max_generation": max((org.generation for org in world.organisms), default=0),
                "mutant_population": sum(1 for org in world.organisms if org.lineage_mutations > 0),
                "species_populations": {
                    world.species[index].name: populations.get(index, 0)
                    for index in range(len(world.species))
                },
            }
        )

    def to_json(self) -> str:
        return json.dumps(self.entries, indent=2, sort_keys=True) + "\n"

    def to_csv(self) -> str:
        lines = ["tick,population,nutrient_total,fossil_hash,max_generation,mutant_population"]
        for entry in self.entries:
            lines.append(
                f"{entry['tick']},{entry['population']},{entry['nutrient_total']},"
                f"{entry['fossil_hash']},{entry.get('max_generation', 0)},"
                f"{entry.get('mutant_population', 0)}"
            )
        return "\n".join(lines) + "\n"