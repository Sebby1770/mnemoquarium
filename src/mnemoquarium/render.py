from __future__ import annotations

from .display import cell_glyph, dominant_organism, organisms_by_cell
from .model import World, ranked_species


NUTRIENT_CHARS = " .,:;irsXA253hMHGS#9B&@"
RESET = "\033[0m"


def nutrient_char(value: int) -> str:
    index = max(0, min(value, 9))
    return NUTRIENT_CHARS[index]


def render_ansi(world: World, *, color: bool = True) -> str:
    cells = [
        [nutrient_char(world.nutrients[y][x]) for x in range(world.width)]
        for y in range(world.height)
    ]

    for (x, y), occupants in organisms_by_cell(world).items():
        organism = dominant_organism(occupants)
        sp = world.species[organism.species_index]
        cells[y][x] = cell_glyph(
            organism,
            count=len(occupants),
            color=color,
            species_glyph=sp.glyph,
            ansi_color=sp.ansi_color,
        )

    return "\n".join("".join(row) for row in cells)


def render_status(world: World) -> str:
    snapshot = world.snapshot()
    return (
        f"tick={snapshot['tick']} "
        f"population={snapshot['population']} "
        f"nutrients={snapshot['nutrient_total']} "
        f"fossil={snapshot['fossil_hash']}"
    )


def render_legend(world: World, *, color: bool = True) -> str:
    lines = [render_status(world)]
    for sp, count in ranked_species(world):
        glyph = sp.glyph
        if color:
            glyph = f"\033[{sp.ansi_color};1m{glyph}{RESET}"
        lines.append(
            f"{glyph} {sp.name:<28} pop={count:<3} "
            f"eat={sp.appetite} curious={sp.curiosity} split={sp.split_threshold}"
        )
    if world.events:
        lines.append("events: " + "; ".join(world.events))
    return "\n".join(lines)