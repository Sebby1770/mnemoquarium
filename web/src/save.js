/* Persistence. One key in localStorage, one shape, and an absolute refusal to
   throw: a browser in private mode, a full quota, a half-written blob from an
   older build — none of it may take the game down on boot.

   This module deliberately imports nothing but config.js. The save has to be
   readable even if the genetics engine never showed up, because the first thing
   main.js wants to know is whether there is a dive to continue. */

import { ECONOMY, RARITY, UPGRADES } from "./config.js";

export const SAVE_KEY = "mnemoquarium.deep.v1";

/* Every sea keeps its own logbook. SAVE_KEY is still the last sea played (so
   older builds and "Continue" read it unchanged); each save is mirrored into a
   slot of its own, and a short index lists the seas you have been to. Opening
   a friend's link, or today's sea, never touches another sea's run. */
const SEA_PREFIX = `${SAVE_KEY}.sea.`;
const INDEX_KEY = `${SAVE_KEY}.seas`;
export const MAX_SEAS = 12;

const VERSION = 1;

/* Sanity ceilings. None of these should ever be reached by honest play; they
   exist so a corrupted or hand-edited blob cannot allocate the tab to death. */
const MAX_PHRASE = 240;
const MAX_CARGO = 96;
const MAX_TEXT = 80;
const MAX_GLYPH = 4;
const MAX_KILL_KEYS = 64;
const MAX_DISCOVERED = 64;
const MAX_LANDMARKS = 64;
const MAX_MUTATION_TAGS = 8;
const MAX_CREDITS = 1e12;
const MAX_DEPTH = 20000;
/* When the quota says no, we retry once with only the best of the hold. */
const PANIC_CARGO = 24;

const CARGO_KINDS = new Set(["fish", "trophy"]);
const QUALITY_MODES = new Set(["auto", "high", "low"]);
const UPGRADE_IDS = UPGRADES.map((spec) => spec.id);
const UPGRADE_CAPS = new Map(UPGRADES.map((spec) => [spec.id, Math.max(0, spec.values.length - 1)]));

/* Resolved once. `localStorage` can throw on mere access inside a sandboxed
   iframe or with site data blocked, so the probe is the only place that is
   allowed to find out. */
let storageChecked = false;
let store = null;

/* The in-memory fallback. With storage disabled the profile still lives for the
   length of the session — you simply lose it when the tab closes, which is a
   fair trade for the game running at all. */
let memory = null;

function storage() {
  if (storageChecked) return store;
  storageChecked = true;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return store;
    const probe = `${SAVE_KEY}.probe`;
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    store = ls;
  } catch (err) {
    // Private mode, blocked cookies, a sandbox without allow-same-origin.
    store = null;
  }
  return store;
}

// ---------------------------------------------------------------- coercion

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value, fallback, lo, hi) {
  const n = Math.floor(num(value, fallback));
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(lo, Math.min(hi, v));
}

function bool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "true") return true;
  if (value === 0 || value === "false") return false;
  return fallback;
}

function text(value, limit, fallback) {
  if (typeof value !== "string") {
    if (value == null || typeof value === "object") return fallback;
    return String(value).slice(0, limit);
  }
  return value.slice(0, limit);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ------------------------------------------------------------- sub-shapes

function migrateUpgrades(raw) {
  const out = {};
  const src = isPlainObject(raw) ? raw : {};
  for (const id of UPGRADE_IDS) {
    const cap = UPGRADE_CAPS.get(id) || 0;
    out[id] = int(src[id], 0, 0, cap);
  }
  return out;
}

/* Cargo is the only unbounded part of a save, so it gets the strictest pass.
   Anything that is not an object, or has no value worth paying for, is dropped
   rather than repaired — the sea can keep it. */
function migrateCargoItem(raw, index) {
  if (!isPlainObject(raw)) return null;

  const kind = CARGO_KINDS.has(raw.kind) ? raw.kind : "fish";
  const rarity = typeof raw.rarity === "string" && RARITY[raw.rarity] ? raw.rarity : "common";

  // Mutations arrive either as a count or as a list of named flips. Keep
  // whichever the hold was written with so the manifest still reads right.
  let mutations = 0;
  if (Array.isArray(raw.mutations)) {
    mutations = raw.mutations
      .slice(0, MAX_MUTATION_TAGS)
      .map((tag) => text(tag, 40, ""))
      .filter((tag) => tag.length > 0);
  } else {
    mutations = int(raw.mutations, 0, 0, 999);
  }

  return {
    id: text(raw.id, 64, "") || `cargo-${index}-${VERSION}`,
    kind,
    speciesIndex: int(raw.speciesIndex, -1, -1, 255),
    name: text(raw.name, MAX_TEXT, "something unnamed"),
    word: text(raw.word, MAX_TEXT, ""),
    glyph: text(raw.glyph, MAX_GLYPH, "?"),
    hue: int(raw.hue, 0, 0, 359),
    rarity,
    value: int(raw.value, 0, 0, MAX_CREDITS),
    depth: int(raw.depth, 0, 0, MAX_DEPTH),
    genome: int(raw.genome, 0, 0, 4294967295),
    generation: int(raw.generation, 0, 0, 9999),
    mutations,
    label: text(raw.label, MAX_TEXT, ""),
  };
}

function migrateCargo(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length && out.length < MAX_CARGO; i += 1) {
    const item = migrateCargoItem(raw[i], i);
    if (item) out.push(item);
  }
  return out;
}

