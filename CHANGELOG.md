# Changelog

All notable changes to **mnemoquarium** are documented here.

## [0.9.0] - 2026-09-13

### Added
- **The Deep** (`web/deep/`) — the aquarium turned inside out. You are in a
  first-person submarine, in a sea grown from the same phrase, and the fish are
  worth money. Net them with a capture beam, sell them at the Hull, refit, and
  find out what lives below your pressure rating. No build step; three.js r160
  is vendored, so it runs off a static file server and offline.
- The genetics are not re-implemented for the game: `web/engine.js` now also
  publishes itself on `globalThis.MnemoEngine`, and the game's `ecology.js`
  grows every species through the same `makeSpecies` / `inheritGenome` /
  `pointMutation` rules the 2D tank uses. A word of your phrase becomes a
  species; its expressed traits become a body, a temper, and a price. A fish
  that carries an inherited mutation sells for more than its siblings, which is
  heredity finally showing up on an invoice.
- **Five depth bands**, each with its own light, fog, flora, residents and
  monsters: the Sunlit Shelf, the Kelp Cathedral, the Twilight Drift, the
  Midnight Reach, and The Forgetting. The seabed is one deterministic
  heightfield that slopes from 62 m under the station to 1,400 m at the rim, so
  every band is reached by swimming, not by a menu.
- **Twelve upgrades** in the drydock: hull plating, pressure casing, impeller,
  cargo hold, cell array, floodlights, sonar array, capture beam, harpoon,
  torpedo tubes, repair drone, trickle reactor. Pressure rating gates depth,
  depth gates money, money buys rating.
- **Six things that hunt you**: reef sharks, glass squid that clamp on and
  drain the cell, lantern anglers that wait in the dark with a light on, a
  segmented leviathan, a Forgetting Wraith that takes a specimen out of the
  hold and out of the record, and the Kraken of Static in the abyss.
- Three weapons (harpoon, torpedo, sonar lance), a sonar ping that paints
  contacts on the HUD, a compass that always knows the bearing home, a rolling
  log, a market, a manifest of the species you have actually caught, and a save
  that survives the tab.
- Tests for the parts that run without a GPU (`web/tests/deep.test.mjs`):
  determinism, the water column never being empty, depth and mutation pricing,
  the upgrade table, and a save file that degrades instead of throwing.
- `web/tests/parse-modules.mjs` compiles every deep module eagerly in CI.
  `node --check` pre-parses function bodies lazily and will pass a file the
  browser then refuses with an unattributed `SyntaxError`; this catches it.

### Changed
- The 2D lab links out to the dive, and the dive links back. Nothing about the
  tank's behaviour changed — same engine, same tests, same tank.

## [0.8.0] - 2026-09-02

### Added
- **Heredity.** The eight low bits of every genome are an expressed region
  that children inherit from their parent. A point mutation flips exactly one
  bit, so a mutant's descendants carry a visibly different appetite,
  curiosity, thrift, or hue until the line mutates again. Every advantage
  has a cost (bigger appetite burns energy, thrift delays breeding), so
  selection has tension instead of one winning genome.
- Organisms record `generation`, `parent`, `born`, and `lineage_mutations`;
  `World.genealogy()` and `World.lineage_of()` summarise who descends from
  whom. Census, snapshots, history CSV, and the Markdown field report all
  include generation depth and mutant counts, and snapshots now round-trip
  the mutation/predation/extinction counters.
- `--lineage PATH` writes a JSON genealogy with every living organism's
  ancestry pointers and expressed traits.
- Browser lab: a **census strip** (stacked population history by species,
  with nutrient shading and weather markers; key C), a **tick-stamped log**,
  a **lineage inspector** (generation, inherited mutations, living
  ancestors, trait chips), and a **shelf** of saved tanks in localStorage.
- Mutant fish shimmer with an iridescent sheen; hue and girth express the
  inherited traits so siblings look alike.
- Installable offline: web manifest, service worker, and an SVG icon.
- Browser engine test suite (`node --test web/tests`) and a CI job for it.

