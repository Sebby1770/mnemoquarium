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
    parser.add_argument("--width", type=int, default=64, help="Habitat width (minimum 12).")
    parser.add_argument("--height", type=int, default=24, help="Habitat height (minimum 8).")
    parser.add_argument("--steps", type=int, default=64, help="Simulation steps.")
    parser.add_argument(
        "--population",
        type=int,
        default=32,
        help="Initial organism count.",
    )
    parser.add_argument(
        "--max-species",
        type=int,
        default=8,
        help="Maximum species derived from phrase words.",
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


def validate_args(args: argparse.Namespace) -> str | None:
    if args.width < 12 or args.height < 8:
        return "width must be at least 12 and height at least 8"
    if args.steps < 0:
        return "steps must be zero or positive"
    if args.population < 1:
        return "population must be at least 1"
    if args.max_species < 1:
        return "max-species must be at least 1"
    if args.speed < 0:
        return "speed must be zero or positive"
    if args.width * args.height > 20_000:
        return "habitat is too large; keep width * height below 20000"
    return None


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    phrase = " ".join(args.phrase).strip() or DEFAULT_PHRASE
    color = not args.no_color

    validation_error = validate_args(args)
    if validation_error:
        print(f"mnemoquarium: {validation_error}", file=sys.stderr)
        return 2

    try:
        world = World.from_phrase(
            phrase,
            width=args.width,
            height=args.height,
            population=args.population,
            max_species=args.max_species,
        )
    except ValueError as exc:
        print(f"mnemoquarium: {exc}", file=sys.stderr)
        return 2

    if args.animate:
        animate(world, steps=args.steps, speed=args.speed, color=color)
    else:
        run_with_progress(world, steps=args.steps, color=color)

    export_errors = write_outputs(world, args)
    if export_errors:
        for message in export_errors:
            print(f"mnemoquarium: {message}", file=sys.stderr)
        return 1

    return 0


def run_with_progress(world: World, *, steps: int, color: bool) -> None:
    report_every = max(1, steps // 8) if steps >= 16 else 0
    for step in range(steps):
        world.step()
        if report_every and (step + 1) % report_every == 0:
            print(
                f"[tick {world.tick_count}] population={len(world.organisms)}",
                file=sys.stderr,
            )

    print(render_ansi(world, color=color))
    print()
    print(render_legend(world, color=color))


def animate(world: World, *, steps: int, speed: float, color: bool) -> None:
    tty = sys.stdout.isatty()
    for step in range(max(0, steps) + 1):
        if tty:
            print("\033[2J\033[H", end="")
        elif step > 0:
            print(f"\n--- tick {world.tick_count} ---")

        print(render_ansi(world, color=color))
        print()
        print(render_legend(world, color=color))

        if step < steps:
            world.step()
            time.sleep(max(0.0, speed))


def write_outputs(world: World, args: argparse.Namespace) -> list[str]:
    outputs = [
        (args.export_svg, svg_document),
        (args.export_json, json_document),
        (args.report, field_report),
    ]
    errors: list[str] = []
    for path, factory in outputs:
        if path is None:
            continue
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(factory(world), encoding="utf-8")
        except OSError as exc:
            errors.append(f"failed to write {path}: {exc}")
    return errors