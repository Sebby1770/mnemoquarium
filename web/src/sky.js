/* The top of the world: a sky, and the sea's surface from both sides.
 *
 * The boat used to hit a ceiling at -1.4 m and the "surface" was a bright
 * sheet of scrolling blobs with light cones hanging under it. Now there is a
 * real surface you can come up through: a wave field you can float on, a sky
 * with a sun and weather in it, and from underneath, Snell's window — the
 * bright disc of sky you only see looking up inside about 48 degrees of the
 * vertical, with the rest of the underside mirroring the dark water below.
 *
 * The wave field is written twice, once in GLSL for the mesh and once in JS
 * for the boat, from the same table, so what you bob on is what you see. */

import * as THREE from "three";

import { damp } from "./util.js";

const G = 9.81;

/* [dirX, dirZ, wavelength m, amplitude m]. A long swell carries most of the
   height; the short ones are texture. Directions fan around one wind. */
const WAVES = [
  [0.83, 0.56, 58, 0.52],
  [0.42, 0.91, 27, 0.26],
  [0.98, 0.18, 14.5, 0.13],
  [0.62, -0.78, 7.6, 0.06],
  [-0.2, 0.98, 3.9, 0.028],
];

const WAVE_K = WAVES.map(([, , len]) => (Math.PI * 2) / len);
const WAVE_W = WAVE_K.map((k) => Math.sqrt(G * k));

const SUN_DIR = new THREE.Vector3(120, 420, 90).normalize();

const SKY_ZENITH = 0x2d6fb8;
const SKY_HORIZON = 0xb9dcef;
const SKY_SUN = 0xfff0d2;
const SEA_FAR = 0x2a6682;
const SEA_DEEP = 0x0b3f57;

const OCEAN_RADIUS = 1250;
const OCEAN_RINGS = 96;
const OCEAN_SEGMENTS = 160;

function glslWaves() {
  const lines = WAVES.map(([dx, dz, , amp], i) => {
    const k = WAVE_K[i].toFixed(5);
    const w = WAVE_W[i].toFixed(5);
    const len = Math.hypot(dx, dz);
    const ux = (dx / len).toFixed(5);
    const uz = (dz / len).toFixed(5);
    return `  { float ph = ${k} * dot(p, vec2(${ux}, ${uz})) - ${w} * t;
    float c = cos(ph);
    h += ${amp.toFixed(4)} * sin(ph);
    d += ${(amp * WAVE_K[i]).toFixed(5)} * c * vec2(${ux}, ${uz}); }`;
  });
  return `
float oceanWaves(vec2 p, float t, out vec2 d) {
  float h = 0.0;
  d = vec2(0.0);
${lines.join("\n")}
  return h;
}`;
}

/* Shared by the dome, the reflection off the water, and Snell's window, so
   the sky you see directly and the sky you see in the sea agree. */
const SKY_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColour;
uniform vec3 uSeaFar;
uniform float uTime;

float skyHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float skyNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = skyHash(i);
  float b = skyHash(i + vec2(1.0, 0.0));
  float c = skyHash(i + vec2(0.0, 1.0));
  float e = skyHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, e, u.x), u.y);
}

float skyFbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i += 1) {
    v += a * skyNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

vec3 skyColour(vec3 dir, bool clouds) {
  vec3 d = normalize(dir);
  float h = d.y;
  vec3 col;
  if (h >= 0.0) {
    col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
    if (clouds) {
      // Clouds live on a plane overhead, so they crowd toward the horizon.
      vec2 cp = d.xz / max(h, 0.07) * 0.75 + vec2(uTime * 0.0045, uTime * 0.002);
      float c = skyFbm(cp * 1.4);
      c = smoothstep(0.5, 0.8, c) * smoothstep(0.015, 0.22, h);
      float lit = clamp(dot(d, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
      vec3 cloud = mix(vec3(0.72, 0.78, 0.86), vec3(1.08, 1.04, 0.98), lit);
      col = mix(col, cloud, c * 0.88);
    }
  } else {
    // Below the horizon from above is more sea, too far off to have waves.
    col = mix(uHorizon, uSeaFar, clamp(-h * 5.0, 0.0, 1.0));
  }
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColour * (pow(s, 1600.0) * 22.0 + pow(s, 90.0) * 0.4 + pow(s, 7.0) * 0.1);
  return col;
}
`;

const _v = new THREE.Vector3();

export class SkyAndSea {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.above = false;
    this.airBlend = 0;

    this.group = new THREE.Group();
    this.group.name = "sky-and-sea";
    game.scene.add(this.group);

    const water = game.water;
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: { value: SUN_DIR.clone() },
      uZenith: { value: new THREE.Color(SKY_ZENITH) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uSunColour: { value: new THREE.Color(SKY_SUN) },
      uSeaFar: { value: new THREE.Color(SEA_FAR) },
      uSeaDeep: { value: new THREE.Color(SEA_DEEP) },
      uAbove: { value: 0 },
      uCamXZ: { value: new THREE.Vector2() },
      // Borrowed live from the water, so the underside is lit by the same sea.
      uAbsorb: water ? water.uniforms.uAbsorb : { value: new THREE.Vector3(0.03, 0.0125, 0.0072) },
      uScatter: water ? water.uniforms.uScatter : { value: new THREE.Color(0x3f93a6) },
      uMurk: water ? water.uniforms.uMurk : { value: 1 },
    };

    this._buildSky();
    this._buildOcean();
    this.horizon = new THREE.Color(SKY_HORIZON);
  }

  /* --------------------------------------------------------------- dome -- */

  _buildSky() {
    const geo = new THREE.SphereGeometry(900, 40, 20);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * p;
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        varying vec3 vDir;
        void main() {
          gl_FragColor = vec4(skyColour(vDir, true), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.name = "sky";
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.visible = false;
    this.group.add(this.sky);
  }

  /* -------------------------------------------------------------- ocean -- */

  /* A polar grid: rings packed tight around the eye and flung wide toward the
     horizon, so the waves near you are finely drawn and the far sea costs next
     to nothing. It rides along with the camera; the waves are sampled in world
     space, so moving the grid does not move the sea. */
  _oceanGeometry() {
    const positions = [0, 0, 0];
    for (let r = 1; r <= OCEAN_RINGS; r += 1) {
      const radius = OCEAN_RADIUS * Math.pow(r / OCEAN_RINGS, 2.05);
      for (let s = 0; s < OCEAN_SEGMENTS; s += 1) {
        const a = (s / OCEAN_SEGMENTS) * Math.PI * 2;
        positions.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      }
    }
    const index = [];
    for (let s = 0; s < OCEAN_SEGMENTS; s += 1) {
      index.push(0, 1 + ((s + 1) % OCEAN_SEGMENTS), 1 + s);
    }
    for (let r = 0; r < OCEAN_RINGS - 1; r += 1) {
      const a0 = 1 + r * OCEAN_SEGMENTS;
      const b0 = 1 + (r + 1) * OCEAN_SEGMENTS;
      for (let s = 0; s < OCEAN_SEGMENTS; s += 1) {
        const s1 = (s + 1) % OCEAN_SEGMENTS;
        index.push(a0 + s, a0 + s1, b0 + s);
        index.push(a0 + s1, b0 + s1, b0 + s);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(index);
    return geo;
  }

  _buildOcean() {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec2 uCamXZ;
        varying vec3 vWorld;
        varying vec3 vNormalW;
        ${glslWaves()}
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec2 slope;
          float h = oceanWaves(wp.xz, uTime, slope);
          // Far rings are wider than the short waves; let those flatten out
          // rather than alias into shimmer.
          float fade = 1.0 - smoothstep(260.0, 1000.0, distance(wp.xz, uCamXZ));
          wp.y = h * fade;
          vWorld = wp.xyz;
          vNormalW = normalize(vec3(-slope.x * fade, 1.0, -slope.y * fade));
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        uniform float uAbove;
        uniform vec3 uSeaDeep;
        uniform vec3 uAbsorb;
        uniform vec3 uScatter;
        uniform float uMurk;
        varying vec3 vWorld;
        varying vec3 vNormalW;

        // Ripples too small to be worth vertices: normal detail only.
        vec3 ripple(vec2 p, float t) {
          float a = sin(dot(p, vec2(1.9, 0.7)) * 1.6 + t * 2.3);
          float b = sin(dot(p, vec2(-0.8, 1.7)) * 2.4 - t * 2.9);
          float c = sin(dot(p, vec2(1.2, -1.4)) * 3.7 + t * 3.6);
          return vec3(a * 0.05 + c * 0.03, 0.0, b * 0.05 - c * 0.02);
        }

        void main() {
          vec3 toEye = cameraPosition - vWorld;
          float dist = length(toEye);
          vec3 V = toEye / max(dist, 0.0001);
          float near = 1.0 - smoothstep(20.0, 160.0, dist);
          vec3 N = normalize(vNormalW + ripple(vWorld.xz, uTime) * near);
          vec3 col;

          if (uAbove > 0.5) {
            // From above: the sea is a mirror of the sky that goes clear
            // where you look straight down into it.
            float ndv = max(dot(N, V), 0.0);
            float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
            vec3 R = reflect(-V, N);
            R.y = abs(R.y);
            vec3 sky = skyColour(R, false);
            float crest = clamp((vWorld.y + 0.2) * 0.9, 0.0, 1.0);
            vec3 body = mix(uSeaDeep, uSeaDeep * 1.9 + vec3(0.0, 0.05, 0.05), crest * 0.5);
            col = mix(body, sky, fres);
            vec3 H = normalize(uSunDir + V);
            col += uSunColour * (pow(max(dot(N, H), 0.0), 520.0) * 7.0 + pow(max(dot(N, H), 0.0), 60.0) * 0.12);
            // The far sea melts into the horizon rather than ending in an edge.
            float haze = smoothstep(180.0, 1150.0, dist);
            col = mix(col, uHorizon, haze);
          } else {
            // From below. Up inside the critical angle you see the sky, bent;
            // outside it the underside mirrors the dark water beneath you.
            float cosUp = abs(V.y);
            float wobble = (N.x + N.z) * 0.08;
            float window = smoothstep(0.6, 0.72, cosUp + wobble);
            vec3 bent = refract(-V, -N, 1.0 / 1.333);
            vec3 through = skyColour(normalize(vec3(bent.x, abs(bent.y) + 0.001, bent.z)), false) * 1.25;
            vec3 mirror = uScatter * 0.7;
            col = mix(mirror, through, window);
            // Everything between you and the surface is still water.
            vec3 T = exp(-uAbsorb * dist * uMurk);
            col = col * T + uScatter * (1.0 - T);
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.ocean = new THREE.Mesh(this._oceanGeometry(), mat);
    this.ocean.name = "ocean-surface";
    this.ocean.frustumCulled = false;
    this.group.add(this.ocean);
  }

  /* ------------------------------------------------------------- queries -- */

  /* The same sum the shader draws, so the boat floats on what you can see. */
  surfaceHeight(x, z, t = this.time) {
    let h = 0;
    for (let i = 0; i < WAVES.length; i += 1) {
      const [dx, dz, , amp] = WAVES[i];
      const len = Math.hypot(dx, dz);
      const ph = WAVE_K[i] * ((x * dx + z * dz) / len) - WAVE_W[i] * t;
      h += amp * Math.sin(ph);
    }
    return h;
  }

  /* Surface slope, for rocking the boat when it is sitting on the swell. */
  surfaceNormal(x, z, out, t = this.time) {
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < WAVES.length; i += 1) {
      const [dx, dz, , amp] = WAVES[i];
      const len = Math.hypot(dx, dz);
      const ux = dx / len;
      const uz = dz / len;
      const ph = WAVE_K[i] * (x * ux + z * uz) - WAVE_W[i] * t;
      const c = amp * WAVE_K[i] * Math.cos(ph);
      sx += c * ux;
      sz += c * uz;
    }
    return (out || _v).set(-sx, 1, -sz).normalize();
  }

  isAbove(position) {
    return position.y > this.surfaceHeight(position.x, position.z);
  }

  /* ------------------------------------------------------------- update -- */

  update(dt, cam) {
    this.time += dt;
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uCamXZ.value.set(cam.x, cam.z);

    this.above = this.isAbove(cam);
    u.uAbove.value = this.above ? 1 : 0;
    this.airBlend = damp(this.airBlend, this.above ? 1 : 0, 10, dt);

    this.ocean.position.set(cam.x, 0, cam.z);
    this.ocean.updateMatrixWorld();

    this.sky.visible = this.above;
    this.sky.position.copy(cam);
    this.sky.updateMatrixWorld();

    // Nothing sits over the sea but air, and the underside is only worth
    // drawing while there is still light enough to see it.
    this.ocean.visible = this.above || cam.y > -900;
  }

  horizonColour(out) {
    return out.copy(this.horizon);
  }

  dispose() {
    for (const mesh of [this.sky, this.ocean]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

export { SUN_DIR };
