/* Tuning bible for the deep. Every subsystem reads its numbers from here so a
   balance change is one edit, not nine. Units are metres, seconds, credits.
   Y is up; the surface is y = 0; depth is -y. */

export const SEA = {
  worldRadius: 4200,        // soft boundary — past this the current shoves you back
  terrainSize: 9600,        // heightfield extent (x and z)
  terrainSegments: 220,     // resolution of the coarse skirt behind the chunks
  chunkSize: 620,           // one streamed terrain tile, metres
  chunkSegments: 72,        // resolution within a tile
  chunkRadius: 3,           // tiles kept around the camera in each direction
  surfaceY: 0,
  maxDepth: 1600,
  stationPos: [0, -30, 0],  // the Hull — dock, market, drydock
  stationRadius: 22,
  dockRadius: 46,           // inside this you may dock
  shelfDepth: 62,           // seabed depth directly under the station
  trenchDepth: 1560,        // seabed depth at the rim of the world
};

/* Depth bands. A zone owns its light, its fog, its fish, and its monsters.
   `top`/`bottom` are depths in metres (positive down). */
export const ZONES = [
  {
    id: "shelf",
    name: "Sunlit Shelf",
    top: 0, bottom: 90,
    fog: 0x2e7f93, fogDensity: 0.0068,
    ambient: 0x9fd8e6, ambientIntensity: 0.85,
    sunIntensity: 1.15,
    water: 0x2b6f84,
    snow: 0.15,              // marine snow density 0..1
    valueMultiplier: 1.0,
    hostileBudget: 1,
    hostiles: [["shark", 0.6], ["lamprey", 0.22], ["razorfin", 0.3]],
    blurb: "warm, shallow, and already picked over",
  },
  {
    id: "kelp",
    name: "Kelp Cathedral",
    top: 90, bottom: 240,
    fog: 0x1d5e58, fogDensity: 0.0095,
    ambient: 0x6fbfa4, ambientIntensity: 0.55,
    sunIntensity: 0.55,
    water: 0x17514c,
    snow: 0.3,
    valueMultiplier: 1.8,
    hostileBudget: 2,
    hostiles: [["shark", 0.3], ["squid", 0.22], ["lamprey", 0.2], ["greatwhite", 0.14], ["razorfin", 0.22], ["inkwidow", 0.14]],
    blurb: "green columns, and things that hold on",
  },
  {
    id: "twilight",
    name: "Twilight Drift",
    top: 240, bottom: 520,
    fog: 0x123048, fogDensity: 0.0125,
    ambient: 0x3f6f9a, ambientIntensity: 0.3,
    sunIntensity: 0.16,
    water: 0x0d2438,
    snow: 0.55,
    valueMultiplier: 3.2,
    hostileBudget: 4,
    hostiles: [["shark", 0.18], ["squid", 0.24], ["angler", 0.12], ["lamprey", 0.14], ["trapjaw", 0.12], ["grandmother", 0.1], ["inkwidow", 0.18], ["choir", 0.12]],
    blurb: "the last of the light, spending itself",
  },
  {
    id: "midnight",
    name: "Midnight Reach",
    top: 520, bottom: 980,
    fog: 0x06121f, fogDensity: 0.0165,
    ambient: 0x1a3352, ambientIntensity: 0.16,
    sunIntensity: 0.03,
    water: 0x040c16,
    snow: 0.8,
    valueMultiplier: 6.0,
    hostileBudget: 4,
    hostiles: [["squid", 0.22], ["angler", 0.18], ["leviathan", 0.12], ["trapjaw", 0.16], ["gulper", 0.16], ["ninefold", 0.1], ["grandmother", 0.06], ["choir", 0.18], ["inkwidow", 0.1]],
    blurb: "no light but the light that wants you closer",
  },
  {
    id: "abyss",
    name: "The Forgetting",
    top: 980, bottom: 1700,
    fog: 0x05040c, fogDensity: 0.021,
    ambient: 0x241a44, ambientIntensity: 0.12,
    sunIntensity: 0.0,
    water: 0x03020a,
    snow: 1.0,
    valueMultiplier: 11.0,
    hostileBudget: 5,
    hostiles: [["wraith", 0.2], ["leviathan", 0.14], ["gulper", 0.12], ["siren", 0.14], ["trapjaw", 0.1], ["ninefold", 0.1], ["tidewarden", 0.08], ["kraken", 0.12], ["choir", 0.14]],
    blurb: "where the tank keeps what it could not hold",
  },
];

