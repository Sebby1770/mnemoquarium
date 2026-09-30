/* The water itself.
 *
 * Distance fog is a lie that reads as smoke. Real water eats light one colour
 * at a time — red is gone inside a few metres, green lasts, blue carries — and
 * throws a little of it back at you from every metre in between. Doing that per
 * channel is most of the difference between "a dark room" and "underwater", so
 * every lit surface in the game gets this patched into its shader instead of
 * three's fog.
 *
 * Patching is done with onBeforeCompile, which needs no addons. Materials that
 * get patched also get a customProgramCacheKey, because three keys its program
 * cache on material parameters and would otherwise happily hand a patched
 * shader to an unpatched material that happened to look the same. */

import * as THREE from "three";

import { WATER, ZONES, zoneForDepth } from "./config.js";
import { clamp01, damp, lerp, smoothstep } from "./util.js";

const CACHE_KEY = "mnemoquarium-water";

const BACKDROP_RADIUS = 1200;  // inside the camera's 1400 m far plane

/* The open water behind everything. It was one flat colour in every
   direction, so nothing could ever be silhouetted and looking up in the
   twilight showed nothing brighter than looking sideways. Now: the horizon is
   exactly the colour distant surfaces fade to (so there is no seam), the
   water below goes darker, and the water above carries the light still coming
   down from the surface — strongest through the twilight, gone by the abyss. */
const BACKDROP_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
  }`;

const BACKDROP_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uNadir;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = d.y >= 0.0
      ? mix(uHorizon, uZenith, pow(d.y, 1.5))
      : mix(uHorizon, uNadir, smoothstep(0.0, 0.85, -d.y));
    // A brighter well straight overhead: the surface, a long way up.
    c += uZenith * 1.1 * pow(max(d.y, 0.0), 6.0);
    gl_FragColor = vec4(c, 1.0);
  }`;

const _zenith = new THREE.Color();
const _nadir = new THREE.Color();

const PING_SPEED = 150;     // m/s the painted front travels
const PING_LINGER = 2.6;    // seconds the contours glow once the front is out

const _colour = new THREE.Color();
const _eye = new THREE.Vector3();
const _sun = new THREE.Vector3(0.35, 1, 0.2).normalize();

/* Beer-Lambert transmittance plus in-scattering, and a caustic web thrown down
   from the surface. The caustic loop is the expensive part, so it is skipped
   wholesale wherever the light has already run out. */
const FRAGMENT_CHUNK = /* glsl */ `
  float deepCaustic(vec2 p, float t) {
    vec2 i = p;
    float c = 1.0;
    const float inten = 0.0045;
    for (int n = 0; n < 4; n += 1) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
    }
    c /= 4.0;
    c = 1.17 - pow(c, 1.4);
    return clamp(pow(abs(c), 8.0), 0.0, 1.0);
  }

  void applyWater(inout vec3 colour, vec3 worldPos, float viewDepth, vec3 worldNormal) {
    // Sunlight reaching this depth at all. Everything optical scales off it.
    float lit = 1.0 - smoothstep(uCausticFade.x, uCausticFade.y, -worldPos.y);

    if (lit > 0.001 && uCausticStrength > 0.0) {
      // Only surfaces facing up catch a caustic, and only near the floor.
      float up = clamp(worldNormal.y, 0.0, 1.0);
      up *= up;
      if (up > 0.01) {
        float web = deepCaustic(worldPos.xz * uCausticScale, uWaterTime * 0.35);
        colour += web * up * lit * uCausticStrength * uCausticTint;
      }
    }

    float d = max(viewDepth, 0.0);
    if (uCamAir > 0.5) {
      // From the air only the stretch of the sightline under the surface is
      // water; above it there is nothing to absorb anything.
      float below = -worldPos.y;
      d = below > 0.0 ? d * below / max(uCamHeight + below, 0.001) : 0.0;
    }
    /* A sonar ping, painted onto whatever it touches: a bright front sweeping
       out at the speed of sound in water, and ten-metre contour lines left
       glowing behind it for a few seconds. Added before the water acts, so a
       far wall is painted dimmer and bluer than a near one. Costs nothing
       while no ping is live — the branch is uniform. */
    if (uPingFade > 0.001) {
      float r = distance(worldPos, uPing.xyz);
      float along = (r - uPing.w) / 3.2;
      float front = exp(-along * along);
      /* Contours a constant pixel width, whatever the slope: a fixed band of
         height smeared into slabs metres wide across gentle ground. */
      float level = worldPos.y * 0.1;
      float gap = abs(fract(level + 0.5) - 0.5);
      #if __VERSION__ >= 300
        float lw = max(fwidth(level), 1e-4);
      #else
        float lw = 0.03;
      #endif
      float contour = 1.0 - smoothstep(0.0, lw * 1.4, gap);
      float behind = step(r, uPing.w) * contour * (1.0 - 0.6 * r / max(uPing.w, 1.0));
      colour += uPingColor * (front * 1.4 + behind * 0.55) * uPingFade;
    }

    d *= uMurk;
    vec3 transmit = exp(-uAbsorb * d);
    colour = colour * transmit + uScatter * (1.0 - transmit);
  }
`;

