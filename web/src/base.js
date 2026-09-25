/* The Hull, from the inside.
 *
 * Docking used to put a menu over the sea. Now the clamps take the boat into
 * a moon pool and you climb out and walk: a steel hangar with the sub floating
 * in the pool under a gantry, the market terminal by the door, the drydock
 * console at the bow where you can see every refit bolted on, a hatch back
 * into the boat, and through a door, the ops room — with the logbook, and the
 * tank, where a copy of every species you have ever brought home swims in a
 * glass box. That tank is the original mnemoquarium, and it is only fair that
 * it is still here.
 *
 * It is its own THREE.Scene and camera; game.frame draws it instead of the sea
 * while the mode is "base" (walking) or "station" (a terminal's panel open,
 * with the room behind it). It deliberately does not use the water optics: in
 * here the air is air.
 *
 * Input follows the same shape as the boat's, so input.js can drive it with a
 * pad or a thumb: `analog` (forward, strafe, boost) and `lookDX/lookDY`. */

import * as THREE from "three";

import { SUB } from "./config.js";
import { clamp, damp, formatCredits } from "./util.js";
import { spindle } from "./geo.js";
import { buildSubModel, fittedParts } from "./submodel.js";
import { pickInteractable, resolveCircle } from "./walk.js";

const EYE = 1.65;
const RADIUS = 0.35;
const WALK = 3.1;
const RUN = 5.4;
const LOOK_SENS = SUB.lookSensitivity;
// Just climbed out: beside the pool, looking along the boat into the room.
// (Facing the boat head-on from the hatch filled the screen with sail.)
const SPAWN = { x: 3.2, z: -5.4, yaw: Math.atan2(3.2, -5.4) };

