# Mnemoquarium: The Deep — module contract

A first-person submarine game grown from the same phrase-fed genetics as the 2D
tank. **This file is the contract.** Every module is written against it; if two
modules disagree the one that broke this file is wrong.

## Ground rules

- Plain ES modules in `web/deep/src/`. **No build step, no bundler, no TypeScript.**
- The only dependency is three.js r160, vendored at `web/deep/vendor/three.module.min.js`
  and mapped to the bare specifier `three` by an importmap in `index.html`.
  Always `import * as THREE from "three";`. Never import three.js addons
  (`three/examples/...`) — they are not vendored. Write controls/loaders yourself.
- House style, matching the rest of the repo: 2-space indent, double quotes,
  semicolons, `const`/`let`, no classes-for-the-sake-of-it, short literate
  comments that say *why*. No emoji in code. Keep user-facing strings in the
  project's voice — plain, slightly haunted, lowercase-ish, never jokey.
- Every module must pass `node --check <file>`.
- Never use `Math.random()` for anything that must be reproducible from the
  phrase (world shape, species, spawn tables). Use the seeded helpers in
  `util.js` / `mnemo.js`. Cosmetic per-frame jitter may use `Math.random()`.
- Performance target: 60 fps with ~400 fish and ~8 creatures on integrated
  graphics. Use `THREE.InstancedMesh` for fish and flora, pool particles and
  projectiles, never allocate `new THREE.Vector3()` inside a per-frame loop
  (hoist scratch vectors to module scope).
- Dispose properly: every class exposes `dispose()` that removes its objects
  from the scene and frees geometries/materials it created.

## Coordinates and units

- three.js default Y-up. The sea surface is `y = 0`. **Depth = `-y`, metres.**
- Seabed is a single heightfield: `world.heightAt(x, z)` returns a negative y.
- 1 unit = 1 metre. Speeds are m/s, damage is hull points, money is credits.

## Files, and who owns what

| file | owner module | exports |
| --- | --- | --- |
| `src/config.js` | **already written — read, never edit** | `SEA, ZONES, RARITY, SUB, WEAPONS, UPGRADES, CREATURES, ECONOMY, HOTKEYS, zoneForDepth(), zoneIndex()` |
| `src/util.js` | **already written — read, never edit** | `clamp, clamp01, lerp, invLerp, smoothstep, smootherstep, damp, moveTowards, wrapAngle, randRange, randInt, weightedPick, makeRng, hash01, valueNoise2D, fbm2D, ridge2D, formatCredits, formatDepth, titleCase, hslHex, TAU` |
| `src/mnemo.js` | **already written — read, never edit** | `Rng, World, fnv, genomeTraits, inheritGenome, makeSpecies, pointMutation, traitsLabel, wordsFromPhrase, EXPRESSED_MASK, DEFAULT_PHRASE` |
| `src/bus.js` | **already written — read, never edit** | `Bus` with `on/once/off/emit/clear` |
| `index.html` | **already written — read, never edit** | markup + importmap; every HUD element id is fixed there |
| `src/ecology.js` | agent | `Ecology` |
| `src/progression.js` | agent | `computeStats, upgradeLevel, upgradeCost, canAfford, applyUpgrade, fishValue, trophyItem, describeStats` |
| `src/world.js` | agent | `SeaWorld` |
| `src/vfx.js` | agent | `VFX` |
| `src/fish.js` | agent | `FishManager` |
| `src/creatures.js` | agent | `CreatureManager` |
| `src/combat.js` | agent | `Combat` |
| `src/sub.js` | agent | `Submarine` |
| `src/hud.js` + `styles.css` | agent | `HUD` |
| `src/audio.js` | agent | `Audio` |
| `src/save.js` | agent | `loadProfile, saveProfile, newProfile, clearProfile, SAVE_KEY, migrate` |
| `src/game.js` + `src/main.js` | agent | `Game`; `main.js` has no exports |
| `src/chart.js` | agent | `Chart` — the sea chart panel (`M`), built from JS |
| `src/nav.js` | agent | `bearingOf, compassPoint, formatRange, rumourCentre, COMPASS_POINTS, RUMOUR_RADIUS` — no three.js |
| `src/quality.js` | agent | `ResolutionGovernor, pixelRatioFor, SCALE, QUALITY_MODES` — no three.js |

## The `game` object

Every subsystem is constructed as `new Thing(game)` and may read/call anything
below. Subsystems must not reach into each other's private fields — only the
documented API.

