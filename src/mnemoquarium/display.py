from __future__ import annotations

from .model import Organism, World


def organisms_by_cell(world: World) -> dict[tuple[int, int], list[Organism]]:
    cells: dict[tuple[int, int], list[Organism]] = {}
    for organism in world.organisms:
        key = (organism.x, organism.y)
        cells.setdefault(key, []).append(organism)
    return cells


def dominant_organism(organisms: list[Organism]) -> Organism:
    return max(organisms, key=lambda organism: organism.energy)


def cell_glyph(organism: Organism, *, count: int, color: bool, species_glyph: str, ansi_color: int) -> str:
    glyph = species_glyph
    if count > 1:
        suffix = str(count) if count < 10 else "+"
        glyph = f"{glyph}{suffix}"
    if color:
        return f"\033[{ansi_color};1m{glyph}\033[0m"
    return glyph