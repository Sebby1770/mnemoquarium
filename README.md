# Mnemoquarium

**Live lab:** [https://sebby1770.github.io/mnemoquarium/](https://sebby1770.github.io/mnemoquarium/)
&nbsp;·&nbsp;
**Dive it:** [the deep](https://sebby1770.github.io/mnemoquarium/deep/)

Deterministic phrase-fed artificial life. Type a phrase and look **through the glass** of a slow side-view aquarium: fish with scales and gills glide over sand and coral. Children inherit their parents' traits, mutations run in families, and a census strip records every bloom and crash. Day and night, reef / kelp / moonlit themes, schooling, and brine. Or run the Python CLI.

Mnemoquarium is a tiny artificial-life lab for the terminal and the browser.

See [CHANGELOG.md](CHANGELOG.md) for release history.

Give it any phrase and it deterministically turns the words into species, seeds a little
nutrient field, and lets the resulting memory ecosystem crawl, bloom, split,
starve, and leave behind a fossil hash.

There are two ways to look at the same ecosystem. Through the glass, in the
2D tank, where you watch it run. Or from inside it, in **[the deep](web/deep/)**
— a first-person submarine game where the fish your phrase grew are worth money,
the dark is expensive, and something down there is hunting.

It is deliberately odd, but useful as a compact Python project:

- pure standard library, no runtime dependencies
- deterministic simulations from phrase seeds
- heritable genomes: children inherit expressed traits, point mutations run in lineages
- genealogy reports (generation depth, founders alive, inherited mutations)
- animated ANSI terminal rendering
- side-view SVG tank export (sand, coral, fish)
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

### Heredity

Each genome carries an expressed region of eight bits. A child inherits those
bits from its parent, and a point mutation flips exactly one of them, so the
appetite, curiosity, thrift, or hue of a mutant is passed down its line. Every
advantage costs something (a bigger appetite burns more energy; thrift, which
shrugs off crowding, delays breeding), so no single genome wins forever.

```bash
PYTHONPATH=src python3 -m mnemoquarium "salt and static" --steps 120 --lineage out/lineage.json --census
```

The census and the Markdown field report show the deepest generation, the mean
generation, and how many fish carry an inherited mutation, per species.

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
                    [--history-interval N] [--lineage PATH] [--census]
                    [--seed N] [--compare PHRASE_A PHRASE_B]
```

Long non-animated runs print progress to stderr every few ticks. Animation
detects non-TTY output and skips screen clears when piped.

## The Deep

```
web/deep/  ->  https://sebby1770.github.io/mnemoquarium/deep/
```

Same phrase. Same genetics. You are in a submarine now.

Every word of your phrase is still a species — `makeSpecies` is imported from
the same `web/engine.js` the 2D tank runs on, so a kiosk is the same fish in
both — but down here each species also has a body plan, a home depth, a temper,
and a price. Children still inherit their parents' expressed bits and still
mutate one at a time, and a specimen carrying an inherited mutation sells for
more than its siblings. That is the whole economy: heredity, on an invoice.

**The loop.** Dive from the Hull. Hold the capture beam on a fish until it comes
in. Come back, sell the hold, refit, and go deeper than you could last time.

**Five bands**, and the seabed slopes into all of them — 62 m under the station,
1,400 m at the rim, no menus, you just swim out:

| band | depth | what it costs you |
| --- | --- | --- |
| Sunlit Shelf | 0–90 m | nothing. it has also been picked over |
| Kelp Cathedral | 90–240 m | green columns, and things that hold on |
| Twilight Drift | 240–520 m | the last of the light, spending itself |
| Midnight Reach | 520–980 m | no light but the light that wants you closer |
| The Forgetting | 980 m+ | where the tank keeps what it could not hold |

**Pressure is the gate.** The stock casing is rated to 140 m. Past the rating
the sea starts folding the boat shut, and the fish worth real money all live
below it. Twelve upgrades in the drydock — casing, hull, impeller, hold, cell,
lamps, sonar, beam, harpoon, torpedo tubes, repair drone, trickle reactor.

**Six things hunt you.** Reef sharks run straight at you. Glass squid clamp on
and drain the cell. Lantern anglers hang still in the dark with a light on.
A leviathan is longer than your lamps reach. A Forgetting Wraith takes a
specimen out of the hold *and out of the record*. The Kraken of Static lives in
the abyss and is not a fair fight yet.

Your lamps are how they find you. Running dark is cheaper and much worse.

**Controls.** `W A S D` thrust · `Space` rise · `C` dive · `Shift` boost ·
mouse look · `LMB` fire · `RMB` capture beam · `1` `2` `3` weapons · `F` lights ·
`R` sonar · `E` dock · `Tab` hold · `Esc` pause.

**No build step.** three.js r160 is vendored at `web/deep/vendor/`, the modules
are plain ES modules, and the whole thing installs offline like the tank does.
Serve the `web/` folder with any static server and open `/deep/`.

- `web/deep/src/ecology.js` — phrase to species to price
- `web/deep/src/world.js` — seabed, bands, flora, the Hull
- `web/deep/src/sub.js` — flight, systems, pressure, the cockpit
- `web/deep/src/fish.js` — shoals, boids, the capture
- `web/deep/src/creatures.js` — the six, and their manners
- `web/deep/ARCHITECTURE.md` — the contract every module is written against

## Development

```bash
PYTHONPATH=src python3 -m unittest discover -s tests   # simulation core
node --test "web/tests/*.test.mjs"                     # browser engine + the deep
node --experimental-vm-modules web/tests/parse-modules.mjs   # compile the deep modules
```

That last one exists because `node --check` pre-parses function bodies lazily:
a malformed literal inside a method passes the check and then fails in the
browser as a bare `SyntaxError` with no file and no line. Compiling each module
eagerly catches it and names the file.

The live lab (`web/`) is a living side-view tank: day/night, themes, hood
lights, glass, sand dunes, seed-derived coral, and fish whose body plan comes
from each species' traits. Click a fish to inspect its generation, inherited
mutations, and living ancestors; mutants shimmer. Below the tank a census
strip charts every species' population over the last 240 ticks, the log
stamps each event with its tick, and the shelf keeps tanks you save in your
browser. The lab installs as an offline app. Keyboard: F feed, T tap,
L lights, Space pause, S photo, C census.

`web/engine.js` mirrors `src/mnemoquarium/model.py` rule for rule (the hash
functions differ, so the same phrase grows a different but equally
deterministic tank in each).

The project is intentionally small enough to read in one sitting:

- `src/mnemoquarium/model.py` — simulation core
- `src/mnemoquarium/display.py` — shared cell occupancy helpers
- `src/mnemoquarium/render.py` — ANSI rendering
- `src/mnemoquarium/export.py` — SVG tank, JSON, and Markdown exporters
- `src/mnemoquarium/cli.py` — argument parsing and orchestration
- `src/mnemoquarium/snapshot.py` — JSON snapshots, history, lineage export
- `web/engine.js` — browser port of the simulation core
- `web/tank.js` — canvas side-view aquarium
- `web/app.js` — lab UI: census strip, log, inspector, shelf
- `web/deep/` — the submarine game (see [The Deep](#the-deep) above)