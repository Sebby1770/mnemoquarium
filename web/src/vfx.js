/* Everything down here that flickers, blooms, or shakes the glass.

   One pooled particle system, three clouds of THREE.Points: an additive spark
   pool, an additive bubble pool, and a soft normal-blended pool for ink and
   blood. Fixed-size BufferAttributes, ring allocation (so a full pool recycles
   its oldest particle), and all the motion integrated on the CPU into arrays
   that were allocated once at construction. Nothing in here allocates during a
   frame — the sea is allowed to be busy, the frame budget is not.

   Sizes and alphas are per-particle, which PointsMaterial does not offer, so
   the points shader is patched through onBeforeCompile with two extra
   attributes. Everything else (fog for the clouds, sizeAttenuation, the map)
   is stock three.js so it keeps matching whatever world.js does to the scene. */

import * as THREE from "three";
import { clamp, clamp01, TAU } from "./util.js";

/* Budgets. These are hard ceilings: spawning past them steals the oldest
   particle rather than growing an array. */
const SPARK_MAX = 1400;
const BUBBLE_MAX = 600;
const CLOUD_MAX = 600;
const SHELL_MAX = 8;
const FLASH_MAX = 6;

/* Per-particle behaviour, chosen once at spawn and switched on in the loop. */
const KIND_SPARK = 0;   // flies outward, snaps out
const KIND_EMBER = 1;   // like a spark but lazier and slightly buoyant
const KIND_BUBBLE = 2;  // rises, wobbles, swells
const KIND_CLOUD = 3;   // expands, slows, dissolves
const KIND_SPIRAL = 4;  // orbits inward toward an anchor point
const KIND_MOTE = 5;    // heavy speck that sinks out of a blood cloud

const SHAKE_DECAY = 3.4;        // per second, exponential
const FOG_EXTINCTION = 0.8;     // lights carry a little further than the fog suggests
const SONAR_COLOR = 0x86f2ff;
const BUBBLE_COLOR = 0xcfeeff;
const INK_COLOR = 0x0d0a18;
const INK_EDGE = 0x2a1a3e;
const BLOOD_COLOR = 0x8c1f2a;

/* Scratch. Hoisted so no public method ever allocates. Public methods read
   their argument into _pos and must not hold it across a call into another
   public method. */
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _color = new THREE.Color();
const EMPTY = Object.freeze({});

function readVec(src, out) {
  if (!src) return out.set(0, 0, 0);
  if (Array.isArray(src)) return out.set(src[0] || 0, src[1] || 0, src[2] || 0);
  return out.set(src.x || 0, src.y || 0, src.z || 0);
}

/* Uniform point on the unit sphere. Cosmetic jitter, so Math.random is fine —
   nothing about a puff of bubbles has to survive a reload. */
function randDir(out) {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * TAU;
  const s = Math.sqrt(Math.max(0, 1 - u * u));
  return out.set(Math.cos(th) * s, u, Math.sin(th) * s);
}

/* Adds per-particle size and alpha to the stock points shader. Kept as a single
   module-level function so every pool shares it: three keys its program cache
   on onBeforeCompile.toString(), and identical source means one compile. */
function patchPoints(shader) {
  shader.vertexShader = `attribute float aScale;
attribute float aAlpha;
varying float vAlpha;
${shader.vertexShader}`.replace(
    "gl_PointSize = size;",
    "vAlpha = aAlpha;\n\tgl_PointSize = size * aScale;",
  );
  shader.fragmentShader = `varying float vAlpha;
${shader.fragmentShader}`.replace(
    "vec4 diffuseColor = vec4( diffuse, opacity );",
    "vec4 diffuseColor = vec4( diffuse, opacity * vAlpha );",
  );
}

/* ---------------------------------------------------------------- textures */

