const canvas = document.getElementById("tank");
const phraseInput = document.getElementById("phrase");
const seedInput = document.getElementById("seed");
const popInput = document.getElementById("population");
const speedInput = document.getElementById("speed");
const inspectEl = document.getElementById("inspect");
const themeSelect = document.getElementById("theme");
const hudClock = document.getElementById("hud-clock");
const playBtn = document.getElementById("btn-play");
const lightsBtn = document.getElementById("btn-lights");
const soundBtn = document.getElementById("btn-sound");

const view = new AquariumView(canvas);
const compareA = new AquariumView(document.getElementById("tank-a"));
const compareB = new AquariumView(document.getElementById("tank-b"));
const censusEl = document.getElementById("census");
const censusCanvas = document.getElementById("census-strip");
const censusNote = document.getElementById("census-note");
const shelfEl = document.getElementById("shelf");
const shelveBtn = document.getElementById("btn-shelve");

let world = World.fromPhrase(phraseInput.value, { population: Number(popInput.value) });
let playing = true;
let lastStep = 0;

// --- Census strip: a rolling record of every species' population -----------
const CENSUS_SPAN = 240;
const census = { ticks: [], rows: [], nutrients: [] };

function resetCensus() {
  census.ticks = [];
  census.rows = [];
  census.nutrients = [];
  recordCensus();
}

function recordCensus() {
  const c = world.census();
  census.ticks.push(c.tick);
  census.rows.push(c.species.map((sp) => sp.population));
  census.nutrients.push(c.nutrient_total);
  if (census.ticks.length > CENSUS_SPAN) {
    census.ticks.shift();
    census.rows.shift();
    census.nutrients.shift();
  }
}