export class Water {
  constructor(game) {
    this.game = game;
    this.materials = new Set();
    this.time = 0;

    const zone = ZONES[0];
    this.uniforms = {
      uWaterTime: { value: 0 },
      uAbsorb: { value: new THREE.Vector3().fromArray(WATER.absorb[zone.id]) },
      uScatter: { value: new THREE.Color(WATER.scatter[zone.id]) },
      uMurk: { value: WATER.murkBase },
      uCausticStrength: { value: WATER.causticStrength },
      uCausticScale: { value: WATER.causticScale },
      uCausticFade: { value: new THREE.Vector2(WATER.causticFadeStart, WATER.causticFadeEnd) },
      uCausticTint: { value: new THREE.Color(0xbfe9ff) },
      uCamAir: { value: 0 },
      uCamHeight: { value: 0 },
      // xyz origin of the last ping, w the radius its front has reached.
      uPing: { value: new THREE.Vector4(0, 0, 0, 0) },
      uPingFade: { value: 0 },
      uPingColor: { value: new THREE.Color(0x3fd6ff) },
    };
    this.ping = { age: -1, range: 0, life: 0 };
    this.offPing = game.bus
      ? game.bus.on("sonar:ping", (e) => this.startPing(e && e.range))
      : null;

    // Live values, eased toward the band the player is actually in.
    this.absorb = this.uniforms.uAbsorb.value.clone();
    this.scatter = this.uniforms.uScatter.value.clone();
    this.targetAbsorb = this.absorb.clone();
    this.targetScatter = this.scatter.clone();
    this.zoneId = zone.id;
    this.sunLevel = 1;

    // The horizon has to agree with where the in-scattering lands, or the
    // world ends in a visible seam. world.js also sets a sky colour; water
    // updates after it and this is the number that matches the shader.
    this.background = this.scatter.clone();

    this.backdropUniforms = {
      uHorizon: { value: new THREE.Color() },
      uZenith: { value: new THREE.Color() },
      uNadir: { value: new THREE.Color() },
    };
    this.backdrop = new THREE.Mesh(
      new THREE.SphereGeometry(BACKDROP_RADIUS, 32, 16),
      new THREE.ShaderMaterial({
        vertexShader: BACKDROP_VERT,
        fragmentShader: BACKDROP_FRAG,
        uniforms: this.backdropUniforms,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      }),
    );
    this.backdrop.name = "water-backdrop";
    this.backdrop.frustumCulled = false;
    // Drawn first and overwritten by everything else: one screen of cheap fill.
    this.backdrop.renderOrder = -1000;
    this.backdrop.matrixAutoUpdate = false;
    game.scene.add(this.backdrop);
    game.scene.background = this.background;
  }

