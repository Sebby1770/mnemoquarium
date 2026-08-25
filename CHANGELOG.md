# Changelog

All notable changes to **mnemoquarium** are documented here.

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