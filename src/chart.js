/* The sea chart (M).
 *
 * The sea is eight kilometres across and the fog lets you see a hundred and
 * fifty metres of it, so the only way to know where you are is to have
 * written it down. The chart is that page: the floor as the sonar would draw
 * it, the Hull, the line where the floor drops past what your casing will
 * take, the way you came, and every place you have surveyed.
 *
 * Places you have not found are only rumours — a circle somewhere near the
 * truth, never the point itself. The survey fee is for going there.
 *
 * Opening the chart holds the boat where it is, like the pause panel does.
 * The bathymetry is drawn once, the first time it is opened; everything on
 * top of it is redrawn only when something moves. */

import { SEA, ZONES, HOTKEYS } from "./config.js";
import { clamp, formatCredits, formatDepth } from "./util.js";
import { LANDMARK_KINDS } from "./landmarks.js";
import { bearingOf, compassPoint, formatRange, rumourCentre } from "./nav.js";

const GRID = 512;               // bathymetry samples per side: ~8 m apiece
const EXTENT = SEA.worldRadius * 1.04;
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const TRAIL_EVERY = 2.5;        // seconds between trail points
const TRAIL_MIN_STEP = 18;      // metres moved before a point is worth keeping
const TRAIL_MAX = 1500;

/* Floor colour by depth. The shelf is the colour of shallow water over sand;
   by the abyss it is the colour of nothing. */
const RAMP = [
  [0, [120, 214, 208]],
  [90, [66, 164, 150]],
  [240, [38, 104, 124]],
  [520, [26, 60, 104]],
  [980, [22, 30, 66]],
  [1600, [9, 10, 26]],
];

function rampAt(depth, out) {
  const d = Math.max(0, depth);
  for (let i = 1; i < RAMP.length; i += 1) {
    const [d1, c1] = RAMP[i];
    if (d <= d1 || i === RAMP.length - 1) {
      const [d0, c0] = RAMP[i - 1];
      const t = clamp((d - d0) / Math.max(1, d1 - d0), 0, 1);
      out[0] = c0[0] + (c1[0] - c0[0]) * t;
      out[1] = c0[1] + (c1[1] - c0[1]) * t;
      out[2] = c0[2] + (c1[2] - c0[2]) * t;
      return out;
    }
  }
  return out;
}