/* The look of the water itself. Absorption is per-channel and in units of
   1/metre: red dies within a few metres, blue carries. That single fact is
   most of what makes water read as water, so it is tuned here rather than
   buried in the shader. */
export const WATER = {
  absorb: {
    shelf:    [0.030, 0.0125, 0.0072],
    kelp:     [0.042, 0.0180, 0.0130],
    twilight: [0.055, 0.0250, 0.0160],
    midnight: [0.070, 0.0360, 0.0250],
    abyss:    [0.090, 0.0520, 0.0400],
  },
  // How much light the water throws back at you — the colour of distance.
  scatter: {
    shelf:    0x3f93a6,
    kelp:     0x246b63,
    twilight: 0x14384f,
    midnight: 0x071522,
    abyss:    0x05040d,
  },
  causticStrength: 0.32,    // on the seabed, in the shallows
  causticScale: 0.085,
  causticFadeStart: 20,     // metres: full strength above this
  causticFadeEnd: 165,      // metres: gone by here
  murkBase: 1,
};

export const POST = {
  enabled: true,
  bloomThreshold: 0.72,
  bloomStrength: 0.85,
  bloomRadius: 1.1,
  bloomScale: 0.5,          // render bloom at half resolution
  vignette: 0.42,
  grain: 0.035,
  aberration: 0.0016,       // grows with depth and with damage
  exposure: 1.02,
  maxPixelRatio: 2,
};

/* Big scenery is streamed in a window around the boat rather than sprinkled
   over the whole 55 square kilometres — at world scale, a few hundred props
   put the nearest one most of a kilometre away, which is the same as having
   none. These are the numbers that decide how thick it is where you are. */
export const SCENERY = {
  cell: 130,               // metres per placement cell
  radius: 5,               // cells kept around the boat in each direction
  boulders: [0, 3],        // props per cell, min..max, chosen per cell by hash
  towers: [0, 1],          // reef bommies per cell
  weed: [0, 3],
  reef: [1, 7],            // small coral heads per cell, on the shelf
  kelp: [0, 2],            // kelp stands per cell (each stand is a clump)
  fans: [0, 2],            // sea-fan clumps per cell
  maxBoulders: 760,
  maxReef: 1500,
  maxKelp: 2600,
  maxFans: 900,
  maxTowers: 420,
  maxWeed: 900,
};

export const RARITY = {
  common:    { label: "common",    multiplier: 1.0,  color: 0x9fb4c4, weight: 60 },
  uncommon:  { label: "uncommon",  multiplier: 1.9,  color: 0x6fe3a0, weight: 25 },
  rare:      { label: "rare",      multiplier: 4.0,  color: 0x63b6ff, weight: 11 },
  mythic:    { label: "mythic",    multiplier: 11.0, color: 0xd08bff, weight: 4 },
};

export const SUB = {
  hullBase: 100,
  batteryBase: 100,
  batteryRechargeDocked: 40,   // per second while docked
  hullRepairDocked: 22,        // per second while docked
  pressureBase: 140,           // depth rating at zero upgrades (m)
  pressureDamage: 5.5,         // hull loss/sec per 100 m beyond the rating
  thrustBase: 15.5,            // m/s^2
  boostMultiplier: 2.15,
  boostDrain: 7.5,             // battery/sec
  lightDrain: 1.1,             // battery/sec while floodlights are on
  idleDrain: 0.28,             // battery/sec, always
  batteryTrickle: 0.0,         // reactor regen per second (upgrade grants this)
  linearDrag: 0.82,            // velocity retained per second at rest
  cargoDragPerTon: 0.02,
  maxSpeedBase: 17,
  vertThrust: 11,
  lookSensitivity: 0.0022,
  rollAssist: 3.2,
  pitchClamp: 1.35,            // radians
  collisionRadius: 3.4,
  terrainBumpDamage: 0.55,     // hull per m/s of impact speed
  cargoSlotsBase: 6,
  captureRangeBase: 14,
  captureTimeBase: 1.15,       // seconds of held beam per fish
  lightRangeBase: 34,
  sonarRangeBase: 140,
  sonarCooldownBase: 7,
  sonarCost: 6,
  respawnPenalty: 0.35,        // fraction of credits lost when the hull fails
};

