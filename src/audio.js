/* The whole soundtrack of the deep is arithmetic. There are no audio files in
   this repo and there never will be: every noise below is synthesised at
   runtime from oscillators and two buffers of generated noise. That keeps the
   game a single folder of text, and it lets the sea's voice follow depth and
   threat continuously instead of crossfading between clips.

   Nothing touches WebAudio until start() is called from a user gesture --
   browsers refuse to open a context any other way, and a refusal that throws
   would take the frame loop down with it. If AudioContext is missing or
   unhappy this module quietly becomes a no-op. A silent game is a playable
   game; a game that throws in the mixer is not. */

import { SEA, ZONES, zoneForDepth } from "./config.js";
import { clamp01, lerp, damp } from "./util.js";

const AudioContextCtor =
  typeof globalThis !== "undefined"
    ? globalThis.AudioContext || globalThis.webkitAudioContext || null
    : null;

/* Headroom: the compressor after this catches a kraken roar landing on top of
   a torpedo, but it should rarely have to work. */
const MASTER_GAIN = 0.62;

/* Ceiling on simultaneous one-shot voices. Past this we drop cues rather than
   let a crowd of harpoon hits turn the mix to gravel. */
const MAX_VOICES = 22;

/* Per-cue loudness trim, so one table holds the balance instead of it being
   smeared across seventeen envelopes. */
const CUE_GAIN = {
  harpoon: 0.80,
  torpedo: 0.90,
  hit: 0.58,
  kill: 0.70,
  capture: 0.55,
  alarm: 0.46,
  sell: 0.58,
  upgrade: 0.64,
  dock: 0.72,
  undock: 0.68,
  roar: 1.00,
  sonar: 0.66,
  damage: 0.84,
  explode: 1.00,
  click: 0.34,
  deny: 0.40,
  depth: 0.78,
};

/* Minimum seconds between two firings of the same cue. This is also the
   de-duplicator: game.js may call sfx() directly for an event this module also
   hears on the bus, and the second copy inside the window is swallowed. */
const CUE_GAP = {
  harpoon: 0.05,
  torpedo: 0.09,
  hit: 0.045,
  kill: 0.12,
  capture: 0.10,
  alarm: 1.30,
  sell: 0.20,
  upgrade: 0.20,
  dock: 0.40,
  undock: 0.40,
  roar: 1.60,
  sonar: 0.25,
  damage: 0.11,
  explode: 0.14,
  click: 0.03,
  deny: 0.14,
  depth: 0.90,
};

/* Soft-clip transfer curve for the things that should sound like metal giving
   up: roars, crunches, explosions. Shared as data; each voice still needs its
   own WaveShaper node so the branches never intermodulate. */
function crunchCurve(amount, samples) {
  const n = samples || 1024;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i += 1) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/* Noise beds. Pink for water and hull (1/f is what moving water sounds like),
   white for the bright chuffs and ticks. Generated once per context. */
function makeNoiseBuffer(ctx, seconds, pink) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < len; i += 1) {
    const w = Math.random() * 2 - 1;
    if (!pink) {
      data[i] = w * 0.72;
      continue;
    }
    // Paul Kellet's economical pink filter: a 1/f slope without an FFT.
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  // Stitch the head over the tail so the loop seam does not tick once a cycle.
  const fade = Math.min(4096, Math.floor(len / 8));
  for (let i = 0; i < fade; i += 1) {
    const k = i / fade;
    data[i] = data[i] * k + data[len - fade + i] * (1 - k);
  }
  return buf;
}

function num(v, fallback) {
  return typeof v === "number" && isFinite(v) ? v : fallback;
}

export class Audio {
  constructor(game) {
    this.game = game || null;
    this.bus = game && game.bus ? game.bus : null;

    this.supported = !!AudioContextCtor;
    /* `enabled` is the player's preference and may be true before a gesture
       has let us open a context; `running` is whether sound is actually live.
       Everything that makes noise checks `running`. */
    const settings = game && game.profile ? game.profile.settings : null;
    this.enabled = !!(settings && settings.sound);
    this.running = false;
    this.ctx = null;

    // Driving values, set from outside and smoothed in update().
    this.depthTarget = 0;
    this.depthSmooth = 0;
    this.thrustTarget = 0;
    this.thrustSmooth = 0;
    this.threatTarget = 0;
    this.threatSmooth = 0;

    this.duckLevel = 1;
    this.groanIn = 12;

    this.lastCue = new Map();     // cue name -> context time it last fired
    this.driven = new Map();      // AudioParam -> last target written
    this.voiceEnds = [];          // context times at which one-shots free up
    this.offs = [];               // bus unsubscribes
    this.suspendTimer = 0;

    this.crunch = crunchCurve(6.5);

    if (this.bus) this.listen();
  }

  /* ------------------------------------------------------------- lifecycle */