  /* Patch one material. Safe to call twice on the same material. */
  register(material) {
    if (!material || this.materials.has(material)) return material;
    this.materials.add(material);

    // Our own attenuation replaces three's; running both double-darkens.
    material.fog = false;

    const uniforms = this.uniforms;
    const previous = material.onBeforeCompile;

    material.onBeforeCompile = (shader, renderer) => {
      if (typeof previous === "function") previous(shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vWaterWorldPos;
          varying float vWaterViewDepth;
          varying vec3 vWaterWorldNormal;`,
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
          vec4 waterWorld = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            waterWorld = instanceMatrix * waterWorld;
          #endif
          waterWorld = modelMatrix * waterWorld;
          vWaterWorldPos = waterWorld.xyz;
          vWaterViewDepth = -mvPosition.z;
          vec3 waterNormal = objectNormal;
          #ifdef USE_INSTANCING
            waterNormal = mat3(instanceMatrix) * waterNormal;
          #endif
          vWaterWorldNormal = normalize(mat3(modelMatrix) * waterNormal);`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uWaterTime;
          uniform vec3 uAbsorb;
          uniform vec3 uScatter;
          uniform float uMurk;
          uniform float uCausticStrength;
          uniform float uCausticScale;
          uniform vec2 uCausticFade;
          uniform vec3 uCausticTint;
          uniform float uCamAir;
          uniform float uCamHeight;
          uniform vec4 uPing;
          uniform float uPingFade;
          uniform vec3 uPingColor;
          varying vec3 vWaterWorldPos;
          varying float vWaterViewDepth;
          varying vec3 vWaterWorldNormal;
          ${FRAGMENT_CHUNK}`,
        )
        // After tone mapping would be wrong: the water acts on radiance, so it
        // has to happen while the value still means light.
        .replace(
          "#include <tonemapping_fragment>",
          `applyWater(gl_FragColor.rgb, vWaterWorldPos, vWaterViewDepth, normalize(vWaterWorldNormal));
          #include <tonemapping_fragment>`,
        );
    };

    /* Without this, three may hand this program to an unpatched lookalike.
       A material that carries its own patch (moss, sway, a swimming body)
       says so in userData.shaderTag, and the key has to include it, or the
       first rock compiled would lend its moss to every coral after it. */
    const tag = (material.userData && material.userData.shaderTag) || "";
    material.customProgramCacheKey = () => `${CACHE_KEY}:${tag}`;
    material.needsUpdate = true;
    return material;
  }

