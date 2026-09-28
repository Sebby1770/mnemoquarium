/* What to do next. Pure: no three.js, no DOM, nothing that needs a GPU.
 *
 * A new player used to be dropped in a sea four kilometres wide with an
 * objective line that only ever warned or pointed home. This is the chain of
 * first goals, from the first fish to the Twilight Drift. Every step decides
 * whether it is done by reading state the save already keeps — fish sold,
 * casings bought, deepest depth, landmarks surveyed — so progress survives a
 * reload without a second copy of it to fall out of step.
 *
 * logbook.js watches the bus and asks this module what to say; the HUD, the
 * compass and the Hull only ever read the answer. */

import { bearingOf, compassPoint, formatRange } from "./nav.js";

/* The words for each control, for whatever the player is holding. The HUD and
   the Hull rewrite their hints from this when the input changes. */
const VERBS = {
  mouse: { beam: "hold right mouse", fire: "click", dock: "hold E", use: "E", look: "click to look around" },
  pad: { beam: "hold LT", fire: "RT", dock: "hold d-pad up", use: "A", look: "right stick looks" },
  touch: { beam: "hold BEAM", fire: "FIRE", dock: "hold DOCK", use: "tap", look: "drag to look" },
};

export function verbs(input) {
  return VERBS[input] || VERBS.mouse;
}

function depthOf(profile) {
  return Number(profile && profile.stats && profile.stats.deepest) || 0;
}

function level(profile, id) {
  return Number(profile && profile.upgrades && profile.upgrades[id]) || 0;
}

/* The chain. Order matters: the first step that is not done is the goal.
   Band steps use the deepest depth ever reached rather than a flag, so a
   veteran's old save lands on the right step with no migration at all. */
export const CHAIN = [
  { id: "beam", done: (p) => (p.stats.discovered || []).length > 0 },
  { id: "sell", done: (p) => (p.stats.fishSold || 0) > 0 },
  { id: "casing", done: (p) => level(p, "pressure") >= 1 },
  { id: "kelp", done: (p) => depthOf(p) >= 90 },
  { id: "sight", done: (p) => (p.stats.sighted || []).length > 0 },
  { id: "survey", done: (p) => (p.stats.landmarks || []).length > 0 },
  { id: "casing2", done: (p) => level(p, "pressure") >= 2 },
  { id: "twilight", done: (p) => depthOf(p) >= 240 },
];

/* Lines for the moment a step completes, in the game's voice. */
export const DONE_LINES = {
  beam: "the first one is in the hold. it will not be the last.",
  sell: "sold. the Hull pays for what it has not seen before.",
  casing: "a new casing. the numbers under you mean something else now.",
  kelp: "the Kelp Cathedral. first descent.",
  sight: "logged. not everything down here is money or teeth.",
  survey: "surveyed. the chart has one less rumour on it.",
  casing2: "a second casing. the light is going to start running out.",
  twilight: "the Twilight Drift. the last of the light, spending itself.",
};

/* A first descent into the kelp pays a little, because it is the first real
   goal and it is further than it looks. */
export const FIRST_DESCENT_FEE = { kelp: 60, twilight: 180 };

export function currentStep(profile) {
  if (!profile || !profile.stats) return CHAIN[0];
  for (const step of CHAIN) if (!step.done(profile)) return step;
  return null;
}

export function stepIndex(profile) {
  const step = currentStep(profile);
  return step ? CHAIN.indexOf(step) : CHAIN.length;
}

function towards(from, to) {
  if (!from || !to) return "";
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return `${compassPoint(bearingOf(dx, dz))} · ${formatRange(Math.hypot(dx, dz))}`;
}

/* What the objective line says for a step, and where the compass marker goes.
 *
 * ctx = {
 *   profile, input, sub: {x, z, depth}, docked: bool,
 *   station: {x, z}, kelp: {x, z}|null,
 *   rumour: {x, z, name, depth}|null,
 *   casingCost: number|null, casing2Cost: number|null,
 * }
 * -> { id, text, target: {x, z}|null, terminal: "market"|"drydock"|null } | null */
