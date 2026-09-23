/* Post-processing: HDR bloom and a colour grade, with no addons.
 *
 * The scene renders into a half-float target, so a lamp, a vent, a lure or the
 * sun can be brighter than white and keep that information. A dual-filter
 * bloom (downsample to a thirty-second, then back up, adding as it climbs)
 * lets anything that bright bleed light into the water around it, which is
 * what light in water actually does. The composite then tone-maps, grades
 * contrast and saturation by depth band, vignettes, and adds a little grain.
 *
 * If anything here fails to initialise, the game renders straight to the
 * canvas as before — a broken grade should never cost a player the picture. */

import * as THREE from "three";

import { zoneForDepth } from "./config.js";
import { damp } from "./util.js";

const LEVELS = 5;

/* How each band is graded. The shelf is saturated and bright; by the abyss
   the colour has drained out of everything that is not making its own. */
const GRADE = {
  air: { saturation: 1.08, contrast: 1.06, bloom: 0.55, lift: 0.0 },
  shelf: { saturation: 1.18, contrast: 1.12, bloom: 0.7, lift: 0.0 },
  kelp: { saturation: 1.12, contrast: 1.14, bloom: 0.75, lift: 0.0 },
  twilight: { saturation: 1.02, contrast: 1.16, bloom: 0.9, lift: 0.004 },
  midnight: { saturation: 0.95, contrast: 1.18, bloom: 1.05, lift: 0.006 },
  abyss: { saturation: 0.92, contrast: 1.2, bloom: 1.15, lift: 0.008 },
};

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const PREFILTER_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
    c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
    c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
    c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
    c /= 8.0;
    // Soft knee: brightness above the threshold bleeds, just below it barely.
    float b = max(max(c.r, c.g), c.b);
    float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, b - uThreshold) / max(b, 1e-4);
    gl_FragColor = vec4(c * w, 1.0);
  }`;

const DOWN_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 h = uTexel * 0.5;
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += texture2D(tSrc, vUv - h).rgb;
    c += texture2D(tSrc, vUv + h).rgb;
    c += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb;
    c += texture2D(tSrc, vUv - vec2(h.x, -h.y)).rgb;
    gl_FragColor = vec4(c / 8.0, 1.0);
  }`;