  /* Called from a click, a key, a form submit -- anything the browser counts
     as intent. Safe to call repeatedly; the graph is built exactly once. */
  start() {
    if (!this.supported) return false;
    if (!this.ctx && !this.create()) return false;
    this.enabled = true;
    this.running = true;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = 0;
    }
    // resume() returns a promise that rejects harmlessly if the gesture that
    // called us has already gone stale. Never let that reach the console.
    const resumed = this.ctx.resume();
    if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(MASTER_GAIN * this.duckLevel, now + 0.9);
    // Re-anchor the bed so a long silence does not snap back in at full tilt.
    this.applyDepth(true);
    this.applyThrust(true);
    this.applyThreat(true);
    return true;
  }

  /* Fade out, then park the context so a muted tab costs nothing. */
  stop() {
    this.enabled = false;
    if (!this.ctx) {
      this.running = false;
      return;
    }
    const now = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(0, now + 0.35);
    this.running = false;
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    // Let the fade finish in wall time before suspending; suspending mid-ramp
    // freezes the gain where it stands and the next start() would click.
    this.suspendTimer = setTimeout(() => {
      this.suspendTimer = 0;
      if (!this.ctx || this.running) return;
      const p = this.ctx.suspend();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }, 430);
  }

  toggle(enabled) {
    const want = enabled === undefined ? !this.enabled : !!enabled;
    if (want) this.start();
    else this.stop();
    // Remember the choice. persist() is debounced upstream, so this is cheap.
    const profile = this.game && this.game.profile ? this.game.profile : null;
    if (profile && profile.settings) profile.settings.sound = this.enabled;
    if (this.game && typeof this.game.persist === "function") this.game.persist();
    return this.enabled;
  }

  dispose() {
    for (const off of this.offs) {
      try {
        off();
      } catch (err) {
        /* a bus that has already been cleared is not an error worth noise */
      }
    }
    this.offs.length = 0;
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer);
      this.suspendTimer = 0;
    }
    if (this.ctx) {
      try {
        for (const src of this.beds) {
          src.onended = null;
          src.stop();
        }
        this.master.disconnect();
        this.comp.disconnect();
      } catch (err) {
        /* teardown is best effort; the close() below frees it regardless */
      }
      try {
        const p = this.ctx.close();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch (err) {
        /* some browsers refuse close() on an already-closed context */
      }
    }
    this.ctx = null;
    this.beds = [];
    this.driven.clear();
    this.lastCue.clear();
    this.voiceEnds.length = 0;
    this.running = false;
    this.enabled = false;
  }

  /* --------------------------------------------------------------- driving */

  setDepth(depth) {
    this.depthTarget = Math.max(0, Math.min(SEA.maxDepth, num(depth, 0)));
  }

  setThrust(amount) {
    this.thrustTarget = clamp01(num(amount, 0));
  }

  setThreat(level) {
    this.threatTarget = clamp01(num(level, 0));
  }

  update(dt) {
    if (!this.running || !this.ctx) return;
    const step = Math.max(0, Math.min(0.1, num(dt, 0)));
    if (step <= 0) return;

    this.depthSmooth = damp(this.depthSmooth, this.depthTarget, 1.5, step);
    this.thrustSmooth = damp(this.thrustSmooth, this.thrustTarget, 7, step);
    // Threat rushes in and leaves slowly -- dread outlives the shark.
    const threatRate = this.threatTarget > this.threatSmooth ? 2.2 : 0.45;
    this.threatSmooth = damp(this.threatSmooth, this.threatTarget, threatRate, step);

    this.applyDepth(false);
    this.applyThrust(false);
    this.applyThreat(false);

    this.groanIn -= step;
    if (this.groanIn <= 0) {
      const t = clamp01(this.depthSmooth / SEA.maxDepth);
      // The hull complains more often the further down you push it.
      this.groanIn = lerp(34, 8.5, t) * (0.55 + Math.random() * 0.95);
      if (this.depthSmooth > 30) this.groan(this.ctx.currentTime + 0.08, t);
    }

    this.pruneVoices(this.ctx.currentTime);
  }

  /* ------------------------------------------------------------------- sfx */

  sfx(name, opts) {
    if (!this.running || !this.ctx) return;
    const key = String(name || "");
    if (!key) return;
    const now = this.ctx.currentTime;
    const gap = CUE_GAP[key] === undefined ? 0.05 : CUE_GAP[key];
    const last = this.lastCue.get(key);
    if (last !== undefined && now - last < gap) return;

    const o = opts || {};
    const gain = (CUE_GAIN[key] === undefined ? 0.6 : CUE_GAIN[key]) * num(o.gain, 1);
    const rate = Math.max(0.25, Math.min(4, num(o.rate, 1)));
    const t = now + Math.max(0, num(o.delay, 0)) + 0.005;
    if (gain <= 0.0005) return;

    let length = 0;
    switch (key) {
      case "harpoon": length = this.cueHarpoon(t, gain, rate); break;
      case "torpedo": length = this.cueTorpedo(t, gain, rate); break;
      case "hit": length = this.cueHit(t, gain, rate); break;
      case "kill": length = this.cueKill(t, gain, rate); break;
      case "capture": length = this.cueCapture(t, gain, rate); break;
      case "alarm": length = this.cueAlarm(t, gain, rate, Math.round(num(o.count, 3))); break;
      case "sell": length = this.cueBell(t, gain, rate, 392, 3); break;
      case "upgrade": length = this.cueUpgrade(t, gain, rate); break;
      case "dock": length = this.cueDock(t, gain, rate); break;
      case "undock": length = this.cueUndock(t, gain, rate); break;
      case "roar": length = this.cueRoar(t, gain, rate, num(o.length, 1)); break;
      case "sonar": length = this.cueSonar(t, gain, rate); break;
      case "damage": length = this.cueDamage(t, gain, rate); break;
      case "explode": length = this.cueExplode(t, gain, rate); break;
      case "click": length = this.cueClick(t, gain, rate); break;
      case "deny": length = this.cueDeny(t, gain, rate); break;
      case "depth": length = this.cueDepth(t, gain, rate); break;
      default: return;
    }
    this.lastCue.set(key, now);
    this.claim(now, length);
  }

  /* ---------------------------------------------------------- graph set-up */

  create() {
    let ctx = null;
    try {
      ctx = new AudioContextCtor({ latencyHint: "interactive" });
      this.ctx = ctx;
      this.build();
      return true;
    } catch (err) {
      // No WebAudio, or the browser refused to hand one over. Run silent.
      console.warn("the deep is running without sound", err);
      this.supported = false;
      this.ctx = null;
      if (ctx && typeof ctx.close === "function") {
        try {
          ctx.close();
        } catch (inner) {
          /* nothing left to do about it */
        }
      }
      return false;
    }
  }

  build() {
    const ctx = this.ctx;
    this.beds = [];

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -15;
    this.comp.knee.value = 20;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.006;
    this.comp.release.value = 0.24;
    this.comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.comp);

    /* A delay/feedback chain standing in for the enormous room the player is
       swimming inside. Cheaper than a convolver and it never needs an impulse
       file, which is the whole rule of this module. */
    this.wash = ctx.createGain();
    this.wash.gain.value = 1;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.29;
    const delay2 = ctx.createDelay(2);
    delay2.delayTime.value = 0.41;
    const washLP = ctx.createBiquadFilter();
    washLP.type = "lowpass";
    washLP.frequency.value = 1700;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.52;
    const washOut = ctx.createGain();
    washOut.gain.value = 0.55;
    this.wash.connect(delay);
    this.wash.connect(delay2);
    delay.connect(washLP);
    delay2.connect(washLP);
    washLP.connect(feedback);
    feedback.connect(delay);
    feedback.connect(delay2);
    washLP.connect(washOut);
    washOut.connect(this.master);
    this.washOut = washOut;

    this.ambient = ctx.createGain();
    this.ambient.gain.value = 1;
    this.ambient.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);

    this.pink = makeNoiseBuffer(ctx, 6, true);
    this.white = makeNoiseBuffer(ctx, 3, false);

    this.buildWater();
    this.buildDrone();
    this.buildThreat();
    this.buildMotor();
  }

  /* The water itself: pink noise squeezed shut by depth, plus a slow surge
     band so it breathes instead of hissing. */
  buildWater() {
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = this.pink;
    src.loop = true;
    src.playbackRate.value = 0.82;

    this.waterLP = ctx.createBiquadFilter();
    this.waterLP.type = "lowpass";
    this.waterLP.frequency.value = 1400;
    this.waterLP.Q.value = 0.7;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 45;

    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0.28;

    src.connect(this.waterLP);
    this.waterLP.connect(hp);
    hp.connect(this.waterGain);
    this.waterGain.connect(this.ambient);
    src.start();
    this.beds.push(src);

    // A very slow wander on the cutoff so the bed never sits still.
    const swell = ctx.createOscillator();
    swell.type = "sine";
    swell.frequency.value = 0.055;
    const swellDepth = ctx.createGain();
    swellDepth.gain.value = 160;
    swell.connect(swellDepth);
    swellDepth.connect(this.waterLP.frequency);
    swell.start();
    this.beds.push(swell);

    // Surge: a resonant low band that swells with depth, the sound of a lot of
    // water deciding where to go.
    const surgeSrc = ctx.createBufferSource();
    surgeSrc.buffer = this.pink;
    surgeSrc.loop = true;
    surgeSrc.playbackRate.value = 0.5;
    const surgeBP = ctx.createBiquadFilter();
    surgeBP.type = "bandpass";
    surgeBP.frequency.value = 175;
    surgeBP.Q.value = 1.4;
    this.surgeGain = ctx.createGain();
    this.surgeGain.gain.value = 0.05;
    surgeSrc.connect(surgeBP);
    surgeBP.connect(this.surgeGain);
    this.surgeGain.connect(this.ambient);
    surgeSrc.start(0, 1.7);
    this.beds.push(surgeSrc);

    const surgeLfo = ctx.createOscillator();
    surgeLfo.type = "sine";
    surgeLfo.frequency.value = 0.083;
    const surgeLfoDepth = ctx.createGain();
    surgeLfoDepth.gain.value = 55;
    surgeLfo.connect(surgeLfoDepth);
    surgeLfoDepth.connect(surgeBP.frequency);
    surgeLfo.start();
    this.beds.push(surgeLfo);
  }

  /* Two saws a few cents apart, beating against each other roughly once every
     three seconds. Pitch and weight both follow depth. */
  buildDrone() {
    const ctx = this.ctx;

    this.droneA = ctx.createOscillator();
    this.droneA.type = "sawtooth";
    this.droneA.frequency.value = 54;
    this.droneB = ctx.createOscillator();
    this.droneB.type = "sawtooth";
    this.droneB.frequency.value = 54 * 1.0073;
    this.droneSub = ctx.createOscillator();
    this.droneSub.type = "sine";
    this.droneSub.frequency.value = 27;

    const mix = ctx.createGain();
    mix.gain.value = 0.34;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;

    this.droneLP = ctx.createBiquadFilter();
    this.droneLP.type = "lowpass";
    this.droneLP.frequency.value = 320;
    this.droneLP.Q.value = 3.2;

    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.05;

    this.droneA.connect(mix);
    this.droneB.connect(mix);
    this.droneSub.connect(subGain);
    subGain.connect(mix);
    mix.connect(this.droneLP);
    this.droneLP.connect(this.droneGain);
    this.droneGain.connect(this.ambient);

    // A glacial detune wobble keeps the pair from ever sounding synthesised.
    const vib = ctx.createOscillator();
    vib.type = "sine";
    vib.frequency.value = 0.037;
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = 7;
    vib.connect(vibDepth);
    vibDepth.connect(this.droneA.detune);
    const vibInv = ctx.createGain();
    vibInv.gain.value = -1;
    vibDepth.connect(vibInv);
    vibInv.connect(this.droneB.detune);

    this.droneA.start();
    this.droneB.start();
    this.droneSub.start();
    vib.start();
    this.beds.push(this.droneA, this.droneB, this.droneSub, vib);
  }

  /* The hunting layer: a root, a tritone above it, and a sour octave. It is
     deliberately an interval you cannot resolve. */
  buildThreat() {
    const ctx = this.ctx;

    this.threatA = ctx.createOscillator();
    this.threatA.type = "sawtooth";
    this.threatA.frequency.value = 43;
    this.threatB = ctx.createOscillator();
    this.threatB.type = "sawtooth";
    this.threatB.frequency.value = 43 * 1.4142;
    this.threatC = ctx.createOscillator();
    this.threatC.type = "triangle";
    this.threatC.frequency.value = 43 * 2.06;

    const mix = ctx.createGain();
    mix.gain.value = 0.33;
    this.threatA.connect(mix);
    this.threatB.connect(mix);
    this.threatC.connect(mix);

    this.threatLP = ctx.createBiquadFilter();
    this.threatLP.type = "lowpass";
    this.threatLP.frequency.value = 150;
    this.threatLP.Q.value = 5.5;

    // A separate node carries the tremolo so the level control stays linear.
    this.threatTrem = ctx.createGain();
    this.threatTrem.gain.value = 0.78;
    this.threatLfo = ctx.createOscillator();
    this.threatLfo.type = "sine";
    this.threatLfo.frequency.value = 2.4;
    const tremDepth = ctx.createGain();
    tremDepth.gain.value = 0.22;
    this.threatLfo.connect(tremDepth);
    tremDepth.connect(this.threatTrem.gain);

    this.threatOut = ctx.createGain();
    this.threatOut.gain.value = 0;

    mix.connect(this.threatLP);
    this.threatLP.connect(this.threatTrem);
    this.threatTrem.connect(this.threatOut);
    this.threatOut.connect(this.master);

    this.threatA.start();
    this.threatB.start();
    this.threatC.start();
    this.threatLfo.start();
    this.beds.push(this.threatA, this.threatB, this.threatC, this.threatLfo);
  }

  /* Impeller: a filtered noise rush over a gritty saw. Both open up with the
     throttle, and there is always a faint idle whirr so the boat feels alive. */
  buildMotor() {
    const ctx = this.ctx;

    this.motorOut = ctx.createGain();
    this.motorOut.gain.value = 0.12;
    this.motorOut.connect(this.master);

    const noise = ctx.createBufferSource();
    noise.buffer = this.pink;
    noise.loop = true;
    noise.playbackRate.value = 1.15;
    this.motorNoiseLP = ctx.createBiquadFilter();
    this.motorNoiseLP.type = "lowpass";
    this.motorNoiseLP.frequency.value = 240;
    this.motorNoiseLP.Q.value = 1.1;
    this.motorNoiseGain = ctx.createGain();
    this.motorNoiseGain.gain.value = 0.03;
    noise.connect(this.motorNoiseLP);
    this.motorNoiseLP.connect(this.motorNoiseGain);
    this.motorNoiseGain.connect(this.motorOut);
    noise.start(0, 0.9);
    this.beds.push(noise);

    this.motorOsc = ctx.createOscillator();
    this.motorOsc.type = "sawtooth";
    this.motorOsc.frequency.value = 26;
    this.motorHarm = ctx.createOscillator();
    this.motorHarm.type = "square";
    this.motorHarm.frequency.value = 39;
    const harmGain = ctx.createGain();
    harmGain.gain.value = 0.22;

    const shaper = ctx.createWaveShaper();
    shaper.curve = crunchCurve(2.2);
    this.motorLP = ctx.createBiquadFilter();
    this.motorLP.type = "lowpass";
    this.motorLP.frequency.value = 190;
    this.motorLP.Q.value = 2.8;
    this.motorOscGain = ctx.createGain();
    this.motorOscGain.gain.value = 0.02;

    this.motorOsc.connect(shaper);
    this.motorHarm.connect(harmGain);
    harmGain.connect(shaper);
    shaper.connect(this.motorLP);
    this.motorLP.connect(this.motorOscGain);
    this.motorOscGain.connect(this.motorOut);

    // A shallow wobble on the impeller pitch: the shaft is not perfectly true.
    const wob = ctx.createOscillator();
    wob.type = "sine";
    wob.frequency.value = 0.61;
    const wobDepth = ctx.createGain();
    wobDepth.gain.value = 12;
    wob.connect(wobDepth);
    wobDepth.connect(this.motorOsc.detune);
    wobDepth.connect(this.motorHarm.detune);

    this.motorOsc.start();
    this.motorHarm.start();
    wob.start();
    this.beds.push(this.motorOsc, this.motorHarm, wob);
  }

  /* ------------------------------------------------------- param following */

  /* setTargetAtTime is click-free and cheap, but re-anchoring the same target
     every frame is pointless churn, so remember what we last asked for. */
  drive(param, value, timeConstant, force) {
    if (!param) return;
    const last = this.driven.get(param);
    if (!force && last !== undefined && Math.abs(last - value) < 1e-3) return;
    this.driven.set(param, value);
    param.setTargetAtTime(value, this.ctx.currentTime, Math.max(0.005, timeConstant));
  }

  applyDepth(force) {
    if (!this.ctx || !this.waterLP) return;
    const t = clamp01(this.depthSmooth / SEA.maxDepth);
    const curved = Math.pow(t, 0.62);
    // Water above you is a lowpass filter you are standing inside.
    this.drive(this.waterLP.frequency, lerp(1500, 190, curved), 0.7, force);
    this.drive(this.waterGain.gain, lerp(0.30, 0.19, t), 0.9, force);
    this.drive(this.surgeGain.gain, lerp(0.045, 0.155, t), 1.1, force);

    const f = lerp(56, 23, Math.pow(t, 0.78));
    this.drive(this.droneA.frequency, f, 1.8, force);
    this.drive(this.droneB.frequency, f * 1.0073, 1.8, force);
    this.drive(this.droneSub.frequency, f * 0.5, 1.8, force);
    this.drive(this.droneLP.frequency, lerp(340, 145, t), 1.4, force);
    this.drive(this.droneGain.gain, lerp(0.045, 0.21, Math.pow(t, 0.85)), 1.4, force);
  }

  applyThrust(force) {
    if (!this.ctx || !this.motorOut) return;
    const a = clamp01(this.thrustSmooth);
    const open = Math.pow(a, 0.8);
    this.drive(this.motorOut.gain, lerp(0.12, 1, open), 0.09, force);
    this.drive(this.motorNoiseLP.frequency, lerp(230, 1450, open), 0.1, force);
    this.drive(this.motorNoiseGain.gain, lerp(0.03, 0.30, open), 0.12, force);
    this.drive(this.motorOsc.frequency, lerp(26, 76, a), 0.12, force);
    this.drive(this.motorHarm.frequency, lerp(39, 114, a), 0.12, force);
    this.drive(this.motorLP.frequency, lerp(185, 840, open), 0.12, force);
    this.drive(this.motorOscGain.gain, lerp(0.02, 0.26, open), 0.12, force);
  }

  applyThreat(force) {
    if (!this.ctx || !this.threatOut) return;
    const l = clamp01(this.threatSmooth);
    const d = clamp01(this.depthSmooth / SEA.maxDepth);
    const root = lerp(46, 30, d);
    this.drive(this.threatA.frequency, root, 1.2, force);
    this.drive(this.threatB.frequency, root * 1.4142, 1.2, force);
    this.drive(this.threatC.frequency, root * 2.06, 1.2, force);
    // Squared so a distant contact is a rumour and a close one is a fact.
    this.drive(this.threatOut.gain, l * l * 0.3, 0.6, force);
    this.drive(this.threatLP.frequency, lerp(135, 440, l), 0.9, force);
    this.drive(this.threatLfo.frequency, lerp(2.1, 6.4, l), 1.0, force);
  }

  /* Duck the bed under something enormous, or under an open panel. */
  duck(level, seconds) {
    if (!this.ctx || !this.master) return;
    this.duckLevel = clamp01(level);
    const now = this.ctx.currentTime;
    const target = this.running ? MASTER_GAIN * this.duckLevel : 0;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), now);
    this.master.gain.setTargetAtTime(target, now, Math.max(0.02, seconds || 0.12));
  }

  /* ------------------------------------------------------- voice plumbing */

  claim(now, length) {
    this.voiceEnds.push(now + Math.max(0.05, length || 0.2));
  }

  free(now) {
    let live = 0;
    for (let i = 0; i < this.voiceEnds.length; i += 1) {
      if (this.voiceEnds[i] > now) live += 1;
    }
    return MAX_VOICES - live;
  }

  pruneVoices(now) {
    const ends = this.voiceEnds;
    let w = 0;
    for (let i = 0; i < ends.length; i += 1) {
      if (ends[i] > now) {
        ends[w] = ends[i];
        w += 1;
      }
    }
    ends.length = w;
  }

  gain(value) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  osc(type, freq, t) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(0.01, freq), t);
    return o;
  }

  filter(type, freq, q, t) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(Math.max(10, freq), t);
    if (q !== undefined) f.Q.setValueAtTime(q, t);
    return f;
  }

  shaper() {
    const s = this.ctx.createWaveShaper();
    s.curve = this.crunch;
    return s;
  }

  /* A looping noise source started at a random offset, so two chuffs in a row
     never phase-lock into a machine gun. */
  noise(t, rate, white) {
    const src = this.ctx.createBufferSource();
    const buf = white ? this.white : this.pink;
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate || 1;
    src.start(t, Math.random() * Math.max(0.01, buf.duration - 0.6));
    return src;
  }

  /* Attack / hold / decay on a gain, exponential so it sounds like a decay and
     not like a fader being pushed. */
  env(param, t, peak, attack, decay, hold) {
    const p = Math.max(0.0004, peak);
    const a = Math.max(0.0008, attack);
    const h = Math.max(0, hold || 0);
    param.setValueAtTime(0.0002, t);
    param.exponentialRampToValueAtTime(p, t + a);
    if (h > 0) param.setValueAtTime(p, t + a + h);
    param.exponentialRampToValueAtTime(0.0002, t + a + h + Math.max(0.01, decay));
    return a + h + decay;
  }

  /* Stop a source and let go of it once it is done. Downstream nodes lose
     their last input at the same moment and become collectable. */
  retire(node, stopAt) {
    try {
      node.stop(stopAt);
    } catch (err) {
      /* a node that refuses to stop has already stopped */
    }
    node.onended = () => {
      node.onended = null;
      try {
        node.disconnect();
      } catch (err) {
        /* already detached */
      }
    };
  }

  out(gainValue, washSend) {
    const g = this.gain(gainValue);
    g.connect(this.sfxBus);
    if (washSend > 0) {
      const send = this.gain(washSend);
      g.connect(send);
      send.connect(this.wash);
    }
    return g;
  }

  /* ------------------------------------------------------------- the cues */

  cueHarpoon(t, g, r) {
    const out = this.out(0.9 * g, 0.05);
    // The bolt: a blip that falls out of the middle of the mix immediately.
    const o = this.osc("square", 900 * r, t);
    o.frequency.exponentialRampToValueAtTime(150 * r, t + 0.09);
    const og = this.gain(0);
    this.env(og.gain, t, 0.5, 0.002, 0.1);
    const lp = this.filter("lowpass", 2800, 1, t);
    o.connect(og);
    og.connect(lp);
    lp.connect(out);
    o.start(t);
    this.retire(o, t + 0.18);
    // The chuff of water shoved out of the tube behind it.
    const n = this.noise(t, 1, true);
    const bp = this.filter("bandpass", 1600 * r, 1.2, t);
    bp.frequency.exponentialRampToValueAtTime(420 * r, t + 0.16);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.34, 0.004, 0.17);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.24);
    return 0.28;
  }

  cueTorpedo(t, g, r) {
    const out = this.out(0.95 * g, 0.14);
    // Launch thump.
    const thump = this.osc("sine", 130 * r, t);
    thump.frequency.exponentialRampToValueAtTime(46 * r, t + 0.22);
    const tg = this.gain(0);
    this.env(tg.gain, t, 0.5, 0.004, 0.26);
    thump.connect(tg);
    tg.connect(out);
    thump.start(t);
    this.retire(thump, t + 0.34);
    // Whoosh: a band of noise sliding up as the fish leaves the tube.
    const n = this.noise(t, 1.1, false);
    const bp = this.filter("bandpass", 260 * r, 1.6, t);
    bp.frequency.exponentialRampToValueAtTime(1750 * r, t + 0.55);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.42, 0.11, 0.52);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.72);
    // Rising tail: the motor winding out into the dark.
    const tail = this.osc("sawtooth", 72 * r, t);
    tail.frequency.exponentialRampToValueAtTime(245 * r, t + 0.7);
    const lp = this.filter("lowpass", 700, 2.4, t);
    lp.frequency.exponentialRampToValueAtTime(1600, t + 0.7);
    const tailGain = this.gain(0);
    this.env(tailGain.gain, t, 0.2, 0.12, 0.55);
    tail.connect(lp);
    lp.connect(tailGain);
    tailGain.connect(out);
    tail.start(t);
    this.retire(tail, t + 0.92);
    return 0.95;
  }

  cueHit(t, g, r) {
    const out = this.out(0.9 * g, 0.04);
    // Click transient: the sound of contact, over before it is heard.
    const o = this.osc("square", 2300 * r, t);
    o.frequency.exponentialRampToValueAtTime(850 * r, t + 0.014);
    const og = this.gain(0);
    this.env(og.gain, t, 0.4, 0.001, 0.03);
    o.connect(og);
    og.connect(out);
    o.start(t);
    this.retire(o, t + 0.06);
    // Short band of noise for the meat of it.
    const n = this.noise(t, 1, true);
    const bp = this.filter("bandpass", 1750 * r, 4, t);
    bp.frequency.exponentialRampToValueAtTime(900 * r, t + 0.09);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.3, 0.002, 0.1);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.15);
    return 0.16;
  }

  /* A minor third downward -- the interval every language uses for something
     stopping. */
  cueKill(t, g, r) {
    const out = this.out(0.9 * g, 0.22);
    const notes = [247 * r, 207.65 * r];
    for (let i = 0; i < notes.length; i += 1) {
      const at = t + i * 0.16;
      const f = notes[i];
      const o = this.osc("triangle", f, at);
      const sub = this.osc("sine", f * 0.5, at);
      const lp = this.filter("lowpass", 1500, 1.2, at);
      const og = this.gain(0);
      const sg = this.gain(0);
      this.env(og.gain, at, 0.34, 0.008, 0.5);
      this.env(sg.gain, at, 0.2, 0.01, 0.55);
      o.connect(og);
      og.connect(lp);
      sub.connect(sg);
      sg.connect(lp);
      lp.connect(out);
      o.start(at);
      sub.start(at);
      this.retire(o, at + 0.62);
      this.retire(sub, at + 0.68);
    }
    return 0.86;
  }

  /* Two bell tones going up: the hold closing on something alive. */
  cueCapture(t, g, r) {
    const out = this.out(0.95 * g, 0.28);
    const notes = [587.33 * r, 880 * r];
    for (let i = 0; i < notes.length; i += 1) {
      const at = t + i * 0.1;
      const f = notes[i];
      const o = this.osc("sine", f, at);
      const p = this.osc("sine", f * 2.76, at);
      const og = this.gain(0);
      const pg = this.gain(0);
      this.env(og.gain, at, 0.26, 0.006, 0.44);
      this.env(pg.gain, at, 0.07, 0.004, 0.26);
      o.connect(og);
      p.connect(pg);
      og.connect(out);
      pg.connect(out);
      o.start(at);
      p.start(at);
      this.retire(o, at + 0.54);
      this.retire(p, at + 0.34);
    }
    return 0.68;
  }

  cueAlarm(t, g, r, count) {
    const out = this.out(0.9 * g, 0.1);
    const lp = this.filter("lowpass", 4200, 0.8, t);
    lp.connect(out);
    const beeps = Math.max(1, Math.min(6, count || 3));
    for (let i = 0; i < beeps; i += 1) {
      const at = t + i * 0.26;
      const hi = this.osc("triangle", 1046 * r, at);
      const lo = this.osc("triangle", 523 * r, at);
      const hg = this.gain(0);
      const lg = this.gain(0);
      this.env(hg.gain, at, 0.3, 0.006, 0.07, 0.1);
      this.env(lg.gain, at, 0.13, 0.006, 0.07, 0.1);
      hi.connect(hg);
      lo.connect(lg);
      hg.connect(lp);
      lg.connect(lp);
      hi.start(at);
      lo.start(at);
      this.retire(hi, at + 0.22);
      this.retire(lo, at + 0.22);
    }
    return beeps * 0.26 + 0.1;
  }

  /* Warm inharmonic bell, used for money and for refits. */
  cueBell(t, g, r, root, partials) {
    const out = this.out(0.95 * g, 0.2);
    const ratios = [1, 2.01, 2.99, 4.21];
    const gains = [0.34, 0.16, 0.08, 0.04];
    const decays = [0.95, 0.62, 0.42, 0.3];
    const n = Math.max(1, Math.min(ratios.length, partials || 3));
    for (let i = 0; i < n; i += 1) {
      const o = this.osc("sine", root * r * ratios[i], t);
      const og = this.gain(0);
      this.env(og.gain, t, gains[i], 0.01, decays[i]);
      o.connect(og);
      og.connect(out);
      o.start(t);
      this.retire(o, t + decays[i] + 0.08);
    }
    return 1.05;
  }

  cueUpgrade(t, g, r) {
    const out = this.out(0.95 * g, 0.26);
    const notes = [392, 523.25, 659.25];
    for (let i = 0; i < notes.length; i += 1) {
      const at = t + i * 0.095;
      const f = notes[i] * r;
      const o = this.osc("sine", f, at);
      const p = this.osc("sine", f * 2.01, at);
      const og = this.gain(0);
      const pg = this.gain(0);
      this.env(og.gain, at, 0.28, 0.01, 0.8);
      this.env(pg.gain, at, 0.11, 0.008, 0.44);
      o.connect(og);
      p.connect(pg);
      og.connect(out);
      pg.connect(out);
      o.start(at);
      p.start(at);
      this.retire(o, at + 0.9);
      this.retire(p, at + 0.5);
    }
    return 1.1;
  }

  /* Clamps taking the weight: a dull body thump and a ring of struck steel. */
  clunk(t, g, out, pitch) {
    const n = this.noise(t, 1, false);
    const lp = this.filter("lowpass", 280 * pitch, 1, t);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.45 * g, 0.002, 0.18);
    n.connect(lp);
    lp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.26);

    const ring = this.noise(t, 1, true);
    const bp = this.filter("bandpass", 430 * pitch, 13, t);
    const rg = this.gain(0);
    this.env(rg.gain, t, 0.2 * g, 0.003, 0.34);
    ring.connect(bp);
    bp.connect(rg);
    rg.connect(out);
    this.retire(ring, t + 0.42);

    const body = this.osc("sine", 96 * pitch, t);
    body.frequency.exponentialRampToValueAtTime(54 * pitch, t + 0.18);
    const bg = this.gain(0);
    this.env(bg.gain, t, 0.4 * g, 0.003, 0.22);
    body.connect(bg);
    bg.connect(out);
    body.start(t);
    this.retire(body, t + 0.3);
  }

  cueDock(t, g, r) {
    const out = this.out(1 * g, 0.18);
    this.clunk(t, 1, out, r);
    this.clunk(t + 0.14, 0.8, out, r * 0.86);
    return 0.62;
  }

  cueUndock(t, g, r) {
    const out = this.out(1 * g, 0.16);
    this.clunk(t, 0.9, out, r * 1.1);
    // The airlock letting go: a long hiss that thins as it leaves.
    const n = this.noise(t + 0.06, 1, true);
    const hp = this.filter("highpass", 700, 0.7, t);
    hp.frequency.exponentialRampToValueAtTime(2400, t + 1.1);
    const ng = this.gain(0);
    this.env(ng.gain, t + 0.06, 0.2, 0.07, 1.05);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 1.3);
    return 1.35;
  }

  /* Kraken and leviathan. Low, slow, and wider than the boat. */
  cueRoar(t, g, r, lengthScale) {
    const dur = Math.max(0.9, Math.min(4.5, 2.3 * num(lengthScale, 1)));
    const out = this.out(1.1 * g, 0.3);
    // Duck everything else so the thing has the room to itself.
    this.duck(0.62, 0.18);
    setTimeout(() => this.duck(1, 0.9), Math.round(dur * 700));

    const n = this.noise(t, 0.7, false);
    const shape = this.shaper();
    const lp = this.filter("lowpass", 70 * r, 6.5, t);
    lp.frequency.exponentialRampToValueAtTime(430 * r, t + dur * 0.42);
    lp.frequency.exponentialRampToValueAtTime(62 * r, t + dur);
    const trem = this.gain(0.75);
    const lfo = this.osc("sine", 6.2, t);
    const lfoDepth = this.gain(0.25);
    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);
    lfo.start(t);
    this.retire(lfo, t + dur + 0.4);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.72, dur * 0.22, dur * 0.7);
    n.connect(shape);
    shape.connect(lp);
    lp.connect(trem);
    trem.connect(ng);
    ng.connect(out);
    this.retire(n, t + dur + 0.4);

    // Two sub voices an octave apart, sliding down as the breath runs out.
    const subs = [44 * r, 88 * r];
    const subGains = [0.42, 0.16];
    for (let i = 0; i < subs.length; i += 1) {
      const o = this.osc("sine", subs[i], t);
      o.frequency.exponentialRampToValueAtTime(subs[i] * 0.62, t + dur);
      const og = this.gain(0);
      this.env(og.gain, t, subGains[i], dur * 0.18, dur * 0.75);
      o.connect(og);
      og.connect(out);
      o.start(t);
      this.retire(o, t + dur + 0.4);
    }
    return dur + 0.5;
  }

  /* The clean ping, and then the room answering it. */
  cueSonar(t, g, r) {
    const out = this.out(0.95 * g, 0.6);
    const o = this.osc("sine", 1180 * r, t);
    o.frequency.exponentialRampToValueAtTime(1120 * r, t + 0.4);
    const og = this.gain(0);
    this.env(og.gain, t, 0.42, 0.008, 0.5);
    o.connect(og);
    og.connect(out);
    o.start(t);
    this.retire(o, t + 0.62);

    const shimmer = this.osc("sine", 2360 * r, t);
    const sg = this.gain(0);
    this.env(sg.gain, t, 0.1, 0.004, 0.22);
    shimmer.connect(sg);
    sg.connect(out);
    shimmer.start(t);
    this.retire(shimmer, t + 0.32);
    return 1.4;
  }

  cueDamage(t, g, r) {
    const out = this.out(1 * g, 0.12);
    // Crunch: noise pushed through the soft clipper and shut down hard.
    const n = this.noise(t, 1, false);
    const shape = this.shaper();
    const lp = this.filter("lowpass", 2300 * r, 2.2, t);
    lp.frequency.exponentialRampToValueAtTime(300 * r, t + 0.3);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.55, 0.003, 0.32);
    n.connect(shape);
    shape.connect(lp);
    lp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.42);
    // The plate behind it ringing.
    const ring = this.noise(t, 1, true);
    const bp = this.filter("bandpass", 620 * r, 9, t);
    const rg = this.gain(0);
    this.env(rg.gain, t, 0.16, 0.004, 0.26);
    ring.connect(bp);
    bp.connect(rg);
    rg.connect(out);
    this.retire(ring, t + 0.34);
    // Body.
    const body = this.osc("sine", 145 * r, t);
    body.frequency.exponentialRampToValueAtTime(46 * r, t + 0.25);
    const bg = this.gain(0);
    this.env(bg.gain, t, 0.45, 0.003, 0.28);
    body.connect(bg);
    bg.connect(out);
    body.start(t);
    this.retire(body, t + 0.38);
    return 0.46;
  }

  cueExplode(t, g, r) {
    const out = this.out(1.05 * g, 0.34);
    this.duck(0.72, 0.12);
    setTimeout(() => this.duck(1, 0.6), 620);

    const n = this.noise(t, 1, false);
    const shape = this.shaper();
    const lp = this.filter("lowpass", 3000 * r, 1.2, t);
    lp.frequency.exponentialRampToValueAtTime(180 * r, t + 0.7);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.78, 0.005, 0.72);
    n.connect(shape);
    shape.connect(lp);
    lp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.9);

    const body = this.osc("sine", 95 * r, t);
    body.frequency.exponentialRampToValueAtTime(28 * r, t + 0.5);
    const bg = this.gain(0);
    this.env(bg.gain, t, 0.62, 0.006, 0.55);
    body.connect(bg);
    bg.connect(out);
    body.start(t);
    this.retire(body, t + 0.68);

    // A crack of pressure on top so it reads as near rather than far.
    const crack = this.noise(t, 1, true);
    const hp = this.filter("highpass", 1800, 0.8, t);
    const cg = this.gain(0);
    this.env(cg.gain, t, 0.3, 0.001, 0.09);
    crack.connect(hp);
    hp.connect(cg);
    cg.connect(out);
    this.retire(crack, t + 0.16);
    return 0.95;
  }

  cueClick(t, g, r) {
    const out = this.out(0.9 * g, 0);
    const o = this.osc("sine", 1500 * r, t);
    const og = this.gain(0);
    this.env(og.gain, t, 0.13, 0.001, 0.028);
    o.connect(og);
    og.connect(out);
    o.start(t);
    this.retire(o, t + 0.06);
    const n = this.noise(t, 1, true);
    const hp = this.filter("highpass", 2600, 0.7, t);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.05, 0.001, 0.02);
    n.connect(hp);
    hp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 0.05);
    return 0.07;
  }

  cueDeny(t, g, r) {
    const out = this.out(0.9 * g, 0);
    const lp = this.filter("lowpass", 900, 1, t);
    lp.connect(out);
    const notes = [168 * r, 152 * r];
    for (let i = 0; i < notes.length; i += 1) {
      const at = t + i * 0.075;
      const o = this.osc("square", notes[i], at);
      const og = this.gain(0);
      this.env(og.gain, at, 0.18, 0.002, 0.055);
      o.connect(og);
      og.connect(lp);
      o.start(at);
      this.retire(o, at + 0.1);
    }
    return 0.2;
  }

  /* Crossing into a new band. One low swell, pitched by how deep the band is,
     and a breath of water behind it. */
  cueDepth(t, g, r) {
    const out = this.out(0.95 * g, 0.32);
    const zone = zoneForDepth(this.depthTarget);
    let idx = 0;
    for (let i = 0; i < ZONES.length; i += 1) {
      if (ZONES[i].id === zone.id) idx = i;
    }
    const roots = [74, 62, 53, 43, 35];
    const f = roots[Math.min(roots.length - 1, idx)] * r;

    const lp = this.filter("lowpass", 400, 2.2, t);
    lp.connect(out);
    const o = this.osc("sine", f, t);
    const fifth = this.osc("sine", f * 1.5, t);
    const og = this.gain(0);
    const fg = this.gain(0);
    this.env(og.gain, t, 0.34, 0.28, 1.5);
    this.env(fg.gain, t, 0.12, 0.36, 1.3);
    o.connect(og);
    fifth.connect(fg);
    og.connect(lp);
    fg.connect(lp);
    o.start(t);
    fifth.start(t);
    this.retire(o, t + 1.95);
    this.retire(fifth, t + 1.8);

    const n = this.noise(t, 0.8, false);
    const bp = this.filter("bandpass", 190, 1.1, t);
    bp.frequency.exponentialRampToValueAtTime(420, t + 1.1);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.2, 0.35, 1.1);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    this.retire(n, t + 1.6);
    return 2;
  }

  /* Hull groans are scheduled by update(), not by the game: they are weather,
     not feedback. Deeper means more often and lower. */
  groan(t, depthT) {
    if (!this.running || !this.ctx) return;
    if (this.free(this.ctx.currentTime) < 3) return;
    const out = this.out(0.5 + depthT * 0.5, 0.3);
    const f = lerp(78, 44, depthT) * (0.85 + Math.random() * 0.35);
    const dur = lerp(1.6, 3.1, depthT);

    const o = this.osc("triangle", f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.84, t + dur);
    const og = this.gain(0);
    this.env(og.gain, t, 0.3, dur * 0.28, dur * 0.7);
    const lp = this.filter("lowpass", 240, 3, t);
    o.connect(og);
    og.connect(lp);
    lp.connect(out);
    o.start(t);
    this.retire(o, t + dur + 0.4);

    // The creak of a seam deciding, slowly, to hold.
    const n = this.noise(t, 0.6, false);
    const bp = this.filter("bandpass", lerp(320, 620, Math.random()), 8.5, t);
    bp.frequency.exponentialRampToValueAtTime(bp.frequency.value * 1.35, t + dur * 0.8);
    const ng = this.gain(0);
    this.env(ng.gain, t, 0.16, dur * 0.3, dur * 0.6);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    this.retire(n, t + dur + 0.3);

    this.claim(this.ctx.currentTime, dur + 0.5);
  }

  /* ---------------------------------------------------------- bus wiring */

  /* The game may call sfx() directly for any of these; CUE_GAP collapses the
     duplicate inside its window, so both wiring styles sound the same. */
  listen() {
    const on = (name, fn) => {
      const off = this.bus.on(name, fn);
      if (typeof off === "function") this.offs.push(off);
    };

    on("combat:fire", (e) => {
      const w = e && e.weapon;
      const id = typeof w === "string" ? w : w && w.id ? w.id : "harpoon";
      if (id === "torpedo") this.sfx("torpedo");
      else if (id === "pulse") this.sfx("sonar", { rate: 0.72, gain: 0.9 });
      else this.sfx("harpoon");
    });
    on("combat:hit", (e) => {
      const kind = e && e.kind;
      if (kind === "terrain") this.sfx("hit", { rate: 0.72, gain: 0.75 });
      else this.sfx("hit");
    });

    on("creature:aggro", (e) => {
      const type = e && e.creature ? e.creature.type : null;
      // Only the things large enough to be heard through steel get a roar.
      if (type && (type.boss || type.mythic)) {
        this.sfx("roar", { length: type.boss ? 1.5 : 1.1, rate: type.boss ? 0.8 : 1 });
      }
    });
    on("creature:killed", (e) => {
      const type = e && e.creature ? e.creature.type : null;
      this.sfx("kill");
      if (type && type.boss) this.sfx("explode", { delay: 0.12 });
    });

    on("fish:captured", () => this.sfx("capture"));
    on("fish:cargo-full", () => this.sfx("deny"));

    on("sub:damage", (e) => {
      const amount = e ? num(e.amount, 0) : 0;
      this.sfx("damage", { gain: 0.8 + clamp01(amount / 40) * 0.5 });
    });
    on("sub:collide", (e) => {
      const speed = e ? num(e.speed, 0) : 0;
      if (speed > 6) this.sfx("damage", { rate: 0.85, gain: 0.7 });
      else this.sfx("hit", { rate: 0.6, gain: 0.6 });
    });
    on("sub:pressure", () => this.sfx("alarm", { count: 2 }));
    on("sub:battery-empty", () => this.sfx("alarm", { count: 3, rate: 0.8 }));
    on("sub:destroyed", () => this.sfx("explode"));
    on("sub:zone", () => this.sfx("depth"));

    on("sonar:ping", () => this.sfx("sonar"));
    on("station:dock", () => this.sfx("dock"));
    on("station:undock", () => this.sfx("undock"));
    on("economy:sold", () => this.sfx("sell"));
    on("economy:upgrade", () => this.sfx("upgrade"));

    on("mode", (e) => {
      const mode = e && e.mode ? e.mode : "";
      if (!this.running) return;
      // Panels pull the sea back so the player can hear themselves think.
      if (mode === "paused") this.duck(0.3, 0.15);
      else if (mode === "station" || mode === "start" || mode === "dead") this.duck(0.6, 0.3);
      else this.duck(1, 0.4);
      // A docked boat is a quiet boat.
      if (mode === "station" || mode === "dead") {
        this.thrustTarget = 0;
        this.threatTarget = 0;
      }
    });
  }
}
