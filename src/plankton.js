/* Bioluminescent plankton: the deep's own light.
 *
 * Below the twilight nothing lit up in response to anything. The contract says
 * cutting your lamps halves how far hunters notice you, but cutting them
 * showed a black screen, so there was no reason to fly dark except fear. Real
 * water down there is full of dinoflagellates that flash when disturbed; the
 * boat should trail blue fire, and anything that moves near you should give
 * itself away by glittering before the sonar ever paints it.
 *
 * One THREE.Points, one draw call. Each point is a seeded offset inside a box
 * that the vertex shader wraps around the camera, so nothing is written to a
 * buffer per frame. What makes a point light is a small ring of "stir" points
 * — the hull, the prop wash, hunters, hits, catches — each stamped with the
 * time it happened; a point near a fresh stir flares and fades. */

import * as THREE from "three";

import { makeRng, smoothstep } from "./util.js";
import { effectsTier } from "./quality.js";

/* The field only has to be dense where you can see a single cell: a 3 m
   disturbance in a 64 m box lit about one and a half points. At 30 m the same
   stir wakes a dozen or more, which is what reads as a flash in the water. */
const BOX = 30;                 // metres of water the field wraps within
const STIRS = 24;               // ring buffer of disturbances
const COUNTS = [2600, 4400, 6800];  // points per effects tier
const MAX_COUNT = COUNTS[COUNTS.length - 1];
const GATE_TOP = 150;           // depth where the first sparks show
const GATE_FULL = 360;          // depth where the field is at full strength
const WAKE_EVERY = 0.09;        // seconds between hull stirs while moving
const HUNTER_EVERY = 0.2;
const HUNTER_REACH = 26;        // metres: the field only reaches about this far from the glass
const TIER_EVERY = 1.5;

const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const VERT = /* glsl */ `
  attribute vec3 aOffset;
  attribute float aSeed;
  uniform vec3 uCam;
  uniform float uTime;
  uniform float uBox;
  uniform float uGate;
  uniform float uPixel;
  uniform vec3 uAbsorb;
  uniform vec4 uStir[${STIRS}];
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying vec3 vColor;

  void main() {
    // Wrap the seeded offset into a box centred on the camera, drifting slowly.
    vec3 h = vec3(uBox * 0.5);
    vec3 drift = vec3(
      sin(uTime * 0.21 + aSeed * 61.0),
      sin(uTime * 0.17 + aSeed * 23.0) * 0.6 - uTime * 0.05,
      cos(uTime * 0.19 + aSeed * 37.0)) * 0.9;
    vec3 p = uCam - h + mod(aOffset + drift - (uCam - h), uBox);

    // How freshly and how closely something moved past this point.
    float e = 0.0;
    for (int i = 0; i < ${STIRS}; i += 1) {
      vec4 s = uStir[i];
      vec3 d = p - s.xyz;
      float age = uTime - s.w;
      e += exp(-dot(d, d) * 0.07) * exp(-max(age, 0.0) * 0.62) * step(0.0, age);
    }
    // Not every cell fires: the seed decides how easily this one is woken.
    float glow = smoothstep(0.18, 1.0, e * (0.35 + aSeed * 0.9));
    // A few flash on their own now and then, so the dark is never quite empty.
    float spont = pow(max(0.0, sin(uTime * (0.25 + aSeed * 0.6) + aSeed * 173.0)), 120.0) * step(0.94, aSeed);
    float lit = (glow + spont * 0.35) * uGate;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float dist = length(p - cameraPosition);
    // The water eats the red first, the blue last, the same as everything else.
    vec3 transmit = exp(-uAbsorb * dist);
    // Well past white where it flares, so the bloom gives each spark a halo.
    vColor = mix(uColA, uColB, fract(aSeed * 7.31)) * lit * transmit * (1.6 + glow * 3.2);

    gl_Position = projectionMatrix * mv;
    float size = uPixel * (0.018 + glow * 0.05) / max(dist, 0.4);
    // A dark cell costs nothing: zero size means no fragments at all.
    gl_PointSize = lit > 0.004 ? clamp(size, 1.0, 6.0) : 0.0;
  }`;

const FRAG = /* glsl */ `
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.05, length(c));
    gl_FragColor = vec4(vColor * a, 1.0);
  }`;

export class Plankton {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.head = 0;
    this.wakeTimer = 0;
    this.hunterTimer = 0;
    this.tierTimer = 0;
    this.offs = [];

