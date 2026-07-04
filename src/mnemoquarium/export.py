from __future__ import annotations

import html
import json

from .display import dominant_organism, organisms_by_cell
from .model import World, ranked_species
from .snapshot import detailed_snapshot


def json_document(world: World) -> str:
    return json.dumps(detailed_snapshot(world), indent=2, sort_keys=True) + "\n"


def field_report(world: World) -> str:
    snapshot = world.snapshot()
    lines = [
        "# Mnemoquarium Field Report",
        "",
        f"Phrase: `{world.phrase}`",
        f"Tick: `{world.tick_count}`",
        f"Fossil hash: `{snapshot['fossil_hash']}`",
        f"Population: `{len(world.organisms)}`",
        f"Nutrient total: `{snapshot['nutrient_total']}`",
        "",
        "## Species",
        "",
        "| Glyph | Species | Source | Pop | Traits |",
        "| --- | --- | --- | ---: | --- |",
    ]
    for sp, count in ranked_species(world):
        traits = (
            f"eat {sp.appetite}, curious {sp.curiosity}, "
            f"stubborn {sp.stubbornness}, split {sp.split_threshold}, "
            f"life {sp.lifespan}"
        )
        lines.append(
            f"| `{sp.glyph}` | {sp.name} | `{sp.source_word}` | {count} | {traits} |"
        )
    if world.events:
        lines.extend(["", "## Last Events", ""])
        lines.extend(f"- {event}" for event in world.events)
    lines.append("")
    return "\n".join(lines)


def svg_document(world: World, *, cell: int = 12) -> str:
    margin = 18
    legend_height = 108 + len(world.species) * 18
    width = world.width * cell + margin * 2
    grid_height = world.height * cell
    height = grid_height + legend_height + margin * 2
    title = html.escape("Mnemoquarium specimen")
    phrase = html.escape(world.phrase)
    fossil = html.escape(world.fossil_hash())

    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        (
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        ),
        "<defs>",
        "<style>",
        "text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }",
        ".small { font-size: 12px; fill: #d8e3ef; }",
        ".label { font-size: 11px; fill: #93a4b8; }",
        "</style>",
        "</defs>",
        '<rect width="100%" height="100%" fill="#071014"/>',
        f'<text x="{margin}" y="25" class="small">{title}</text>',
        f'<text x="{margin}" y="44" class="label">phrase: {phrase}</text>',
        f'<text x="{margin}" y="62" class="label">tick: {world.tick_count} / fossil: {fossil}</text>',
    ]

    ox = margin
    oy = margin + 60
    parts.append(
        f'<rect x="{ox - 1}" y="{oy - 1}" width="{world.width * cell + 2}" '
        f'height="{grid_height + 2}" fill="#0d1b20" stroke="#24404a"/>'
    )
    for y, row in enumerate(world.nutrients):
        for x, value in enumerate(row):
            light = 8 + value * 6
            opacity = 0.25 + value * 0.055
            parts.append(
                f'<rect x="{ox + x * cell}" y="{oy + y * cell}" '
                f'width="{cell}" height="{cell}" fill="hsl(185 42% {light}%)" '
                f'opacity="{opacity:.2f}"/>'
            )

    for (x, y), occupants in organisms_by_cell(world).items():
        organism = dominant_organism(occupants)
        sp = world.species[organism.species_index]
        energy = organism.energy
        radius = max(3, min(cell * 0.48, 2 + energy * 0.18))
        cx = ox + x * cell + cell / 2
        cy = oy + y * cell + cell / 2
        glyph = html.escape(sp.glyph)
        parts.append(
            f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius:.1f}" '
            f'fill="hsl({sp.hue} 78% 56%)" opacity="0.88"/>'
        )
        parts.append(
            f'<text x="{cx:.1f}" y="{cy + 3:.1f}" text-anchor="middle" '
            f'font-size="{max(8, cell - 2)}" fill="#071014">{glyph}</text>'
        )
        if len(occupants) > 1:
            parts.append(
                f'<text x="{cx + cell * 0.28:.1f}" y="{cy - cell * 0.22:.1f}" '
                f'font-size="8" fill="#d8e3ef">{len(occupants)}</text>'
            )

    legend_y = oy + grid_height + 28
    parts.append(f'<text x="{margin}" y="{legend_y}" class="small">species ledger</text>')
    for index, (sp, count) in enumerate(ranked_species(world), start=1):
        y = legend_y + index * 18
        glyph = html.escape(sp.glyph)
        name = html.escape(sp.name)
        source = html.escape(sp.source_word)
        parts.append(
            f'<circle cx="{margin + 6}" cy="{y - 4}" r="5" '
            f'fill="hsl({sp.hue} 78% 56%)"/>'
        )
        parts.append(
            f'<text x="{margin + 18}" y="{y}" class="label">'
            f'{glyph} {name} from "{source}" - pop {count}, '
            f'eat {sp.appetite}, curious {sp.curiosity}, split {sp.split_threshold}'
            "</text>"
        )

    parts.append("</svg>")
    return "\n".join(parts) + "\n"