```js
game = {
  canvas, renderer, scene, camera, clock,   // three.js plumbing
  bus,                 // Bus
  phrase, seed,        // string, uint32 (seed = fnv(["mnemoquarium-deep", phrase]))
  rng,                 // seeded Rng for setup-time randomness
  profile,             // persisted player profile (see save.js)
  stats,               // result of progression.computeStats(profile.upgrades)
  ecology, world, sub, fish, creatures, combat, vfx, hud, audio,
  mode,                // "boot" | "start" | "dive" | "station" | "paused" | "chart" | "dead"
  elapsed,             // seconds of dive time
  dt,                  // last frame delta, clamped to <= 1/20
  paused,              // bool
  setMode(mode),       // emits "mode"
  log(text, kind),     // kind: "info"|"good"|"bad"|"warn"|"lore"
  toast(text),
  addCredits(delta, reason),
  recomputeStats(),    // after an upgrade: refresh game.stats and sub systems
  persist(),           // debounced save of game.profile
}
```

Construction order in `game.js`: `save -> ecology -> world -> vfx -> sub -> fish
-> creatures -> combat -> audio -> hud`.
Update order each frame: `sub -> world -> fish -> creatures -> combat -> vfx ->
audio -> hud`, then `renderer.render(scene, camera)`.

## Shared data shapes

```js
// SpeciesSpec — ecology.species[i], stable for a given phrase
{
  index, name, word, glyph, hue, seed,          // from the mnemoquarium engine
  appetite, curiosity, stubbornness, lifespan,  // engine traits
  kind,        // "tetra"|"guppy"|"angel"|"betta"|"catfish"|"eel"
  zoneId, zone,          // home depth band (config.ZONES entry)
  size,        // body length in metres, ~0.25..2.6
  speed,       // cruise m/s
  schooling,   // 0..1 — how tightly it shoals
  skittish,    // 0..1 — how hard it flees the sub
  glow,        // 0..1 bioluminescence
  rarity,      // "common"|"uncommon"|"rare"|"mythic"
  baseValue,   // credits before rarity/depth multipliers
  colorHex, bellyHex, glowHex,   // ints, e.g. 0x44ffaa
  description, // one line of flavour
}

// FishInstance — runtime, owned by FishManager
{
  id, species, position /*Vector3*/, velocity /*Vector3*/, heading, scale,
  genome, generation, mutations, traits /*genomeTraits()*/,
  value, rarity, alive, capturing /*0..1*/, shoal,
}

// CargoItem — persisted in profile.cargo
{
  id, kind: "fish"|"trophy", speciesIndex, name, word, glyph, hue,
  rarity, value, depth, genome, generation, mutations, label,
}

// Creature — runtime, owned by CreatureManager
{
  id, type /*config.CREATURES entry*/, hp, hpMax,
  position /*Vector3*/, velocity /*Vector3*/, heading,
  state /*"idle"|"patrol"|"hunt"|"attack"|"flee"|"dead"*/, stateTime,
  object /*THREE.Object3D*/, radius, alive, stun, lastAttack, aggro /*bool*/,
}

// Profile — persisted (save.js)
{
  version: 1, phrase, seed, credits,
  upgrades: { hull:0, pressure:0, thrust:0, cargo:0, battery:0, lights:0,
              sonar:0, capture:0, harpoon:0, torpedo:0, repair:0, reactor:0 },
  cargo: [CargoItem],
  ammo: { torpedo: 0 },
  stats: { dives:0, fishSold:0, creditsEarned:0, deepest:0, deaths:0,
           kills:{}, discovered:[] /* species indices seen */,
           landmarks:[] /* surveyed landmark ids, "lm-N" */ },
  settings: { sound:false, invertY:false, sensitivity:1, quality:"auto" },
  updated: 0,   // ms epoch
}
```

## Module APIs (exact)