### Changed
- Version bumped to 0.8.0. `mnemoquarium` exports `Traits` and
  `genome_traits`. Population dynamics are a little leaner than 0.7 because
  traits now trade off against each other.

## [0.7.0] - 2026-08-25

### Changed
- **Slow cinema tank** — default tempo is much slower (~2s per tick). Fish
  glide between cells instead of darting; tails, fins, bubbles, and caustics
  move at aquarium pace. Tap-the-glass startle is gentler.
- **More realistic fish** — larger bodies, scale rows, gill slit, lateral line,
  belly/dorsal highlights, and an iris that matches species hue.
- Version bumped to 0.7.0.

## [0.6.0] - 2026-08-25

### Added
- Living tank in the browser lab: day/night cycle from season, tick, and
  wall-clock, with a smooth blend, moon/stars in the room, and a HUD clock.
- Themes — reef, kelp forest, moonlit — with a hood picker and `theme=` in
  the share URL hash.
- Loose schooling for tetras and guppies (same-species alignment/cohesion).
- Save photo downloads a PNG of the canvas; keyboard S.
- Optional Web Audio (off by default): bubble pops and a low water bed,
  started only from the Sound toggle.
- Keyboard: F feed, T tap, L lights, Space play/pause, S snapshot.
- `prefers-reduced-motion` damps bob, caustics, and plant sway.
- Hang-on filter and heater gadgets on the glass.
- HUD shows phase, clock, and theme; SVG specimens get a moonlit night tint.

### Changed
- Version bumped to 0.6.0.

## [0.5.0] - 2026-08-25

### Added
- Side-view aquarium in the browser lab: glass tank, hood lights, sand bed,
  branching coral, anemones, kelp, bubbles, shrimp, and a glass snail.
- Six fish morphologies (tetra, guppy, angelfish, betta, catfish, eel) derived
  from species traits, with smooth swimming between ticks.
- Feed flakes, tap-the-glass startle, click-to-inspect, lights, fullscreen.
- Compare mode now draws two live mini-tanks.
- SVG specimen export is a side-view tank (sand, coral, fish) instead of a
  glyph grid.

### Changed
- Version bumped to 0.5.0.

## [0.4.1] - 2026-08-18

### Added
- Browser lab on GitHub Pages: live habitat canvas, play/step, share links,
  and phrase compare. Source lives in `web/`.

## [0.4.0] - 2026-08-18

### Added
- Seasons (spring / summer / autumn / winter) that change weather cadence
- `--seed` to override the phrase-derived world seed
- Census includes the current season

## [0.3.0] - 2026-08-18

### Added
- Mutations on split (genome flicker; occasional species drift)
- Predation when a hungrier organism shares a cell with a weaker neighbour
- Drought weather on tick 41
- Extinction tracking and a JSON `--census` report
- Tests for drought and census

### Changed
- Snapshots include mutations, predations, and extinctions
- Version bumped to 0.3.0

## [0.2.0] - 2026-07-04

### Added
- JSON snapshot replay via `--replay`
- Rich JSON exports with full world state (organisms, nutrients, species catalog)
- History exports: `--record-history`, `--history-csv`, `--history-interval`
- Standalone HTML gallery export (`--export-html`) with React Bits–inspired aurora UI
- Phrase comparison mode: `--compare "phrase a" "phrase b"`
- Population sparkline on stderr (`--sparkline`)
- Shared `display.py` and `snapshot.py` modules
- CLI validation, TTY-safe animation, and `--max-species`
- Overcrowded cell count indicators in terminal and SVG
- 15 tests and GitHub Actions CI across Python 3.10–3.13
- `CHANGELOG.md`

### Changed
- Species exports now include `seed` and `ansi_color` for faithful replay
- Unique glyph assignment even with long phrase word lists
- Version bumped to 0.2.0

## [0.1.0] - 2026-07-04

### Added
- Deterministic phrase-fed artificial life simulation
- ANSI terminal rendering and SVG/JSON/Markdown exporters
- Installable CLI (`mnemoquarium`) and core test suite