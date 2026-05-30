from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

from .export import field_report, json_document, svg_document
from .model import DEFAULT_PHRASE, World
from .render import render_ansi, render_legend


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mnemoquarium",
        description="Grow a deterministic terminal ecosystem from a phrase.",
    )
    parser.add_argument(
        "phrase",
        nargs="*",
        help="Seed phrase. If omitted, a default phrase is used.",
    )
    parser.add_argument("--width", type=int, default=64, help="Habitat width.")
    parser.add_argument("--height", type=int, default=24, help="Habitat height.")
    parser.add_argument("--steps", type=int, default=64, help="Simulation steps.")
    parser.add_argument(
        "--population",
        type=int,
        default=32,
        help="Initial organism count.",
    )
    parser.add_argument(
        "--animate",
        action="store_true",
        help="Animate each step in the terminal.",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=0.04,
        help="Seconds between animation frames.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI color output.",
    )
    parser.add_argument("--export-svg", type=Path, help="Write an SVG specimen card.")
    parser.add_argument("--export-json", type=Path, help="Write a JSON snapshot.")
    parser.add_argument("--report", type=Path, help="Write a Markdown field report.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    phrase = " ".join(args.phrase).strip() or DEFAULT_PHRASE
    color = not args.no_color

    try:
        world = World.from_phrase(
            phrase,
            width=args.width,
            height=args.height,
            population=args.population,
        )
    except ValueError as exc:
        print(f"mnemoquarium: {exc}", file=sys.stderr)
        return 2

    if args.animate:
        animate(world, steps=args.steps, speed=args.speed, color=color)
    else:
        world.run(args.steps)
        print(render_ansi(world, color=color))
        print()
        print(render_legend(world, color=color))

    write_outputs(world, args)
    return 0


def animate(world: World, *, steps: int, speed: float, color: bool) -> None:
    for step in range(max(0, steps) + 1):
        print("\033[2J\033[H", end="")
        print(render_ansi(world, color=color))
        print()
        print(render_legend(world, color=color))
        if step < steps:
            world.step()
            time.sleep(max(0.0, speed))


def write_outputs(world: World, args: argparse.Namespace) -> None:
    outputs = [
        (args.export_svg, svg_document),
        (args.export_json, json_document),
        (args.report, field_report),
    ]
    for path, factory in outputs:
        if path is None:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(factory(world), encoding="utf-8")