### `ecology.js`
```js
export class Ecology {
  constructor(phrase, seed)
  phrase; seed; species;              // SpeciesSpec[]  (1..8 entries)
  speciesInZone(zoneId) -> SpeciesSpec[]      // never empty: falls back to nearest band
  rollIndividual(species, rng) -> { genome, generation, mutations, traits, value, rarity, scale }
  valueOf(species, individual, depth) -> credits
  describe(species) -> string
  roster() -> [{ index, name, word, glyph, zoneId, rarity, baseValue, colorHex }]
}
```
Species are derived from `makeSpecies(phrase, 8)` in `mnemo.js` — **do not invent
your own species generator.** Map engine traits onto game traits deterministically:
curiosity -> speed/skittishness, appetite -> size, stubbornness -> schooling,
hue -> colour (`hslHex`). Spread the species across `ZONES` so every band has at
least one resident (e.g. `zoneIdx = (index * ZONES.length / speciesCount)` mixed
with the species seed), and make the deepest bands rarer and worth more.
`fishKind` logic should mirror `web/tank.js`: appetite>=3 && curiosity<=2 ->
"catfish"; stubbornness>=6 -> "angel"; curiosity>=6 && appetite<=2 -> "tetra";
else seeded pick.

### `progression.js`
```js
export function computeStats(upgrades) -> {
  hullMax, pressureRating, thrust, maxSpeed, cargoSlots, batteryMax,
  lightRange, sonarRange, captureRange, captureTime, harpoonDamage,
  torpedoAmmo, torpedoUnlocked, repairRate, batteryTrickle, sonarCooldown,
}
export function upgradeLevel(upgrades, id) -> number
export function upgradeCost(upgrades, id) -> number|null   // null when maxed
export function canAfford(profile, id) -> boolean
export function applyUpgrade(profile, id) -> { ok, cost, level, reason }
export function fishValue(species, individual, depth) -> number
export function trophyItem(creatureType, depth) -> CargoItem
export function describeStats(stats) -> [{ label, value }]
```
All numbers come from `config.UPGRADES` / `config.SUB` / `config.ECONOMY`.
Derived stats not in the table: `maxSpeed = SUB.maxSpeedBase * (thrust / SUB.thrustBase)`,
`captureTime = SUB.captureTimeBase * (1 - 0.12 * level)` floored at 0.35,
`sonarCooldown = SUB.sonarCooldownBase * (1 - 0.15 * level)`.

### `world.js`
```js
export class SeaWorld {
  constructor(game)
  group; stationPosition /*Vector3*/; bounds /*{radius}*/;
  heightAt(x, z) -> number          // seabed y, negative, deterministic from game.seed
  normalAt(x, z, out) -> Vector3
  zoneAt(depth) -> zone             // config.zoneForDepth
  zoneAtPosition(vec3) -> zone
  distanceToStation(vec3) -> number
  isDockable(vec3) -> boolean       // within SEA.dockRadius and not too fast
  clampToBounds(position, velocity) -> boolean   // true when it pushed back
  sampleFlow(position, time, out) -> Vector3     // gentle drift current
  setZone(zone, immediate)          // lerps fog/light/water colour
  update(dt, cameraPosition)
  dispose()
}
```
Owns: seabed heightfield mesh (`SEA.terrainSize` / `SEA.terrainSegments`),
sea-surface plane seen from below, sun/ambient/hemisphere lights, `THREE.FogExp2`
whose colour/density lerps between zones, instanced flora (coral on the shelf,
kelp in the kelp band, tube worms and glowing polyps deeper), scattered rocks,
the station (a lit hull with a docking ring at `SEA.stationPos`), god rays near
the surface, and the marine-snow particle field that thickens with depth.
Heightfield shape: shallow reef shelf around the station (~`SEA.shelfDepth`),
falling away with distance to `SEA.trenchDepth` at the world rim, plus ridges
and a canyon from `fbm2D`/`ridge2D` seeded with `game.seed`. `heightAt` must be
the *same function* the mesh is built from — build the mesh by sampling it.

### `vfx.js`
```js
export class VFX {
  constructor(game)
  update(dt)
  bubbles(position, count, opts)          // opts: {spread, rise, size, life}
  hitSpark(position, colorHex)
  explosion(position, scale, colorHex)
  inkCloud(position, radius)
  bloodCloud(position, colorHex)
  captureSparkle(position, colorHex)
  sonarWave(origin, range)                // expanding translucent shell
  screenShake(amount)                     // read by sub.js via game.vfx.shake
  shake                                   // number, current shake amount 0..1
  dispose()
}
```
Pooled `THREE.Points` / sprites. Everything must be cheap and additive-blended.

