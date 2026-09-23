# Changelog

All notable changes to **mnemoquarium** are documented here.

## [1.4.0] - 2026-09-23

### Added
- **A sky, and a surface you can come up through.** The boat used to hit a
  ceiling at -1.4 m under a bright sheet of scrolling blobs with light cones
  hanging off it. Now there is a real sea surface — a wave field you can float
  on — and a sky with a sun and moving cloud above it. Hold Space and the tower
  breaks the surface; the boat rides the swell and rocks with it, and the
  diesel charges the cell for free while you sit up there. C takes you down.
- **Snell's window.** From underneath, the surface is the bright disc of sky
  you only see looking up inside about 48 degrees of vertical, bent by the
  waves, with the rest of the underside mirroring the dark water below. The
  swell the boat floats on and the swell you see are the same function.
- **Post-processing, with no addons**: the scene renders to a half-float target
  so a lamp, a vent or the sun can be brighter than white, and a dual-filter
  bloom lets that bleed into the water. The composite tone-maps and grades
  contrast and saturation per depth band — saturated on the shelf, drained in
  the abyss — with a vignette and a little grain. Measured cost on top of the
  frame: 0 to 1.7 ms at a 2400 x 1520 buffer.
- **A reef.** Branching staghorn with bright growing tips, brain coral with
  meandering grooves, tiered table coral, and tube sponges, in reef colours
  that the water drains with depth the way it really does.
- **Reef bommies** built out of coral heads stacked into a mound around a
  rock core, instead of one displaced column (which read as a giant blue egg).
- **Kelp you can get lost in**: stands of giant kelp with blades up the stipe,
  and sea fans, swaying in the shader.

### Changed
- **Rocks are rocks.** Displaced by three scales of noise with cracks cut in,
  welded so they shade smooth rather than faceted, with baked ambient occlusion
  (dark in the hollows and underneath) and moss on the tops that thins out with
  depth and gives way to silt.
- **Sharks swim.** Every fish-shaped creature bends with a travelling wave that
  starts at nothing at the snout and grows toward the tail, computed in the
  creature's own frame so fins and tail bend with the body instead of coming
  apart. Whales wave up and down. Countershading and a lamp rim-light come with
  it. The shark lost the separate belly mesh that made it look like a beluga,
  and got a darker back and a pointed snout.
- **Weed, kelp and fans sway on the GPU.** The old sea-fan and kelp fields were
  one draw call per clump — about 300 of them — for CPU sway. Now they are
  streamed and instanced like the rest of the scenery: **354 draw calls down to
  51** while adding 1,400 kelp stalks and 650 fans, with fewer triangles.
- The god-ray cones and the old surface sheet are gone.
- The cockpit glass streaks are gone: against a bright sky they read as white
  bars across the view.
- Vent fields carry a warm halo that survives the water, so they read as a glow
  in the black from a hundred metres off; fish bioluminescence is a soft round
  glow instead of a square.

### Fixed
- The world clamp still had its own "the surface is not an exit" ceiling at
  -2.5 m, and hitting it logged "the current leans on you", which was about the
  edge of the world, not the top of it.
- The Tidewarden and the Ninefold never had their follow-the-leader trail
  seeded (only the leviathan did), so their bodies started collapsed onto the
  head.

## [1.3.0] - 2026-09-22

### Fixed
- **You could not see the big scenery, because it was not there.** Nine hundred
  props scattered over fifty-five square kilometres put a measured *two* of
  them within 120 m of the boat, against a fog-limited view of about 150. The
  field is streamed now: the world is cut into cells, a cell's contents are a
  pure function of (seed, cell), and only the cells near the boat are written
  into the instance buffers. Same determinism, same draw-call budget — and 21
  props within 150 m instead of 2, the nearest at 24 m.
- **The drift net could never reach anything.** It shed 92% of its speed every
  second and stopped twelve metres out, and it opened so slowly that fish it
  started next to had fled before it could close. Drag only applies once it is
  open and is gentler, it opens in a quarter of a second, and it throws
  further. It now takes its full capacity out of a shoal.

### Added
- **The drift net** (`4`). The capture beam takes one fish while something with
  teeth decides what it thinks of you holding still; the net takes a whole
  shoal for one throw and one cell's worth of charge. Bought in the drydock,
  three fish a cast at mark 1 and twelve at mark 4. A full net keeps the dear
  ones and lets the rest through the mesh.
- **Eighteen landmarks**, seven kinds, placed by the phrase from 57 m to
  1,431 m: wrecks broken in two with a gap you can fly through, hydrothermal
  vent fields, whale falls, rock arches, deep kelp groves, drowned lights still
  turning, and boneyards. Finding one pays a survey fee that scales with depth.
  Geometry is built when you come within 460 m and given back when you leave.
- **Five more creatures with bodies of their own** — Old Grey and Grandmother
  Tooth (scarred apex sharks), The Sounding (a sperm whale that is not hunting
  you and will not turn for you), The Ninefold (nine bells on one chain), and
  The Tidewarden. Fifteen creature types now, all with distinct silhouettes.

### Changed
- **The shark is an animal instead of a missile.** Its body was a symmetric
  spindle — widest in the middle, pointed at both ends — which is the shape of
  a torpedo. Girth now peaks a third back from a blunt snout and runs down a
  long taper to a narrow peduncle, the back half is squeezed flat sideways, the
  tail is a crescent with a much longer upper lobe, and it has an underslung
  mouth, five gill slits, an eye and a second dorsal.
- Boulders are rounder; they were stretching into slabs.