export const WEAPONS = {
  harpoon: {
    id: "harpoon",
    name: "Harpoon Gun",
    damage: 14,
    cooldown: 0.62,
    speed: 95,
    life: 2.4,
    cost: 1.5,               // battery per shot
    ammo: Infinity,
    color: 0xdfe9f2,
  },
  torpedo: {
    id: "torpedo",
    name: "Torpedo Tube",
    damage: 90,
    splash: 9,
    splashDamage: 45,
    cooldown: 2.4,
    speed: 42,
    life: 5.5,
    cost: 0,
    ammoBase: 0,             // unlocked by upgrade
    color: 0xffb066,
  },
  net: {
    id: "net",
    name: "Drift Net",
    damage: 0,
    cooldown: 3.4,
    speed: 38,
    life: 3.4,
    cost: 6,                 // battery per throw
    radius: 11,              // how wide it opens
    capacity: 3,             // fish per throw at mark 1
    color: 0xbfe9d0,
    ammo: Infinity,
  },
  pulse: {
    id: "pulse",
    name: "Sonar Lance",
    damage: 26,
    stun: 2.4,
    cooldown: 3.4,
    range: 46,
    cost: 9,
    color: 0x86f2ff,
  },
};

/* Upgrade tree. `values[level]` is the stat at that level; level 0 is stock.
   `costs[level]` is the price to reach level+1. */
export const UPGRADES = [
  {
    id: "hull", name: "Hull Plating", stat: "hullMax", icon: "▣",
    blurb: "More steel between you and the pressure.",
    values: [100, 150, 215, 300, 400, 520],
    costs: [220, 520, 1150, 2600, 5800],
  },
  {
    id: "pressure", name: "Pressure Casing", stat: "pressureRating", icon: "⌄",
    blurb: "Rated depth. Go past it and the sea starts folding you shut.",
    values: [140, 280, 460, 700, 1050, 1650],
    costs: [300, 780, 1900, 4400, 9800],
  },
  {
    id: "thrust", name: "Impeller", stat: "thrust", icon: "➤",
    blurb: "Acceleration and top speed.",
    values: [15.5, 19, 23, 27.5, 33],
    costs: [260, 640, 1500, 3600],
  },
  {
    id: "cargo", name: "Cargo Hold", stat: "cargoSlots", icon: "▤",
    blurb: "How much of the sea you can carry home.",
    values: [6, 10, 16, 24, 34, 48],
    costs: [180, 460, 1100, 2500, 5400],
  },
  {
    id: "battery", name: "Cell Array", stat: "batteryMax", icon: "⚡",
    blurb: "Charge for lights, boost, and the loud weapons.",
    values: [100, 150, 215, 300, 410],
    costs: [200, 520, 1250, 2900],
  },
  {
    id: "lights", name: "Floodlights", stat: "lightRange", icon: "☀",
    blurb: "Reach of the lamps. The dark charges rent.",
    values: [34, 52, 74, 100, 132],
    costs: [160, 420, 980, 2200],
  },
  {
    id: "sonar", name: "Sonar Array", stat: "sonarRange", icon: "◎",
    blurb: "Ping range — paints fish, monsters, and the floor.",
    values: [140, 220, 330, 460, 620],
    costs: [190, 480, 1150, 2700],
  },
  {
    id: "capture", name: "Capture Beam", stat: "captureRange", icon: "◇",
    blurb: "Range and speed of the collection beam.",
    values: [14, 19, 25, 32, 40],
    costs: [210, 540, 1300, 3000],
  },
  {
    id: "harpoon", name: "Harpoon Gun", stat: "harpoonDamage", icon: "↟",
    blurb: "Damage per bolt.",
    values: [14, 22, 33, 48, 68],
    costs: [240, 600, 1450, 3400],
  },
  {
    id: "torpedo", name: "Torpedo Tubes", stat: "torpedoAmmo", icon: "◆",
    blurb: "Unlocks torpedoes, then carries more of them.",
    values: [0, 3, 6, 10, 16],
    costs: [900, 2100, 4600, 9200],
  },
  {
    id: "net", name: "Drift Net", stat: "netCapacity", icon: "⊞",
    blurb: "Unlocks the net, then widens it. Takes a whole shoal in one throw.",
    values: [0, 3, 5, 8, 12],
    costs: [780, 1850, 4200, 8900],
  },
  {
    id: "repair", name: "Repair Drone", stat: "repairRate", icon: "✚",
    blurb: "Welds the hull back together while you fly.",
    values: [0, 0.7, 1.5, 2.8],
    costs: [700, 1900, 4500],
  },
  {
    id: "reactor", name: "Trickle Reactor", stat: "batteryTrickle", icon: "◈",
    blurb: "Slow charge that never asks the dock for permission.",
    values: [0, 1.2, 2.6, 4.4],
    costs: [650, 1700, 4100],
  },
  {
    id: "scrubber", name: "Ink Scrubbers", stat: "inkKept", icon: "≋",
    blurb: "Wipers and a solvent jet on the glass. Ink clears faster.",
    values: [100, 60, 35, 15],
    costs: [480, 1250, 3000],
  },
  {
    id: "lattice", name: "Shock Lattice", stat: "shockDamage", icon: "ϟ",
    blurb: "A charged skin. Anything that grabs the hull lets go, hurting.",
    values: [0, 40, 90, 160],
    costs: [820, 2000, 4700],
  },
];

