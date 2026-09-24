# Mnemoquarium

**Play it:** [https://sebby1770.github.io/mnemoquarium/](https://sebby1770.github.io/mnemoquarium/)

A first-person submarine game in a sea grown from words. Every word becomes a
species down there — its colour, its size, its temper, its price. Net what you
find, sell it at the Hull, and buy a casing that can take you lower than the
last one could.

The same words always grow the same sea, so you can learn a trench the way you
learn a room.

![the deep](https://sebby1770.github.io/mnemoquarium/icon.svg)

## Play

Press **Dive**. That is the whole menu — it picks a sea for you and drops you
in the water. If you want a particular one, *Grow a sea from your own words* at
the bottom of the menu takes any phrase you like.

| | |
| --- | --- |
| `W` `A` `S` `D` | thrust |
| `Space` / `C` | rise / dive — keep rising and you surface |
| `Shift` | boost |
| mouse | look (click once to lock) |
| `LMB` | fire |
| `RMB` | capture beam — hold it on a fish |
| `1` `2` `3` `4` | harpoon / torpedo / sonar lance / drift net |
| `Q` / mouse wheel | next weapon (skips what the drydock has not fitted) |
| `F` | floodlights |
| `R` | sonar ping |
| `M` | sea chart |
| `E` | dock at the Hull |
| `Tab` | look in the hold |
| `Esc` | pause |

**The surface.** Keep rising and the tower breaks through into air: a sky,
a swell that rocks the boat, and a diesel that charges the cell for free while
you sit up there. From underneath, the surface is a bright window of sky
overhead.

**The loop.** Dive from the Hull → hold the beam on a fish until it comes in →
come back, sell the hold, refit → go deeper than you could last time.

**Pressure is the gate.** The stock casing is rated to 140 m. Go much past it
and the sea starts folding the boat shut — and everything worth real money
lives below your rating. Buy the Pressure Casing first.

**Your lamps are how they find you.** `F` kills them. Running dark is cheaper
and much worse.

**The chart.** `M` holds the boat and opens the sea chart: the floor drawn from
the same heightfield you fly over, the Hull, the way you came since you left
the clamps, and an amber line where the floor drops past what your casing is
rated for — inside it you can touch bottom. Landmarks you have surveyed are
marked and named. The ones you have not are only rumours: a dashed circle
somewhere near the truth. The survey fee is for going there.

**Graphics.** The pause panel has a *Graphics* setting. *Auto* (the default)
watches the frame time and lowers the render resolution when the GPU cannot
keep up, then earns it back slowly when it can. *Sharp* pins full resolution;
*Fast* pins it low.

### The water column

The sea is about 4 km across and it is a **margin, not a bowl**: the phrase
picks a direction, and that side is a broad continental shelf you can work for
a long time while the opposite side falls away early into the basin. At 2 km
out the floor might be 200 m under you or 1,300 m, depending only on which way
you went.

Things worth navigating by: a **shelf break** where the shelf gives up — over
200 m of drop in 120 m of travel, running across the map as a coastline you can
follow; two **trench arms** that meet; and a dozen **seamounts**, some rising
400 m off the basin floor and breaking up out of the dark.

Every band is reached by swimming, not by a menu.

| band | depth | what it costs you |
| --- | --- | --- |
| Sunlit Shelf | 0–90 m | nothing. it has also been picked over |
| Kelp Cathedral | 90–240 m | green columns, and things that hold on |
| Twilight Drift | 240–520 m | the last of the light, spending itself |
| Midnight Reach | 520–980 m | no light but the light that wants you closer |
| The Forgetting | 980 m+ | where the tank keeps what it could not hold |

### What hunts you

Reef sharks run straight at you. **Static lamprey** arrive as a knot of ten and
are only a problem together. Glass squid clamp on and drain the cell. Lantern
anglers hang still in the dark with a light on. A **trapjaw** lies flat in the
silt wearing the colours of the floor and does not move until you are close.
A **gulper** is mostly mouth. A leviathan is longer than your lamps reach. A
**hull-light siren** hangs a slowly turning docking ring in the abyss, the same
warm colour as the Hull's — there is no dock. A Forgetting Wraith takes a
specimen out of your hold *and out of your record*. The Kraken of Static lives
down there too and is not a fair fight yet.

Between you and them: boulder clusters, coral towers up to 40 m, and curtains
of weed thick enough to lose something in.

### Places worth finding

Eighteen landmarks, placed by the phrase, from 57 m down to 1,400: wrecks
broken in two with a gap you can fly through, hydrothermal vent fields, whale
falls with the scavengers still on them, rock arches, kelp groves far deeper
than kelp belongs, drowned lights still turning, and boneyards of shells and
anchors. Reaching one for the first time pays a survey fee that scales with
how deep you had to go to do it.

## Where the fish come from

This is the part that makes it mnemoquarium and not just a submarine game.

Each distinct word in a phrase becomes a species. The phrase hash chooses its
traits — appetite, curiosity, stubbornness, lifespan, hue — and those traits
become a body plan, a home depth, a temper, and a price.

### Heredity

Each genome carries an expressed region of eight bits. A child inherits those
bits from its parent, and a point mutation flips exactly one of them, so the
appetite, curiosity, thrift, or hue of a mutant is passed down its line.

Down here that shows up on an invoice. A specimen carrying an inherited
mutation is worth more than its siblings, because the market pays for something
it has not seen before:

| specimen | lineage | sells for |
| --- | --- | --- |
| glass-kiosk-listener | gen 1 | 11 cr |
| glass-kiosk-listener | gen 2 · 1 inherited | 14 cr |
| glass-kiosk-listener | gen 3 · 1 inherited | 15 cr |

Value also scales with the depth you took it from, so the same fish is worth
several times more if you carried it up from the dark.

## How it is built

No build step, no bundler, no runtime dependencies beyond a vendored copy of
three.js r160. The modules are plain ES modules behind an importmap, and the
whole thing installs offline. Serve the `web/` folder with any static server.

```bash
python3 -m http.server 8765 --directory web
```

- `web/engine.js` — the genetics: species, genomes, inheritance, mutation
- `web/src/water.js` — the underwater light model: absorption, scattering, caustics
- `web/src/sky.js` — the sky, the sea surface from both sides, and the swell
- `web/src/post.js` — HDR bloom and the per-depth colour grade
- `web/src/landmarks.js` — the places worth finding
- `web/src/ecology.js` — phrase to species to price
- `web/src/world.js` — seabed, depth bands, flora, the Hull
- `web/src/sub.js` — flight, systems, pressure, the cockpit
- `web/src/fish.js` — shoals, boids, the capture
- `web/src/creatures.js` — the six, and their manners
- `web/src/combat.js` — harpoon, torpedoes, sonar lance, the beam
- `web/src/hud.js` — instruments, market, drydock, manifest
- `web/src/chart.js` — the sea chart
- `web/src/nav.js` — bearings, ranges, rumours (shared by the compass and the chart)
- `web/src/quality.js` — the resolution governor
- `web/ARCHITECTURE.md` — the contract every module is written against

`web/engine.js` mirrors `src/mnemoquarium/model.py` rule for rule, so the
terminal simulator below and the game grow fish by the same laws.

## The terminal simulator

The original mnemoquarium: a deterministic artificial-life lab for the
terminal, pure standard library, no runtime dependencies. The game's genetics
are a port of it.

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

Each distinct word becomes a species that roams a wraparound nutrient field,
eats, reproduces, starves, and occasionally gets hit by weather like
remembering tides and static blooms. Because all randomness is seeded from the
phrase, the same command always produces the same final fossil hash — a
BLAKE2b digest of the whole simulation state.

Export a specimen:

```bash
PYTHONPATH=src python3 -m mnemoquarium \
  "library dust with electric teeth" \
  --steps 96 \
  --export-svg out/specimen.svg \
  --export-json out/specimen.json \
  --report out/field-report.md
```

Compare two phrases, or record a population time series:

```bash
PYTHONPATH=src python3 -m mnemoquarium --compare "neon rain" "static bloom" --steps 64
PYTHONPATH=src python3 -m mnemoquarium "library dust" --steps 96 \
  --record-history out/history.json --history-csv out/history.csv
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

- `src/mnemoquarium/model.py` — simulation core
- `src/mnemoquarium/render.py` — ANSI rendering
- `src/mnemoquarium/export.py` — SVG tank, JSON, and Markdown exporters
- `src/mnemoquarium/cli.py` — argument parsing and orchestration
- `src/mnemoquarium/snapshot.py` — JSON snapshots, history, lineage export

## Development

```bash
PYTHONPATH=src python3 -m unittest discover -s tests            # simulation core
node --test "web/tests/*.test.mjs"                              # engine + game logic
node --experimental-vm-modules web/tests/parse-modules.mjs      # compile the game modules
```

That last one exists because `node --check` pre-parses function bodies lazily:
a malformed literal inside a method passes the check and then fails in the
browser as a bare `SyntaxError` with no file and no line. Compiling each module
eagerly catches it and names the file.

See [CHANGELOG.md](CHANGELOG.md) for release history.