function migrateKills(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  let keys = 0;
  for (const key of Object.keys(raw)) {
    if (keys >= MAX_KILL_KEYS) break;
    const id = text(key, 24, "");
    if (!id) continue;
    const count = int(raw[key], 0, 0, 999999);
    if (count <= 0) continue;
    out[id] = count;
    keys += 1;
  }
  return out;
}

function migrateDiscovered(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const entry of raw) {
    if (seen.size >= MAX_DISCOVERED) break;
    const n = Math.floor(num(entry, -1));
    if (!Number.isFinite(n) || n < 0 || n > 255) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

function migrateStats(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    dives: int(src.dives, 0, 0, 999999),
    fishSold: int(src.fishSold, 0, 0, 9999999),
    creditsEarned: int(src.creditsEarned, 0, 0, MAX_CREDITS),
    deepest: int(src.deepest, 0, 0, MAX_DEPTH),
    deaths: int(src.deaths, 0, 0, 999999),
    kills: migrateKills(src.kills),
    discovered: migrateDiscovered(src.discovered),
    // Surveyed landmark ids. Dropping these on save meant every landmark paid
    // its survey fee again after a reload.
    landmarks: migrateLandmarks(src.landmarks),
    // Ambient animals seen, by kind id — each pays its sighting fee once.
    sighted: migrateIds(src.sighted, /^[a-z]{2,16}$/, 32),
  };
}

function migrateIds(raw, pattern, cap) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const entry of raw) {
    if (seen.size >= cap) break;
    if (typeof entry === "string" && pattern.test(entry)) seen.add(entry);
  }
  return [...seen];
}

function migrateLandmarks(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const entry of raw) {
    if (seen.size >= MAX_LANDMARKS) break;
    if (typeof entry !== "string" || !/^lm-\d{1,3}$/.test(entry)) continue;
    seen.add(entry);
  }
  return [...seen];
}

function migrateSettings(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    /* Sound is on unless the player has turned it off themselves. Saves from
       before this were muted by default, not by choice, so a save without
       soundSet gets sound back. */
    sound: src.soundSet === true ? bool(src.sound, true) : true,
    soundSet: src.soundSet === true,
    invertY: bool(src.invertY, false),
    // The pause panel's slider is 20..300 percent; store it as a plain factor.
    sensitivity: Math.max(0.2, Math.min(3, num(src.sensitivity, 1))),
    // "auto" lets the render scale follow the frame rate; the other two pin it.
    quality: QUALITY_MODES.has(src.quality) ? src.quality : "auto",
  };
}

// -------------------------------------------------------------------- API

/* A fresh logbook: stock boat, starting float, empty hold. */
export function newProfile(phrase, seed) {
  const upgrades = {};
  for (const id of UPGRADE_IDS) upgrades[id] = 0;
  return {
    version: VERSION,
    phrase: text(phrase, MAX_PHRASE, ""),
    seed: num(seed, 0) >>> 0,
    credits: Math.max(0, Math.round(num(ECONOMY.startingCredits, 0))),
    upgrades,
    cargo: [],
    ammo: { torpedo: 0 },
    stats: {
      dives: 0,
      fishSold: 0,
      creditsEarned: 0,
      deepest: 0,
      deaths: 0,
      kills: {},
      discovered: [],
      landmarks: [],
      sighted: [],
    },
    settings: { sound: true, soundSet: false, invertY: false, sensitivity: 1, quality: "auto" },
    updated: now(),
  };
}

