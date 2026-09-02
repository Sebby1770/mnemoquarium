/* Side-view aquarium renderer. Looks through the glass: sand, coral, fish. */
(function (global) {
  "use strict";

  const KINDS = ["tetra", "guppy", "angel", "betta", "catfish", "eel"];

  const SEASON_TINT = {
    spring: { wash: "rgba(70, 170, 90, 0.10)", sand: [38, 42, 62], light: 1.05, plant: 10 },
    summer: { wash: "rgba(40, 170, 190, 0.08)", sand: [36, 44, 58], light: 1.12, plant: 4 },
    autumn: { wash: "rgba(180, 120, 40, 0.10)", sand: [34, 40, 52], light: 0.94, plant: -4 },
    winter: { wash: "rgba(40, 70, 140, 0.14)", sand: [30, 16, 46], light: 0.80, plant: -10 },
  };

  const THEMES = {
    reef: {
      id: "reef",
      label: "Reef",
      waterHue: 192,
      waterSat: 48,
      nightHue: 224,
      kelpCount: 9,
      kelpBias: 0.12,
      plant: 0,
      bio: 0,
      wash: null,
      sand: null,
    },
    kelp: {
      id: "kelp",
      label: "Kelp forest",
      waterHue: 158,
      waterSat: 40,
      nightHue: 176,
      kelpCount: 18,
      kelpBias: 0.78,
      plant: 16,
      bio: 0.12,
      wash: "rgba(28, 110, 62, 0.16)",
      sand: [42, 28, 40],
    },
    moonlit: {
      id: "moonlit",
      label: "Moonlit",
      waterHue: 222,
      waterSat: 54,
      nightHue: 234,
      kelpCount: 7,
      kelpBias: 0.1,
      plant: -6,
      bio: 1,
      wash: "rgba(18, 32, 96, 0.22)",
      sand: [220, 16, 26],
    },
  };

  function hsl(h, s, l, a) {
    return a == null ? `hsl(${h} ${s}% ${l}%)` : `hsla(${h} ${s}% ${l}% / ${a})`;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function fishKind(sp) {
    if (sp.appetite >= 3 && sp.curiosity <= 2) return "catfish";
    if (sp.stubbornness >= 6) return "angel";
    if (sp.curiosity >= 6 && sp.appetite <= 2) return "tetra";
    return KINDS[sp.seed % KINDS.length];
  }

  function morph(sp, genome, org) {
    const kind = fishKind(sp);
    const g = genome >>> 0;
    const traits = typeof genomeTraits === "function" ? genomeTraits(g) : { appetite: 0, curiosity: 0, thrift: false, hue_shift: 0 };
    const hue = (sp.hue + traits.hue_shift + 360) % 360;
    const lineage = org && org.lineage_mutations ? org.lineage_mutations : 0;
    return {
      kind,
      hue,
      belly: (hue + 28 + (g % 18)) % 360,
      // Pattern comes from the inherited region, so siblings look alike.
      pattern: (g & 0xff) % 3,
      stripeCount: 3 + ((g >>> 9) % 5),
      spotCount: 4 + ((g >>> 11) % 7) + Math.min(4, lineage),
      tailFan: 0.55 + ((g >>> 13) % 40) / 100,
      speed: 0.55 + Math.max(0, sp.curiosity + traits.curiosity) * 0.12,
      girth: 1 + traits.appetite * 0.08,
      sheen: Math.min(1, lineage * 0.35),
      traits,
      bottom: kind === "catfish" || kind === "eel",
    };
  }

  function sandHeight(x, width, seed) {
    const n = (x / Math.max(1, width)) * Math.PI * 2;
    return (
      34 +
      Math.sin(n * 1.15 + seed) * 16 +
      Math.sin(n * 2.6 + seed * 0.3) * 9 +
      Math.sin(n * 6.1 + seed * 0.7) * 4
    );
  }

  class AquariumView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.world = null;
      this.fish = new Map();
      this.bubbles = [];
      this.flakes = [];
      this.ripples = [];
      this.shrimp = [];
      this.snail = { x: 0.12, dir: 1, yOff: 0 };
      this.lights = true;
      this.theme = "reef";
      this.picked = null;
      this.shock = 0;
      this.decor = null;
      this.cssW = 1100;
      this.cssH = 620;
      this.onPick = null;
      this.onBubble = null;
      this.reducedMotion = false;
      this.phase = { cycle: 0.5, night: 0, label: "day", clock: "12:00" };
      this._last = performance.now();
      this._bindMotion();
      this.resize();
    }

    _bindMotion() {
      if (typeof window.matchMedia !== "function") return;
      this._mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const apply = () => {
        this.reducedMotion = !!this._mq.matches;
      };
      apply();
      if (this._mq.addEventListener) this._mq.addEventListener("change", apply);
      else if (this._mq.addListener) this._mq.addListener(apply);
    }

    _m() {
      return this.reducedMotion ? 0.12 : 1;
    }

    themeSpec() {
      return THEMES[this.theme] || THEMES.reef;
    }

    setTheme(id) {
      this.theme = THEMES[id] ? id : "reef";
      if (this.world) this.decor = this._buildDecor(this.world);
    }

    dayNight(now) {
      const season = this.world ? this.world.season() : "summer";
      const dayLen = { spring: 0.56, summer: 0.68, autumn: 0.5, winter: 0.36 }[season] || 0.5;
      const tickCycle = ((this.world ? this.world.tick_count : 0) % 48) / 48;
      const wallCycle = ((now / 1000) / 96) % 1;
      const cycle = (tickCycle * 0.62 + wallCycle * 0.38) % 1;
      const elev = -Math.cos(cycle * Math.PI * 2);
      const threshold = (dayLen - 0.5) * 1.6;
      let night = clamp(0.5 - elev * 0.5 - threshold * 0.35, 0, 1);
      let label = "day";
      if (night >= 0.72) label = "night";
      else if (night >= 0.42) label = cycle < 0.5 ? "dawn" : "dusk";
      if (this.theme === "moonlit") night = clamp(night * 0.55 + 0.42, 0, 1);
      const hours = (cycle * 24 + 24) % 24;
      const hh = Math.floor(hours);
      const mm = Math.floor((hours - hh) * 60);
      const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      return { cycle, night, label, clock, season };
    }

    attach(world) {
      this.world = world;
      this.fish.clear();
      this.bubbles = [];
      this.flakes = [];
      this.picked = null;
      this.decor = this._buildDecor(world);
      this.shrimp = this._buildShrimp(world);
      this.snail.x = 0.08 + (world.seed % 50) / 200;
      this._syncFish(true);
    }

    resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(320, Math.floor(rect.width || this.canvas.width || 1100));
      const h = Math.max(240, Math.floor(rect.height || this.canvas.height || 620));
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    layout() {
      const w = this.cssW;
      const h = this.cssH;
      const pad = { l: 20, r: 20, t: 36, b: 18 };
      return {
        x: pad.l,
        y: pad.t,
        w: w - pad.l - pad.r,
        h: h - pad.t - pad.b,
        sand: sandHeight(0, w, this.world ? this.world.seed : 1),
      };
    }

    waterRect() {
      const box = this.layout();
      const drought = this._drought();
      const waterTop = box.y + 10 + drought * 28;
      const sand = this._sandBase();
      return { x: box.x, y: waterTop, w: box.w, h: sand - waterTop, sand };
    }

    _sandBase() {
      const box = this.layout();
      return box.y + box.h - 8;
    }

    sandY(px) {
      return this._sandBase() - sandHeight(px, this.cssW, this.world ? this.world.seed : 1);
    }

    _drought() {
      if (!this.world) return 0;
      return this.world.events.some((e) => /drought/.test(e)) ? 1 : 0;
    }

    _tint() {
      const season = this.world ? this.world.season() : "summer";
      const base = SEASON_TINT[season] || SEASON_TINT.summer;
      const theme = this.themeSpec();
      return {
        wash: theme.wash || base.wash,
        sand: theme.sand || base.sand,
        light: base.light,
        plant: base.plant + theme.plant,
        waterHue: theme.waterHue,
        waterSat: theme.waterSat,
        nightHue: theme.nightHue,
      };
    }

    toTank(org) {
      const water = this.waterRect();
      const world = this.world;
      const nx = (org.x + 0.5) / world.width;
      const ny = (org.y + 0.5) / world.height;
      const sp = world.species[org.species_index];
      const kind = fishKind(sp);
      let y = water.y + 16 + ny * (water.h - 36);
      const x = water.x + nx * water.w;
      if (kind === "catfish") y = this.sandY(x) - 14 - (org.energy % 7);
      if (kind === "eel") y = water.y + water.h * 0.62 + ny * water.h * 0.22;
      return { x, y };
    }

    _buildDecor(world) {
      const rng = new Rng(world.seed ^ 0x5f3759df);
      const theme = this.themeSpec();
      const items = [];
      const extra = theme.kelpBias > 0.5 ? 6 : 0;
      const count = 7 + (world.seed % 5) + extra;
      const reefKinds = ["branch", "brain", "anemone", "kelp", "rock", "wood"];
      const kelpKinds = ["kelp", "kelp", "kelp", "rock", "wood", "kelp", "branch"];
      const kinds = theme.kelpBias > 0.5 ? kelpKinds : reefKinds;
      for (let i = 0; i < count; i += 1) {
        let kind = kinds[rng.randrange(kinds.length)];
        if (theme.kelpBias > 0.4 && rng.random() < theme.kelpBias) kind = "kelp";
        items.push({
          kind,
          x: 0.06 + rng.random() * 0.88,
          scale: 0.7 + rng.random() * 0.9,
          hue: (90 + rng.randrange(80) + i * 17) % 360,
          phase: rng.random() * Math.PI * 2,
          seed: rng.next(),
        });
      }
      items.sort((a, b) => a.x - b.x);
      const aerator = 0.08 + (world.seed % 17) / 90;
      return { items, aerator };
    }

    _buildShrimp(world) {
      const rng = new Rng(world.seed ^ 0xc0ffee);
      const n = 3 + (world.seed % 3);
      const list = [];
      for (let i = 0; i < n; i += 1) {
        list.push({
          x: rng.random(),
          dir: rng.random() < 0.5 ? 1 : -1,
          phase: rng.random() * 10,
          hue: 8 + rng.randrange(24),
        });
      }
      return list;
    }

    _syncFish(snap) {
      const world = this.world;
      if (!world) return;
      const live = new Set();
      for (const org of world.organisms) {
        live.add(org.genome);
        const target = this.toTank(org);
        let vis = this.fish.get(org.genome);
        if (!vis) {
          const sp = world.species[org.species_index];
          vis = {
            genome: org.genome,
            px: target.x,
            py: target.y,
            facing: 1,
            angle: 0,
            phase: (org.genome % 1000) / 159.1,
            morph: morph(sp, org.genome, org),
            vx: 0,
            vy: 0,
            dart: 0,
          };
          this.fish.set(org.genome, vis);
        }
        vis.org = org;
        vis.sp = world.species[org.species_index];
        vis.targetX = target.x;
        vis.targetY = target.y;
        if (snap) {
          vis.px = target.x;
          vis.py = target.y;
        }
      }
      for (const key of [...this.fish.keys()]) {
        if (!live.has(key)) this.fish.delete(key);
      }
    }

    feed() {
      const water = this.waterRect();
      for (let i = 0; i < 18; i += 1) {
        this.flakes.push({
          x: water.x + 40 + Math.random() * (water.w - 80),
          y: water.y + 8,
          r: 1.2 + Math.random() * 1.6,
          vy: 0.18 + Math.random() * 0.35,
          rot: Math.random() * Math.PI,
          life: 1,
        });
      }
    }

    tap(cssX, cssY) {
      this.shock = 1;
      this.ripples.push({ x: cssX, y: cssY, r: 6, life: 1 });
      this.fish.forEach((vis) => {
        const dx = vis.px - cssX;
        const dy = vis.py - cssY;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 180) {
          vis.dart = 7 * (1 - d / 180);
          vis.vx += (dx / d) * vis.dart;
          vis.vy += (dy / d) * vis.dart * 0.4;
        }
      });
    }

    pickAt(cssX, cssY) {
      let best = null;
      let bestD = 28;
      this.fish.forEach((vis) => {
        const d = Math.hypot(vis.px - cssX, vis.py - cssY);
        if (d < bestD) {
          bestD = d;
          best = vis;
        }
      });
      this.picked = best;
      if (this.onPick) this.onPick(best);
      return best;
    }

    eventToLocal(event) {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ((event.clientX - rect.left) / rect.width) * this.cssW,
        y: ((event.clientY - rect.top) / rect.height) * this.cssH,
      };
    }

    snapshotDataUrl() {
      return this.canvas.toDataURL("image/png");
    }

    stepVisual(now) {
      const dt = Math.min(48, now - this._last) / 16.67;
      this._last = now;
      this.phase = this.dayNight(now);
      this._syncFish(false);
      this.shock *= Math.pow(0.92, dt);
      const water = this.waterRect();
      this._school(dt);
      this.fish.forEach((vis) => {
        let dx = vis.targetX - vis.px;
        const wrap = this.cssW * 0.45;
        if (Math.abs(dx) > wrap) {
          vis.px = vis.targetX;
          vis.py = vis.targetY;
          dx = 0;
        }
        const dy = vis.targetY - vis.py;
        const glide = 0.016 * dt;
        vis.px += dx * glide + vis.vx * 0.018 * dt;
        vis.py += dy * glide * 1.1 + vis.vy * 0.018 * dt;
        vis.vx *= Math.pow(0.92, dt);
        vis.vy *= Math.pow(0.92, dt);
        vis.dart *= Math.pow(0.94, dt);
        const heading = dx + vis.vx;
        if (heading > 5) vis.facing = 1;
        else if (heading < -5) vis.facing = -1;
        vis.angle = clamp((dy * 0.012 + vis.vx * 0.008) * vis.facing, -0.22, 0.22);
        if (Math.hypot(dx, dy) < 8) {
          vis.px += Math.sin(now * 0.0007 + vis.phase) * 0.18 * this._m();
          vis.py += Math.cos(now * 0.00055 + vis.phase) * 0.12 * this._m();
        }
        vis.py = clamp(vis.py, water.y + 14, this.sandY(vis.px) - 10);
        vis.px = clamp(vis.px, water.x + 16, water.x + water.w - 16);
        if (this.flakes.length && vis.morph.kind !== "eel") {
          const flake = this.flakes[0];
          vis.px += (flake.x - vis.px) * 0.0016 * vis.morph.speed * dt;
        }
      });
      this._stepParticles(dt, now, water);
    }

    _school(dt) {
      const members = [];
      this.fish.forEach((vis) => {
        const kind = vis.morph.kind;
        if (kind === "tetra" || kind === "guppy") members.push(vis);
      });
      const mot = this._m();
      for (const vis of members) {
        let cx = 0;
        let cy = 0;
        let avx = 0;
        let avy = 0;
        let n = 0;
        let sx = 0;
        let sy = 0;
        for (const other of members) {
          if (other === vis) continue;
          if (!vis.org || !other.org) continue;
          if (other.org.species_index !== vis.org.species_index) continue;
          const dx = other.px - vis.px;
          const dy = other.py - vis.py;
          const d = Math.hypot(dx, dy);
          if (d < 8 && d > 0.1) {
            sx -= dx / d;
            sy -= dy / d;
          } else if (d < 92) {
            cx += other.px;
            cy += other.py;
            avx += other.vx;
            avy += other.vy;
            n += 1;
          }
        }
        vis.vx += sx * 0.16 * dt * mot;
        vis.vy += sy * 0.16 * dt * mot;
        if (n > 0) {
          vis.vx += ((cx / n - vis.px) * 0.006 + (avx / n - vis.vx) * 0.05) * dt * mot;
          vis.vy += ((cy / n - vis.py) * 0.006 + (avy / n - vis.vy) * 0.05) * dt * mot;
        }
        vis.vx = clamp(vis.vx, -7, 7);
        vis.vy = clamp(vis.vy, -4, 4);
      }
    }

    _stepParticles(dt, now, water) {
      if (this.decor && Math.random() < 0.16 * dt) {
        const ax = water.x + this.decor.aerator * water.w;
        this.bubbles.push({
          x: ax + (Math.random() - 0.5) * 10,
          y: this.sandY(ax) - 12,
          r: 1 + Math.random() * 2.4,
          vy: 0.22 + Math.random() * 0.32,
          wobble: Math.random() * 6,
          born: now,
        });
        if (this.onBubble) this.onBubble();
      }
      if (Math.random() < 0.08 * dt) {
        const fx = water.x + 18;
        this.bubbles.push({
          x: fx + (Math.random() - 0.5) * 6,
          y: water.y + 22,
          r: 0.8 + Math.random() * 1.6,
          vy: 0.3 + Math.random() * 0.4,
          wobble: Math.random() * 6,
          born: now,
        });
      }
      this.bubbles = this.bubbles.filter((b) => {
        b.y -= b.vy * dt;
        b.x += Math.sin((now + b.wobble) * 0.003) * 0.35 * this._m();
        return b.y > water.y + 4;
      }).slice(-90);
      this.flakes = this.flakes.filter((f) => {
        f.y += f.vy * dt;
        f.x += Math.sin(now * 0.002 + f.rot) * 0.2 * this._m();
        f.rot += 0.03 * dt * this._m();
        f.life -= 0.002 * dt;
        return f.y < this.sandY(f.x) - 6 && f.life > 0;
      });
      this.ripples = this.ripples.filter((r) => {
        r.r += 2.4 * dt;
        r.life -= 0.03 * dt;
        return r.life > 0;
      });
      this.shrimp.forEach((s) => {
        s.x += s.dir * 0.00035 * dt * (this.reducedMotion ? 0.35 : 1);
        if (s.x < 0.04 || s.x > 0.96) s.dir *= -1;
      });
      this.snail.x += this.snail.dir * 0.00008 * dt * (this.reducedMotion ? 0.35 : 1);
      if (this.snail.x < 0.04 || this.snail.x > 0.96) this.snail.dir *= -1;
    }

    draw(now) {
      if (!this.world) return;
      const ctx = this.ctx;
      const w = this.cssW;
      const h = this.cssH;
      const box = this.layout();
      const water = this.waterRect();
      const tint = this._tint();
      const t = now * 0.001;
      this.phase = this.dayNight(now);
      const lamp = this.lights ? 1 : 0;
      const sky = 1 - this.phase.night * 0.92;
      const light = clamp((0.18 + sky * 0.52 + lamp * 0.48) * tint.light, 0.12, 1.35);

      ctx.clearRect(0, 0, w, h);
      this._drawCabinet(ctx, w, h, box);
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();

      this._drawBackWall(ctx, box, water, tint, light);
      this._drawGodRays(ctx, water, t, light);
      this._drawFarPlants(ctx, water, t, tint);
      this._drawSand(ctx, water, tint, light);
      this._drawDecor(ctx, water, t, tint, false);
      this._drawHeater(ctx, box, water, light);
      this._drawPlankton(ctx, water, light);
      this._drawFlakes(ctx);
      const fish = [...this.fish.values()].sort((a, b) => a.py - b.py);
      fish.forEach((vis) => this._drawFish(ctx, vis, now, light));
      this._drawShrimp(ctx, water, now);
      this._drawDecor(ctx, water, t, tint, true);
      this._drawFilter(ctx, box, water, light);
      this._drawBubbles(ctx);
      this._drawSnail(ctx, box, water, now);
      this._drawCaustics(ctx, water, t, light);
      this._drawSurface(ctx, water, t, light);
      this._drawRipples(ctx);
      if (!this.lights) {
        const a = this.theme === "moonlit"
          ? 0.26 + this.phase.night * 0.16
          : 0.2 + this.phase.night * 0.32;
        ctx.fillStyle = this.theme === "moonlit"
          ? `rgba(4, 12, 36, ${a})`
          : `rgba(2, 6, 14, ${a})`;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      } else if (this.phase.night > 0.35) {
        ctx.fillStyle = `rgba(6, 12, 32, ${0.08 * this.phase.night})`;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
      this._drawBioSpark(ctx, water, now);
      this._drawGlass(ctx, box, water, light);
      ctx.restore();
      this._drawHood(ctx, box, light);
      this._drawNameplate(ctx, box);
    }

    _drawCabinet(ctx, w, h, box) {
      ctx.fillStyle = "#120c08";
      ctx.fillRect(0, 0, w, h);
      const wood = ctx.createLinearGradient(0, 0, 0, h);
      wood.addColorStop(0, "#3a2416");
      wood.addColorStop(0.5, "#2a1a10");
      wood.addColorStop(1, "#1a100a");
      ctx.fillStyle = wood;
      ctx.fillRect(4, 4, w - 8, h - 8);
      this._drawSky(ctx, w, box);
      ctx.strokeStyle = "rgba(255, 210, 150, 0.12)";
      ctx.lineWidth = 2;
      ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = "#07090c";
      ctx.fillRect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
    }

    _drawSky(ctx, w, box) {
      const night = this.phase.night;
      const moonlit = this.theme === "moonlit";
      const skyNight = clamp(night + (moonlit ? 0.32 : 0), 0, 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(8, 8, w - 16, Math.max(8, box.y - 6));
      ctx.clip();
      const g = ctx.createLinearGradient(0, 0, 0, box.y);
      if (skyNight > 0.45) {
        g.addColorStop(0, hsl(230, 42, lerp(26, 5, skyNight)));
        g.addColorStop(1, hsl(222, 36, lerp(16, 3, skyNight)));
      } else {
        g.addColorStop(0, hsl(198, 36, lerp(58, 22, skyNight)));
        g.addColorStop(1, hsl(32, 28, lerp(28, 10, skyNight)));
      }
      ctx.fillStyle = g;
      ctx.fillRect(8, 8, w - 16, box.y);
      if (skyNight < 0.55) {
        ctx.beginPath();
        ctx.arc(w * 0.16, Math.max(14, box.y * 0.42), 9, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 214, 140, ${(1 - skyNight) * 0.7})`;
        ctx.fill();
      }
      if (skyNight > 0.28) {
        const rng = new Rng((this.world ? this.world.seed : 1) ^ 0x51a);
        ctx.globalAlpha = clamp((skyNight - 0.22) * 1.35, 0, 1);
        for (let i = 0; i < 42; i += 1) {
          const sx = 12 + rng.random() * (w - 24);
          const sy = 10 + rng.random() * Math.max(6, box.y - 12);
          ctx.fillStyle = i % 9 === 0 ? "#fde68a" : "#e8f0ff";
          const r = i % 7 === 0 ? 1.4 : 0.9;
          ctx.fillRect(sx, sy, r, r);
        }
        const mx = w * 0.82;
        const my = Math.max(16, box.y * 0.4);
        ctx.globalAlpha = skyNight * 0.4;
        ctx.beginPath();
        ctx.arc(mx, my, 13, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(210, 224, 255, 0.55)";
        ctx.fill();
        ctx.globalAlpha = skyNight * 0.95;
        ctx.beginPath();
        ctx.arc(mx, my, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = "#f0ece0";
        ctx.fill();
      }
      ctx.restore();
    }

    _drawBackWall(ctx, box, water, tint, light) {
      const night = this.phase.night;
      const hue = lerp(tint.waterHue, tint.nightHue, night);
      const sat = tint.waterSat + night * 8;
      const g = ctx.createLinearGradient(0, water.y, 0, water.sand);
      g.addColorStop(0, hsl(hue, sat, 36 * light + 12));
      g.addColorStop(0.42, hsl(hue + 6, sat + 2, 20 * light + 8));
      g.addColorStop(1, hsl(hue + 12, sat - 6, 8 * light + 5));
      ctx.fillStyle = g;
      ctx.fillRect(box.x, box.y, box.w, box.h);
      if (tint.wash) {
        ctx.fillStyle = tint.wash;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
    }

    _drawGodRays(ctx, water, t, light) {
      if (light < 0.4) return;
      if (this.phase.night > 0.78 && !this.lights) return;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const mot = this._m();
      for (let i = 0; i < 6; i += 1) {
        const x = water.x + ((i * 0.18 + t * 0.015 * mot) % 1) * water.w;
        ctx.beginPath();
        ctx.moveTo(x, water.y);
        ctx.lineTo(x + 18 + i * 4, water.sand);
        ctx.lineTo(x + 70 + i * 8, water.sand);
        ctx.lineTo(x + 22, water.y);
        ctx.closePath();
        ctx.fillStyle = `rgba(180, 230, 255, ${0.028 * light})`;
        ctx.fill();
      }
      ctx.restore();
    }

    _drawSand(ctx, water, tint, light) {
      const { x, w } = water;
      const base = water.sand;
      ctx.beginPath();
      ctx.moveTo(x, base + 4);
      for (let i = 0; i <= 48; i += 1) {
        const px = x + (i / 48) * w;
        ctx.lineTo(px, base - sandHeight(px, this.cssW, this.world.seed));
      }
      ctx.lineTo(x + w, base + 8);
      ctx.lineTo(x, base + 8);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, base - 70, 0, base + 8);
      g.addColorStop(0, hsl(tint.sand[0], tint.sand[1], Math.min(72, tint.sand[2] * light + 16)));
      g.addColorStop(0.55, hsl(36, 48, 50 * light + 8));
      g.addColorStop(1, hsl(28, 38, 26 * light + 4));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.save();
      ctx.clip();
      for (let i = 0; i < 220; i += 1) {
        const gx = x + ((i * 73 + this.world.seed) % 997) / 997 * w;
        const gy = base - ((i * 19 + this.world.seed) % 40) - 4;
        ctx.fillStyle = i % 5 === 0 ? hsl(28, 20, 28) : hsl(40, 30, 62, 0.25);
        ctx.fillRect(gx, gy, i % 7 === 0 ? 3 : 1.2, 1.2);
      }
      for (let i = 0; i < 14; i += 1) {
        const px = x + ((i * 97 + this.world.seed) % 800) / 800 * w;
        const py = base - 10 - (i % 5) * 2;
        ctx.beginPath();
        ctx.ellipse(px, py, 4 + (i % 4), 2.2, 0.2, 0, Math.PI * 2);
        ctx.fillStyle = hsl(30, 18, 38 + (i % 3) * 8);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawFarPlants(ctx, water, t, tint) {
      const rng = new Rng(this.world.seed ^ 0x111);
      const n = this.themeSpec().kelpCount;
      for (let i = 0; i < n; i += 1) {
        const px = water.x + rng.random() * water.w;
        const h = 70 + rng.randrange(90);
        this._kelp(ctx, px, this.sandY(px), h, t, hsl(110 + tint.plant, 35, 16, 0.55), 0.6);
      }
    }

    _kelp(ctx, x, y, height, t, color, thin) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      const sway = Math.sin(t * 0.8 + x * 0.02) * 10 * thin * this._m();
      ctx.bezierCurveTo(x + sway, y - height * 0.35, x - sway * 1.2, y - height * 0.7, x + sway * 0.4, y - height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * thin;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    _drawDecor(ctx, water, t, tint, foreground) {
      this.decor.items.forEach((item, index) => {
        const isFront = index % 3 === 0;
        if (foreground !== isFront) return;
        const x = water.x + item.x * water.w;
        const y = this.sandY(x);
        const s = item.scale * (foreground ? 1.05 : 0.85);
        if (item.kind === "kelp") {
          this._kelp(ctx, x, y, 90 * s, t + item.phase, hsl(120 + tint.plant, 45, 28, 0.85), 1);
          this._kelp(ctx, x + 8, y, 70 * s, t + item.phase + 1, hsl(130 + tint.plant, 40, 22, 0.8), 0.8);
        } else if (item.kind === "branch") {
          this._branchCoral(ctx, x, y, s, item.hue, t, item.phase);
        } else if (item.kind === "brain") {
          this._brainCoral(ctx, x, y, s, item.hue);
        } else if (item.kind === "anemone") {
          this._anemone(ctx, x, y, s, item.hue, t, item.phase);
        } else if (item.kind === "rock") {
          this._rock(ctx, x, y, s);
        } else {
          this._wood(ctx, x, y, s);
        }
      });
    }

    _branchCoral(ctx, x, y, s, hue, t, phase) {
      const mot = this._m();
      const drawArm = (x0, y0, ang, len, depth) => {
        const x1 = x0 + Math.cos(ang) * len;
        const y1 = y0 + Math.sin(ang) * len;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = hsl(hue, 55, 42 + depth * 6);
        ctx.lineWidth = Math.max(1.4, 5 * s - depth * 1.2);
        ctx.lineCap = "round";
        ctx.stroke();
        if (depth < 3) {
          const wob = Math.sin(t * 0.7 + phase + depth) * 0.08 * mot;
          drawArm(x1, y1, ang - 0.55 + wob, len * 0.68, depth + 1);
          drawArm(x1, y1, ang + 0.62 + wob, len * 0.62, depth + 1);
        }
      };
      drawArm(x, y, -Math.PI / 2, 22 * s, 0);
      drawArm(x, y, -Math.PI / 2 - 0.4, 16 * s, 0);
    }

    _brainCoral(ctx, x, y, s, hue) {
      ctx.beginPath();
      ctx.ellipse(x, y - 10 * s, 18 * s, 12 * s, 0, 0, Math.PI * 2);
      ctx.fillStyle = hsl(hue, 50, 46);
      ctx.fill();
      ctx.strokeStyle = hsl(hue, 40, 32);
      ctx.lineWidth = 1.4;
      for (let i = -2; i <= 2; i += 1) {
        ctx.beginPath();
        ctx.ellipse(x, y - 10 * s, 14 * s - Math.abs(i) * 2, 4 * s, i * 0.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    _anemone(ctx, x, y, s, hue, t, phase) {
      ctx.beginPath();
      ctx.ellipse(x, y - 4, 8 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fillStyle = hsl(hue, 40, 28);
      ctx.fill();
      const mot = this._m();
      for (let i = 0; i < 11; i += 1) {
        const a = -Math.PI + i * 0.28;
        const wob = Math.sin(t * 0.55 + phase + i) * 8 * s * mot;
        ctx.beginPath();
        ctx.moveTo(x, y - 6);
        ctx.quadraticCurveTo(x + Math.cos(a) * 10 * s + wob, y - 28 * s, x + Math.cos(a) * 16 * s, y - 36 * s);
        ctx.strokeStyle = hsl(hue + i * 4, 70, 58);
        ctx.lineWidth = 1.6 * s;
        ctx.stroke();
      }
    }

    _rock(ctx, x, y, s) {
      ctx.beginPath();
      ctx.moveTo(x - 22 * s, y);
      ctx.quadraticCurveTo(x - 16 * s, y - 22 * s, x, y - 18 * s);
      ctx.quadraticCurveTo(x + 20 * s, y - 26 * s, x + 26 * s, y);
      ctx.closePath();
      ctx.fillStyle = hsl(220, 8, 28);
      ctx.fill();
      ctx.fillStyle = hsl(220, 6, 38);
      ctx.beginPath();
      ctx.ellipse(x - 4 * s, y - 10 * s, 6 * s, 3 * s, -0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    _wood(ctx, x, y, s) {
      ctx.save();
      ctx.translate(x, y - 6);
      ctx.rotate(-0.35);
      ctx.fillStyle = hsl(28, 32, 28);
      ctx.fillRect(-30 * s, -5 * s, 60 * s, 8 * s);
      ctx.fillStyle = hsl(28, 28, 18);
      ctx.fillRect(-28 * s, -2 * s, 56 * s, 2);
      ctx.restore();
    }

    _drawFilter(ctx, box, water, light) {
      const x = box.x + 16;
      const y = water.y - 4;
      ctx.fillStyle = hsl(215, 10, 14 * light + 10);
      ctx.fillRect(x - 10, y - 12, 26, 32);
      ctx.fillStyle = hsl(215, 8, 8);
      ctx.fillRect(x - 8, y - 8, 22, 7);
      ctx.strokeStyle = hsl(200, 12, 28 * light + 10);
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x + 2, y + 20);
      ctx.lineTo(x + 2, this.sandY(x) - 16);
      ctx.stroke();
      ctx.fillStyle = hsl(200, 10, 22);
      ctx.fillRect(x - 6, this.sandY(x) - 22, 16, 12);
      ctx.fillStyle = hsl(200, 14, 36 * light + 12);
      ctx.fillRect(x + 12, y + 6, 12, 5);
      ctx.fillStyle = hsl(45, 70, 55 * light + 10);
      ctx.fillRect(x - 4, y - 10, 4, 3);
    }

    _drawHeater(ctx, box, water, light) {
      const x = box.x + box.w - 18;
      const top = water.y + 28;
      const bot = this.sandY(x) - 14;
      ctx.strokeStyle = `rgba(170, 200, 214, ${0.35 + 0.25 * light})`;
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bot);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255, 92, 42, ${0.4 * light + 0.28})`;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(x, bot - 32);
      ctx.lineTo(x, bot - 4);
      ctx.stroke();
      ctx.fillStyle = hsl(0, 45, 42);
      ctx.beginPath();
      ctx.arc(x - 6, top + 10, 3.2, 0, Math.PI * 2);
      ctx.arc(x - 6, bot - 36, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    _drawPlankton(ctx, water, light) {
      const world = this.world;
      const bio = this.themeSpec().bio;
      ctx.save();
      ctx.globalAlpha = bio > 0.5 ? 0.28 + 0.2 * this.phase.night : 0.22 * light;
      for (let y = 0; y < world.height; y += 2) {
        for (let x = 0; x < world.width; x += 3) {
          const n = world.nutrients[y][x];
          if (n <= 0) continue;
          const px = water.x + ((x + 0.5) / world.width) * water.w;
          const py = water.y + ((y + 0.5) / world.height) * water.h;
          ctx.fillStyle = bio > 0.4
            ? hsl(168 + n * 10, 80, 62 + n * 3)
            : hsl(80 + n * 8, 60, 60 + n * 3);
          ctx.beginPath();
          ctx.arc(px, py, 0.7 + n * 0.18, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    _drawBioSpark(ctx, water, now) {
      const bio = this.themeSpec().bio;
      if (bio < 0.35) return;
      const rng = new Rng(this.world.seed ^ 0xb10);
      const mot = this._m();
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const glow = 0.35 + this.phase.night * 0.55;
      for (let i = 0; i < 52; i += 1) {
        const baseX = rng.random();
        const baseY = rng.random();
        const speed = 0.012 + rng.random() * 0.03;
        const px = water.x + ((baseX + now * 0.000035 * speed * mot) % 1) * water.w;
        const py = water.y + ((baseY + Math.sin(now * 0.00028 * mot + i) * 0.04 + 1) % 1) * water.h;
        const pulse = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now * 0.0028 + i * 0.7));
        ctx.fillStyle = hsl(164 + (i % 24), 90, 68, 0.28 * pulse * glow * bio);
        ctx.beginPath();
        ctx.arc(px, py, 1.05 + (i % 3) * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawFish(ctx, vis, now, light) {
      const org = vis.org;
      const m = vis.morph;
      const sp = vis.sp;
      const energy = org.energy;
      let L = 22 + energy * 0.58 + (sp.lifespan % 8);
      let H = L * 0.36;
      if (m.kind === "angel") { L *= 0.82; H = L * 1.18; }
      if (m.kind === "eel") { L *= 1.85; H = L * 0.15; }
      if (m.kind === "betta") { H = L * 0.44; }
      if (m.kind === "guppy") { L *= 0.88; H = L * 0.46; }
      if (m.kind === "tetra") { L *= 0.95; H = L * 0.33; }
      if (m.kind === "catfish") { L *= 1.05; H = L * 0.28; }
      H *= m.girth || 1;
      const mot = this._m();
      const tail = Math.sin(now * 0.0036 * m.speed + vis.phase) * (0.14 + 0.22 * mot);
      const bob = Math.sin(now * 0.0011 * m.speed + vis.phase) * 1.6 * mot;
      ctx.save();
      ctx.translate(vis.px, vis.py + bob);
      ctx.scale(vis.facing, 1);
      ctx.rotate(vis.angle + tail * 0.08);
      ctx.globalAlpha = 0.96;

      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.beginPath();
      ctx.ellipse(0, H * 0.85, L * 0.42, H * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();

      this._fishBody(ctx, m, L, H, tail);
      const grad = ctx.createLinearGradient(-L * 0.4, -H, L * 0.5, H);
      grad.addColorStop(0, hsl(m.belly, 70, 62 * light + 10));
      grad.addColorStop(0.45, hsl(m.hue, 78, 48 * light + 8));
      grad.addColorStop(1, hsl((m.hue + 20) % 360, 55, 22 * light + 6));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = hsl(m.hue, 40, 18);
      ctx.lineWidth = 0.7;
      ctx.stroke();

      ctx.save();
      ctx.clip();
      this._fishPattern(ctx, m, L, H);
      this._fishScales(ctx, m, L, H, light);
      ctx.fillStyle = hsl(m.belly, 35, 82, 0.28);
      ctx.beginPath();
      ctx.ellipse(L * 0.08, H * 0.12, L * 0.32, H * 0.22, 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hsl(m.belly, 40, 88, 0.22);
      ctx.beginPath();
      ctx.ellipse(L * 0.05, -H * 0.2, L * 0.3, H * 0.12, -0.25, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = hsl(m.hue, 30, 22, 0.55);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(L * 0.16, 0, H * 0.38, -1.15, 1.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(L * 0.18, 0);
      ctx.quadraticCurveTo(-L * 0.02, H * 0.06, -L * 0.32, 0);
      ctx.strokeStyle = hsl(m.hue, 20, 30, 0.35);
      ctx.lineWidth = 0.8;
      ctx.stroke();

      if (m.sheen > 0) {
        ctx.save();
        ctx.globalAlpha = 0.16 + 0.18 * m.sheen * (0.5 + 0.5 * Math.sin(now * 0.0021 + vis.phase));
        const sheen = ctx.createLinearGradient(-L * 0.4, -H, L * 0.5, H);
        sheen.addColorStop(0, hsl((m.hue + 140) % 360, 90, 70));
        sheen.addColorStop(0.5, hsl((m.hue + 200) % 360, 90, 78));
        sheen.addColorStop(1, hsl((m.hue + 260) % 360, 90, 70));
        ctx.fillStyle = sheen;
        this._fishBody(ctx, m, L, H, tail);
        ctx.fill();
        ctx.restore();
      }
      this._fins(ctx, m, L, H, tail, now);
      this._eye(ctx, m, L, H);
      if (m.kind === "catfish") this._barbels(ctx, L, H);
      ctx.restore();

      if (this.picked && this.picked.genome === vis.genome) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.ellipse(vis.px, vis.py + bob, L * 0.7, H * 0.8, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    _fishBody(ctx, m, L, H, tail) {
      ctx.beginPath();
      if (m.kind === "eel") {
        ctx.moveTo(L * 0.48, 0);
        for (let i = 0; i <= 12; i += 1) {
          const u = i / 12;
          const x = L * 0.48 - u * L * 0.96;
          const y = Math.sin(u * Math.PI * 3 + tail) * H * 0.7 * (0.3 + u);
          const r = H * (0.9 - u * 0.7);
          if (i === 0) ctx.moveTo(x, y - r);
          else ctx.lineTo(x, y - r);
        }
        for (let i = 12; i >= 0; i -= 1) {
          const u = i / 12;
          const x = L * 0.48 - u * L * 0.96;
          const y = Math.sin(u * Math.PI * 3 + tail) * H * 0.7 * (0.3 + u);
          const r = H * (0.9 - u * 0.7);
          ctx.lineTo(x, y + r);
        }
        ctx.closePath();
        return;
      }
      if (m.kind === "angel") {
        ctx.moveTo(L * 0.42, 0);
        ctx.bezierCurveTo(L * 0.1, -H * 0.9, -L * 0.05, -H * 0.5, -L * 0.32, 0);
        ctx.bezierCurveTo(-L * 0.05, H * 0.5, L * 0.1, H * 0.9, L * 0.42, 0);
        ctx.closePath();
        return;
      }
      ctx.moveTo(L * 0.5, 0);
      ctx.bezierCurveTo(L * 0.22, -H * 0.95, -L * 0.05, -H * 0.7, -L * 0.4, 0);
      ctx.bezierCurveTo(-L * 0.05, H * 0.75, L * 0.22, H * 0.9, L * 0.5, 0);
      ctx.closePath();
    }

    _fishScales(ctx, m, L, H, light) {
      ctx.strokeStyle = hsl(m.hue, 25, 18, 0.22 * light);
      ctx.lineWidth = 0.55;
      const cols = 7;
      const rows = 5;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const x = L * 0.22 - c * (L * 0.09) - (r % 2) * 2;
          const y = -H * 0.28 + r * (H * 0.14);
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1.4, H * 0.11), 0.35, Math.PI - 0.35);
          ctx.stroke();
        }
      }
    }

    _fishPattern(ctx, m, L, H) {
      if (m.pattern === 0) {
        for (let i = 0; i < m.stripeCount; i += 1) {
          const x = -L * 0.28 + i * (L * 0.55) / m.stripeCount;
          ctx.fillStyle = hsl(m.hue, 40, 18, 0.35);
          ctx.fillRect(x, -H, 2.2, H * 2);
        }
      } else if (m.pattern === 1) {
        for (let i = 0; i < m.spotCount; i += 1) {
          const x = -L * 0.25 + (i * 17 % 30);
          const y = -H * 0.3 + (i * 13 % 20);
          ctx.beginPath();
          ctx.arc(x, y, 1.6 + (i % 3) * 0.5, 0, Math.PI * 2);
          ctx.fillStyle = hsl(m.hue, 30, 16, 0.4);
          ctx.fill();
        }
      }
    }

    _fins(ctx, m, L, H, tail, now) {
      const flap = Math.sin(now * 0.0045 + tail) * 0.2 * this._m();
      ctx.fillStyle = hsl(m.hue, 60, 46, 0.7);
      ctx.beginPath();
      ctx.moveTo(L * 0.05, -H * 0.2);
      ctx.quadraticCurveTo(-L * 0.02, -H * (m.kind === "angel" ? 1.6 : 1.05), -L * 0.18, -H * 0.1);
      ctx.closePath();
      ctx.fill();
      if (m.kind === "angel" || m.kind === "betta") {
        ctx.beginPath();
        ctx.moveTo(L * 0.02, H * 0.15);
        ctx.quadraticCurveTo(-L * 0.05, H * (m.kind === "angel" ? 1.55 : 1.1), -L * 0.2, H * 0.1);
        ctx.closePath();
        ctx.fill();
      }
      ctx.save();
      ctx.translate(L * 0.08, H * 0.1);
      ctx.rotate(flap);
      ctx.beginPath();
      ctx.ellipse(0, 0, L * 0.12, H * 0.18, 0.6, 0, Math.PI * 2);
      ctx.fillStyle = hsl(m.hue, 50, 50, 0.45);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(-L * 0.38, 0);
      ctx.rotate(tail * (m.kind === "betta" ? 0.5 : 0.35));
      ctx.beginPath();
      if (m.kind === "betta") {
        ctx.moveTo(0, 0);
        ctx.bezierCurveTo(-L * 0.15, -H * 1.1, -L * 0.7, -H * 0.8, -L * 0.55, 0);
        ctx.bezierCurveTo(-L * 0.7, H * 0.8, -L * 0.15, H * 1.1, 0, 0);
      } else if (m.kind === "guppy") {
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(-L * 0.35, -H * 0.9, -L * 0.55, -H * 0.1);
        ctx.lineTo(-L * 0.2, 0);
        ctx.quadraticCurveTo(-L * 0.55, H * 0.1, -L * 0.35, H * 0.9);
      } else {
        ctx.moveTo(0, -H * 0.08);
        ctx.quadraticCurveTo(-L * 0.28, -H * 0.55, -L * 0.42, -H * 0.12);
        ctx.lineTo(-L * 0.18, 0);
        ctx.quadraticCurveTo(-L * 0.42, H * 0.12, -L * 0.28, H * 0.55);
        ctx.lineTo(0, H * 0.08);
      }
      ctx.closePath();
      ctx.fillStyle = hsl((m.hue + 12) % 360, 65, 48, 0.85);
      ctx.fill();
      ctx.restore();
    }

    _eye(ctx, m, L, H) {
      const ex = L * 0.28;
      const ey = -H * 0.08;
      const r = Math.max(1.8, H * 0.18);
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fillStyle = "#f7f3e8";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + r * 0.15, ey, r * 0.62, 0, Math.PI * 2);
      ctx.fillStyle = hsl(m.hue, 45, 28);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + r * 0.28, ey, r * 0.38, 0, Math.PI * 2);
      ctx.fillStyle = "#0c0d10";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + r * 0.45, ey - r * 0.28, r * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
    }

    _barbels(ctx, L, H) {
      ctx.strokeStyle = hsl(30, 20, 30);
      ctx.lineWidth = 1;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(L * 0.42, s * H * 0.12);
        ctx.quadraticCurveTo(L * 0.55, s * H * 0.35, L * 0.62, s * H * 0.22);
        ctx.stroke();
      }
    }

    _drawShrimp(ctx, water, now) {
      this.shrimp.forEach((s) => {
        const x = water.x + s.x * water.w;
        const y = this.sandY(x) - 6 + Math.sin(now * 0.004 + s.phase) * 2 * this._m();
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(s.dir, 1);
        ctx.fillStyle = hsl(s.hue, 70, 62);
        ctx.beginPath();
        ctx.ellipse(0, 0, 5, 2.1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = hsl(s.hue, 50, 40);
        ctx.beginPath();
        ctx.moveTo(4, -1);
        ctx.lineTo(7, -4);
        ctx.stroke();
        ctx.restore();
      });
    }

    _drawSnail(ctx, box, water, now) {
      const x = box.x + 8;
      const y = water.y + 20 + this.snail.x * (water.h - 40);
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = hsl(25, 35, 42);
      ctx.beginPath();
      ctx.arc(0, 0, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hsl(25, 20, 28);
      ctx.beginPath();
      ctx.arc(0, 0, 3, 0.2, 4);
      ctx.stroke();
      ctx.restore();
    }

    _drawBubbles(ctx) {
      this.bubbles.forEach((b) => {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(200, 230, 255, 0.18)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fill();
      });
    }

    _drawFlakes(ctx) {
      this.flakes.forEach((f) => {
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.rot);
        ctx.fillStyle = hsl(38, 70, 62, 0.9);
        ctx.fillRect(-f.r, -f.r * 0.4, f.r * 2, f.r * 0.8);
        ctx.restore();
      });
    }

    _drawCaustics(ctx, water, t, light) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.beginPath();
      const mot = this._m();
      for (let i = 0; i < 4; i += 1) {
        const y = water.y + ((t * 12 * mot + i * 40) % water.h);
        ctx.moveTo(water.x, y);
        for (let x = 0; x <= 20; x += 1) {
          const px = water.x + (x / 20) * water.w;
          const py = y + Math.sin(px * 0.03 + t * 0.55 * mot + i) * 6 * mot;
          ctx.lineTo(px, py);
        }
      }
      ctx.strokeStyle = `rgba(160, 220, 255, ${0.07 * light * (this.reducedMotion ? 0.35 : 1)})`;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    _drawSurface(ctx, water, t, light) {
      ctx.save();
      const mot = this._m();
      ctx.beginPath();
      ctx.moveTo(water.x, water.y);
      for (let i = 0; i <= 32; i += 1) {
        const px = water.x + (i / 32) * water.w;
        const py = water.y + Math.sin(px * 0.045 + t * 0.7) * 2.2 * mot + Math.sin(px * 0.12 + t * 0.9) * 1.1 * mot;
        ctx.lineTo(px, py);
      }
      ctx.lineTo(water.x + water.w, water.y - 10);
      ctx.lineTo(water.x, water.y - 10);
      ctx.closePath();
      ctx.fillStyle = `rgba(210, 240, 255, ${0.16 * light})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(255,255,255,${0.35 * light})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i <= 32; i += 1) {
        const px = water.x + (i / 32) * water.w;
        const py = water.y + Math.sin(px * 0.045 + t * 0.7) * 2.2 * mot;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    _drawRipples(ctx) {
      this.ripples.forEach((r) => {
        ctx.beginPath();
        ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${0.35 * r.life})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }

    _drawGlass(ctx, box, water, light) {
      const g = ctx.createLinearGradient(box.x, 0, box.x + 40, 0);
      g.addColorStop(0, `rgba(255,255,255,${0.16 * light})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(box.x, box.y, 28, box.h);
      ctx.fillStyle = "rgba(8, 16, 24, 0.18)";
      ctx.fillRect(box.x + box.w - 16, box.y, 16, box.h);
      ctx.strokeStyle = "rgba(180, 210, 230, 0.35)";
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x + 1.5, box.y + 1.5, box.w - 3, box.h - 3);
      if (this.shock > 0.04) {
        ctx.fillStyle = `rgba(255,255,255,${0.08 * this.shock})`;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
    }

    _drawHood(ctx, box, light) {
      ctx.fillStyle = "#14110f";
      ctx.fillRect(box.x - 6, box.y - 22, box.w + 12, 18);
      if (this.lights) {
        const glow = 0.3 + 0.25 * Math.min(1, light);
        const warm = this.theme === "moonlit"
          ? `rgba(160, 200, 255, ${glow})`
          : `rgba(255, 236, 190, ${glow + 0.08})`;
        const lamp = ctx.createLinearGradient(box.x, box.y - 4, box.x, box.y + 24);
        lamp.addColorStop(0, warm);
        lamp.addColorStop(1, "rgba(255, 236, 190, 0)");
        ctx.fillStyle = lamp;
        ctx.fillRect(box.x + 10, box.y - 4, box.w - 20, 28);
      }
      ctx.fillStyle = this.lights
        ? (this.theme === "moonlit" ? "#93c5fd" : "#fde68a")
        : "#3f3f46";
      for (let i = 0; i < 8; i += 1) {
        const x = box.x + 24 + i * ((box.w - 48) / 7);
        ctx.beginPath();
        ctx.arc(x, box.y - 13, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    _drawNameplate(ctx, box) {
      if (!this.world) return;
      ctx.fillStyle = "rgba(8, 10, 14, 0.45)";
      ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
      const theme = this.themeSpec().label.toLowerCase();
      ctx.fillText(
        `${this.world.phrase}  ·  ${this.world.season()}  ·  ${this.phase.label} ${this.phase.clock}  ·  ${theme}  ·  tick ${this.world.tick_count}`,
        box.x + 8,
        box.y + box.h + 12
      );
    }
  }

  global.AquariumView = AquariumView;
  global.fishKind = fishKind;
  global.THEMES = THEMES;
})(window);
