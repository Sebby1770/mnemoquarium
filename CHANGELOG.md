# Changelog

All notable changes to **mnemoquarium** are documented here.

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