/* Take anything that claims to be a profile — a parsed blob, a JSON string, a
   half-populated object from an older build — and return a complete, valid one.
   Missing fields are filled from the stock profile; nonsense is clamped. Only a
   value that could not be a profile at all comes back null. */
export function migrate(raw) {
  let src = raw;
  if (typeof src === "string") {
    try {
      src = JSON.parse(src);
    } catch (err) {
      return null;
    }
  }
  if (!isPlainObject(src)) return null;

  const profile = newProfile(src.phrase, src.seed);
  profile.version = VERSION;
  profile.credits = int(src.credits, profile.credits, 0, MAX_CREDITS);
  profile.upgrades = migrateUpgrades(src.upgrades);
  profile.cargo = migrateCargo(src.cargo);

  const ammo = isPlainObject(src.ammo) ? src.ammo : {};
  profile.ammo = { torpedo: int(ammo.torpedo, 0, 0, 9999) };

  profile.stats = migrateStats(src.stats);
  profile.settings = migrateSettings(src.settings);
  profile.updated = int(src.updated, 0, 0, Number.MAX_SAFE_INTEGER);

  return profile;
}

/* The saved dive, or null when there is nothing readable to continue. A blob we
   cannot parse is left where it is rather than deleted — it is the player's
   only copy, and they may want to fish it out of devtools one day. */
export function loadProfile() {
  const ls = storage();
  let raw = null;
  if (ls) {
    try {
      raw = ls.getItem(SAVE_KEY);
    } catch (err) {
      raw = null;
    }
  }

  if (typeof raw !== "string" || raw.length === 0) {
    // Nothing on disk. In-memory play still counts as a dive in progress.
    return memory;
  }

  const profile = migrate(raw);
  if (!profile) return memory;
  memory = profile;
  return profile;
}

/* Write the profile. Returns true only when it actually reached storage, so a
   caller may warn once that this dive lives in RAM. Never throws. */
export function saveProfile(profile) {
  try {
    const snapshot = migrate(profile);
    if (!snapshot) return false;

    const stamp = now();
    snapshot.updated = stamp;
    if (isPlainObject(profile)) {
      profile.updated = stamp;
      // Hold the live object, not the copy, so the in-memory fallback keeps
      // tracking the dive instead of freezing at the last write.
      memory = profile;
    } else {
      memory = snapshot;
    }

    const ls = storage();
    if (!ls) return false;

    // Whatever is under SAVE_KEY may be a different sea's only copy.
    adoptLast(ls);
    let payload = JSON.stringify(snapshot);
    let ok = writeRaw(ls, SAVE_KEY, payload);
    if (!ok) {
      // Quota. Sell the hold down to its best pieces and try once more; a save
      // that loses cargo still beats a save that loses the boat.
      snapshot.cargo = snapshot.cargo
        .slice()
        .sort((a, b) => b.value - a.value)
        .slice(0, PANIC_CARGO);
      payload = JSON.stringify(snapshot);
      ok = writeRaw(ls, SAVE_KEY, payload);
    }
    if (ok && snapshot.phrase) {
      writeRaw(ls, seaKeyFor(snapshot.phrase), payload);
      touchIndex(ls, snapshot);
    }
    return ok;
  } catch (err) {
    // Circular references, a frozen profile, a stringify that ran out of room.
    return false;
  }
}

/* Forget a sea's run — the one given, or the last one played. The start
   screen's "erase save" ends up here. Other seas keep theirs. */
export function clearProfile(phrase) {
  const ls = storage();
  let current = null;
  if (ls) {
    try {
      current = migrate(ls.getItem(SAVE_KEY) || "");
    } catch (err) {
      current = null;
    }
  }
  const target = phrase || (current && current.phrase) || (memory && memory.phrase) || "";
  if (!phrase || (memory && memory.phrase === target)) memory = null;
  if (!ls) return;
  try {
    if (!phrase || (current && current.phrase === target)) ls.removeItem(SAVE_KEY);
    if (target) {
      ls.removeItem(seaKeyFor(target));
      writeIndex(ls, readIndex(ls).filter((e) => e.phrase !== target));
    }
  } catch (err) {
    // Nothing to be done; the key outlives us.
  }
}

