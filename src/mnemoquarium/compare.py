from __future__ import annotations

from .model import World


def compare_worlds(left: World, right: World) -> str:
    lines = [
        "Mnemoquarium comparison",
        f"left phrase:  {left.phrase!r} @ tick {left.tick_count}",
        f"right phrase: {right.phrase!r} @ tick {right.tick_count}",
        f"left fossil:  {left.fossil_hash()}",
        f"right fossil: {right.fossil_hash()}",
        f"same fossil:  {left.fossil_hash() == right.fossil_hash()}",
        f"population:   {len(left.organisms)} vs {len(right.organisms)}",
        f"nutrients:    {sum(sum(row) for row in left.nutrients)} vs {sum(sum(row) for row in right.nutrients)}",
        "",
        "species populations:",
    ]

    left_counts = left.population_by_species()
    right_counts = right.population_by_species()
    names = {sp.name for sp in left.species} | {sp.name for sp in right.species}
    for name in sorted(names):
        left_pop = next(
            (left_counts.get(index, 0) for index, sp in enumerate(left.species) if sp.name == name),
            0,
        )
        right_pop = next(
            (right_counts.get(index, 0) for index, sp in enumerate(right.species) if sp.name == name),
            0,
        )
        delta = right_pop - left_pop
        sign = "+" if delta > 0 else ""
        lines.append(f"  {name:<32} {left_pop:>3} -> {right_pop:>3} ({sign}{delta})")

    return "\n".join(lines) + "\n"