/* How many pixels the frame can afford.
 *
 * The scene renders into a half-float target with 4x MSAA and then runs a
 * bloom chain over it, all at the device pixel ratio. On a laptop with a 2x
 * screen that is four times the pixels the same laptop's GPU can fill at 60,
 * and the sea turns into a slideshow exactly where it is prettiest. The
 * governor watches the real frame time and trades resolution for it.
 *
 * It drops fast and climbs slowly. Rebuilding the render targets is not free,
 * so it never moves more than once every couple of seconds, and a scale that
 * has already failed once is not tried again for a while — otherwise a 60 Hz
 * screen, where every frame that fits reads 16.7 ms whether it had room to
 * spare or not, would bounce between two scales forever.
 *
 * Nothing here touches three.js, so the rules can be tested without a GPU. */

export const QUALITY_MODES = ["auto", "high", "low"];

export const SCALE = {
  max: 1,
  min: 0.5,
  low: 0.6,
  dropStep: 0.1,
  riseStep: 0.05,
};

const SLOW = 1 / 45;           // sustained frame time that costs resolution
const FAST = 1 / 57;           // sustained frame time that may earn it back
const SMOOTHING = 0.08;        // EMA weight of a new frame
const WARMUP = 1.5;            // seconds ignored after start / resize / mode change
const DROP_COOLDOWN = 1.25;
const RISE_COOLDOWN = 4;
const RISE_HOLD = 3;           // seconds of fast frames before climbing
const FAILED_MEMORY = 25;      // seconds a failed scale is off the table
const OUTLIER = 0.25;          // a frame this long is a hitch or a tab switch

function round2(x) {
  return Math.round(x * 100) / 100;
}

export class ResolutionGovernor {
  constructor(mode = "auto") {
    this.scale = SCALE.max;
    this.avg = 1 / 60;
    this.cooldown = WARMUP;
    this.fastFor = 0;
    this.failedAt = Infinity;  // lowest scale known to be too slow
    this.failedFor = 0;
    this.setMode(mode);
  }

  /* Returns the scale the mode wants right now. */
  setMode(mode) {
    this.mode = QUALITY_MODES.includes(mode) ? mode : "auto";
    if (this.mode === "high") this.scale = SCALE.max;
    else if (this.mode === "low") this.scale = SCALE.low;
    this.reset();
    return this.scale;
  }

  /* Forget the recent frames without forgetting the scale: a resize or a
     panel opening changes the workload, so old timings mean nothing. */
  reset() {
    this.avg = 1 / 60;
    this.cooldown = Math.max(this.cooldown || 0, WARMUP);
    this.fastFor = 0;
  }

  /* Feed one raw (unclamped) frame delta. Returns the new scale when it
     changed, or null when the frame should render as before. */
  sample(dt) {
    if (this.mode !== "auto") return null;
    if (!(dt > 0) || dt > OUTLIER) return null;

    this.avg += (dt - this.avg) * SMOOTHING;
    if (this.failedFor > 0) {
      this.failedFor -= dt;
      if (this.failedFor <= 0) this.failedAt = Infinity;
    }
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return null;
    }

    if (this.avg > SLOW && this.scale > SCALE.min) {
      this.failedAt = Math.min(this.failedAt, this.scale);
      this.failedFor = FAILED_MEMORY;
      this.scale = round2(Math.max(SCALE.min, this.scale - SCALE.dropStep));
      this.cooldown = DROP_COOLDOWN;
      this.fastFor = 0;
      // Start the next judgement from a neutral frame time, not the slow one.
      this.avg = 1 / 50;
      return this.scale;
    }

    if (this.avg < FAST) this.fastFor += dt;
    else this.fastFor = 0;

    if (this.fastFor >= RISE_HOLD && this.scale < SCALE.max) {
      const next = round2(Math.min(SCALE.max, this.scale + SCALE.riseStep));
      if (next >= this.failedAt) return null;
      this.scale = next;
      this.cooldown = RISE_COOLDOWN;
      this.fastFor = 0;
      return this.scale;
    }
    return null;
  }
}

/* The pixel ratio the renderer should use for a device ratio and a scale.
   Capped at 2 because nobody can see the third pixel, floored so the picture
   never goes coarser than half a CSS pixel. */
export function pixelRatioFor(devicePixelRatio, scale) {
  const dpr = Math.min(2, Number(devicePixelRatio) > 0 ? Number(devicePixelRatio) : 1);
  return Math.max(0.5, round2(dpr * scale));
}
