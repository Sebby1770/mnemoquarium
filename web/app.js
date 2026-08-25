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

let world = World.fromPhrase(phraseInput.value, { population: Number(popInput.value) });
let playing = true;
let lastStep = 0;

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
  paintHud();
  writeHash();
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
  ].map(([k, v]) => `<div class="kpi"><strong>${v}</strong><span>${k}</span></div>`).join("");

  document.getElementById("legend").innerHTML = census.species
    .slice()
    .sort((a, b) => b.population - a.population)
    .map((sp) => {
      const kind = typeof fishKind === "function" ? fishKind(sp) : "";
      return `
      <div class="sp">
        <span class="dot" style="background:hsl(${sp.hue} 78% 56%)"></span>
        <span>${sp.glyph} ${sp.name} · ${sp.population}</span>
        <span class="kind">${kind || ""}</span>
      </div>`;
    }).join("");

  const events = world.events.length ? world.events : ["the brine is quiet"];
  document.getElementById("events").innerHTML = events.map((e) => `<li>${e}</li>`).join("");
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
  inspectEl.hidden = false;
  inspectEl.innerHTML = `
    <strong>${sp.name}</strong>
    ${fishKind(sp)} from “${sp.source_word}”<br>
    energy ${vis.org.energy} · age ${vis.org.age}<br>
    eat ${sp.appetite} · curious ${sp.curiosity}
  `;
};

view.onBubble = () => audio.bubble();

function loop(now) {
  if (playing && now - lastStep >= delay()) {
    world.step();
    paintHud();
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
  world.step();
  paintHud();
});
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
requestAnimationFrame(loop);