## [1.2.0] - 2026-09-13

### Added
- **Four new things that want you dead.**
  - **Static Lamprey** — arrives as a knot of six to eleven. One is nothing,
    which is the point; they are what the Sonar Lance is for.
  - **Trapjaw** — lies flat in the silt wearing the colours of the floor and
    does not move at all until you are within about fifty metres, then lunges
    at four times its cruising speed. "the floor opens. it was never the floor."
  - **Gulper** — mostly mouth, with an animal apologising behind it. A thin
    line of light down the tail is the only warning.
  - **Hull-Light Siren** — hangs a slowly turning docking ring in the abyss,
    the same warm colour as the Hull's. There is no dock.
- **Big scenery you fly between rather than over**: boulder clusters 10-30 m
  across, coral towers up to 40 m on the shelf, and curtains of weed thick
  enough that going through is a decision. Four instanced draw calls for the
  whole field.

### Changed
- **A much wider view out of the boat.** Field of view raised from 68 to 78,
  and the cockpit window is now cut to the actual frustum rather than pinned to
  fixed coordinates — so it frames whatever screen you are on instead of eating
  a chunk of it, and the two heavy diagonal struts are down to slivers in the
  top corners. It re-cuts itself on resize and when boost widens the view.
- **The drydock is a list, not a wall of cards.** One row per refit carrying
  only what you need to decide — what it is, where it is now, where it goes,
  what it costs — with the ones you can actually afford sorted to the top and
  the rest dimmed.
- **The menu is quieter.** One line says what the sea is ("5 species · Sunlit
  Shelf down to The Forgetting · best 48 cr"), the species cards are tighter,
  and the controls and the phrase box fold away so the eye lands on Dive.
- Hostile budgets raised in the three deepest bands, and the spawn tables
  rebalanced so every band has something new in it.

## [1.1.0] - 2026-09-13

### Added
- **Real underwater light.** Distance fog is a lie that reads as smoke; water
  eats light one colour at a time. Every lit surface now runs per-channel
  Beer-Lambert absorption with in-scattering, patched into three's shaders via
  `onBeforeCompile` (no addons), so red dies within metres, blue carries, and
  distance goes the colour of the water rather than the colour of fog.
  In-scattered light also dies with the sunlight that causes it, which is what
  stops a thousand metres down from looking like bright haze.
- **Caustics** projected onto the seabed and anything else facing up, fading
  out with the daylight by about 150 m.
- **Silt**: the water thickens near the floor, where you stir it up.

### Changed
- **The world is a margin, not a bowl.** Depth used to be essentially a
  function of distance from the Hull, so every heading was the same journey.
  There is now a continental shelf on one side and a basin on the other, chosen
  by the phrase: at 2 km out the floor ranges from about 200 m on the shelf
  side to 1,300 m over the basin.
- **Grown from 1.5 km to 4.2 km across**, with the depth bands mapping onto
  real distance — the Sunlit Shelf starts a few hundred metres from the Hull
  and The Forgetting is a two-and-a-half kilometre swim.
- **A shelf break** you can navigate by: a genuine escarpment, over 200 m of
  drop in 120 m of travel, wandering across the map rather than ringing it.
- **Two trench arms** that meet, instead of one meander.
- **Seamounts**: 9-13 isolated peaks, some rising 400 m off the basin floor and
  breaking up out of the dark into the twilight, visible from a long way out.
- Terrain is domain-warped, so ridgelines wander instead of reading as noise.
- Terrain now streams: a 1.76 km detail tile at 10 m resolution follows the sub
  over a coarse backdrop, rebuilt a couple of rows per frame (about 2.8 ms
  while it runs, and it only runs for a second or so every twenty seconds of
  travel). `heightAt` reads that tile, so what you collide with agrees with
  what you can see to within 0.7 m — at the old grid it had drifted to 2 m.
- The seabed is darker and shaded by slope, so sand, rock and silt read apart.
- Nothing breaches the surface any more.

### Fixed
- The game could hang forever on "flooding the tanks" if it was opened in a
  background tab: boot waited on `requestAnimationFrame`, which a tab that is
  not painting never fires. It now takes whichever of the frame or a short
  timeout arrives first.

## [1.0.0] - 2026-09-13

### Changed
- **The game is the site now.** `web/deep/` moved up to `web/`, so
  https://sebby1770.github.io/mnemoquarium/ opens straight into The Deep
  instead of a landing page in front of it.
- **No phrase to type.** The front menu is a title, a **Dive** button, and a
  quiet panel showing what the sea it picked for you has in it. A returning
  player gets **Continue** with their credits and deepest dive on it instead.
  Seas are drawn from a curated list; *show me another sea* rerolls, and
  *Grow a sea from your own words* at the bottom still takes any phrase — it
  is just no longer a thing you must deal with before you can play.
- **Dive starts in the water.** Previously the first thing after the menu was
  the station panel; now you spawn outside the Hull with the dock prompt
  within reach, so the shop is a choice rather than a gate.
- Starting a new sea, or typing a different one, asks for confirmation before
  it overwrites a run worth keeping.

### Removed
- **The 2D side-view tank** (`web/index.html`, `web/tank.js`, `web/app.js` and
  its stylesheet). The browser half of the project is the game now.
- `web/engine.js` stays, and is unchanged: it is the genetics both the game and
  the Python simulator grow fish by, not part of the old tank's UI.

### Kept
- The terminal simulator (`mnemoquarium` on the CLI) and its 32 tests are
  untouched. It remains the reference implementation `web/engine.js` mirrors.

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