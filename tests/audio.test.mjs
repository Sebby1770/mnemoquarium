// The sound, without a sound card: a fake AudioContext just rich enough to
// count what audio.js builds and schedules. Run with: node --test web/tests
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

let clock = 0;
const made = { osc: 0, bufsrc: 0 };

function param(v) {
  return {
    value: v,
    events: [],
    setValueAtTime(x) { this.value = x; return this; },
    linearRampToValueAtTime(x) { this.value = x; return this; },
    exponentialRampToValueAtTime(x) {
      // The real thing throws on this too; it is the classic WebAudio bug.
      if (!(x > 0)) throw new RangeError(`exponential ramp to ${x}`);
      this.value = x;
      return this;
    },
    setTargetAtTime(x, t) { this.events.push([x, t]); this.value = x; return this; },
    cancelScheduledValues() { return this; },
  };
}
function node(extra = {}) {
  return Object.assign({ connect(d) { return d; }, disconnect() {}, start() {}, stop() {}, onended: null }, extra);
}
class FakeContext {
  constructor() { this.sampleRate = 48000; this.destination = node(); this.state = "running"; this.onstatechange = null; }
  get currentTime() { return clock; }
  createGain() { return node({ gain: param(1) }); }
  createOscillator() { made.osc += 1; return node({ frequency: param(440), detune: param(0), type: "sine" }); }
  createBiquadFilter() { return node({ frequency: param(350), Q: param(1), gain: param(0), type: "lowpass" }); }
  createBufferSource() { made.bufsrc += 1; return node({ playbackRate: param(1), buffer: null, loop: false }); }
  createWaveShaper() { return node({ curve: null }); }
  createDelay() { return node({ delayTime: param(0) }); }
  createStereoPanner() { return node({ pan: param(0) }); }
  createDynamicsCompressor() {
    return node({ threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) });
  }
  createBuffer(ch, len, sr) { const d = new Float32Array(len); return { duration: len / sr, getChannelData() { return d; } }; }
  resume() { return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
globalThis.AudioContext = FakeContext;

const require = createRequire(import.meta.url);
globalThis.MnemoEngine = require("../engine.js");
const { Bus } = await import("../src/bus.js");
const { Audio } = await import("../src/audio.js");

// A camera at the origin looking down -Z: the identity view matrix.
const camera = { matrixWorldInverse: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } };
const vec = (x, y, z) => ({
  x, y, z,
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); },
});

function rig(extra = {}) {
  clock = 0;
  const bus = new Bus();
  const game = {
    bus, camera, mode: "dive",
    profile: { settings: { sound: true } },
    persist() {},
    ...extra,
  };
  const audio = new Audio(game);
  audio.start();
  return { bus, game, audio };
}

function oscillatorsDuring(fn) {
  const before = made.osc + made.bufsrc;
  fn();
  return made.osc + made.bufsrc - before;
}

test("the pressure trickle does not crunch; a real blow does", () => {
  const { bus } = rig();
  clock = 1;
  const trickle = oscillatorsDuring(() => {
    for (let i = 0; i < 20; i += 1) {
      clock += 0.5;
      bus.emit("sub:damage", { amount: 0.6, continuous: true, hull: 90 });
    }
  });
  assert.equal(trickle, 0, "continuous pressure damage played a crunch");
  clock += 1;
  const blow = oscillatorsDuring(() => bus.emit("sub:damage", { amount: 18, hull: 70 }));
  assert.ok(blow > 0, "a real blow made no sound");
});

test("the voice cap holds under a flood of cues", () => {
  const { audio } = rig();
  for (let i = 0; i < 80; i += 1) {
    clock += 0.06;
    audio.sfx("hit");
    audio.sfx("harpoon");
    audio.sfx("capture");
  }
  assert.ok(audio.free(clock) >= 0, `more voices live than the cap allows (${audio.free(clock)})`);
});

test("a roar ducks through its own gain and leaves the pause duck alone", () => {
  const { bus, audio } = rig();
  bus.emit("mode", { mode: "paused" });
  const master = audio.master.gain.value;
  clock += 2;
  audio.sfx("roar", { length: 1.2 });
  assert.equal(audio.master.gain.value, master, "the roar rewrote the mode duck");
  const last = audio.eventDuck.gain.events.at(-1);
  assert.equal(last[0], 1, "the event duck never schedules its own recovery");
});

test("a sonar ping answers with echoes, nearest first, from where each thing is", () => {
  const sub = { position: vec(0, -300, 0), altitude: 40, docked: false, cargoFull: false, battery: 50, batteryMax: 100 };
  const creatures = {
    all: [
      { alive: true, aggro: true, position: vec(30, -300, -10), radius: 2, type: { kind: "beast" } },
      { alive: true, aggro: false, position: vec(-90, -300, 20), radius: 9, type: { kind: "leviathan" } },
      { alive: true, aggro: true, position: vec(900, -300, 0), radius: 2, type: { kind: "beast" } },
    ],
  };
  const world = { stationPosition: vec(0, -30, 0) };
  const landmarks = { nearest: () => null };
  const { audio } = rig({ sub, creatures, world, landmarks });
  clock = 5;
  const scheduled = oscillatorsDuring(() => audio.sonarReturns(140));
  assert.ok(scheduled >= 3, `only ${scheduled} voices for two contacts and the floor`);
  assert.equal(audio.echoes.length, 2, "the contact 900 m out answered a 140 m ping");
  assert.ok(audio.echoes[0].d < audio.echoes[1].d, "echoes are not nearest first");
});

test("the Hull calls you home when the hold is full, and not from the clamps", () => {
  const sub = { position: vec(120, -60, 0), docked: false, cargoFull: true, battery: 80, batteryMax: 100 };
  const world = { stationPosition: vec(0, -30, 0) };
  const { audio, game } = rig({ sub, world });
  clock = 3;
  let calls = oscillatorsDuring(() => { for (let i = 0; i < 40; i += 1) { clock += 0.1; audio.updateBeacon(0.1); } });
  assert.ok(calls > 0, "a full hold 120 m out heard nothing from the Hull");
  sub.docked = true;
  calls = oscillatorsDuring(() => { for (let i = 0; i < 80; i += 1) { clock += 0.1; audio.updateBeacon(0.1); } });
  assert.equal(calls, 0, "the beacon kept calling while docked");
  void game;
});

test("a windup is placed on the side it comes from", () => {
  const { audio } = rig();
  const right = audio.place(vec(10, 0, -10));
  const left = audio.place(vec(-10, 0, -10));
  const behind = audio.place(vec(0, 0, 10));
  assert.ok(right.pan > 0.3 && left.pan < -0.3, `pan right ${right.pan}, left ${left.pan}`);
  assert.ok(behind.cutoff < right.cutoff, "something behind should sound duller than something ahead");
  clock = 2;
  assert.doesNotThrow(() => audio.sfx("windup", { at: vec(8, 0, -4), time: 0.45 }));
  assert.doesNotThrow(() => audio.sfx("notice", { at: vec(-40, 0, -40) }));
});