const _dir = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/* ---------------------------------------------------------- textures -- */

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function gratingTexture() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#1d2328";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#0c1013";
    g.lineWidth = 6;
    for (let i = 0; i <= 8; i += 1) {
      g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, h); g.stroke();
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(w, i * 32); g.stroke();
    }
    g.fillStyle = "rgba(255,255,255,0.05)";
    for (let i = 0; i < 400; i += 1) g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  });
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function panelTexture() {
  const t = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = "#39434b";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#2c353c";
    g.fillRect(8, 8, w - 16, h - 16);
    g.fillStyle = "#4b565e";
    for (const [x, y] of [[16, 16], [w - 24, 16], [16, h - 24], [w - 24, h - 24]]) {
      g.beginPath(); g.arc(x + 4, y + 4, 4, 0, Math.PI * 2); g.fill();
    }
    // Streaks of damp.
    for (let i = 0; i < 30; i += 1) {
      g.fillStyle = `rgba(20,30,34,${0.05 + Math.random() * 0.12})`;
      g.fillRect(Math.random() * w, 0, 1 + Math.random() * 3, h * Math.random());
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function hazardTexture() {
  const t = canvasTexture(128, 32, (g, w, h) => {
    g.fillStyle = "#e0a526";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#15171a";
    for (let x = -h; x < w + h; x += 32) {
      g.beginPath(); g.moveTo(x, h); g.lineTo(x + 16, h); g.lineTo(x + 16 + h, 0); g.lineTo(x + h, 0); g.fill();
    }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

function labelTexture(text, sub) {
  return canvasTexture(512, 160, (g, w, h) => {
    g.fillStyle = "rgba(4,10,16,0.82)";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(126,224,208,0.7)";
    g.lineWidth = 4;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = "#bff4ea";
    g.font = "600 64px ui-monospace, Menlo, Consolas, monospace";
    g.textAlign = "center";
    g.fillText(text, w / 2, 86);
    if (sub) {
      g.fillStyle = "#7e98a8";
      g.font = "28px ui-monospace, Menlo, Consolas, monospace";
      g.fillText(sub, w / 2, 130);
    }
  });
}

/* ------------------------------------------------------------ shaders -- */

const POOL_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float n(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 p = vUv * vec2(13.0, 5.4);
    float r = n(p * 1.3 + uTime * 0.25) * 0.6 + n(p * 3.1 - uTime * 0.4) * 0.4;
    float caustic = pow(1.0 - abs(r - 0.5) * 2.0, 6.0);
    vec3 deep = vec3(0.01, 0.07, 0.09);
    vec3 lit = vec3(0.1, 0.55, 0.6);
    vec3 c = mix(deep, lit, 0.25 + caustic * 0.75);
    gl_FragColor = vec4(c, 1.0);
  }`;

const WINDOW_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  varying vec2 vUv;
  float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float n(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    // The sea outside: brighter up toward the surface, rays leaning down,
    // and now and then something passing.
    vec3 top = vec3(0.12, 0.45, 0.55);
    vec3 bottom = vec3(0.01, 0.06, 0.1);
    vec3 c = mix(bottom, top, pow(vUv.y, 1.4));
    float ray = n(vec2(vUv.x * 7.0 - vUv.y * 2.5 + uSeed, uTime * 0.1));
    c += vec3(0.08, 0.16, 0.18) * pow(ray, 3.0) * vUv.y;
    for (int i = 0; i < 3; i += 1) {
      float fi = float(i);
      float x = fract(uTime * (0.02 + fi * 0.013) + fi * 0.37 + uSeed);
      vec2 fish = vec2(x * 1.4 - 0.2, 0.3 + fi * 0.18 + sin(uTime * 0.3 + fi) * 0.04);
      vec2 d = (vUv - fish) * vec2(1.0, 3.2 + fi);
      float body = smoothstep(0.05 + fi * 0.02, 0.0, length(d));
      c = mix(c, vec3(0.0, 0.03, 0.05), body * 0.8);
    }
    // Glass: a little frame vignette and a sheen.
    float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x) * smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
    c *= 0.4 + 0.6 * edge;
    c += vec3(0.06) * smoothstep(0.02, 0.0, abs(vUv.x - vUv.y * 0.6 - 0.2));
    gl_FragColor = vec4(c * 1.6, 1.0);
  }`;

const FULL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

/* ------------------------------------------------------------ the room -- */

export class Base {
  constructor(game) {
    this.game = game;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05080b);
    this.scene.fog = new THREE.Fog(0x05080b, 18, 42);
    this.camera = new THREE.PerspectiveCamera(72, window.innerWidth / Math.max(1, window.innerHeight), 0.05, 120);
    this.time = 0;
    this.active = false;

    // Pilot-shaped input, so input.js can drive this exactly like the boat.
    this.analog = { forward: 0, strafe: 0, vert: 0, boost: false, dock: false };
    this.lookDX = 0;
    this.lookDY = 0;
    this.keys = Object.create(null);

    this.pos = { x: SPAWN.x, z: SPAWN.z };
    this.yaw = SPAWN.yaw;
    this.pitch = -0.08;
    this.bob = 0;
    this.locked = false;

    this.boxes = [];
    this.items = [];
    this.disposables = [];
    this.focus = null;
    this.sparks = [];
    this.fitted = "";

    this._build();
    this._buildEnvironment();
    this._buildHud();
    this._bind();
  }

  /* ----------------------------------------------------------- building -- */

  _mat(opts) {
    const m = new THREE.MeshStandardMaterial(opts);
    this.disposables.push(m);
    return m;
  }

  _box(w, h, d, material, x, y, z, collide = true) {
    const g = new THREE.BoxGeometry(w, h, d);
    this.disposables.push(g);
    const m = new THREE.Mesh(g, material);
    m.position.set(x, y, z);
    this.scene.add(m);
    if (collide) this.boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    return m;
  }

  _build() {
    const grate = gratingTexture();
    const panels = panelTexture();
    const hazard = hazardTexture();
    this.disposables.push(grate, panels, hazard);

    const floorMat = this._mat({ map: grate, roughness: 0.75, metalness: 0.45 });
    grate.repeat.set(8, 8);
    const wallMat = this._mat({ map: panels, roughness: 0.65, metalness: 0.35 });
    panels.repeat.set(6, 2);
    const trim = this._mat({ color: 0x2a333a, roughness: 0.5, metalness: 0.6 });
    const hazardMat = this._mat({ map: hazard, roughness: 0.6 });
    hazard.repeat.set(10, 1);
    const pipeMat = this._mat({ color: 0x6d4a2c, roughness: 0.5, metalness: 0.7 });
    const lampMat = this._mat({ color: 0xffffff, emissive: 0xffe2b0, emissiveIntensity: 2.2 });
    const railMat = this._mat({ color: 0xc88a1e, roughness: 0.5, metalness: 0.6 });

    /* Hangar: 26 x 22, nine metres high. Ops room behind it through a door. */
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(26, 22), trim);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = 9;
    this.scene.add(ceil);
    this.disposables.push(ceil.geometry);

    // Walls (the back one has a door in it).
    this._box(1, 9, 24, wallMat, -13.5, 4.5, 0);
    this._box(1, 9, 24, wallMat, 13.5, 4.5, 0);
    this._box(28, 9, 1, wallMat, 0, 4.5, 11.5);
    this._box(12.3, 9, 1, wallMat, -7.35, 4.5, -11.5);
    this._box(12.3, 9, 1, wallMat, 7.35, 4.5, -11.5);
    this._box(2.4, 6.2, 1, wallMat, 0, 5.9, -11.5, false);
    // Door frame, hazard striped.
    this._box(0.25, 2.8, 1.1, hazardMat, -1.25, 1.4, -11.5, false);
    this._box(0.25, 2.8, 1.1, hazardMat, 1.25, 1.4, -11.5, false);

    // Ribs up the walls and beams across the ceiling.
    for (let i = -5; i <= 5; i += 1) {
      this._box(0.3, 9, 0.5, trim, -12.9, 4.5, i * 2, false);
      this._box(0.3, 9, 0.5, trim, 12.9, 4.5, i * 2, false);
    }
    for (let i = -4; i <= 4; i += 1) this._box(26, 0.5, 0.35, trim, 0, 8.6, i * 2.6, false);
    // Pipes along the walls, because a submarine base without pipes is a gym.
    for (const [y, r] of [[7.6, 0.18], [7.1, 0.12]]) {
      for (const x of [-12.6, 12.6]) {
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 22, 10), pipeMat);
        pipe.rotation.x = Math.PI / 2;
        pipe.position.set(x, y, 0);
        this.scene.add(pipe);
        this.disposables.push(pipe.geometry);
      }
    }

    /* The moon pool: 13 x 5.4 of open sea in the floor, hazard-edged and
       railed, with the boat floating in it on the clamps. */
    const poolMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: FULL_VERT,
      fragmentShader: POOL_FRAG,
    });
    this.poolMat = poolMat;
    this.disposables.push(poolMat);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(13, 5.4), poolMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.7;
    this.scene.add(water);
    this.disposables.push(water.geometry);
    // The pool's walls, dark, so it reads as a hole and not a painted floor.
    const well = this._mat({ color: 0x0b1216, roughness: 0.9 });
    this._box(13.4, 0.8, 0.2, well, 0, -0.4, 2.8, false);
    this._box(13.4, 0.8, 0.2, well, 0, -0.4, -2.8, false);
    this._box(0.2, 0.8, 5.6, well, 6.6, -0.4, 0, false);
    this._box(0.2, 0.8, 5.6, well, -6.6, -0.4, 0, false);
    // The floor, in four pieces round the pool.
    for (const [w, d, x, z] of [[26, 8.2, 0, 6.9], [26, 8.2, 0, -6.9], [6.3, 5.6, -9.85, 0], [6.3, 5.6, 9.85, 0]]) {
      const piece = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorMat);
      piece.rotation.x = -Math.PI / 2;
      piece.position.set(x, 0, z);
      this.scene.add(piece);
      this.disposables.push(piece.geometry);
    }
    // Hazard edge and railings (with a gap at the hatch).
    this._box(13.6, 0.03, 0.3, hazardMat, 0, 0.015, 2.95, false);
    this._box(13.6, 0.03, 0.3, hazardMat, 0, 0.015, -2.95, false);
    this._box(0.3, 0.03, 5.6, hazardMat, 6.95, 0.015, 0, false);
    this._box(0.3, 0.03, 5.6, hazardMat, -6.95, 0.015, 0, false);
    const rail = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 6), railMat);
      bar.rotation.z = Math.PI / 2;
      bar.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      bar.position.set((x0 + x1) / 2, 1.05, (z0 + z1) / 2);
      this.scene.add(bar);
      this.disposables.push(bar.geometry);
      for (let i = 0; i <= Math.floor(len / 1.4); i += 1) {
        const t = i / Math.max(1, Math.floor(len / 1.4));
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.05, 6), railMat);
        post.position.set(x0 + (x1 - x0) * t, 0.52, z0 + (z1 - z0) * t);
        this.scene.add(post);
        this.disposables.push(post.geometry);
      }
    };
    rail(-6.8, 3.1, 6.8, 3.1);
    rail(-6.8, -3.1, -0.3, -3.1);
    rail(1.5, -3.1, 6.8, -3.1);
    rail(-6.8, -3.1, -6.8, 3.1);
    rail(6.8, -3.1, 6.8, 3.1);
    this.boxes.push({ minX: -6.9, maxX: 6.9, minZ: -3.15, maxZ: 3.15 });

    // A gangway plank from the gap to the boat's deck.
    this._box(1.6, 0.08, 2.1, trim, 0.6, 0.35, -2.1, false);

    // The gantry over the pool.
    this._box(0.4, 7.5, 0.4, trim, -7.4, 3.75, 3.6, false);
    this._box(0.4, 7.5, 0.4, trim, 7.4, 3.75, 3.6, false);
    this._box(0.4, 7.5, 0.4, trim, -7.4, 3.75, -3.6, false);
    this._box(0.4, 7.5, 0.4, trim, 7.4, 3.75, -3.6, false);
    this._box(15.2, 0.5, 0.5, railMat, 0, 7.5, 3.6, false);
    this._box(15.2, 0.5, 0.5, railMat, 0, 7.5, -3.6, false);
    this.trolley = this._box(0.8, 0.5, 7.7, trim, 0, 7.2, 0, false);
    this.arm = this._box(0.18, 4.2, 0.18, trim, 0, 5, 0, false);

    /* The boat. Rebuilt whenever the refit changes. */
    this.subHolder = new THREE.Group();
    this.subHolder.position.set(0, -0.35, 0);
    this.subHolder.rotation.y = Math.PI / 2;   // bow toward +X, the drydock console
    this.scene.add(this.subHolder);
    this.subKey = "";
    this._rebuildSub();

    /* Windows onto the sea, left and right. */
    const winMat = (seed) => {
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uSeed: { value: seed } },
        vertexShader: FULL_VERT,
        fragmentShader: WINDOW_FRAG,
      });
      this.disposables.push(m);
      return m;
    };
    this.windowMats = [];
    for (const [x, ry, seed] of [[-12.95, Math.PI / 2, 0.1], [12.95, -Math.PI / 2, 0.6]]) {
      for (const z of [-6, 6]) {
        const m = winMat(seed + z * 0.05);
        this.windowMats.push(m);
        const win = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), m);
        win.position.set(x, 3.6, z);
        win.rotation.y = ry;
        this.scene.add(win);
        this.disposables.push(win.geometry);
        const frame = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 4), trim);
        frame.scale.set(4.3, 2.45, 1);
        frame.rotation.set(0, ry, Math.PI / 4);
        frame.position.set(x + Math.sign(-x) * 0.02, 3.6, z);
        this.scene.add(frame);
        this.disposables.push(frame.geometry);
      }
    }

    /* Ops room: 12 x 8 behind the door. */
    this._box(1, 5, 9, wallMat, -6.5, 2.5, -15.5);
    this._box(1, 5, 9, wallMat, 6.5, 2.5, -15.5);
    this._box(14, 5, 1, wallMat, 0, 2.5, -20.5);
    const opsFloor = new THREE.Mesh(new THREE.PlaneGeometry(12, 9), floorMat);
    opsFloor.rotation.x = -Math.PI / 2;
    opsFloor.position.set(0, 0, -15.5);
    this.scene.add(opsFloor);
    this.disposables.push(opsFloor.geometry);
    const opsCeil = new THREE.Mesh(new THREE.PlaneGeometry(12, 9), trim);
    opsCeil.rotation.x = Math.PI / 2;
    opsCeil.position.set(0, 4.2, -15.5);
    this.scene.add(opsCeil);
    this.disposables.push(opsCeil.geometry);
    const opsWin = new THREE.Mesh(new THREE.PlaneGeometry(5, 2.2), winMat(0.33));
    this.windowMats.push(opsWin.material);
    opsWin.position.set(0, 2.3, -19.95);
    this.scene.add(opsWin);
    this.disposables.push(opsWin.geometry);
    // A bunk and a table, so somebody lives here.
    this._box(2.2, 0.5, 0.9, this._mat({ color: 0x3a3f36, roughness: 0.9 }), -4.8, 0.45, -18.8);
    this._box(2.2, 0.5, 0.9, this._mat({ color: 0x3a3f36, roughness: 0.9 }), -4.8, 1.9, -18.8, false);
    this._box(1.6, 0.08, 1.0, trim, -3.6, 0.9, -13.4);

    /* The tank: the aquarium the game grew out of. */
    this._buildTank();

    /* Terminals. */
    this._terminal("market", "MARKET", "sell the hold", -10.2, -8.6, Math.PI * 0.25);
    this._terminal("drydock", "DRYDOCK", "refit the boat", 9.3, -1.6, -Math.PI / 2 + 0.35);
    this._terminal("log", "MANIFEST", "the record", 4.6, -18.9, 0.2);
    // The hatch: stand in the railing gap and look at the boat.
    this.items.push({ id: "hatch", label: "Board the boat · dive", x: 0.6, z: -2.4, reach: 2.4 });
    const hatchSign = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture("HATCH", "board · dive"), transparent: true }));
    this.disposables.push(hatchSign.material.map, hatchSign.material);
    hatchSign.position.set(0.6, 2.9, -3.2);
    hatchSign.scale.set(1.8, 0.56, 1);
    this.scene.add(hatchSign);

    // Crates, for something to walk round.
    const crate = this._mat({ color: 0x4a5a3a, roughness: 0.85 });
    for (const [x, z, s] of [[-11, 8.5, 1.2], [-9.6, 9.3, 1], [-11.2, 6.9, 0.9], [10.8, 8.8, 1.3], [11.3, -9.6, 1]]) {
      this._box(s, s, s, crate, x, s / 2, z);
    }

    /* Light. Warm work lamps overhead, the pool's glow from below, a cold
       fill from the windows, and a key on the boat so the refit reads. */
    this.scene.add(new THREE.HemisphereLight(0x8fb8d0, 0x2a241c, 1.0));
    for (const [x, z] of [[-7, -7], [7, -7], [-7, 7], [7, 7], [0, -15.5]]) {
      const l = new THREE.PointLight(0xffd9a0, 70, 26, 1.1);
      l.position.set(x, z < -12 ? 3.9 : 8.2, z);
      this.scene.add(l);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.5, 0.3, 12, 1, true), trim);
      shade.position.set(x, z < -12 ? 4.05 : 8.35, z);
      this.scene.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), lampMat);
      bulb.position.set(x, z < -12 ? 3.95 : 8.25, z);
      this.scene.add(bulb);
      this.disposables.push(shade.geometry, bulb.geometry);
    }
    // The pool lights the room from below — from its ends, clear of the hull,
    // or the boat glows like a lamp itself.
    this.poolGlows = [];
    for (const x of [-5.6, 5.6]) {
      const glow = new THREE.PointLight(0x4fd6e0, 9, 11, 1.3);
      glow.position.set(x, -0.5, 0);
      this.scene.add(glow);
      this.poolGlows.push(glow);
    }
    const key = new THREE.SpotLight(0xffffff, 10, 20, 0.6, 0.5, 1.2);
    key.position.set(0, 8, 2);
    key.target.position.set(0, 0, 0);
    this.scene.add(key, key.target);
  }

  /* Metal with nothing to reflect renders black. The addons' RoomEnvironment
     is not vendored, so this builds its own: a dim box with a few bright
     panels where the lamps and the pool are, prefiltered once. */
  _buildEnvironment() {
    const renderer = this.game.renderer;
    if (!renderer || !THREE.PMREMGenerator) return;
    const env = new THREE.Scene();
    const box = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 30), new THREE.MeshBasicMaterial({ color: 0x1a232a, side: THREE.BackSide }));
    box.position.y = 5;
    env.add(box);
    const panel = (color, w, h, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      env.add(m);
    };
    for (const [x, z] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) panel(0xffd9a0, 3, 3, x, 10.9, z, Math.PI / 2, 0);
    panel(0x4fd6e0, 13, 5, 0, -0.9, 0, -Math.PI / 2, 0);
    panel(0x2e7f93, 6, 3, -14.9, 4, 0, 0, Math.PI / 2);
    panel(0x2e7f93, 6, 3, 14.9, 4, 0, 0, -Math.PI / 2);
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      this.envTarget = pmrem.fromScene(env, 0.04);
      pmrem.dispose();
      this.scene.environment = this.envTarget.texture;
    } catch (err) {
      // No environment is ugly, not broken.
      this.envTarget = null;
    }
    env.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  _terminal(id, title, sub, x, z, yaw) {
    const body = this._mat({ color: 0x1b242b, roughness: 0.5, metalness: 0.7 });
    const screen = this._mat({ color: 0x031014, emissive: 0x3fc9c0, emissiveIntensity: 0.6 });
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 0.6), body);
    base.position.y = 0.5;
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.12), body);
    top.position.set(0, 1.3, -0.12);
    top.rotation.x = -0.35;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.55), screen);
    glow.position.set(0, 1.31, -0.05);
    glow.rotation.x = -0.35;
    g.add(base, top, glow);
    this.scene.add(g);
    this.disposables.push(base.geometry, top.geometry, glow.geometry);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(title, sub), transparent: true }));
    this.disposables.push(label.material.map, label.material);
    label.position.set(x, 2.25, z);
    label.scale.set(1.7, 0.53, 1);
    this.scene.add(label);
    // Stand in front of it (the screen faces +Z in the terminal's own frame).
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    this.boxes.push({ minX: x - 0.55, maxX: x + 0.55, minZ: z - 0.55, maxZ: z + 0.55 });
    this.items.push({ id, label: `${title.charAt(0)}${title.slice(1).toLowerCase()} · ${sub}`, x: x + fx * 0.6, z: z + fz * 0.6, reach: 2.2, screen });
  }

  _buildTank() {
    // Glass and water barely there: with the room's reflections on them at
    // full strength they read as frosted, and the fish are the point.
    const glassMat = this._mat({ color: 0x9fe8ff, roughness: 0.05, transparent: true, opacity: 0.05, depthWrite: false, envMapIntensity: 0.2 });
    const waterMat = this._mat({ color: 0x021a20, roughness: 1, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 0 });
    const frame = this._mat({ color: 0x14191d, roughness: 0.5, metalness: 0.8 });
    const cx = 0;
    const cz = -17.6;
    this.tankCentre = new THREE.Vector3(cx, 1.55, cz);
    this._box(3.6, 0.9, 1.6, frame, cx, 0.45, cz);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(3.4, 1.4, 1.4), glassMat);
    glass.position.set(cx, 1.62, cz);
    const water = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.25, 1.3), waterMat);
    water.position.set(cx, 1.58, cz);
    this.scene.add(water, glass);
    this.disposables.push(glass.geometry, water.geometry);
    this._box(3.6, 0.12, 1.6, frame, cx, 2.37, cz, false);
    const tankLight = new THREE.PointLight(0x7fe7ff, 6, 4, 1.5);
    tankLight.position.set(cx, 2.2, cz);
    this.scene.add(tankLight);
    this.tankFish = new THREE.Group();
    this.scene.add(this.tankFish);
    this.fishGeometry = spindle({ length: 0.26, radius: 0.05, rings: 8, segments: 8, flattenX: 0.6 });
    this.disposables.push(this.fishGeometry);
    this.tankKey = "";
    this.items.push({ id: "tank", label: "The tank · what you have brought home", x: cx, z: cz + 1.3, reach: 2.2 });
  }

  _refreshTank() {
    const game = this.game;
    const seen = (game.profile && game.profile.stats && game.profile.stats.discovered) || [];
    const key = seen.join(",");
    if (key === this.tankKey) return;
    this.tankKey = key;
    for (const child of [...this.tankFish.children]) {
      this.tankFish.remove(child);
      if (child.material) child.material.dispose();
    }
    const species = (game.ecology && game.ecology.species) || [];
    this.fishes = [];
    for (const sp of species) {
      if (!seen.includes(sp.index)) continue;
      const m = new THREE.MeshStandardMaterial({ color: sp.colorHex, emissive: sp.glowHex || sp.colorHex, emissiveIntensity: 0.35, roughness: 0.4 });
      // Two of each, the way these things are supposed to be kept.
      for (let k = 0; k < 2; k += 1) {
        const fish = new THREE.Mesh(this.fishGeometry, m);
        const s = 0.8 + Math.min(1.6, (sp.size || 1) * 0.35);
        fish.scale.setScalar(s);
        this.tankFish.add(fish);
        this.fishes.push({ mesh: fish, phase: Math.random() * 10, speed: 0.4 + Math.random() * 0.4, lane: Math.random() });
      }
    }
  }

  _rebuildSub() {
    const up = (this.game.profile && this.game.profile.upgrades) || {};
    const key = JSON.stringify(up);
    if (key === this.subKey) return false;
    const first = this.subKey === "";
    this.subKey = key;
    if (this.subModel) {
      this.subHolder.remove(this.subModel.group);
      this.subModel.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of this.subModel.materials) m.dispose();
    }
    this.subModel = buildSubModel(up);
    this.subHolder.add(this.subModel.group);
    this.fitted = fittedParts(up).join(" · ");
    return !first;
  }

  /* ------------------------------------------------------------- the HUD -- */

  _buildHud() {
    const root = document.createElement("div");
    root.id = "base-hud";
    root.hidden = true;
    root.innerHTML = `
      <div class="base-plate">
        <span class="label">the hull · tender station</span>
        <strong class="base-credits"></strong>
      </div>
      <div class="base-dot"></div>
      <button type="button" class="base-prompt" hidden></button>
      <div class="base-foot">
        <p class="base-help">WASD walk · Shift run · mouse look (click) · E use</p>
        <p class="base-fitted"></p>
      </div>`;
    document.body.appendChild(root);
    this.hud = root;
    this.hudCredits = root.querySelector(".base-credits");
    this.hudPrompt = root.querySelector(".base-prompt");
    this.hudFitted = root.querySelector(".base-fitted");
    this.hudHelp = root.querySelector(".base-help");
    this.onPrompt = (e) => { e.preventDefault(); this.interact(); };
    this.hudPrompt.addEventListener("click", this.onPrompt);

    // A way back from a terminal's panel to the room.
    const foot = document.querySelector("#panel-station .station-foot");
    if (foot) {
      this.backBtn = document.createElement("button");
      this.backBtn.type = "button";
      this.backBtn.id = "btn-walk";
      this.backBtn.textContent = "Walk the Hull";
      foot.prepend(this.backBtn);
      this.onBack = (e) => { e.preventDefault(); this.game.setMode("base"); };
      this.backBtn.addEventListener("click", this.onBack);
    }
  }

  /* ------------------------------------------------------------- input -- */

  _bind() {
    const game = this.game;
    this.onKey = (e, down) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (game.mode === "station" && down && e.code === "Escape") {
        game.setMode("base");
        return;
      }
      if (game.mode !== "base") return;
      if (["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        this.keys[e.code] = down;
        e.preventDefault();
      }
      if (down && !e.repeat && (e.code === "KeyE" || e.code === "Enter")) {
        e.preventDefault();
        this.interact();
      }
    };
    this.onKeyDown = (e) => this.onKey(e, true);
    this.onKeyUp = (e) => this.onKey(e, false);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);

    this.onMouseMove = (e) => {
      if (game.mode !== "base" || !this.locked) return;
      this.lookDX += e.movementX || 0;
      this.lookDY += e.movementY || 0;
    };
    document.addEventListener("mousemove", this.onMouseMove);
    this.onCanvasDown = (e) => {
      if (game.mode !== "base") return;
      if (!this.locked && !game.sub.touchLook && game.canvas.requestPointerLock) {
        try {
          const r = game.canvas.requestPointerLock();
          if (r && r.catch) r.catch(() => {});
        } catch (err) { void err; }
      } else if (this.locked && e.button === 0) {
        this.interact();
      }
    };
    game.canvas.addEventListener("mousedown", this.onCanvasDown);
    this.onLock = () => {
      this.locked = document.pointerLockElement === game.canvas;
      this.lookDX = 0;
      this.lookDY = 0;
    };
    document.addEventListener("pointerlockchange", this.onLock);

    this.offs = [
      game.bus.on("mode", (e) => this._onMode(e.mode, e.prev)),
      game.bus.on("economy:upgrade", (e) => {
        if (this._rebuildSub()) this._celebrate(e && e.id);
      }),
      game.bus.on("economy:credits", () => this._writeHud()),
      game.bus.on("fish:captured", () => { this.tankKey = "?"; }),
    ];
  }

  _onMode(mode, prev) {
    const on = mode === "base" || mode === "station";
    if (on && !this.active) this.enter(prev);
    else if (!on && this.active) this.exit();
    this.hud.hidden = mode !== "base";
    if (mode === "base") this._writeHud();
  }

  enter() {
    this.active = true;
    this.pos.x = SPAWN.x;
    this.pos.z = SPAWN.z;
    this.yaw = SPAWN.yaw;
    this.pitch = -0.08;
    this._rebuildSub();
    this.tankKey = "?";
    this._refreshTank();
    this._writeHud();
    this.resize();
  }

  exit() {
    this.active = false;
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
    this.hud.hidden = true;
  }

  interact() {
    const game = this.game;
    if (game.mode !== "base" || !this.focus) return;
    const id = this.focus.id;
    if (game.audio) game.audio.sfx("click");
    if (id === "hatch") {
      // The pointer lock, if any, is kept: the boat wants it next.
      game.undock();
      return;
    }
    if (id === "tank") {
      const seen = (game.profile.stats.discovered || []).length;
      const all = (game.ecology.species || []).length;
      game.toast(seen ? `${seen} of ${all} kinds in the tank` : "the tank is empty. bring something home.");
      return;
    }
    // A terminal: open the station panel on its tab, with the room behind it.
    game.setMode("station");
    if (game.hud) game.hud.selectTab(id);
  }

  /* ----------------------------------------------------------- per frame -- */

  update(dt) {
    if (!this.active) return;
    this.time += dt;
    this.poolMat.uniforms.uTime.value = this.time;
    for (const m of this.windowMats) m.uniforms.uTime.value = this.time;
    for (let i = 0; i < this.poolGlows.length; i += 1) {
      this.poolGlows[i].intensity = 8 + Math.sin(this.time * 1.3 + i * 2) * 1.5;
    }

    // The boat rides the pool, and the screw idles.
    if (this.subModel) {
      this.subHolder.position.y = -0.35 + Math.sin(this.time * 0.8) * 0.05;
      this.subHolder.rotation.z = Math.sin(this.time * 0.6) * 0.012;
      this.subModel.screw.rotation.z += dt * 0.6;
    }
    this._updateTank(dt);
    this._updateSparks(dt);
    this._updateGantry(dt);

    if (this.game.mode === "base") this._walk(dt);
    this._placeCamera();
  }

  _walk(dt) {
    const settings = (this.game.profile && this.game.profile.settings) || {};
    const sens = LOOK_SENS * (settings.sensitivity || 1);
    this.yaw -= this.lookDX * sens;
    this.pitch = clamp(this.pitch - this.lookDY * sens * (settings.invertY ? -1 : 1), -1.3, 1.3);
    this.lookDX = 0;
    this.lookDY = 0;
    const k = this.keys;
    if (k.ArrowLeft) this.yaw += dt * 2;
    if (k.ArrowRight) this.yaw -= dt * 2;

    let f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) + this.analog.forward;
    let s = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0) + this.analog.strafe;
    f = clamp(f, -1, 1);
    s = clamp(s, -1, 1);
    const mag = Math.hypot(f, s);
    if (mag > 1) { f /= mag; s /= mag; }
    const speed = (k.ShiftLeft || k.ShiftRight || this.analog.boost) ? RUN : WALK;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    // Facing is -Z at yaw 0, same as the boat.
    const dx = (-sy * f + cy * s) * speed * dt;
    const dz = (-cy * f - sy * s) * speed * dt;
    const [nx, nz] = resolveCircle(this.pos.x + dx, this.pos.z + dz, RADIUS, this.boxes);
    const moved = Math.hypot(nx - this.pos.x, nz - this.pos.z);
    this.pos.x = nx;
    this.pos.z = nz;
    this.bob += moved * 2.4;

    this.focus = pickInteractable(this.pos.x, this.pos.z, -sy, -cy, this.items);
    const label = this.focus ? this.focus.label : "";
    if (this.lastPrompt !== label) {
      this.lastPrompt = label;
      this.hudPrompt.hidden = !label;
      if (label) this.hudPrompt.innerHTML = `<kbd>E</kbd> ${label}`;
    }
    for (const item of this.items) {
      if (item.screen) item.screen.emissiveIntensity = item === this.focus ? 1.0 + Math.sin(this.time * 6) * 0.2 : 0.55;
    }
  }

  _placeCamera() {
    const bob = Math.sin(this.bob) * 0.035;
    this.camera.position.set(this.pos.x, EYE + bob, this.pos.z);
    _euler.set(this.pitch, this.yaw, Math.sin(this.bob * 0.5) * 0.004);
    this.camera.quaternion.setFromEuler(_euler);
  }

  _updateTank() {
    if (!this.fishes) return;
    const c = this.tankCentre;
    for (let i = 0; i < this.fishes.length; i += 1) {
      const f = this.fishes[i];
      const t = this.time * f.speed + f.phase;
      const x = c.x + Math.sin(t) * 1.35;
      const z = c.z + Math.cos(t * 1.3) * 0.45;
      const y = c.y - 0.35 + f.lane * 0.7 + Math.sin(t * 2.1) * 0.05;
      _dir.set(Math.cos(t) * 1.35, 0, -Math.sin(t * 1.3) * 0.45 * 1.3);
      f.mesh.position.set(x, y, z);
      f.mesh.rotation.y = Math.atan2(_dir.x, _dir.z);
    }
  }

  /* A refit: the gantry swings over and welds for a moment. */
  _celebrate(id) {
    this.weld = 1.4;
    this.weldTarget = { hull: 0, pressure: -1, thrust: -4.8, cargo: 1, battery: -1.2, lights: 3.4, sonar: 3, capture: 4, harpoon: 2.6, torpedo: 3.4, net: -2.8, repair: 0.6, reactor: -1.8, scrubber: 4.2, lattice: 0 }[id] || 0;
    if (this.game.audio) this.game.audio.sfx("upgrade");
  }

  _updateGantry(dt) {
    const want = this.weld > 0 ? this.weldTarget : 0;
    this.trolley.position.x = damp(this.trolley.position.x, want, 3, dt);
    this.arm.position.x = this.trolley.position.x;
    this.arm.position.y = damp(this.arm.position.y, this.weld > 0 ? 3.9 : 5, 3, dt);
    if (this.weld > 0) {
      this.weld -= dt;
      if (Math.random() < dt * 30) this._spark(this.arm.position.x, 1.6, 0);
    }
  }

  _spark(x, y, z) {
    if (!this.sparkGeo) {
      this.sparkGeo = new THREE.SphereGeometry(0.04, 4, 3);
      this.sparkMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0 });
      this.disposables.push(this.sparkGeo, this.sparkMat);
    }
    if (this.sparks.length > 60) return;
    const m = new THREE.Mesh(this.sparkGeo, this.sparkMat);
    m.position.set(x + (Math.random() - 0.5) * 0.2, y, z + (Math.random() - 0.5) * 0.2);
    this.scene.add(m);
    this.sparks.push({ mesh: m, v: new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 2.5, (Math.random() - 0.5) * 3), life: 0.6 + Math.random() * 0.4 });
  }

  _updateSparks(dt) {
    for (let i = this.sparks.length - 1; i >= 0; i -= 1) {
      const s = this.sparks[i];
      s.life -= dt;
      s.v.y -= 9 * dt;
      s.mesh.position.addScaledVector(s.v, dt);
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        this.sparks.splice(i, 1);
      }
    }
  }

  _writeHud() {
    const p = this.game.profile;
    if (!p) return;
    const cargo = (p.cargo || []).length;
    this.hudCredits.textContent = `${formatCredits(p.credits || 0)} cr${cargo ? ` · ${cargo} in the hold` : ""}`;
    this.hudFitted.textContent = this.fitted ? `fitted: ${this.fitted}` : "";
    if (this.game.sub && this.game.sub.touchLook) this.hudHelp.textContent = "left thumb walk · right thumb look · tap the prompt to use";
  }

  resize() {
    this.camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
    this.camera.updateProjectionMatrix();
  }

  /* Where the player is standing, for tests and debugging. */
  where() {
    return { x: this.pos.x, z: this.pos.z, yaw: this.yaw, focus: this.focus ? this.focus.id : null };
  }

  dispose() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("pointerlockchange", this.onLock);
    this.game.canvas.removeEventListener("mousedown", this.onCanvasDown);
    this.hudPrompt.removeEventListener("click", this.onPrompt);
    if (this.backBtn) {
      this.backBtn.removeEventListener("click", this.onBack);
      this.backBtn.remove();
    }
    for (const off of this.offs || []) off();
    this.hud.remove();
    if (this.subModel) {
      this.subModel.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const m of this.subModel.materials) m.dispose();
    }
    for (const d of this.disposables) if (d && d.dispose) d.dispose();
    if (this.envTarget) this.envTarget.dispose();
    this.scene.clear();
  }
}