const UP_FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vec2 h = uTexel * 0.5 * uRadius;
    vec3 c = texture2D(tSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
    c += texture2D(tSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
    c += texture2D(tSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
    c += texture2D(tSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
    gl_FragColor = vec4(c / 12.0, 1.0);
  }`;

const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform float uExposure;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uLift;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uAberration;
  uniform float uTime;
  uniform vec2 uResolution;
  varying vec2 vUv;

  // The same ACES fit three uses, so the grade reads like the old picture
  // before it was graded.
  vec3 rrtOdt(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 aces(vec3 c) {
    const mat3 inM = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777));
    const mat3 outM = mat3(
      vec3(1.60475, -0.10208, -0.00327),
      vec3(-0.53108, 1.10813, -0.07276),
      vec3(-0.07367, -0.00605, 1.07602));
    c *= uExposure / 0.6;
    c = inM * c;
    c = rrtOdt(c);
    c = outM * c;
    return clamp(c, 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c));
  }
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 fromCentre = vUv - 0.5;
    // A breath of chromatic aberration toward the edges of the glass.
    vec2 shift = fromCentre * uAberration;
    vec3 scene;
    scene.r = texture2D(tScene, vUv + shift).r;
    scene.g = texture2D(tScene, vUv).g;
    scene.b = texture2D(tScene, vUv - shift).b;

    vec3 c = scene + texture2D(tBloom, vUv).rgb * uBloom;
    c = aces(c);

    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, uSaturation);
    c = (c - 0.5) * uContrast + 0.5 + uLift;

    float v = smoothstep(0.85, 0.2, length(fromCentre * vec2(uResolution.x / uResolution.y, 1.0) * 0.9));
    c *= mix(1.0 - uVignette, 1.0, v);

    c = toSRGB(clamp(c, 0.0, 1.0));
    c += (hash(vUv * uResolution + fract(uTime) * 91.7) - 0.5) * uGrain;
    gl_FragColor = vec4(c, 1.0);
  }`;

function pass(fragmentShader, uniforms, blending = THREE.NoBlending) {
  return new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending,
    toneMapped: false,
  });
}

export class PostFX {
  constructor(game) {
    this.game = game;
    this.renderer = game.renderer;
    this.enabled = true;
    this.time = 0;
    this.grade = { ...GRADE.shelf };

    const gl2 = this.renderer.capabilities.isWebGL2;
    this.type = gl2 ? THREE.HalfFloatType : THREE.UnsignedByteType;
    this.samples = gl2 ? 4 : 0;

    // One oversized triangle covers the screen with no diagonal seam.
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri);
    this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene();
    this.quadScene.add(this.quad);
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.sceneTarget = null;
    this.mips = [];

    this.prefilter = pass(PREFILTER_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 0.85 },
      uKnee: { value: 0.35 },
    });
    this.down = pass(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.up = pass(UP_FRAG, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.2 },
    }, THREE.AdditiveBlending);
    this.composite = pass(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0.7 },
      uExposure: { value: 1.04 },
      uSaturation: { value: 1.1 },
      uContrast: { value: 1.1 },
      uLift: { value: 0 },
      uVignette: { value: 0.32 },
      uGrain: { value: 0.022 },
      uAberration: { value: 0.0025 },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    });

    this.setSize();
  }


  setSize() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.floor(size.x));
    const h = Math.max(1, Math.floor(size.y));
    if (w === this.width && h === this.height && this.sceneTarget) return;
    this.width = w;
    this.height = h;

    if (this.sceneTarget) this.sceneTarget.dispose();
    for (const m of this.mips) m.dispose();
    this.mips = [];

    this.sceneTarget = new THREE.WebGLRenderTarget(w, h, {
      type: this.type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: this.samples,
    });
    let mw = w;
    let mh = h;
    for (let i = 0; i < LEVELS; i += 1) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      this.mips.push(new THREE.WebGLRenderTarget(mw, mh, {
        type: this.type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      }));
    }
    this.composite.uniforms.uResolution.value.set(w, h);
  }

  _run(material, target, clear = true) {
    const r = this.renderer;
    this.quad.material = material;
    r.setRenderTarget(target);
    if (clear) r.clear(true, false, false);
    r.render(this.quadScene, this.quadCamera);
  }

  /* Ease the grade toward the band the eye is in, or toward air if surfaced. */
  _updateGrade(dt) {
    const game = this.game;
    const air = game.sky && game.sky.above;
    const depth = game.sub ? game.sub.depth : 0;
    const target = air ? GRADE.air : GRADE[zoneForDepth(depth).id] || GRADE.shelf;
    for (const key of Object.keys(target)) this.grade[key] = damp(this.grade[key], target[key], 1.6, dt);
    const u = this.composite.uniforms;
    u.uSaturation.value = this.grade.saturation;
    u.uContrast.value = this.grade.contrast;
    u.uLift.value = this.grade.lift;
    u.uBloom.value = this.grade.bloom;
    // The glass warps a little more the deeper it is asked to hold.
    u.uAberration.value = air ? 0.0012 : 0.0018 + Math.min(1, depth / 1200) * 0.003;
    // Damage shakes the picture as well as the camera.
    const shake = game.vfx ? game.vfx.shake || 0 : 0;
    u.uAberration.value += shake * 0.006;
    u.uTime.value = this.time;
  }

  render(scene, camera, dt = 0) {
    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.time += dt;
    this._updateGrade(dt);
    const r = this.renderer;
    const prevAutoClear = r.autoClear;

    r.setRenderTarget(this.sceneTarget);
    r.render(scene, camera);

    r.autoClear = false;
    // Bright pass into the first mip.
    this.prefilter.uniforms.tSrc.value = this.sceneTarget.texture;
    this.prefilter.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this._run(this.prefilter, this.mips[0]);
    // Down the chain...
    for (let i = 1; i < LEVELS; i += 1) {
      const src = this.mips[i - 1];
      this.down.uniforms.tSrc.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._run(this.down, this.mips[i]);
    }
    // ...and back up, adding each level onto the one above it.
    for (let i = LEVELS - 1; i > 0; i -= 1) {
      const src = this.mips[i];
      this.up.uniforms.tSrc.value = src.texture;
      this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._run(this.up, this.mips[i - 1], false);
    }

    this.composite.uniforms.tScene.value = this.sceneTarget.texture;
    this.composite.uniforms.tBloom.value = this.mips[0].texture;
    this._run(this.composite, null);
    r.autoClear = prevAutoClear;
  }

  dispose() {
    if (this.sceneTarget) this.sceneTarget.dispose();
    for (const m of this.mips) m.dispose();
    for (const m of [this.prefilter, this.down, this.up, this.composite]) m.dispose();
    this.quad.geometry.dispose();
  }
}