function drawCensus() {
  if (!censusCanvas || censusEl.hidden) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = censusCanvas.getBoundingClientRect();
  const w = Math.max(200, Math.floor(rect.width || 1100));
  const h = 120;
  if (censusCanvas.width !== Math.floor(w * dpr)) {
    censusCanvas.width = Math.floor(w * dpr);
    censusCanvas.height = Math.floor(h * dpr);
  }
  const ctx = censusCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(6, 10, 14, 0.9)";
  ctx.fillRect(0, 0, w, h);
  const n = census.rows.length;
  if (n < 2) return;
  const pad = { l: 34, r: 8, t: 8, b: 16 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const totals = census.rows.map((row) => row.reduce((a, b) => a + b, 0));
  const maxPop = Math.max(1, ...totals);
  const maxNut = Math.max(1, ...census.nutrients);
  const xAt = (i) => pad.l + (i / (CENSUS_SPAN - 1)) * plotW;
  const offset = CENSUS_SPAN - n;

  // gridlines
  ctx.strokeStyle = "rgba(232, 223, 210, 0.08)";
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k += 1) {
    const y = pad.t + (k / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  // nutrients as a faint area behind the fish
  ctx.beginPath();
  ctx.moveTo(xAt(offset), pad.t + plotH);
  census.nutrients.forEach((v, i) => ctx.lineTo(xAt(offset + i), pad.t + plotH - (v / maxNut) * plotH));
  ctx.lineTo(xAt(offset + n - 1), pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = "rgba(126, 200, 195, 0.10)";
  ctx.fill();

  // stacked species bands
  const speciesCount = world.species.length;
  const cumulative = census.rows.map(() => 0);
  for (let si = 0; si < speciesCount; si += 1) {
    const sp = world.species[si];
    const top = [];
    const bottom = [];
    census.rows.forEach((row, i) => {
      bottom.push(cumulative[i]);
      cumulative[i] += row[si] || 0;
      top.push(cumulative[i]);
    });
    ctx.beginPath();
    top.forEach((v, i) => {
      const x = xAt(offset + i);
      const y = pad.t + plotH - (v / maxPop) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    for (let i = n - 1; i >= 0; i -= 1) {
      ctx.lineTo(xAt(offset + i), pad.t + plotH - (bottom[i] / maxPop) * plotH);
    }
    ctx.closePath();
    ctx.fillStyle = `hsl(${sp.hue} 70% 52% / 0.55)`;
    ctx.fill();
    ctx.strokeStyle = `hsl(${sp.hue} 78% 66%)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    top.forEach((v, i) => {
      const x = xAt(offset + i);
      const y = pad.t + plotH - (v / maxPop) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // weather markers
  ctx.fillStyle = "rgba(224, 179, 106, 0.55)";
  census.ticks.forEach((tick, i) => {
    if (tick % 41 === 0 || tick % 29 === 0) {
      ctx.fillRect(xAt(offset + i) - 0.5, pad.t, 1, plotH);
    }
  });

  // axes
  ctx.fillStyle = "rgba(154, 140, 120, 0.9)";
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textAlign = "right";
  ctx.fillText(String(maxPop), pad.l - 4, pad.t + 9);
  ctx.fillText("0", pad.l - 4, pad.t + plotH);
  ctx.textAlign = "left";
  ctx.fillText(`t${census.ticks[0]}`, xAt(offset), h - 4);
  ctx.textAlign = "right";
  ctx.fillText(`t${census.ticks[n - 1]}`, xAt(offset + n - 1), h - 4);
}

// --- Log: recent events with the tick they happened on ---------------------
const LOG_LIMIT = 40;
const log = [];
let lastLoggedTick = -1;

function recordLog() {
  if (world.tick_count === lastLoggedTick) return;
  lastLoggedTick = world.tick_count;
  const events = world.events.length ? world.events : [];
  for (const text of events) log.push({ tick: world.tick_count, text });
  while (log.length > LOG_LIMIT) log.shift();
}

function resetLog() {
  log.length = 0;
  lastLoggedTick = -1;
}

// --- Shelf: saved tanks in localStorage -------------------------------------
const SHELF_KEY = "mnemoquarium.shelf.v1";

function readShelf() {
  try {
    const raw = localStorage.getItem(SHELF_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeShelf(list) {
  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(list.slice(0, 24)));
  } catch {
    /* private mode or quota: the shelf is a convenience only */
  }
}

function shelveCurrent() {
  const entry = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    phrase: phraseInput.value,
    seed: seedInput.value,
    pop: popInput.value,
    theme: view.theme,
    tick: world.tick_count,
    population: world.organisms.length,
    species: world.species.map((sp) => ({ glyph: sp.glyph, hue: sp.hue })),
    savedAt: new Date().toISOString(),
  };
  const list = readShelf().filter(
    (item) => !(item.phrase === entry.phrase && String(item.seed) === String(entry.seed) && item.theme === entry.theme),
  );
  list.unshift(entry);
  writeShelf(list);
  paintShelf();
  shelveBtn.textContent = "Shelved";
  setTimeout(() => { shelveBtn.textContent = "Save to shelf"; }, 1400);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function paintShelf() {
  if (!shelfEl) return;
  const list = readShelf();
  if (!list.length) {
    shelfEl.innerHTML = '<p class="shelf-empty">Nothing shelved yet. Grow a tank you like and press “Save to shelf”.</p>';
    return;
  }
  shelfEl.innerHTML = list.map((item) => {
    const dots = (item.species || []).slice(0, 8)
      .map((sp) => `<span class="dot" style="background:hsl(${Number(sp.hue) || 0} 78% 56%)"></span>`).join("");
    const when = item.savedAt ? new Date(item.savedAt).toLocaleDateString() : "";
    return `
      <div class="shelf-item" data-id="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.phrase)}</strong>
        <div class="meta">${dots} ${escapeHtml(item.theme || "reef")}${item.seed !== "" && item.seed != null ? ` · seed ${escapeHtml(item.seed)}` : ""} · pop ${escapeHtml(item.pop)} · ${escapeHtml(when)}</div>
        <div class="row">
          <button type="button" class="primary" data-act="load">Load</button>
          <button type="button" class="ghost" data-act="remove">Remove</button>
        </div>
      </div>`;
  }).join("");
}

shelfEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  const card = button.closest(".shelf-item");
  const id = card && card.dataset.id;
  const list = readShelf();
  const item = list.find((entry) => entry.id === id);
  if (!item) return;
  if (button.dataset.act === "remove") {
    writeShelf(list.filter((entry) => entry.id !== id));
    paintShelf();
    return;
  }
  phraseInput.value = item.phrase || "";
  seedInput.value = item.seed == null ? "" : item.seed;
  popInput.value = item.pop || 28;
  applyTheme(item.theme || "reef");
  growFromForm();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

const audio = {
  ctx: null,
  enabled: false,
  bed: null,
  lastPop: 0,
  _ensure() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this.ctx) this.ctx = new AC();
    return this.ctx;
  },
  async setEnabled(on) {
    if (on) {
      const ctx = this._ensure();
      if (!ctx) return false;
      if (ctx.state === "suspended") await ctx.resume();
      this.enabled = true;
      this._startBed();
      return true;
    }
    this.enabled = false;
    this._stopBed();
    if (this.ctx && this.ctx.state === "running") this.ctx.suspend();
    return false;
  },
  _startBed() {
    if (!this.ctx || this.bed) return;
    const ctx = this.ctx;
    const seconds = 2;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 260;
    const gain = ctx.createGain();
    gain.gain.value = 0.032;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.bed = { src, filter, gain };
  },
  _stopBed() {
    if (!this.bed) return;
    try { this.bed.src.stop(); } catch { /* already stopped */ }
    this.bed = null;
  },
  bubble() {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastPop < 0.09) return;
    this.lastPop = now;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const freq = 420 + Math.random() * 480;
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(80, freq * 0.45), now + 0.09);
    gain.gain.setValueAtTime(0.038, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);
  },
  thud() {
    if (!this.enabled || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(88, now);
    osc.frequency.exponentialRampToValueAtTime(36, now + 0.18);
    gain.gain.setValueAtTime(0.055, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  },
};

function delay() {
  // Slow cinema tank: ~2s per tick at the default of 3.
  const s = Number(speedInput.value);
  return Math.max(480, 2300 - s * 90);
}

function applyTheme(id) {
  const theme = THEMES[id] ? id : "reef";
  view.setTheme(theme);
  compareA.setTheme(theme);
  compareB.setTheme(theme);
  if (themeSelect.value !== theme) themeSelect.value = theme;
  writeHash();
}

function writeHash() {
  const url = new URL(location.href);
  const params = new URLSearchParams({
    phrase: phraseInput.value,
    pop: popInput.value,
    theme: view.theme,
  });
  if (seedInput.value !== "") params.set("seed", seedInput.value);
  url.hash = params.toString();
  history.replaceState(null, "", url);
}

function growFromForm() {
  world = World.fromPhrase(phraseInput.value, {
    seed: seedInput.value === "" ? undefined : Number(seedInput.value),
    population: Number(popInput.value) || 28,
  });
  view.attach(world);
  resetLog();
  resetCensus();
  paintHud();
  drawCensus();
  writeHash();
}

function advance() {
  world.step();
  recordLog();
  recordCensus();
  paintHud();
  drawCensus();
}

function paintHud() {
  const census = world.census();
  const phase = view.phase || { label: "day", clock: "12:00" };
  document.getElementById("kpis").innerHTML = [
    ["Tick", census.tick],
    ["Season", census.season],
    ["Phase", `${phase.label} ${phase.clock}`],
    ["Theme", (THEMES[view.theme] || THEMES.reef).label],
    ["Population", census.population],
    ["Nutrients", census.nutrient_total],
    ["Mutations", census.mutations],
    ["Predations", census.predations],
    ["Deepest gen", census.max_generation],
    ["Mutant fish", census.mutant_population],
  ].map(([k, v]) => `<div class="kpi"><strong>${v}</strong><span>${k}</span></div>`).join("");

  document.getElementById("legend").innerHTML = census.species
    .slice()
    .sort((a, b) => b.population - a.population)
    .map((sp) => {
      const kind = typeof fishKind === "function" ? fishKind(sp) : "";
      const lineage = sp.population
        ? ` · gen ${sp.max_generation}${sp.mutants ? ` · ${sp.mutants} mutant${sp.mutants === 1 ? "" : "s"}` : ""}`
        : " · extinct";
      return `
      <div class="sp">
        <span class="dot" style="background:hsl(${sp.hue} 78% 56%)"></span>
        <span>${sp.glyph} ${sp.name} · ${sp.population}<small class="kind">${lineage}</small></span>
        <span class="kind">${kind || ""}</span>
      </div>`;
    }).join("");

  const items = log.length ? log.slice().reverse() : [{ tick: census.tick, text: "the brine is quiet" }];
  document.getElementById("events").innerHTML = items
    .map((entry, i) => `<li class="${i === 0 ? "fresh" : ""}"><span class="t">t${entry.tick}</span><span>${escapeHtml(entry.text)}</span></li>`)
    .join("");
  if (censusNote) {
    censusNote.textContent = `gen ${census.max_generation} · mean ${census.mean_generation} · ${census.mutant_population} mutant${census.mutant_population === 1 ? "" : "s"}`;
  }
}

function setPlaying(next) {
  playing = next;
  playBtn.textContent = playing ? "Pause" : "Play";
}

function togglePlay() {
  setPlaying(!playing);
}

function tapGlass() {
  const water = view.waterRect();
  view.tap(water.x + water.w * 0.5, water.y + water.h * 0.35);
  audio.thud();
}

function toggleLights() {
  view.lights = !view.lights;
  lightsBtn.textContent = view.lights ? "Lights" : "Lights (off)";
}

function savePhoto() {
  const stamp = view.world ? view.world.tick_count : 0;
  const a = document.createElement("a");
  a.href = view.snapshotDataUrl();
  a.download = `mnemoquarium-${view.theme}-t${stamp}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return !!el.isContentEditable;
}

view.onPick = (vis) => {
  if (!vis) {
    inspectEl.hidden = true;
    inspectEl.innerHTML = "";
    return;
  }
  const sp = vis.sp;
  const org = vis.org;
  const traits = genomeTraits(org.genome);
  const chain = world.lineageOf(org.genome);
  const ancestors = Math.max(0, chain.length - 1);
  const parent = chain[1];
  const parentSp = parent ? world.species[parent.species_index] : null;
  const chips = [
    traits.appetite ? `appetite ${traits.appetite > 0 ? "+" : ""}${traits.appetite}` : "",
    traits.curiosity ? `curiosity ${traits.curiosity > 0 ? "+" : ""}${traits.curiosity}` : "",
    traits.thrift ? "thrifty" : "",
    traits.hue_shift ? `hue ${traits.hue_shift > 0 ? "+" : ""}${traits.hue_shift}°` : "",
  ].filter(Boolean);
  inspectEl.hidden = false;
  inspectEl.innerHTML = `
    <strong>${escapeHtml(sp.name)}</strong>
    ${fishKind(sp)} from “${escapeHtml(sp.source_word)}”<br>
    energy ${org.energy} · age ${org.age} · born t${org.born || 0}<br>
    eat ${Math.max(1, sp.appetite + traits.appetite)} · curious ${Math.max(0, sp.curiosity + traits.curiosity)}
    <span class="lineage">generation ${org.generation || 0}${org.lineage_mutations ? ` · carries ${org.lineage_mutations} mutation${org.lineage_mutations === 1 ? "" : "s"}` : " · unmutated line"}${
      parentSp ? ` · parent ${escapeHtml(parentSp.glyph)} alive` : (org.generation ? " · parent gone" : " · founder")
    }${ancestors > 1 ? ` · ${ancestors} living ancestors` : ""}</span>
    <span>${chips.length ? chips.map((c) => `<span class="trait">${c}</span>`).join("") : '<span class="trait">baseline traits</span>'}</span>
  `;
};

view.onBubble = () => audio.bubble();

function loop(now) {
  if (playing && now - lastStep >= delay()) {
    advance();
    lastStep = now;
  }
  view.stepVisual(now);
  view.draw(now);
  if (compareA.world) {
    compareA.stepVisual(now);
    compareA.draw(now);
  }
  if (compareB.world) {
    compareB.stepVisual(now);
    compareB.draw(now);
  }
  const clockText = `${view.phase.label} · ${view.phase.clock} · ${view.theme}`;
  if (hudClock.textContent !== clockText) hudClock.textContent = clockText;
  if (document.body.dataset.phase !== view.phase.label) {
    document.body.dataset.phase = view.phase.label;
  }
  if (document.body.dataset.theme !== view.theme) {
    document.body.dataset.theme = view.theme;
  }
  requestAnimationFrame(loop);
}

document.getElementById("seed-form").addEventListener("submit", (event) => {
  event.preventDefault();
  growFromForm();
});
playBtn.addEventListener("click", () => togglePlay());
document.getElementById("btn-step").addEventListener("click", () => {
  setPlaying(false);
  advance();
});
shelveBtn.addEventListener("click", () => shelveCurrent());

function toggleCensus() {
  censusEl.hidden = !censusEl.hidden;
  if (!censusEl.hidden) drawCensus();
}
document.getElementById("btn-feed").addEventListener("click", () => {
  view.feed();
  audio.bubble();
  audio.bubble();
});
lightsBtn.addEventListener("click", () => toggleLights());
document.getElementById("btn-tap").addEventListener("click", () => tapGlass());
document.getElementById("btn-photo").addEventListener("click", () => savePhoto());
soundBtn.addEventListener("click", async () => {
  const on = await audio.setEnabled(!audio.enabled);
  soundBtn.textContent = on ? "Sound (on)" : "Sound";
  soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
});
document.getElementById("btn-full").addEventListener("click", async () => {
  const cabinet = document.querySelector(".cabinet");
  if (!document.fullscreenElement) await cabinet.requestFullscreen();
  else await document.exitFullscreen();
});
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value));
canvas.addEventListener("click", (event) => {
  const pt = view.eventToLocal(event);
  const hit = view.pickAt(pt.x, pt.y);
  if (!hit) {
    view.tap(pt.x, pt.y);
    audio.thud();
  }
});
window.addEventListener("resize", () => {
  view.resize();
  compareA.resize();
  compareB.resize();
  drawCensus();
});
document.addEventListener("fullscreenchange", () => {
  view.resize();
});

document.addEventListener("keydown", (event) => {
  if (isTypingTarget(event.target)) return;
  const key = event.key;
  if (key === " " || key === "Spacebar") {
    event.preventDefault();
    togglePlay();
  } else if (key === "f" || key === "F") {
    event.preventDefault();
    view.feed();
    audio.bubble();
  } else if (key === "t" || key === "T") {
    event.preventDefault();
    tapGlass();
  } else if (key === "l" || key === "L") {
    event.preventDefault();
    toggleLights();
  } else if (key === "s" || key === "S") {
    event.preventDefault();
    savePhoto();
  } else if (key === "c" || key === "C") {
    event.preventDefault();
    toggleCensus();
  }
});

document.getElementById("btn-share").addEventListener("click", async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    document.getElementById("btn-share").textContent = "Copied";
    setTimeout(() => { document.getElementById("btn-share").textContent = "Copy share link"; }, 1400);
  } catch {
    prompt("Copy this tank URL", location.href);
  }
});

document.getElementById("btn-compare").addEventListener("click", () => {
  const steps = Number(document.getElementById("compare-steps").value) || 48;
  const a = World.fromPhrase(document.getElementById("phrase-a").value);
  const b = World.fromPhrase(document.getElementById("phrase-b").value);
  for (let i = 0; i < steps; i += 1) {
    a.step();
    b.step();
  }
  document.getElementById("label-a").textContent = a.phrase;
  document.getElementById("label-b").textContent = b.phrase;
  compareA.theme = view.theme;
  compareB.theme = view.theme;
  compareA.attach(a);
  compareB.attach(b);
  compareA.resize();
  compareB.resize();
  document.getElementById("compare-out").textContent = compareWorlds(a, b);
});

const boot = new URLSearchParams(location.hash.replace(/^#/, ""));
if (boot.get("phrase")) phraseInput.value = boot.get("phrase");
if (boot.get("seed")) seedInput.value = boot.get("seed");
if (boot.get("pop")) popInput.value = boot.get("pop");
const bootTheme = boot.get("theme");
if (bootTheme && THEMES[bootTheme]) themeSelect.value = bootTheme;
applyTheme(themeSelect.value);
growFromForm();
paintShelf();
requestAnimationFrame(loop);
