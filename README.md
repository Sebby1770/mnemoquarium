# Mnemoquarium

Mnemoquarium is a tiny artificial-life lab for the terminal.

See [CHANGELOG.md](CHANGELOG.md) for release history. Give it any
phrase and it deterministically turns the words into species, seeds a little
nutrient field, and lets the resulting memory ecosystem crawl, bloom, split,
starve, and leave behind a fossil hash.

It is deliberately odd, but useful as a compact Python project:

- pure standard library, no runtime dependencies
- deterministic simulations from phrase seeds
- animated ANSI terminal rendering
- SVG specimen card export
- JSON snapshot export
- Markdown field report export
- installable CLI plus a testable simulation core

## Quick Start

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
mnemoquarium "the vending machine remembers my name" --steps 90 --animate
```

Run without installation from the repository root:

```bash
PYTHONPATH=src python3 -m mnemoquarium "library dust with electric teeth" --steps 64
```

Export a specimen:

```bash
PYTHONPATH=src python3 -m mnemoquarium \
  "library dust with electric teeth" \
  --steps 96 \
  --export-svg out/specimen.svg \
  --export-json out/specimen.json \
  --report out/field-report.md
```

## What It Does

Each distinct word in the phrase becomes a species (up to `--max-species`).
The phrase hash chooses its traits: appetite, curiosity, stubbornness, split
threshold, lifespan, glyph, and color. The organisms roam a wraparound nutrient
field, make noisy local decisions, eat, reproduce, and occasionally get hit by
weird weather events like remembering tides or static blooms.

Because all randomness is seeded from the phrase, this command will always
generate the same final fossil:

```bash
PYTHONPATH=src python3 -m mnemoquarium "same phrase, same aquarium" --steps 50
```

### Fossil hash

The fossil hash is a BLAKE2b digest of the full simulation state (organisms,
nutrients, tick). Same phrase + dimensions + steps always yields the same
hash — a compact fingerprint of the ecosystem's final memory.

## CLI

Compare two phrases side by side:

```bash
PYTHONPATH=src python3 -m mnemoquarium --compare "neon rain" "static bloom" --steps 64
```

Export a React Bits–styled HTML gallery page:

```bash
PYTHONPATH=src python3 -m mnemoquarium "library dust" --steps 48 --export-html out/gallery.html
```

Resume from a saved specimen:

```bash
PYTHONPATH=src python3 -m mnemoquarium --replay out/specimen.json --steps 40
```

Record a population time series while the habitat runs:

```bash
PYTHONPATH=src python3 -m mnemoquarium "library dust" --steps 96 \
  --record-history out/history.json \
  --history-csv out/history.csv \
  --history-interval 4
```

```text
usage: mnemoquarium [phrase ...] [--width N] [--height N] [--steps N]
                    [--population N] [--max-species N] [--replay PATH]
                    [--animate] [--speed SECONDS] [--no-color]
                    [--export-svg PATH] [--export-json PATH] [--report PATH]
                    [--record-history PATH] [--history-csv PATH]
                    [--history-interval N]
```

Long non-animated runs print progress to stderr every few ticks. Animation
detects non-TTY output and skips screen clears when piped.

## Development

```bash
PYTHONPATH=src python3 -m unittest discover -s tests
```

The project is intentionally small enough to read in one sitting:

- `src/mnemoquarium/model.py` — simulation core
- `src/mnemoquarium/display.py` — shared cell occupancy helpers
- `src/mnemoquarium/render.py` — ANSI rendering
- `src/mnemoquarium/export.py` — SVG, JSON, and Markdown exporters
- `src/mnemoquarium/cli.py` — argument parsing and orchestration