  /* Walk a subtree and patch everything lit in it. Used once on the whole
     scene after construction, and again per creature as they spawn, which is
     cheap because register() is idempotent. */
  adopt(root) {
    if (!root) return;
    root.traverse((node) => {
      const material = node.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const m of list) {
        // Additive glows are meant to punch through the water, not sit in it.
        if (m && m.isMeshStandardMaterial) this.register(m);
      }
    });
  }

  adoptScene(scene) {
    this.adopt(scene || this.game.scene);
  }

  forget(material) {
    this.materials.delete(material);
  }

  /* Ease the optics toward the band the sub is in. Snapping between zones is
     jarring in a way fog never was, because the colour of everything changes. */
  update(dt) {
    this.time += dt;
    this.updatePing(dt);
    this.uniforms.uWaterTime.value = this.time;

    const sub = this.game.sub;
    const depth = sub ? sub.depth : 0;
    const zone = zoneForDepth(depth);
    if (zone.id !== this.zoneId) {
      this.zoneId = zone.id;
      this.targetAbsorb.fromArray(WATER.absorb[zone.id] || WATER.absorb.shelf);
      this.targetScatter.set(WATER.scatter[zone.id] || WATER.scatter.shelf);
    }

    const rate = 1.4;
    this.absorb.x = damp(this.absorb.x, this.targetAbsorb.x, rate, dt);
    this.absorb.y = damp(this.absorb.y, this.targetAbsorb.y, rate, dt);
    this.absorb.z = damp(this.absorb.z, this.targetAbsorb.z, rate, dt);
    this.scatter.r = damp(this.scatter.r, this.targetScatter.r, rate, dt);
    this.scatter.g = damp(this.scatter.g, this.targetScatter.g, rate, dt);
    this.scatter.b = damp(this.scatter.b, this.targetScatter.b, rate, dt);

    this.uniforms.uAbsorb.value.copy(this.absorb);

    /* In-scattered light is sunlight bounced toward you, so it has to die with
       the sun. Holding it constant is what makes naive underwater fog read as
       bright haze at a thousand metres, where there is nothing left to scatter.
       A small floor keeps the abyss from going to pure algebraic black. */
    const sun = Math.max(0.055, Math.exp(-depth / 118));
    this.sunLevel = damp(this.sunLevel, sun, 2, dt);
    this.uniforms.uScatter.value.copy(this.scatter).multiplyScalar(this.sunLevel);

    /* Caustics are a surface phenomenon: they fade with depth on their own, but
       they also have nothing to project when the lamps are the only light. */
    const daylight = 1 - clamp01((depth - WATER.causticFadeStart) / Math.max(1, WATER.causticFadeEnd - WATER.causticFadeStart));
    this.uniforms.uCausticStrength.value = WATER.causticStrength * daylight;

    // Silt near the floor, and in the trench where nothing stirs it out.
    let murk = WATER.murkBase;
    if (sub) {
      const floor = this.game.world ? this.game.world.heightAt(sub.position.x, sub.position.z) : -9999;
      const altitude = sub.position.y - floor;
      murk *= lerp(1.35, 1, clamp01(altitude / 26));
    }
    this.uniforms.uMurk.value = damp(this.uniforms.uMurk.value, murk, 2, dt);

    /* Surfaced, the horizon is the sky's; the sky dome covers it anyway, but
       the clear colour shows at the seams. Under, it is the water's. */
    const sky = this.game.sky;
    const air = !!(sky && sky.above);
    this.uniforms.uCamAir.value = air ? 1 : 0;
    const eye = this.game.camera;
    if (eye) {
      eye.getWorldPosition(_eye);
      this.uniforms.uCamHeight.value = Math.max(0, _eye.y);
    }
    if (air) sky.horizonColour(this.background);
    else this.background.copy(this.uniforms.uScatter.value);
    this.game.scene.background = this.background;
    this.updateBackdrop(depth, air);
  }

  /* The colour distance resolves to — the HUD and the post pass both want it. */
  horizonColour(out) {
    return (out || _colour).copy(this.uniforms.uScatter.value);
  }

  updateBackdrop(depth, air) {
    const b = this.backdrop;
    const aboard = this.game.base && this.game.base.active;
    b.visible = !air && !aboard;
    if (!b.visible) return;
    const horizon = this.uniforms.uScatter.value;
    /* How much brighter the water overhead is than the water beside you. In
       the shallows the whole sea is bright; through the twilight the light
       from above is most of what there is; by the abyss there is none. */
    const twilight = smoothstep(200, 320, depth) * (1 - smoothstep(620, 1000, depth));
    const lift = 2 + twilight * 6;
    const u = this.backdropUniforms;
    u.uHorizon.value.copy(horizon);
    u.uZenith.value.copy(_zenith.copy(horizon).multiplyScalar(depth > 1000 ? 1 : lift));
    u.uNadir.value.copy(_nadir.copy(horizon).multiplyScalar(0.28));
    const eye = this.game.camera;
    if (eye) {
      eye.getWorldPosition(_eye);
      b.position.copy(_eye);
      b.updateMatrix();
      b.updateMatrixWorld(true);
    }
  }

  /* The Sonar Array's blurb always promised to paint the floor; until now a
     ping only lit monsters. The front moves at 150 m/s (a slowed speed of
     sound, so you can watch it go) out to the array's range. */
  startPing(range) {
    const sub = this.game.sub;
    if (!sub) return;
    const r = Math.max(20, Number(range) || 140);
    this.uniforms.uPing.value.set(sub.position.x, sub.position.y, sub.position.z, 0);
    this.ping.age = 0;
    this.ping.range = r;
    this.ping.life = r / PING_SPEED + PING_LINGER;
  }

  updatePing(dt) {
    const ping = this.ping;
    if (ping.age < 0) return;
    ping.age += dt;
    const u = this.uniforms;
    u.uPing.value.w = Math.min(ping.range, ping.age * PING_SPEED);
    const fadeOut = 1 - smoothstep(ping.life - 1.2, ping.life, ping.age);
    u.uPingFade.value = Math.max(0, fadeOut);
    if (ping.age >= ping.life) {
      ping.age = -1;
      u.uPingFade.value = 0;
    }
  }

  dispose() {
    if (this.offPing) this.offPing();
    this.offPing = null;
    if (this.backdrop) {
      if (this.backdrop.parent) this.backdrop.parent.remove(this.backdrop);
      this.backdrop.geometry.dispose();
      this.backdrop.material.dispose();
      this.backdrop = null;
    }
    for (const material of this.materials) {
      material.onBeforeCompile = () => {};
      material.customProgramCacheKey = () => "";
      material.needsUpdate = true;
    }
    this.materials.clear();
  }
}

export { _sun as WATER_SUN };