export const CREATURES = {
  shark: {
    id: "shark", name: "Reef Shark", kind: "beast",
    hp: 70, damage: 13, speed: 15.5, turn: 1.5, radius: 2.6, length: 4.4,
    aggro: 62, attackRange: 6.5, attackCooldown: 2.0, bounty: 85,
    color: 0x46525e, bellyColor: 0xd7dde2, glow: 0,
    trophy: "shark tooth", mythic: false,
  },
  squid: {
    id: "squid", name: "Glass Squid", kind: "cephalopod",
    hp: 110, damage: 9, speed: 12, turn: 2.1, radius: 3.1, length: 6.0,
    aggro: 70, attackRange: 11, attackCooldown: 1.5, bounty: 160,
    color: 0x8f5fb0, bellyColor: 0xe7c7ff, glow: 0.4,
    grapple: true, batteryDrain: 9,
    trophy: "ink gland", mythic: false,
  },
  angler: {
    id: "angler", name: "Lantern Angler", kind: "beast",
    hp: 150, damage: 24, speed: 9, turn: 1.2, radius: 3.4, length: 5.2,
    aggro: 95, attackRange: 7.5, attackCooldown: 2.6, bounty: 340,
    color: 0x241c2e, bellyColor: 0x3a2b45, glow: 1.0, lureColor: 0xffe9a8,
    lure: true,
    trophy: "cold lantern", mythic: false,
  },
  leviathan: {
    id: "leviathan", name: "Leviathan", kind: "serpent",
    hp: 620, damage: 42, speed: 18, turn: 1.0, radius: 5.5, length: 34,
    aggro: 150, attackRange: 12, attackCooldown: 3.0, bounty: 2400,
    color: 0x1d4f62, bellyColor: 0x7fe3d0, glow: 0.5,
    segments: 14,
    trophy: "serpent scale", mythic: true,
  },
  wraith: {
    id: "wraith", name: "Forgetting Wraith", kind: "spirit",
    hp: 300, damage: 18, speed: 13, turn: 2.6, radius: 3.8, length: 7,
    aggro: 120, attackRange: 14, attackCooldown: 2.2, bounty: 1500,
    color: 0x6a4fb5, bellyColor: 0xc9b8ff, glow: 0.9,
    phasing: true, memoryDrain: true,
    trophy: "unremembered name", mythic: true,
  },
  lamprey: {
    id: "lamprey", name: "Static Lamprey", kind: "swarm",
    hp: 26, damage: 5, speed: 17, turn: 3.4, radius: 1.1, length: 2.4,
    aggro: 80, attackRange: 4.5, attackCooldown: 0.9, bounty: 40,
    color: 0x6d5f7a, bellyColor: 0xc9ff9e, glow: 0.5,
    // Arrives as a knot of them. One is nothing; nine is a problem.
    swarm: [6, 11], latch: true, batteryDrain: 2,
    trophy: "ring of teeth", mythic: false,
  },
  trapjaw: {
    id: "trapjaw", name: "Trapjaw", kind: "ambusher",
    hp: 260, damage: 46, speed: 21, turn: 1.1, radius: 3.6, length: 7.4,
    aggro: 48, attackRange: 9, attackCooldown: 3.4, bounty: 620,
    color: 0x2b2a24, bellyColor: 0xe8d9a8, glow: 0.1,
    // Sits in the silt looking like the floor until you are nearly on it.
    ambush: true, lungeSpeed: 44,
    trophy: "hinged jaw", mythic: false,
  },
  siren: {
    id: "siren", name: "Hull-Light Siren", kind: "spirit",
    hp: 380, damage: 26, speed: 15, turn: 2.2, radius: 3.2, length: 8,
    aggro: 210, attackRange: 13, attackCooldown: 2.4, bounty: 1900,
    color: 0x2a3f6b, bellyColor: 0xffd98a, glow: 1,
    // It shows you a docking light. There is no dock.
    lure: true, mimic: true, memoryDrain: false,
    trophy: "false beacon", mythic: true,
  },
  gulper: {
    id: "gulper", name: "Gulper", kind: "beast",
    hp: 420, damage: 33, speed: 11, turn: 0.9, radius: 5, length: 15,
    aggro: 110, attackRange: 14, attackCooldown: 3.2, bounty: 1100,
    color: 0x140f1c, bellyColor: 0x7a3f6b, glow: 0.2,
    // A mouth with an animal behind it. Swallows, then drags.
    swallow: true,
    trophy: "distended gullet", mythic: false,
  },
  grandmother: {
    id: "grandmother", name: "Grandmother Tooth", kind: "beast",
    hp: 1500, damage: 52, speed: 21, turn: 1.35, radius: 6.4, length: 18,
    aggro: 150, attackRange: 13, attackCooldown: 2.6, bounty: 4200,
    color: 0x6f7a80, bellyColor: 0xe8eef2, glow: 0,
    // The shark that got old. Scarred, enormous, and in no hurry.
    unique: true, mythic: true, scarred: true,
    trophy: "grandmother's tooth",
  },
  ninefold: {
    id: "ninefold", name: "The Ninefold", kind: "colony",
    hp: 2300, damage: 30, speed: 8, turn: 0.8, radius: 7, length: 52,
    aggro: 170, attackRange: 26, attackCooldown: 1.9, bounty: 7600,
    color: 0x3a2f6b, bellyColor: 0x9df2ff, glow: 1,
    // Nine bells on one chain, and it is not nine animals, and it is not one.
    unique: true, mythic: true, bells: 9, batteryDrain: 6,
    trophy: "a bell from the chain",
  },
  tidewarden: {
    id: "tidewarden", name: "The Tidewarden", kind: "serpent",
    hp: 3400, damage: 70, speed: 20, turn: 0.85, radius: 9, length: 78,
    aggro: 220, attackRange: 20, attackCooldown: 3.2, bounty: 15000,
    color: 0x123c3a, bellyColor: 0xffd27f, glow: 0.7,
    unique: true, mythic: true, boss: true, segments: 26,
    trophy: "warden's crest",
  },
  greatwhite: {
    id: "greatwhite", name: "Old Grey", kind: "beast",
    hp: 540, damage: 38, speed: 22, turn: 1.25, radius: 4.2, length: 11,
    aggro: 130, attackRange: 9, attackCooldown: 2.6, bounty: 1400,
    color: 0x565f68, bellyColor: 0xe4e9ec, glow: 0,
    // One to a sea, and it remembers you. Runs in from outside the lamps.
    unique: true, pack: [2, 3], scarred: true,
    trophy: "grey tooth", mythic: false,
  },
  sperm: {
    id: "sperm", name: "The Sounding", kind: "leviathan",
    hp: 1600, damage: 52, speed: 16, turn: 0.55, radius: 9, length: 46,
    aggro: 170, attackRange: 22, attackCooldown: 4.2, bounty: 6200,
    color: 0x3b3742, bellyColor: 0xb9b2a4, glow: 0.1,
    /* Not hostile until it is. It dives through the bands on its own errand
       and will not turn for you — being in the way is the danger. */
    unique: true, indifferent: true, huge: true,
    trophy: "a tooth the size of your forearm", mythic: true,
  },
  inkwidow: {
    id: "inkwidow", name: "Ink Widow", kind: "cephalopod",
    hp: 190, damage: 11, speed: 11, turn: 2.4, radius: 2.2, length: 4.6,
    aggro: 58, attackRange: 7.5, attackCooldown: 1.7, bounty: 420,
    color: 0x4a1830, bellyColor: 0xff5c86, glow: 0.3,
    /* Walks the floor like the harmless ones do, until it does not. It wraps
       the boat, holds it, and blacks out the glass. */
    crawler: true, grabs: true, inks: true,
    trophy: "widow's ink sac", mythic: false,
  },
  razorfin: {
    id: "razorfin", name: "Razorfin", kind: "beast",
    hp: 32, damage: 7, speed: 22, turn: 3.1, radius: 1.0, length: 2.3,
    aggro: 72, attackRange: 4.2, attackCooldown: 1.1, bounty: 55,
    color: 0x7f8d9c, bellyColor: 0xe6eef4, glow: 0,
    // Barracuda, and never one: a pack that takes turns.
    swarm: [3, 5],
    trophy: "razor jaw", mythic: false,
  },
  choir: {
    id: "choir", name: "Stinging Choir", kind: "drifter",
    hp: 42, damage: 6, speed: 5.5, turn: 1.3, radius: 1.5, length: 2.8,
    aggro: 46, attackRange: 4.6, attackCooldown: 1.3, bounty: 95,
    color: 0x5a2f8a, bellyColor: 0xff7ad9, glow: 1,
    // Bells that sing in the lamp frequencies. They sting the cell flat.
    swarm: [4, 7], drifter: true, batteryDrain: 3,
    drainLine: "the bells sting the housing. the cell hums, and drops.",
    trophy: "stinging bell", mythic: false,
  },
  kraken: {
    id: "kraken", name: "Kraken of Static", kind: "boss",
    hp: 2600, damage: 60, speed: 9, turn: 0.7, radius: 14, length: 40,
    aggro: 200, attackRange: 34, attackCooldown: 2.4, bounty: 12000,
    color: 0x4a2340, bellyColor: 0xff7e6b, glow: 0.6,
    arms: 8, boss: true,
    trophy: "kraken beak", mythic: true,
  },
};