function makeCanvas(size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function finishTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* A hot core with a long tail — reads as a spark at any distance. */
function makeDotTexture() {
  const size = 64;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.92)");
  g.addColorStop(0.42, "rgba(255,255,255,0.34)");
  g.addColorStop(0.72, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(canvas);
}

/* Bright rim, hollow middle, one highlight: a bubble seen from anywhere. */
function makeRingTexture() {
  const size = 64;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, "rgba(255,255,255,0.06)");
  g.addColorStop(0.5, "rgba(255,255,255,0.10)");
  g.addColorStop(0.76, "rgba(255,255,255,0.82)");
  g.addColorStop(0.88, "rgba(255,255,255,0.30)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const h = ctx.createRadialGradient(c * 0.66, c * 0.62, 0, c * 0.66, c * 0.62, c * 0.34);
  h.addColorStop(0, "rgba(255,255,255,0.7)");
  h.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(canvas);
}

/* Soft, deliberately lopsided blob — a perfect circle reads as a bullet hole,
   not a cloud. The offsets are fixed so the texture is the same every load. */
function makeBlobTexture() {
  const size = 128;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const c = size / 2;
  const base = ctx.createRadialGradient(c, c, 0, c, c, c);
  base.addColorStop(0, "rgba(255,255,255,0.85)");
  base.addColorStop(0.38, "rgba(255,255,255,0.55)");
  base.addColorStop(0.72, "rgba(255,255,255,0.16)");
  base.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const lobes = [
    [0.34, 0.40, 0.26], [0.66, 0.36, 0.22], [0.60, 0.68, 0.28],
    [0.30, 0.64, 0.20], [0.50, 0.50, 0.32],
  ];
  for (let i = 0; i < lobes.length; i += 1) {
    const [lx, ly, lr] = lobes[i];
    const g = ctx.createRadialGradient(lx * size, ly * size, 0, lx * size, ly * size, lr * size);
    g.addColorStop(0, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return finishTexture(canvas);
}

/* Wide falloff for the explosion flash sprite. */
function makeGlowTexture() {
  const size = 128;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.12, "rgba(255,255,255,0.78)");
  g.addColorStop(0.34, "rgba(255,255,255,0.32)");
  g.addColorStop(0.62, "rgba(255,255,255,0.09)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finishTexture(canvas);
}

/* ------------------------------------------------------------ particle pool */

class ParticlePool {
  constructor(capacity, material, opts = {}) {
    const n = capacity;
    this.capacity = n;
    this.cursor = 0;      // ring allocator: the slot here is the oldest one
    this.live = 0;
    this.used = 0;        // high-water mark, keeps the draw range tight early on
    this.colorDirty = false;
    this.fogExtinction = opts.fogExtinction !== false;

    // Attribute-backed state (uploaded to the GPU).
    this.posArr = new Float32Array(n * 3);
    this.colArr = new Float32Array(n * 3);
    this.alphaArr = new Float32Array(n);
    this.scaleArr = new Float32Array(n);

    // CPU-only state.
    this.vel = new Float32Array(n * 3);
    this.anchor = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.lifeMax = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.drag = new Float32Array(n);
    this.buoy = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    this.fadeIn = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.freq = new Float32Array(n);
    this.wobble = new Float32Array(n);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.colArr, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphaArr, 1).setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.BufferAttribute(this.scaleArr, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setAttribute("aAlpha", this.alphaAttr);
    geo.setAttribute("aScale", this.scaleAttr);
    geo.setDrawRange(0, 0);
    // Particles live in world space on an object that never moves, so culling
    // and bounds recomputation would both be lies. Skip them.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.geometry = geo;
    this.material = material;

    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = opts.renderOrder || 0;
    this.points.visible = false;
  }

  /* Round-robin allocation. When every slot is alive the one under the cursor
     is by definition the least recently handed out, so overwriting it recycles
     the oldest particle without keeping a free list. */
  acquire() {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.life[i] <= 0) this.live += 1;
    if (i + 1 > this.used) this.used = i + 1;
    this.colorDirty = true;
    return i;
  }

  place(i, x, y, z, vx, vy, vz) {
    const k = i * 3;
    this.posArr[k] = x;
    this.posArr[k + 1] = y;
    this.posArr[k + 2] = z;
    this.vel[k] = vx;
    this.vel[k + 1] = vy;
    this.vel[k + 2] = vz;
  }

  anchorAt(i, x, y, z) {
    const k = i * 3;
    this.anchor[k] = x;
    this.anchor[k + 1] = y;
    this.anchor[k + 2] = z;
  }

  tint(i, color) {
    const k = i * 3;
    this.colArr[k] = color.r;
    this.colArr[k + 1] = color.g;
    this.colArr[k + 2] = color.b;
  }

  /* Every field a recycled slot could be carrying from its last life gets
     written here, so callers only set the extras they actually use. */
  shape(i, kind, life, size0, size1, alpha, fadeIn, drag, buoy) {
    this.kind[i] = kind;
    this.life[i] = life;
    this.lifeMax[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.alpha0[i] = alpha;
    this.fadeIn[i] = fadeIn;
    this.drag[i] = drag;
    this.buoy[i] = buoy;
    this.wobble[i] = 0;
    this.freq[i] = 0;
    this.phase[i] = 0;
    this.scaleArr[i] = size0;
    this.alphaArr[i] = fadeIn > 0 ? 0 : alpha;
  }

  update(dt, cx, cy, cz, extinction) {
    if (this.live === 0) {
      if (this.points.visible) this.points.visible = false;
      return;
    }
    const pos = this.posArr;
    const vel = this.vel;
    const anch = this.anchor;
    const alphaArr = this.alphaArr;
    const scaleArr = this.scaleArr;
    const n = this.used;
    let live = 0;

    for (let i = 0; i < n; i += 1) {
      let l = this.life[i];
      if (l <= 0) continue;
      l -= dt;
      const max = this.lifeMax[i];
      if (l <= 0) {
        this.life[i] = 0;
        alphaArr[i] = 0;
        scaleArr[i] = 0;
        continue;
      }
      this.life[i] = l;
      live += 1;

      const age = max - l;
      const t = 1 - l / max;
      const k = i * 3;
      const kind = this.kind[i];

      if (kind === KIND_SPIRAL) {
        // No free flight: the velocity slots carry (orbit radius, lift, spin)
        // and the particle is placed on a shrinking helix around its anchor.
        const shrink = (1 - t) * (1 - t);
        const ang = this.phase[i] + vel[k + 2] * age;
        const r = vel[k] * shrink;
        pos[k] = anch[k] + Math.cos(ang) * r;
        pos[k + 1] = anch[k + 1] + vel[k + 1] * t + Math.sin(ang * 0.7) * r * 0.22;
        pos[k + 2] = anch[k + 2] + Math.sin(ang) * r;
      } else {
        const decay = Math.exp(-this.drag[i] * dt);
        let vx = vel[k];
        let vy = vel[k + 1];
        let vz = vel[k + 2];
        vy += this.buoy[i] * dt;
        const wob = this.wobble[i];
        if (wob > 0) {
          // Bubbles do not rise straight; they scribble.
          const f = this.freq[i];
          const w = wob * dt;
          vx += Math.cos(this.phase[i] + age * f) * w;
          vz += Math.sin(this.phase[i] * 1.7 + age * f * 0.83) * w;
        }
        vx *= decay;
        vy *= decay;
        vz *= decay;
        vel[k] = vx;
        vel[k + 1] = vy;
        vel[k + 2] = vz;
        pos[k] += vx * dt;
        pos[k + 1] += vy * dt;
        pos[k + 2] += vz * dt;
      }

      // Clouds bloom fast then creep; everything else grows linearly.
      const grow = kind === KIND_CLOUD ? Math.sqrt(t) : t;
      let size = this.size0[i] + (this.size1[i] - this.size0[i]) * grow;

      let a = this.alpha0[i];
      const fin = this.fadeIn[i];
      if (fin > 0 && age < fin) a *= age / fin;
      const u = 1 - t;
      if (kind === KIND_SPARK) {
        a *= u * u;
      } else if (kind === KIND_EMBER) {
        a *= u * Math.sqrt(u);
      } else if (kind === KIND_BUBBLE) {
        a *= u < 0.25 ? u * 4 : 1;
      } else if (kind === KIND_SPIRAL) {
        // Brightens as it converges, then goes out at the anchor.
        a *= clamp01(u * 3) * (0.4 + 0.6 * t);
      } else {
        a *= u * u * (3 - 2 * u);
      }

      if (extinction > 0) {
        // Additive motes are lights, and the water eats light. Attenuate on the
        // CPU rather than letting fog mix them toward the fog colour, which
        // would make distant sparks brighten the haze instead of dying in it.
        const dx = pos[k] - cx;
        const dy = pos[k + 1] - cy;
        const dz = pos[k + 2] - cz;
        a *= Math.exp(-extinction * Math.sqrt(dx * dx + dy * dy + dz * dz));
        if (a < 0.004) size = 0;
      }

      alphaArr[i] = a;
      scaleArr[i] = size;
    }

    this.live = live;
    this.geometry.setDrawRange(0, this.used);
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    if (this.colorDirty) {
      this.colAttr.needsUpdate = true;
      this.colorDirty = false;
    }
    this.points.visible = true;
  }

  clear() {
    this.life.fill(0);
    this.alphaArr.fill(0);
    this.scaleArr.fill(0);
    this.live = 0;
    this.cursor = 0;
    this.points.visible = false;
    this.alphaAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
  }

  dispose() {
    if (this.points.parent) this.points.parent.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------- vfx */

export class VFX {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.camera = game.camera;

    /* sub.js reads this every frame for camera shake, so it stays a plain
       number in 0..1 no matter what anyone throws at screenShake(). */
    this.shake = 0;
    this.camPos = new THREE.Vector3();
    if (this.camera) this.camera.getWorldPosition(this.camPos);

    // Someone who asked the browser for less motion should not be thrown
    // around by every torpedo.
    let reduced = false;
    try {
      reduced = typeof matchMedia === "function"
        && matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (err) {
      reduced = false;
    }
    this.shakeScale = reduced ? 0.25 : 1;

    this.group = new THREE.Group();
    this.group.name = "vfx";
    this.group.matrixAutoUpdate = false;
    this.scene.add(this.group);

    this.dotTexture = makeDotTexture();
    this.ringTexture = makeRingTexture();
    this.blobTexture = makeBlobTexture();
    this.glowTexture = makeGlowTexture();

    const sparkMaterial = new THREE.PointsMaterial({
      size: 1,                       // real size rides on the aScale attribute
      sizeAttenuation: true,
      map: this.dotTexture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,                    // handled by CPU extinction instead
    });
    sparkMaterial.onBeforeCompile = patchPoints;

    const bubbleMaterial = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: true,
      map: this.ringTexture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    bubbleMaterial.onBeforeCompile = patchPoints;

    const cloudMaterial = new THREE.PointsMaterial({
      size: 1,
      sizeAttenuation: true,
      map: this.blobTexture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      fog: true,                     // ink really should wash out with distance
    });
    cloudMaterial.onBeforeCompile = patchPoints;

    // Render order climbs so the additive things land on top of the murk.
    this.clouds = new ParticlePool(CLOUD_MAX, cloudMaterial, {
      renderOrder: 1, fogExtinction: false,
    });
    this.bubblePool = new ParticlePool(BUBBLE_MAX, bubbleMaterial, { renderOrder: 2 });
    this.sparks = new ParticlePool(SPARK_MAX, sparkMaterial, { renderOrder: 3 });
    this.pools = [this.clouds, this.bubblePool, this.sparks];
    for (let i = 0; i < this.pools.length; i += 1) this.group.add(this.pools[i].points);

    /* Expanding shells: sonar pings seen from inside, explosion fronts seen
       from outside. One geometry, one material each so opacity is per-shell. */
    this.shellGeometry = new THREE.SphereGeometry(1, 24, 14);
    this.shells = [];
    this.shellCursor = 0;
    for (let i = 0; i < SHELL_MAX; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: SONAR_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const mesh = new THREE.Mesh(this.shellGeometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.shells.push({
        mesh, material, life: 0, lifeMax: 1, r0: 1, r1: 2, alpha0: 0.3,
      });
    }

    /* Flash sprites for the first frames of an explosion. */
    this.flashes = [];
    this.flashCursor = 0;
    for (let i = 0; i < FLASH_MAX; i += 1) {
      const material = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.frustumCulled = false;
      sprite.visible = false;
      sprite.renderOrder = 5;
      this.group.add(sprite);
      this.flashes.push({ sprite, material, life: 0, lifeMax: 1, size: 1 });
    }

    this.disposed = false;
  }

  /* ------------------------------------------------------------- per frame */

  update(dt) {
    if (this.disposed) return;
    const step = clamp(Number(dt) || 0, 0, 1 / 20);

    this.shake *= Math.exp(-SHAKE_DECAY * step);
    if (this.shake < 0.002) this.shake = 0;

    if (this.camera) this.camera.getWorldPosition(this.camPos);
    const fog = this.scene.fog;
    const extinction = fog && fog.isFogExp2 ? fog.density * FOG_EXTINCTION : 0;
    const cx = this.camPos.x;
    const cy = this.camPos.y;
    const cz = this.camPos.z;

    for (let i = 0; i < this.pools.length; i += 1) {
      const pool = this.pools[i];
      pool.update(step, cx, cy, cz, pool.fogExtinction ? extinction : 0);
    }

    for (let i = 0; i < this.shells.length; i += 1) {
      const s = this.shells[i];
      if (s.life <= 0) continue;
      s.life -= step;
      if (s.life <= 0) {
        s.life = 0;
        s.mesh.visible = false;
        s.material.opacity = 0;
        continue;
      }
      const t = 1 - s.life / s.lifeMax;
      const ease = 1 - (1 - t) * (1 - t);           // fast out of the gate
      const r = s.r0 + (s.r1 - s.r0) * ease;
      s.mesh.scale.setScalar(r);
      const u = 1 - t;
      s.material.opacity = s.alpha0 * u * Math.sqrt(u);
    }

    for (let i = 0; i < this.flashes.length; i += 1) {
      const f = this.flashes[i];
      if (f.life <= 0) continue;
      f.life -= step;
      if (f.life <= 0) {
        f.life = 0;
        f.sprite.visible = false;
        f.material.opacity = 0;
        continue;
      }
      const t = 1 - f.life / f.lifeMax;
      f.sprite.scale.setScalar(f.size * (0.3 + 0.95 * t));
      const u = 1 - t;
      f.material.opacity = u * u;
    }
  }

  /* ---------------------------------------------------------------- effects */

  /* Rising wash: thruster exhaust, a hit, a hull breach, anything that lets air
     out. opts: {spread, rise, size, life}. */
  bubbles(position, count, opts) {
    if (this.disposed) return;
    const o = opts || EMPTY;
    readVec(position, _pos);
    const q = this._budget(_pos);
    if (q <= 0) return;

    const spread = o.spread != null ? o.spread : 0.55;
    const rise = o.rise != null ? o.rise : 2.4;
    const size = o.size != null ? o.size : 1;
    const life = o.life != null ? o.life : 2.6;
    const asked = Math.min(48, Math.max(0, Math.round(Number(count) || 0)));
    if (asked <= 0) return;
    const n = Math.max(1, Math.round(asked * q));

    const pool = this.bubblePool;
    _color.setHex(BUBBLE_COLOR);
    for (let j = 0; j < n; j += 1) {
      const i = pool.acquire();
      randDir(_dir);
      const r = spread * Math.cbrt(Math.random());
      pool.place(
        i,
        _pos.x + _dir.x * r,
        _pos.y + _dir.y * r,
        _pos.z + _dir.z * r,
        _dir.x * 0.7 + (Math.random() - 0.5) * 0.5,
        Math.abs(_dir.y) * 0.5 + Math.random() * 0.4,
        _dir.z * 0.7 + (Math.random() - 0.5) * 0.5,
      );
      const s0 = (0.055 + Math.random() * 0.13) * size;
      pool.shape(
        i, KIND_BUBBLE,
        life * (0.6 + Math.random() * 0.8),
        s0, s0 * 1.8,
        0.3 + Math.random() * 0.25,
        0.06,
        1.15,
        rise * (0.7 + Math.random() * 0.6),
      );
      pool.wobble[i] = 0.9 + Math.random() * 1.5;
      pool.freq[i] = 3 + Math.random() * 4.5;
      pool.phase[i] = Math.random() * TAU;
      pool.tint(i, _color);
    }
  }

  /* A bolt biting something. Short, bright, mostly gone before you register it. */
  hitSpark(position, colorHex) {
    if (this.disposed) return;
    readVec(position, _pos);
    const q = this._budget(_pos);
    if (q <= 0) return;

    const hex = colorHex == null ? 0xbfe6ff : colorHex;
    const pool = this.sparks;
    const n = Math.max(4, Math.round(16 * q));
    const px = _pos.x;
    const py = _pos.y;
    const pz = _pos.z;

    for (let j = 0; j < n; j += 1) {
      const i = pool.acquire();
      randDir(_dir);
      const speed = 4.5 + Math.random() * 12;
      pool.place(
        i,
        px + _dir.x * 0.2, py + _dir.y * 0.2, pz + _dir.z * 0.2,
        _dir.x * speed, _dir.y * speed, _dir.z * speed,
      );
      const s0 = 0.08 + Math.random() * 0.16;
      pool.shape(
        i, KIND_SPARK,
        0.18 + Math.random() * 0.34,
        s0, s0 * 0.4,
        0.85,
        0, 4.4, 0.7,
      );
      // Every third mote keeps a white core so the burst has a temperature.
      _color.setHex(j % 3 === 0 ? 0xffffff : hex);
      pool.tint(i, _color);
    }

    this.bubbles(_pos, 3, { spread: 0.35, rise: 1.9, size: 0.8, life: 1.5 });
  }

  /* Flash, sparks, a shell, and a shove. Scale is roughly the blast radius in
     metres divided by nine. */
  explosion(position, scale, colorHex) {
    if (this.disposed) return;
    readVec(position, _pos);
    const s = clamp(Number(scale) || 1, 0.25, 6);
    const hex = colorHex == null ? 0xffb066 : colorHex;
    const q = this._budget(_pos);
    const dist = this.camPos.distanceTo(_pos);
    const px = _pos.x;
    const py = _pos.y;
    const pz = _pos.z;

    // The shake lands even when the blast is too far to bother drawing.
    this.screenShake(clamp01((0.75 * s) / (1 + dist / 24)));
    if (q <= 0) return;

    this._flash(px, py, pz, 6.5 * s, 0.26, 0xfff2d8);
    this._shell(px, py, pz, 0.5 * s, 9.5 * s, 0.42, hex, 0.5, THREE.FrontSide);

    const pool = this.sparks;
    const n = Math.max(10, Math.round(70 * s * q));
    for (let j = 0; j < n; j += 1) {
      const i = pool.acquire();
      randDir(_dir);
      const speed = (7 + Math.random() * 26) * s;
      const r = 0.3 * s;
      pool.place(
        i,
        px + _dir.x * r, py + _dir.y * r, pz + _dir.z * r,
        _dir.x * speed, _dir.y * speed, _dir.z * speed,
      );
      const ember = j % 4 === 0;
      const s0 = (0.12 + Math.random() * 0.22) * s;
      pool.shape(
        i,
        ember ? KIND_EMBER : KIND_SPARK,
        ember ? 0.9 + Math.random() * 1.4 : 0.25 + Math.random() * 0.5,
        s0, s0 * (ember ? 0.5 : 0.3),
        0.95,
        0,
        ember ? 1.9 : 3.6,
        ember ? 1.4 : 0.5,
      );
      _color.setHex(j % 5 === 0 ? 0xffffff : hex);
      pool.tint(i, _color);
    }

    this.bubbles(_pos, Math.round(18 * s), {
      spread: 1.1 * s, rise: 3.1, size: 1.4 * s, life: 3.2,
    });
  }

  /* Squid ink: a hole in the water that closes slowly. */
  inkCloud(position, radius) {
    if (this.disposed) return;
    readVec(position, _pos);
    const r = clamp(Number(radius) || 6, 1, 40);
    const q = this._budget(_pos);
    if (q <= 0) return;

    const pool = this.clouds;
    const n = Math.max(8, Math.round(clamp(r * 6, 12, 90) * q));
    const px = _pos.x;
    const py = _pos.y;
    const pz = _pos.z;

    for (let j = 0; j < n; j += 1) {
      const i = pool.acquire();
      randDir(_dir);
      const d = r * 0.3 * Math.cbrt(Math.random());
      const speed = 0.5 + Math.random() * 1.7;
      pool.place(
        i,
        px + _dir.x * d, py + _dir.y * d, pz + _dir.z * d,
        _dir.x * speed, _dir.y * speed * 0.5, _dir.z * speed,
      );
      pool.shape(
        i, KIND_CLOUD,
        4.5 + Math.random() * 3.5,
        r * 0.22, r * (0.85 + Math.random() * 0.4),
        0.34 + Math.random() * 0.16,
        0.22,
        1.7,
        0.12,
      );
      // A little violet at the edges keeps it from reading as a dead pixel.
      _color.setHex(j % 4 === 0 ? INK_EDGE : INK_COLOR);
      pool.tint(i, _color);
    }
  }

  /* What comes out of a thing that was alive. Glowing species bleed light. */
  bloodCloud(position, colorHex) {
    if (this.disposed) return;
    readVec(position, _pos);
    const hex = colorHex == null ? BLOOD_COLOR : colorHex;
    const q = this._budget(_pos);
    if (q <= 0) return;

    const pool = this.clouds;
    const n = Math.max(5, Math.round(22 * q));
    const px = _pos.x;
    const py = _pos.y;
    const pz = _pos.z;
    _color.setHex(hex);

    for (let j = 0; j < n; j += 1) {
      const i = pool.acquire();
      randDir(_dir);
      const d = 0.5 * Math.cbrt(Math.random());
      const speed = 0.8 + Math.random() * 2.4;
      pool.place(
        i,
        px + _dir.x * d, py + _dir.y * d, pz + _dir.z * d,
        _dir.x * speed, _dir.y * speed + 0.3, _dir.z * speed,
      );
      const heavy = j % 5 === 0;
      const s0 = 0.3 + Math.random() * 0.4;
      pool.shape(
        i,
        heavy ? KIND_MOTE : KIND_CLOUD,
        heavy ? 1.6 + Math.random() * 1.6 : 2.2 + Math.random() * 2.2,
        s0, heavy ? s0 * 1.2 : s0 * (4 + Math.random() * 3),
        heavy ? 0.55 : 0.4 + Math.random() * 0.2,
        0.1,
        heavy ? 1.2 : 2.1,
        heavy ? -0.9 : 0.45,
      );
      pool.tint(i, _color);
    }
  }

  /* The capture beam pulling a fish apart into light. Cheap enough to call
     every frame the beam is held. */
  captureSparkle(position, colorHex) {
    if (this.disposed) return;
    readVec(position, _pos);
    const hex = colorHex == null ? 0x9fe8ff : colorHex;
    const q = this._budget(_pos);
    if (q <= 0) return;

    const pool = this.sparks;
    const n = Math.max(2, Math.round(6 * q));
    const px = _pos.x;
    const py = _pos.y;
    const pz = _pos.z;
    _color.setHex(hex);

    for (let j = 0; j < n; j += 1) {
      const i = pool.acquire();
      const ang = Math.random() * TAU;
      const r0 = 1.3 + Math.random() * 2.1;
      const spin = (6 + Math.random() * 6) * (Math.random() < 0.5 ? -1 : 1);
      const lift = (Math.random() - 0.5) * 1.6;
      pool.anchorAt(i, px, py, pz);
      // Spiral particles carry (radius, lift, spin) where velocity would be.
      pool.place(
        i,
        px + Math.cos(ang) * r0, py, pz + Math.sin(ang) * r0,
        r0, lift, spin,
      );
      const s0 = 0.09 + Math.random() * 0.14;
      pool.shape(i, KIND_SPIRAL, 0.45 + Math.random() * 0.5, s0, s0 * 0.55, 0.9, 0, 0, 0);
      pool.phase[i] = ang;
      pool.tint(i, j % 4 === 0 ? _color.setHex(0xffffff) : _color.setHex(hex));
    }
  }

  /* The ping: a wall of light leaving you, and a smaller one chasing it so it
     reads as a pulse rather than a balloon. */
  sonarWave(origin, range) {
    if (this.disposed) return;
    readVec(origin, _pos);
    const r = clamp(Number(range) || 140, 20, 1400);
    const dur = clamp(r / 150, 1.0, 3.2);
    this._shell(_pos.x, _pos.y, _pos.z, 2.5, r, dur, SONAR_COLOR, 0.26, THREE.BackSide);
    this._shell(_pos.x, _pos.y, _pos.z, 1.2, r * 0.55, dur * 0.62, SONAR_COLOR, 0.16, THREE.BackSide);
  }

  /* sub.js reads game.vfx.shake; this is the only way anything writes it. */
  screenShake(amount) {
    const a = Number(amount);
    if (!(a > 0)) return;
    this.shake = clamp01(this.shake + a * this.shakeScale);
  }

  /* ---------------------------------------------------------------- private */

  /* Fewer particles the further away the event is, nothing at all once the fog
     has swallowed it. A kraken dying over the horizon should not cost a frame. */
  _budget(pos) {
    const d = this.camPos.distanceTo(pos);
    if (d > 520) return 0;
    if (d < 40) return 1;
    return clamp(1 - (d - 40) / 300, 0.22, 1);
  }

  _flash(x, y, z, size, life, hex) {
    const f = this.flashes[this.flashCursor];
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    f.sprite.position.set(x, y, z);
    f.sprite.scale.setScalar(size * 0.3);
    f.sprite.visible = true;
    f.material.color.setHex(hex);
    f.material.opacity = 1;
    f.size = size;
    f.life = life;
    f.lifeMax = life;
  }

  _shell(x, y, z, r0, r1, life, hex, alpha, side) {
    const s = this.shells[this.shellCursor];
    this.shellCursor = (this.shellCursor + 1) % this.shells.length;
    s.mesh.position.set(x, y, z);
    s.mesh.scale.setScalar(r0);
    s.mesh.visible = true;
    s.material.color.setHex(hex);
    if (s.material.side !== side) {
      s.material.side = side;
      // Sidedness is baked into the compiled program, so ask for a refetch.
      s.material.needsUpdate = true;
    }
    s.material.opacity = alpha;
    s.r0 = r0;
    s.r1 = r1;
    s.alpha0 = alpha;
    s.life = life;
    s.lifeMax = life;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    for (let i = 0; i < this.pools.length; i += 1) this.pools[i].dispose();
    this.pools.length = 0;

    for (let i = 0; i < this.shells.length; i += 1) {
      const s = this.shells[i];
      this.group.remove(s.mesh);
      s.material.dispose();
    }
    this.shells.length = 0;
    this.shellGeometry.dispose();

    for (let i = 0; i < this.flashes.length; i += 1) {
      const f = this.flashes[i];
      this.group.remove(f.sprite);
      f.material.dispose();
    }
    this.flashes.length = 0;

    this.dotTexture.dispose();
    this.ringTexture.dispose();
    this.blobTexture.dispose();
    this.glowTexture.dispose();

    if (this.group.parent) this.group.parent.remove(this.group);
    this.shake = 0;
  }
}