export function objectiveFor(step, ctx) {
  if (!step || !ctx) return null;
  const v = verbs(ctx.input);
  const p = ctx.profile || { cargo: [], credits: 0 };
  const held = (p.cargo || []).length;
  const credits = Math.floor(Number(p.credits) || 0);
  const here = ctx.sub || null;
  const out = { id: step.id, text: "", target: null, terminal: null };

  switch (step.id) {
    case "beam":
      out.text = ctx.docked
        ? `board the boat, then ${v.beam} on a fish to take it`
        : `${v.beam} on a fish to take it`;
      break;
    case "sell":
      if (held === 0) {
        out.text = `${v.beam} on a fish to take it — the Hull buys what you bring`;
      } else if (ctx.docked) {
        out.text = "sell the hold at the market terminal";
        out.terminal = "market";
      } else {
        out.text = `take the catch home · the Hull bears ${towards(here, ctx.station)}`;
        out.target = ctx.station;
      }
      break;
    case "casing":
    case "casing2": {
      const cost = step.id === "casing" ? ctx.casingCost : ctx.casing2Cost;
      if (held > 0 && !ctx.docked) {
        out.text = `sell the hold · the Hull bears ${towards(here, ctx.station)}`;
        out.target = ctx.station;
      } else if (cost && credits >= cost) {
        out.text = ctx.docked
          ? "buy the pressure casing at the drydock"
          : `a casing is paid for · the Hull bears ${towards(here, ctx.station)}`;
        out.terminal = "drydock";
        if (!ctx.docked) out.target = ctx.station;
      } else {
        out.text = cost
          ? `save for a pressure casing · ${credits} / ${cost} cr`
          : "save for a pressure casing";
        out.terminal = ctx.docked ? "drydock" : null;
      }
      break;
    }
    case "kelp":
      out.text = ctx.kelp
        ? `the Kelp Cathedral starts at 90 m · ${towards(here, ctx.kelp)}`
        : "the Kelp Cathedral starts at 90 m — follow the floor down";
      out.target = ctx.kelp || null;
      break;
    case "sight":
      out.text = "log a sighting — a turtle, a manta, an octopus, a moon jelly";
      break;
    case "survey":
      if (ctx.rumour) {
        out.text = `a ${String(ctx.rumour.name || "place").toLowerCase()} is rumoured ${towards(here, ctx.rumour)} · ${Math.round(ctx.rumour.depth)} m`;
        out.target = ctx.rumour;
      } else {
        out.text = "find a landmark — the chart (M) has rumours on it";
      }
      break;
    case "twilight":
      out.text = "the Twilight Drift starts at 240 m — the light gives out there";
      break;
    default:
      return null;
  }
  return out;
}

/* The refit to pin at the top of the drydock, with a reason in one line.
   `next(id)` returns the cost of the next level, or null when maxed. */
export function recommendedRefit(profile, stats, next) {
  if (!profile || typeof next !== "function") return null;
  const rating = Number(stats && stats.pressureRating) || 140;
  const deepest = depthOf(profile);
  const pick = (id, reason) => (next(id) != null ? { id, reason } : null);

  // Nothing worth real money lives above the stock rating.
  if (level(profile, "pressure") === 0) {
    return pick("pressure", "everything worth money lives below your rating");
  }
  // Pressed against the rating: the next band is the next casing.
  if (deepest >= rating * 0.8) {
    const r = pick("pressure", "you have been living at your rating");
    if (r) return r;
  }
  // A deeper boat with a small hold wastes the trip down.
  if (level(profile, "cargo") < level(profile, "pressure")) {
    const r = pick("cargo", "a deeper sea wants a bigger hold");
    if (r) return r;
  }
  // Past the twilight, the lamps are how you see anything at all.
  if (rating >= 240 && level(profile, "lights") < level(profile, "pressure") - 1) {
    const r = pick("lights", "past the twilight, the lamps are the only light");
    if (r) return r;
  }
  return pick("pressure", "the next band down is the next casing");
}