export const ECONOMY = {
  startingCredits: 150,
  sellBonusPerRarity: 1.0,
  trophyValueShare: 1.0,       // bounty is paid in full on the kill
  depthBonusPerKm: 0.35,       // extra fraction of value per km of capture depth
};

export const HOTKEYS = {
  forward: ["KeyW"], back: ["KeyS"], left: ["KeyA"], right: ["KeyD"],
  up: ["Space"], down: ["KeyC", "ControlLeft"], boost: ["ShiftLeft"],
  lights: ["KeyF"], sonar: ["KeyR"], dock: ["KeyE"], cargo: ["Tab"],
  weapon1: ["Digit1"], weapon2: ["Digit2"], weapon3: ["Digit3"], weapon4: ["Digit4"],
  cycle: ["KeyQ"], pause: ["Escape"], map: ["KeyM"], photo: ["KeyP"],
};

export function zoneForDepth(depth) {
  const d = Math.max(0, depth);
  for (const z of ZONES) if (d < z.bottom) return z;
  return ZONES[ZONES.length - 1];
}

export function zoneIndex(id) {
  return Math.max(0, ZONES.findIndex((z) => z.id === id));
}

/* Where the game lives and where its people are. Anything left empty is
   simply not shown — fill these in and the menu grows the links. */
export const SITE = {
  // The canonical page to share. Used instead of location so a link shared
  // from an embed (itch.io's iframe, a portal) still points somewhere real.
  play: "https://sebby1770.github.io/mnemoquarium/",
  // Pay-what-you-want or tip jar: an itch.io page, Ko-fi, GitHub Sponsors...
  support: "",
  // A Discord (or any community) invite.
  community: "",
  // GoatCounter count endpoint, e.g. "https://mnemoquarium.goatcounter.com/count".
  // Analytics stay off while this is empty, and always honour Do Not Track.
  goatcounter: "",
};
