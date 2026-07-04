from __future__ import annotations

import argparse
from pathlib import Path
import sys
import time

from .compare import compare_worlds
from .export import field_report, html_document, json_document, svg_document
from .model import DEFAULT_PHRASE, World
from .render import render_ansi, render_legend, sparkline
from .snapshot import HistoryRecorder, read_snapshot_file


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
        "--replay",
        type=Path,
        help="Resume simulation from a JSON snapshot export.",
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
    parser.add_argument(
        "--record-history",
        type=Path,
        help="Write a JSON time series of population and nutrient totals.",
    )
    parser.add_argument(
        "--history-csv",
        type=Path,
        help="Write a CSV time series of population and nutrient totals.",
    )
    parser.add_argument(
        "--history-interval",
        type=int,
        default=1,
        help="Record history every N ticks.",
    )
    parser.add_argument("--export-html", type=Path, help="Write a standalone HTML gallery page.")
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar=("PHRASE_A", "PHRASE_B"),
        help="Run two phrases with identical settings and print a comparison report.",
    )
    parser.add_argument(
        "--sparkline",
        action="store_true",
        help="Show a population sparkline on stderr after the run.",
    )
    return parser


def validate_args(args: argparse.Namespace) -> str | None:
    if args.replay is None:
        if args.width < 12 or args.height < 8:
            return "width must be at least 12 and height at least 8"
        if args.population < 1:
            return "population must be at least 1"
        if args.max_species < 1:
            return "max-species must be at least 1"
    if args.steps < 0:
        return "steps must be zero or positive"
    if args.speed < 0:
        return "speed must be zero or positive"
    if args.history_interval < 1:
        return "history-interval must be at least 1"
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

    if args.compare:
        return run_compare(args)

    try:
        world = build_world(args, phrase)
    except (ValueError, OSError) as exc:
        print(f"mnemoquarium: {exc}", file=sys.stderr)
        return 2

    history = HistoryRecorder(interval=args.history_interval)
    history.maybe_record(world)

    if args.animate:
        animate(world, steps=args.steps, speed=args.speed, color=color, history=history)
    else:
        run_with_progress(world, steps=args.steps, color=color, history=history)

    if args.sparkline and history.entries:
        populations = [int(entry["population"]) for entry in history.entries]
        print(f"population {sparkline(populations)}", file=sys.stderr)

    export_errors = write_outputs(world, args, history)
    if export_errors:
        for message in export_errors:
            print(f"mnemoquarium: {message}", file=sys.stderr)
        return 1

    return 0


def run_compare(args: argparse.Namespace) -> int:
    left_phrase, right_phrase = args.compare
    settings = dict(
        width=args.width,
        height=args.height,
        population=args.population,
        max_species=args.max_species,
    )
    left = World.from_phrase(left_phrase, **settings).run(args.steps)
    right = World.from_phrase(right_phrase, **settings).run(args.steps)
    print(compare_worlds(left, right))
    return 0


def build_world(args: argparse.Namespace, phrase: str) -> World:
    if args.replay is not None:
        return read_snapshot_file(args.replay)
    return World.from_phrase(
        phrase,
        width=args.width,
        height=args.height,
        population=args.population,
        max_species=args.max_species,
    )


def run_with_progress(
    world: World,
    *,
    steps: int,
    color: bool,
    history: HistoryRecorder,
) -> None:
    report_every = max(1, steps // 8) if steps >= 16 else 0
    for step in range(steps):
        world.step()
        history.maybe_record(world)
        if report_every and (step + 1) % report_every == 0:
            print(
                f"[tick {world.tick_count}] population={len(world.organisms)}",
                file=sys.stderr,
            )

    print(render_ansi(world, color=color))
    print()
    print(render_legend(world, color=color))


def animate(
    world: World,
    *,
    steps: int,
    speed: float,
    color: bool,
    history: HistoryRecorder,
) -> None:
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
            history.maybe_record(world)
            time.sleep(max(0.0, speed))


def write_outputs(
    world: World,
    args: argparse.Namespace,
    history: HistoryRecorder,
) -> list[str]:
    outputs: list[tuple[Path | None, str]] = [
        (args.export_svg, svg_document(world)),
        (args.export_json, json_document(world)),
        (args.export_html, html_document(world)),
        (args.report, field_report(world)),
        (args.record_history, history.to_json()),
        (args.history_csv, history.to_csv()),
    ]
    errors: list[str] = []
    for path, content in outputs:
        if path is None:
            continue
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            errors.append(f"failed to write {path}: {exc}")
    return errors