### `fish.js`
```js
export class FishManager {
  constructor(game)
  all;                          // FishInstance[] (live)
  update(dt)
  beamTarget(range, coneCos) -> FishInstance|null   // best fish in the camera cone
  capture(fish) -> CargoItem|null                   // removes it, returns cargo
  raycast(origin, dir, range) -> { fish, distance, point }|null
  scatter(position, radius, force)
  countInZone(zoneId) -> number
  dispose()
}
```
Shoals spawn around the player by zone, despawn beyond ~1.8x view distance, and
are budgeted (max ~420 fish). Boids: cohesion/separation/alignment within a
shoal, flee the sub scaled by `species.skittish`, avoid terrain via
`world.heightAt`, drift with `world.sampleFlow`. One `InstancedMesh` per species
with a procedural low-poly fish body; glowing species get an additive sprite.
Capturing sets `fish.capturing` 0..1 as the beam holds and emits
`fish:captured` with the `CargoItem` when it completes.

### `creatures.js`
```js
export class CreatureManager {
  constructor(game)
  all; threatLevel;             // Creature[], 0..1
  update(dt)
  spawn(typeId, position) -> Creature
  raycast(origin, dir, range) -> { creature, distance, point }|null
  sphereHit(point, radius) -> Creature[]
  damage(creature, amount, opts) -> boolean     // true when the hit killed it
  nearestHostile(position, range) -> Creature|null
  pingReveal(range)             // sonar: outline hostiles for a few seconds
  dispose()
}
```
Spawn budget per zone from `zone.hostileBudget` / `zone.hostiles` (weighted).
Bodies are procedural: shark (streamlined body + fins), squid (mantle + eight
animated tentacles), angler (bulbous body + a glowing lure on a stalk),
leviathan (chain of `segments` that follows a spline), wraith (translucent
additive shell that phases), kraken (huge mantle + `arms` long tentacles, only
in the abyss, one at a time, boss-loud). AI states: patrol -> hunt when the sub
is within `type.aggro` (halved if the sub's lights are off) -> attack when
inside `type.attackRange` -> flee at low hp for non-boss beasts. Attacks call
`game.sub.damage(type.damage, creature)`; squid additionally
`game.sub.drainBattery(type.batteryDrain)`; wraith deletes one random cargo item
(the sea forgets it) instead of pure damage half the time. Deaths emit
`creature:killed` with `bounty` and a trophy `CargoItem` from
`progression.trophyItem`.

### `combat.js`
```js
export class Combat {
  constructor(game)
  weapons;          // [{ id, name, ammo, cooldown, ready }]
  currentIndex; currentWeapon;
  selectWeapon(i)
  firePrimary()     // respects cooldown, battery, ammo
  setBeam(active)   // right mouse: capture beam
  beamTarget;       // FishInstance|null — HUD reads this
  beamProgress;     // 0..1
  update(dt)
  dispose()
}
```
Harpoon and torpedo are pooled projectile objects with simple sphere-vs-creature
and vs-terrain collision; the sonar lance is a short-range hitscan cone that
stuns. Torpedo consumes `profile.ammo.torpedo`. Emits `combat:fire`,
`combat:hit`.

### `sub.js`
```js
export class Submarine {
  constructor(game)
  object;           // THREE.Object3D — the hull; game.camera is a child
  position; velocity; depth; speed; heading;   // live values, read-only outside
  hull; hullMax; battery; batteryMax;
  lightsOn; docked; cargoFull;
  stats;            // mirror of game.stats
  update(dt)
  applyStats()      // after an upgrade
  damage(amount, source)
  repair(amount)
  drainBattery(amount)
  drawBattery(amount) -> boolean        // false when there is not enough
  addCargo(item) -> boolean
  forward(out) -> Vector3
  nudge(impulse /*Vector3*/)
  setInputEnabled(enabled)
  dock(); undock(); respawn();
  ping()            // sonar: costs battery, emits "sonar:ping"
  dispose()
}
```
6-DOF-ish flight: mouse look drives yaw/pitch (pitch clamped to
`SUB.pitchClamp`), WASD thrusts in the camera basis, Space/C add vertical
thrust, Shift boosts while battery holds. Pointer lock is requested on click
while `game.mode === "dive"` and released for panels. Quadratic drag, a small
buoyancy pull toward neutral, camera shake from `game.vfx.shake`, hull damage on
terrain contact scaled by impact speed, and continuous pressure damage below
`stats.pressureRating` (warn first via `sub:pressure`). A first-person cockpit
frame (a few dark struts and a window rim) sits in front of the camera so the
player feels boxed in; keep it out of the crosshair.

### `hud.js` + `styles.css`
```js
export class HUD {
  constructor(game)
  update(dt)
  log(text, kind)
  toast(text)
  setMode(mode)
  refreshStation()   // market + drydock + manifest
  refreshCargo()
  refreshRoster()    // start screen species list
  dispose()
}
```
**Drives the exact element ids already in `index.html`** — do not add markup to
`index.html`; create any extra nodes from JS inside the containers that exist.
Ids available: `view, hud, vignette, damage-flash, crosshair, crosshair-ring,
crosshair-progress, crosshair-dot, reticle-label, contacts, topbar, compass,
compass-strip, compass-needle, zone-plate, readout-zone, readout-zone-blurb,
credit-plate, readout-credits, warnings, gauges, gauge-hull, gauge-battery,
gauge-cargo (each with .gauge-label/.gauge-track/.gauge-fill/.gauge-value),
instruments, readout-depth, readout-speed, readout-rating, readout-floor,
weapon-rack, sonar-note, log, toast, objective, hint-dock, panel-start,
start-form, start-phrase, start-begin, start-continue, start-roster,
start-reset, panel-station, station-credits, station-tabs, station-market,
market-summary, btn-sell-all, market-list, station-drydock, shop-list,
station-log, station-stats, station-species, btn-undock, panel-cargo,
cargo-list, panel-pause, pause-stats, btn-resume, btn-abandon, toggle-sound,
toggle-invert, range-sens, panel-dead, dead-headline, dead-detail, btn-revive,
loading, loading-text, loading-bar`.
Panels open/close by toggling the `hidden` attribute and `body[data-mode]`.
`styles.css` owns the whole look: dark instrument-panel aesthetic, thin
letterspaced labels, amber/cyan accents, `body[data-zone]` tints the HUD per
depth band, responsive down to a phone, and `prefers-reduced-motion` respected.
Also style the sonar `#contacts` markers (absolutely positioned divs the HUD
places from projected world positions).

### `audio.js`
```js
export class Audio {
  constructor(game)
  enabled;
  start(); stop(); toggle(enabled)
  sfx(name, opts)   // "harpoon","torpedo","hit","kill","capture","alarm","sell",
                    // "upgrade","dock","undock","roar","sonar","damage","explode",
                    // "click","deny","depth"
  setDepth(depth); setThrust(amount); setThreat(level)
  update(dt)
  dispose()
}
```
Pure WebAudio synthesis — no asset files. Nothing may make a sound until
`start()` is called from a user gesture; `AudioContext` must be created lazily
in `start()`.

### `save.js`
```js
export const SAVE_KEY = "mnemoquarium.deep.v1";
export function newProfile(phrase, seed) -> Profile
export function loadProfile() -> Profile|null      // null when absent/corrupt
export function saveProfile(profile)               // try/catch, quota-safe
export function clearProfile()
export function migrate(raw) -> Profile|null
```
Never throw on bad JSON or a disabled `localStorage` — degrade to in-memory.

### `game.js` / `main.js`
`Game` owns the renderer, the fixed-ish loop (`requestAnimationFrame`, dt clamp,
pause on tab blur), the mode machine, docking (auto-dock prompt inside
`world.isDockable`), selling, upgrading, death/respawn (lose
`SUB.respawnPenalty` of credits and the hold), and persistence. `main.js` boots:
feature-detect WebGL (fall back to a readable message linking `../index.html`),
read `?phrase=` from the URL, wire the start screen, construct `Game`, expose
`window.__deep = game` for debugging.

## Events on the bus

`log{text,kind}`, `toast{text}`, `mode{mode,prev}`, `sub:damage{amount,source,hull}`,
`sub:destroyed{cause}`, `sub:zone{zone,prev}`, `sub:pressure{over,depth,rating}`,
`sub:collide{speed}`, `sub:battery-empty{}`, `fish:captured{item,fish}`,
`fish:cargo-full{}`, `creature:spawn{creature}`, `creature:aggro{creature}`,
`creature:attack{creature,damage}`, `creature:killed{creature,bounty,item}`,
`combat:fire{weapon}`, `combat:hit{kind,amount,point}`, `sonar:ping{range}`,
`station:dock{}`, `station:undock{}`, `economy:sold{credits,items}`,
`economy:credits{credits,delta,reason}`, `economy:upgrade{id,level,cost}`,
`profile:changed{}`.

## The loop the game is actually about

dive -> net fish (deeper = rarer = worth more) -> survive what lives there ->
come back to the Hull -> sell -> refit -> the next band down is now survivable.
Pressure rating gates depth; depth gates money; money buys rating. Every zone
should feel like it costs something new.