function hex(n) {
  return `#${(n >>> 0).toString(16).padStart(6, "0")}`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export class Chart {
  constructor(game) {
    this.game = game;
    this.open = false;
    this.zoom = 1;
    this.cx = 0;
    this.cz = 0;
    this.trail = [];
    this.trailTimer = 0;
    this.depths = null;         // Float32Array GRID*GRID, filled on first open
    this.bathy = null;          // canvas
    this.ratingLayer = null;    // canvas
    this.ratingFor = -1;
    this.drag = null;

    this._buildDom();
    this._bind();
  }

  /* ------------------------------------------------------------- markup -- */

  _buildDom() {
    const panel = el("div", "panel screen chart-panel");
    panel.id = "panel-chart";
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Sea chart");

    const inner = el("div", "panel-inner chart-inner");
    const head = el("header", "chart-head");
    const titles = el("div");
    titles.append(el("p", "eyebrow", "sea chart"), el("h2", null, "Where you have been"));
    this.closeBtn = el("button", "chart-close", "Close · M");
    this.closeBtn.type = "button";
    head.append(titles, this.closeBtn);

    const body = el("div", "chart-body");
    const stage = el("div", "chart-stage");
    this.canvas = el("canvas", "chart-canvas");
    this.canvas.setAttribute("aria-label", "Bathymetric chart of the sea");
    stage.append(this.canvas);
    this.stage = stage;

    const side = el("aside", "chart-side");
    this.readout = el("dl", "chart-readout");
    const legend = el("div", "chart-legend");
    legend.append(el("span", "label", "the water column"));
    for (const zone of ZONES) {
      const row = el("div", "chart-key");
      const sw = el("span", "chart-swatch");
      const c = rampAt((zone.top + Math.min(zone.bottom, SEA.maxDepth)) / 2, [0, 0, 0]);
      sw.style.background = `rgb(${c.map((v) => Math.round(v)).join(",")})`;
      const top = formatDepth(zone.top);
      const bottom = zone.bottom >= 1e5 ? "" : `–${formatDepth(zone.bottom)}`;
      row.append(sw, el("span", null, `${zone.name}`), el("span", "chart-dim", `${top}${bottom}`));
      legend.append(row);
    }
    const rated = el("div", "chart-key");
    rated.append(el("span", "chart-swatch chart-swatch-line"), el("span", null, "your casing's limit on the floor"));
    const rumour = el("div", "chart-key");
    rumour.append(el("span", "chart-swatch chart-swatch-rumour"), el("span", null, "a rumour — somewhere inside"));
    legend.append(rated, rumour);

    const help = el("p", "hint", "Scroll to zoom, drag to pan, double-click to find the boat. M or Esc to close.");
    side.append(this.readout, legend, help);

    body.append(stage, side);
    inner.append(head, body);
    panel.append(inner);
    document.body.appendChild(panel);
    this.panel = panel;
    this.ctx = this.canvas.getContext("2d");
  }

  _bind() {
    const game = this.game;
    this.onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      const isMap = HOTKEYS.map.includes(e.code);
      if (this.open) {
        if (isMap || e.code === "Escape") {
          e.preventDefault();
          this.close();
        } else if (e.code === "Equal" || e.code === "NumpadAdd") {
          this.zoomAt(this.zoom * 1.4);
        } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
          this.zoomAt(this.zoom / 1.4);
        }
        return;
      }
      if (isMap && game.mode === "dive") {
        e.preventDefault();
        this.show();
      }
    };
    window.addEventListener("keydown", this.onKey);

    this.onResize = () => { if (this.open) this.draw(); };
    window.addEventListener("resize", this.onResize, { passive: true });

    this.onClose = (e) => { e.preventDefault(); this.close(); };
    this.closeBtn.addEventListener("click", this.onClose);

    this.onWheel = (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.zoomAt(this.zoom * factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.onDown = (e) => {
      this.drag = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz };
      this.canvas.setPointerCapture(e.pointerId);
    };
    this.onMove = (e) => {
      if (!this.drag) return;
      const s = this.scale();
      this.cx = this.drag.cx - (e.clientX - this.drag.x) / s;
      this.cz = this.drag.cz - (e.clientY - this.drag.y) / s;
      this.clampView();
      this.draw();
    };
    this.onUp = () => { this.drag = null; };
    this.onDbl = () => { this.centreOnBoat(); this.draw(); };
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("dblclick", this.onDbl);

    this.offs = [
      game.bus.on("station:undock", () => { this.trail.length = 0; }),
      game.bus.on("mode", (e) => {
        if (this.open && e && e.mode !== "chart") this.hide();
      }),
    ];
  }

  /* ------------------------------------------------------------- the log -- */

  update(dt) {
    if (this.game.mode !== "dive") return;
    this.trailTimer -= dt;
    if (this.trailTimer > 0) return;
    this.trailTimer = TRAIL_EVERY;
    const p = this.game.sub.position;
    const last = this.trail[this.trail.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < TRAIL_MIN_STEP) return;
    this.trail.push({ x: p.x, z: p.z, depth: this.game.sub.depth });
    if (this.trail.length > TRAIL_MAX) this.trail.splice(0, this.trail.length - TRAIL_MAX);
  }

  /* ------------------------------------------------------------ open/close -- */

  show() {
    const game = this.game;
    if (this.open || game.mode !== "dive") return;
    this.ensureBathymetry();
    this.open = true;
    this.panel.hidden = false;
    // Holding the boat still is what the "chart" mode is for; game.frame only
    // runs the sub on "dive" and "station".
    game.setMode("chart");
    if (this.zoom === 1) { this.cx = 0; this.cz = 0; }
    this.writeReadout();
    this.draw();
    if (game.audio) game.audio.sfx("click");
  }

  close() {
    if (!this.open) return;
    this.hide();
    if (this.game.mode === "chart") this.game.setMode("dive");
  }

  hide() {
    this.open = false;
    this.panel.hidden = true;
    this.drag = null;
  }

  /* ----------------------------------------------------------------- view -- */

  scale() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    return (Math.min(w, h) / (EXTENT * 2)) * this.zoom;
  }

  clampView() {
    const lim = EXTENT * (1 - 1 / this.zoom);
    this.cx = clamp(this.cx, -lim, lim);
    this.cz = clamp(this.cz, -lim, lim);
  }

  zoomAt(next, px, py) {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const sx = px == null ? w / 2 : px;
    const sy = py == null ? h / 2 : py;
    const before = this.scale();
    const wx = this.cx + (sx - w / 2) / before;
    const wz = this.cz + (sy - h / 2) / before;
    this.zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
    const after = this.scale();
    // Keep the point under the cursor under the cursor.
    this.cx = wx - (sx - w / 2) / after;
    this.cz = wz - (sy - h / 2) / after;
    this.clampView();
    this.draw();
  }

  centreOnBoat() {
    const p = this.game.sub.position;
    if (this.zoom < 3) this.zoom = 3;
    this.cx = p.x;
    this.cz = p.z;
    this.clampView();
  }

  /* ----------------------------------------------------------- bathymetry -- */

  ensureBathymetry() {
    if (this.depths) return;
    const world = this.game.world;
    const n = GRID;
    const depths = new Float32Array(n * n);
    const step = (EXTENT * 2) / (n - 1);
    for (let j = 0; j < n; j += 1) {
      const z = -EXTENT + j * step;
      for (let i = 0; i < n; i += 1) {
        const x = -EXTENT + i * step;
        depths[j * n + i] = -world.heightAt(x, z);
      }
    }
    this.depths = depths;
    this.step = step;

    const canvas = document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(n, n);
    const px = img.data;
    const col = [0, 0, 0];
    const bands = ZONES.map((z) => z.bottom).filter((b) => b < SEA.maxDepth);
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const k = j * n + i;
        const d = depths[k];
        const dx = depths[j * n + Math.min(n - 1, i + 1)] - depths[j * n + Math.max(0, i - 1)];
        const dz = depths[Math.min(n - 1, j + 1) * n + i] - depths[Math.max(0, j - 1) * n + i];
        // Lit from the north-west, the way every chart since paper has been.
        const shade = clamp(1 - (dx + dz) / (step * 2.2), 0.55, 1.35);
        rampAt(d, col);
        let r = col[0] * shade;
        let g = col[1] * shade;
        let b = col[2] * shade;

        // Contours every hundred metres, and a brighter line at each band.
        const right = depths[j * n + Math.min(n - 1, i + 1)];
        const down = depths[Math.min(n - 1, j + 1) * n + i];
        const crosses = (lvl) => (d < lvl) !== (right < lvl) || (d < lvl) !== (down < lvl);
        let band = false;
        for (const lvl of bands) if (crosses(lvl)) { band = true; break; }
        if (band) {
          r = r * 0.45 + 200 * 0.55; g = g * 0.45 + 230 * 0.55; b = b * 0.45 + 240 * 0.55;
        } else if (Math.floor(d / 100) !== Math.floor(right / 100) || Math.floor(d / 100) !== Math.floor(down / 100)) {
          r *= 0.72; g *= 0.72; b *= 0.72;
        }

        // Past the edge of the world the current turns you round.
        const x = -EXTENT + i * step;
        const z = -EXTENT + j * step;
        if (x * x + z * z > SEA.worldRadius * SEA.worldRadius) { r *= 0.35; g *= 0.35; b *= 0.4; }

        const o = k * 4;
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.bathy = canvas;
  }

  /* The floor where it crosses the casing's rating: inside the line you can
     touch bottom, outside it the floor is deeper than the boat can go. */
  ensureRatingLayer() {
    const rating = Math.round(Number(this.game.stats && this.game.stats.pressureRating) || 0);
    if (this.ratingLayer && this.ratingFor === rating) return;
    const n = GRID;
    const depths = this.depths;
    const canvas = this.ratingLayer || document.createElement("canvas");
    canvas.width = n;
    canvas.height = n;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(n, n);
    const px = img.data;
    for (let j = 0; j < n - 1; j += 1) {
      for (let i = 0; i < n - 1; i += 1) {
        const d = depths[j * n + i] < rating;
        if (d !== (depths[j * n + i + 1] < rating) || d !== (depths[(j + 1) * n + i] < rating)) {
          const o = (j * n + i) * 4;
          px[o] = 255; px[o + 1] = 196; px[o + 2] = 107; px[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this.ratingLayer = canvas;
    this.ratingFor = rating;
  }

  /* ----------------------------------------------------------------- draw -- */

  draw() {
    if (!this.open) return;
    const canvas = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#03060c";
    ctx.fillRect(0, 0, w, h);

    const s = this.scale();
    const X = (x) => w / 2 + (x - this.cx) * s;
    const Y = (z) => h / 2 + (z - this.cz) * s;
    const half = EXTENT;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bathy, X(-half), Y(-half), half * 2 * s, half * 2 * s);
    this.ensureRatingLayer();
    ctx.globalAlpha = 0.9;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.ratingLayer, X(-half), Y(-half), half * 2 * s, half * 2 * s);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;

    // The rim of the world.
    ctx.strokeStyle = "rgba(126, 214, 232, 0.25)";
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(X(0), Y(0), SEA.worldRadius * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    this.drawScaleBar(ctx, w, h, s);
    this.drawLandmarks(ctx, X, Y, s);
    this.drawHull(ctx, X, Y);
    this.drawTrail(ctx, X, Y);
    this.drawBoat(ctx, X, Y);
    this.drawNorth(ctx, w);
  }

  drawTrail(ctx, X, Y) {
    const p = this.game.sub.position;
    const pts = this.trail;
    if (!pts.length) return;
    ctx.strokeStyle = "rgba(126, 224, 208, 0.75)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(X(pts[0].x), Y(pts[0].z));
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(X(pts[i].x), Y(pts[i].z));
    ctx.lineTo(X(p.x), Y(p.z));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawHull(ctx, X, Y) {
    const st = this.game.world.stationPosition;
    const x = X(st.x);
    const y = Y(st.z);
    ctx.fillStyle = "#ffc46b";
    ctx.shadowColor = "rgba(255, 196, 107, 0.8)";
    ctx.shadowBlur = 10;
    ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.shadowBlur = 0;
    this.label(ctx, "the Hull", x + 8, y + 4, "#ffd9a0");
  }

  drawBoat(ctx, X, Y) {
    const sub = this.game.sub;
    const p = sub.position;
    const fwd = sub.forward();
    const ang = Math.atan2(fwd.z, fwd.x);
    const x = X(p.x);
    const y = Y(p.z);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = "#e8fbff";
    ctx.shadowColor = "rgba(126, 224, 208, 0.9)";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, 5.5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -5.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  drawLandmarks(ctx, X, Y, s) {
    const lms = (this.game.landmarks && this.game.landmarks.all) || [];
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    for (const lm of lms) {
      if (lm.found) {
        const kind = LANDMARK_KINDS[lm.kind] || { colorHex: 0xffffff, icon: "•" };
        const x = X(lm.position.x);
        const y = Y(lm.position.z);
        ctx.fillStyle = hex(kind.colorHex);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        this.label(ctx, `${kind.icon} ${lm.name} · ${formatDepth(lm.depth)}`, x + 7, y + 4, "#e3eef3");
      } else {
        const r = rumourCentre(lm);
        const rad = Math.max(5, r.radius * s);
        ctx.strokeStyle = "rgba(207, 227, 238, 0.4)";
        ctx.fillStyle = "rgba(207, 227, 238, 0.06)";
        ctx.setLineDash([2, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(X(r.x), Y(r.z), rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        if (rad > 12) {
          ctx.fillStyle = "rgba(207, 227, 238, 0.55)";
          ctx.textAlign = "center";
          ctx.fillText("?", X(r.x), Y(r.z) + 4);
          ctx.textAlign = "left";
        }
      }
    }
  }

  drawScaleBar(ctx, w, h, s) {
    // The longest round distance that fits in about a sixth of the width.
    const want = (w / 6) / s;
    const steps = [50, 100, 200, 250, 500, 1000, 2000];
    let metres = steps[0];
    for (const m of steps) if (m <= want) metres = m;
    const len = metres * s;
    const x = 16;
    const y = h - 18;
    ctx.strokeStyle = "rgba(211, 230, 240, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4);
    ctx.stroke();
    this.label(ctx, formatRange(metres), x + len + 6, y + 3, "#d3e6f0");
  }

  drawNorth(ctx, w) {
    const x = w - 22;
    const y = 24;
    ctx.fillStyle = "rgba(211, 230, 240, 0.85)";
    ctx.beginPath();
    ctx.moveTo(x, y - 10); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x, y + 1); ctx.lineTo(x - 5, y + 4);
    ctx.closePath();
    ctx.fill();
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillText("N", x, y + 16);
    ctx.textAlign = "left";
  }

  label(ctx, text, x, y, color) {
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(3, 6, 12, 0.85)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /* -------------------------------------------------------------- readout -- */

  writeReadout() {
    const game = this.game;
    const p = game.sub.position;
    const st = game.world.stationPosition;
    const lms = (game.landmarks && game.landmarks.all) || [];
    const found = lms.filter((lm) => lm.found);
    const fees = found.reduce((sum, lm) => sum + (lm.pay || 0), 0);

    const dx = st.x - p.x;
    const dz = st.z - p.z;
    const home = Math.hypot(dx, dz);

    let near = null;
    let nearD = Infinity;
    for (const lm of lms) {
      if (lm.found) continue;
      const r = rumourCentre(lm);
      const d = Math.hypot(r.x - p.x, r.z - p.z);
      if (d < nearD) { nearD = d; near = r; }
    }

    const rows = [
      ["depth", `${formatDepth(game.sub.depth)} · rated ${formatDepth(game.stats.pressureRating)}`],
      ["the Hull", home < 30 ? "alongside" : `${compassPoint(bearingOf(dx, dz))} · ${formatRange(home)}`],
      ["surveyed", `${found.length} of ${lms.length} · ${formatCredits(fees)} cr in fees`],
      ["nearest rumour", near ? `${compassPoint(bearingOf(near.x - p.x, near.z - p.z))} · ${formatRange(nearD)}` : "none left"],
    ];
    const frag = document.createDocumentFragment();
    for (const [k, v] of rows) {
      const row = el("div", "chart-row");
      row.append(el("dt", null, k), el("dd", null, v));
      frag.append(row);
    }
    this.readout.replaceChildren(frag);
  }

  /* ------------------------------------------------------------- teardown -- */

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("resize", this.onResize);
    this.closeBtn.removeEventListener("click", this.onClose);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onUp);
    this.canvas.removeEventListener("dblclick", this.onDbl);
    for (const off of this.offs || []) off();
    this.panel.remove();
    this.depths = null;
    this.bathy = null;
    this.ratingLayer = null;
    this.trail.length = 0;
  }
}
