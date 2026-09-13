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
    hostiles: [["shark", 1.0]],
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
    hostiles: [["shark", 0.6], ["squid", 0.4]],
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
    hostileBudget: 3,
    hostiles: [["shark", 0.35], ["squid", 0.5], ["angler", 0.15]],
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
    hostileBudget: 3,
    hostiles: [["squid", 0.45], ["angler", 0.35], ["leviathan", 0.2]],
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
    hostileBudget: 4,
    hostiles: [["wraith", 0.4], ["leviathan", 0.3], ["squid", 0.15], ["kraken", 0.15]],
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
];

export const CREATURES = {
  shark: {
    id: "shark", name: "Reef Shark", kind: "beast",
    hp: 70, damage: 13, speed: 15.5, turn: 1.5, radius: 2.6, length: 4.4,
    aggro: 62, attackRange: 6.5, attackCooldown: 2.0, bounty: 85,
    color: 0x5d6b78, bellyColor: 0xd7dde2, glow: 0,
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
  weapon1: ["Digit1"], weapon2: ["Digit2"], weapon3: ["Digit3"],
  pause: ["Escape"], map: ["KeyM"],
};

export function zoneForDepth(depth) {
  const d = Math.max(0, depth);
  for (const z of ZONES) if (d < z.bottom) return z;
  return ZONES[ZONES.length - 1];
}

export function zoneIndex(id) {
  return Math.max(0, ZONES.findIndex((z) => z.id === id));
}