/* The run on one particular sea, or null if you have never dived it. */
export function loadSea(phrase) {
  const want = text(phrase, MAX_PHRASE, "");
  if (!want) return null;
  if (memory && memory.phrase === want) return memory;
  const ls = storage();
  if (!ls) return null;
  let raw = null;
  try {
    raw = ls.getItem(seaKeyFor(want));
  } catch (err) {
    raw = null;
  }
  let profile = typeof raw === "string" && raw ? migrate(raw) : null;
  if (!profile) {
    // Saves from before slots existed live only under SAVE_KEY.
    try {
      const last = migrate(ls.getItem(SAVE_KEY) || "");
      if (last && last.phrase === want) profile = last;
    } catch (err) {
      profile = null;
    }
  }
  return profile && profile.phrase === want ? profile : null;
}

/* The seas you have been to, most recent first: [{ phrase, credits, deepest, updated }]. */
export function listSeas() {
  const ls = storage();
  if (!ls) return memory && memory.phrase ? [summary(memory)] : [];
  adoptLast(ls);
  return readIndex(ls).sort((a, b) => b.updated - a.updated);
}

/* A save from before slots existed lives only under SAVE_KEY, and the next
   dive on another sea would overwrite it. Give it a slot and an index entry
   first. Cheap when there is nothing to do. */
function adoptLast(ls) {
  let raw = null;
  try {
    raw = ls.getItem(SAVE_KEY);
  } catch (err) {
    return;
  }
  if (typeof raw !== "string" || !raw) return;
  const last = migrate(raw);
  if (!last || !last.phrase) return;
  const key = seaKeyFor(last.phrase);
  let slot = null;
  try {
    slot = ls.getItem(key);
  } catch (err) {
    slot = null;
  }
  if (slot) return;
  if (writeRaw(ls, key, JSON.stringify(last))) touchIndex(ls, last);
}

/* Where a sea's slot lives. FNV-1a of the phrase, so the key is short and
   the phrase itself never has to be a valid key. */
export function seaKeyFor(phrase) {
  let h = 0x811c9dc5;
  const str = String(phrase || "");
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${SEA_PREFIX}${h.toString(16).padStart(8, "0")}`;
}

function summary(profile) {
  return {
    phrase: profile.phrase,
    credits: int(profile.credits, 0, 0, MAX_CREDITS),
    deepest: int(profile.stats && profile.stats.deepest, 0, 0, MAX_DEPTH),
    updated: int(profile.updated, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function readIndex(ls) {
  let list = [];
  try {
    list = JSON.parse(ls.getItem(INDEX_KEY) || "[]");
  } catch (err) {
    list = [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    if (!isPlainObject(e)) continue;
    const phrase = text(e.phrase, MAX_PHRASE, "");
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(summary({ ...e, stats: { deepest: e.deepest } }));
    if (out.length >= MAX_SEAS * 2) break;
  }
  return out;
}

function writeIndex(ls, list) {
  writeRaw(ls, INDEX_KEY, JSON.stringify(list));
}

/* Put this sea at the top of the index, and let the oldest go past MAX_SEAS. */
function touchIndex(ls, profile) {
  const list = readIndex(ls).filter((e) => e.phrase !== profile.phrase);
  list.unshift(summary(profile));
  list.sort((a, b) => b.updated - a.updated);
  const keep = list.slice(0, MAX_SEAS);
  for (const gone of list.slice(MAX_SEAS)) {
    try {
      ls.removeItem(seaKeyFor(gone.phrase));
    } catch (err) {
      void err;
    }
  }
  writeIndex(ls, keep);
}

// ---------------------------------------------------------------- plumbing

function now() {
  try {
    return Date.now();
  } catch (err) {
    return 0;
  }
}

function writeRaw(ls, key, payload) {
  try {
    ls.setItem(key, payload);
    return true;
  } catch (err) {
    return false;
  }
}