    const rng = makeRng(game.seed, "plankton");
    const offsets = new Float32Array(MAX_COUNT * 3);
    const seeds = new Float32Array(MAX_COUNT);
    for (let i = 0; i < MAX_COUNT; i += 1) {
      offsets[i * 3] = rng.random() * BOX;
      offsets[i * 3 + 1] = rng.random() * BOX;
      offsets[i * 3 + 2] = rng.random() * BOX;
      seeds[i] = rng.random();
    }
    const geo = new THREE.BufferGeometry();
    // position is required by three but unused: the shader places every point.
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_COUNT * 3), 3));
    geo.setAttribute("aOffset", new THREE.BufferAttribute(offsets, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    this.geometry = geo;

    const stirs = [];
    for (let i = 0; i < STIRS; i += 1) stirs.push(new THREE.Vector4(0, 0, 0, -1e4));
    this.stirs = stirs;

    const water = game.water;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: BOX },
        uGate: { value: 0 },
        uPixel: { value: 800 },
        // Shared with the water model, so the sparks fade with the same colour
        // of distance as every surface in the sea.
        uAbsorb: water && water.uniforms && water.uniforms.uAbsorb
          ? water.uniforms.uAbsorb
          : { value: new THREE.Vector3(0.12, 0.05, 0.03) },
        uStir: { value: stirs },
        uColA: { value: new THREE.Color(0x46e6ff) },
        uColB: { value: new THREE.Color(0x8dffc6) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.name = "plankton";
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    game.scene.add(this.points);
    this.applyTier();

    // Anything violent is a disturbance worth lighting.
    const bus = game.bus;
    if (bus) {
      this.offs.push(bus.on("combat:hit", (e) => { if (e && e.point) this.stir(e.point); }));
      this.offs.push(bus.on("fish:captured", (e) => { if (e && e.fish && e.fish.position) this.stir(e.fish.position); }));
      this.offs.push(bus.on("creature:attack", (e) => { if (e && e.creature) this.stir(e.creature.position); }));
      this.offs.push(bus.on("creature:killed", (e) => { if (e && e.creature) this.stir(e.creature.position); }));
    }
  }

  /* Record a disturbance at a world position, now. */
  stir(pos, dx = 0, dy = 0, dz = 0) {
    if (!pos) return;
    const s = this.stirs[this.head];
    s.set(pos.x + dx, pos.y + dy, pos.z + dz, this.time);
    this.head = (this.head + 1) % STIRS;
  }

  applyTier() {
    const game = this.game;
    const gov = game.governor;
    const mode = gov ? gov.mode : "auto";
    const tier = effectsTier(mode, gov ? gov.scale : 1);
    this.geometry.setDrawRange(0, COUNTS[tier]);
  }

  update(dt) {
    const game = this.game;
    const sub = game.sub;
    const diving = game.mode === "dive" && sub && !(game.base && game.base.active);
    const depth = sub ? sub.depth : 0;
    const gate = smoothstep(GATE_TOP, GATE_FULL, depth);
    this.points.visible = diving && gate > 0.001;
    if (!this.points.visible) return;

    this.time += dt;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    // Lamps off, the eye adapts: the same sparks read brighter in the black.
    u.uGate.value = gate * (sub.lightsOn ? 0.8 : 1.25);
    game.camera.getWorldPosition(_cam);
    u.uCam.value.copy(_cam);
    const cam = game.camera;
    const h = game.renderer ? game.renderer.domElement.height : 900;
    u.uPixel.value = h / (2 * Math.tan(((cam.fov || 70) * Math.PI) / 360));

    // The hull and its wash, while the boat is actually moving.
    this.wakeTimer -= dt;
    if (this.wakeTimer <= 0 && sub.speed > 0.8) {
      this.wakeTimer = WAKE_EVERY;
      sub.forward(_fwd);
      // The bow wave wakes the water ahead of the glass, so the sparks slide
      // past the window as you drive; the wash lights the way you came.
      const side = (Math.random() - 0.5) * 3.2;
      this.stir(sub.position, _fwd.x * 5 + _fwd.z * side, _fwd.y * 5 + (Math.random() - 0.5) * 1.5, _fwd.z * 5 - _fwd.x * side);
      this.stir(sub.position, -_fwd.x * 3.2, -_fwd.y * 3.2 - 0.4, -_fwd.z * 3.2);
      this.stir(sub.position, -_fwd.x * 7.5 + (Math.random() - 0.5) * 1.6, -_fwd.y * 7.5, -_fwd.z * 7.5 + (Math.random() - 0.5) * 1.6);
    }

    // Hunters close enough to matter give themselves away as they come.
    this.hunterTimer -= dt;
    if (this.hunterTimer <= 0) {
      this.hunterTimer = HUNTER_EVERY;
      const all = game.creatures && game.creatures.all;
      if (all) {
        let n = 0;
        const reach = HUNTER_REACH * HUNTER_REACH;
        for (let i = 0; i < all.length && n < 3; i += 1) {
          const c = all[i];
          if (!c.alive || !c.position) continue;
          if (c.position.distanceToSquared(sub.position) > reach) continue;
          const v = c.velocity;
          if (v && v.lengthSq() < 0.5) continue;   // an ambusher lying still stays dark
          this.stir(c.position);
          n += 1;
        }
      }
    }

    this.tierTimer -= dt;
    if (this.tierTimer <= 0) {
      this.tierTimer = TIER_EVERY;
      this.applyTier();
    }
  }

  dispose() {
    for (const off of this.offs) if (typeof off === "function") off();
    this.offs.length = 0;
    if (this.points.parent) this.points.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}
