from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .model import Organism, Species, World, make_species


def detailed_snapshot(world: World) -> dict[str, Any]:
    base = world.snapshot()
    base["organisms"] = [
        {
            "species_index": organism.species_index,
            "x": organism.x,
            "y": organism.y,
            "energy": organism.energy,
            "age": organism.age,
            "genome": organism.genome,
        }
        for organism in world.organisms
    ]
    base["nutrients"] = world.nutrients
    base["species_catalog"] = [sp.as_dict() for sp in world.species]
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
    )


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
                "species_populations": {
                    world.species[index].name: populations.get(index, 0)
                    for index in range(len(world.species))
                },
            }
        )

    def to_json(self) -> str:
        return json.dumps(self.entries, indent=2, sort_keys=True) + "\n"

    def to_csv(self) -> str:
        lines = ["tick,population,nutrient_total,fossil_hash"]
        for entry in self.entries:
            lines.append(
                f"{entry['tick']},{entry['population']},{entry['nutrient_total']},{entry['fossil_hash']}"
            )
        return "\n".join(lines) + "\n"